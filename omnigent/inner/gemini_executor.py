"""
GeminiExecutor: run agent turns through the Google Gemini CLI.

Spawns ``gemini -p <prompt> -o stream-json --session-id <uuid>`` as a
subprocess for each turn.  The Gemini CLI manages its own agent loop,
tool execution (via MCP), and session state internally.

Omnigent tools are bridged into Gemini via a generated ``.gemini/settings.json``
that registers a local MCP stdio server
(``python -m omnigent.inner.gemini_mcp_server``) as the ``"omnigent"``
MCP server.  The MCP server proxies tool calls to the Omnigent server's
``/v1/sessions/{session_id}/mcp`` endpoint so policies, history
recording, sub-agents, and all other Omnigent features work normally.

Session persistence uses Gemini's ``--session-id`` flag: we generate a
UUID on the first turn and reuse it on subsequent turns so Gemini's own
history store maintains context.

Requirements:
    The ``gemini`` CLI must be installed and on PATH (or set via
    ``HARNESS_GEMINI_PATH``).

Env vars (read by :func:`build_gemini_executor`):

- ``HARNESS_GEMINI_MODEL``  — model identifier passed as ``-m``.
  Defaults to ``None`` (Gemini CLI's own default).
- ``HARNESS_GEMINI_PATH``   — absolute path to the ``gemini`` binary.
  Defaults to ``"gemini"`` (searches PATH).
- ``HARNESS_GEMINI_CWD``    — workspace directory; defaults to
  ``OMNIGENT_RUNNER_WORKSPACE`` then ``None``.
- ``HARNESS_GEMINI_OS_ENV`` — ``"true"`` to pass the full
  ``os.environ`` to the subprocess (default: ``False``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from omnigent.inner.executor import (
    Executor,
    ExecutorConfig,
    ExecutorError,
    ExecutorEvent,
    Message,
    TextChunk,
    ToolSpec,
    TurnComplete,
)

_logger = logging.getLogger(__name__)

# Maximum seconds to wait for a Gemini subprocess to complete a single turn.
_GEMINI_TURN_TIMEOUT_S = 600.0


def _session_key(messages: list[Message]) -> str:
    """Extract a stable session key from the message list.

    Matches pi_executor.py's ``_session_key`` pattern: checks the last
    message's ``session_id`` field, then its ``metadata.session_id``,
    then falls back to ``"__default__"``.

    :param messages: Omnigent conversation history for the turn.
    :returns: A stable per-conversation key string.
    """
    if messages:
        last = messages[-1]
        if last.get("session_id"):
            return str(last["session_id"])
        meta = last.get("metadata") or {}
        if isinstance(meta, dict) and meta.get("session_id"):
            return str(meta["session_id"])
    return "__default__"


def _extract_last_user_message(messages: list[Message]) -> str:
    """Extract the text of the most recent user message.

    :param messages: Omnigent conversation history.
    :returns: User message text, or ``""`` when none found.
    """
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                parts: list[str] = []
                for block in content:
                    if isinstance(block, dict):
                        text = block.get("text")
                        if isinstance(text, str):
                            parts.append(text)
                if parts:
                    return "\n".join(parts)
            elif isinstance(content, str):
                return content
    return ""


def _get_conversation_id() -> str:
    """Read --conversation-id from argv, same pattern as hermes_executor.py."""
    argv = sys.argv
    for i, arg in enumerate(argv):
        if arg == "--conversation-id" and i + 1 < len(argv):
            return argv[i + 1]
    return os.environ.get("OMNIGENT_SESSION_ID", "")


def _build_gemini_settings(
    workspace: str,
    tools: list[ToolSpec],
    *,
    server_url: str,
    session_id: str,
) -> None:
    """Write (or merge into) ``{workspace}/.gemini/settings.json``.

    When ``tools`` is empty, leaves ``mcpServers`` out so Gemini
    doesn't try to connect to the MCP server unnecessarily.  Preserves
    any existing keys in the settings file — only ``mcpServers`` is
    overwritten.

    :param workspace: Workspace root directory path.
    :param tools: Omnigent tool specs to expose via MCP; empty → skip
        mcpServers entry.
    :param server_url: Omnigent HTTP server URL.
    :param session_id: Omnigent conversation/session ID.
    """
    gemini_dir = Path(workspace) / ".gemini"
    settings_path = gemini_dir / "settings.json"
    gemini_dir.mkdir(parents=True, exist_ok=True)

    settings: dict[str, Any] = {}  # type: ignore[explicit-any]
    if settings_path.is_file():
        try:
            settings = json.loads(settings_path.read_text()) or {}
        except (json.JSONDecodeError, OSError):
            settings = {}

    if tools:
        mcp_env: dict[str, str] = {
            "OMNIGENT_TOOLS_JSON": json.dumps(tools, separators=(",", ":")),
            "RUNNER_SERVER_URL": server_url,
            "OMNIGENT_SESSION_ID": session_id,
        }
        settings["mcpServers"] = {
            "omnigent": {
                "command": sys.executable,
                "args": ["-m", "omnigent.inner.gemini_mcp_server"],
                "env": mcp_env,
                "timeout": 30000,
                "trust": True,
            }
        }

    settings_path.write_text(json.dumps(settings, indent=2) + "\n")


@dataclass
class _GeminiSessionState:
    """Per-conversation state for a GeminiExecutor session."""

    gemini_session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    first_turn: bool = True


class GeminiExecutor(Executor):
    """Execute agent turns via the Google Gemini CLI.

    Spawns ``gemini`` as a subprocess for each turn, parsing its
    ``--output stream-json`` JSONL event stream into Omnigent
    :class:`ExecutorEvent` objects.
    """

    def __init__(
        self,
        *,
        gemini_path: str = "gemini",
        cwd: str | None = None,
        model: str | None = None,
        os_env: bool = False,
    ) -> None:
        """Create a GeminiExecutor.

        :param gemini_path: Path to the ``gemini`` CLI binary (or bare
            name to search PATH).
        :param cwd: Workspace directory the subprocess runs in.  When
            ``None``, the subprocess inherits its parent's cwd.
        :param model: Gemini model identifier passed as ``-m``.
            ``None`` uses the CLI's own default.
        :param os_env: When ``True``, pass the full ``os.environ`` to
            the subprocess (mirrors ``HARNESS_GEMINI_OS_ENV``).
        """
        self._gemini_path = gemini_path
        self._cwd = cwd
        self._model = model
        self._os_env = os_env
        self._session_states: dict[str, _GeminiSessionState] = {}
        self._conv_id = _get_conversation_id()

    def handles_tools_internally(self) -> bool:
        """Gemini handles tool calls via its own MCP loop."""
        return True

    def supports_streaming(self) -> bool:
        return True

    async def run_turn(
        self,
        messages: list[Message],
        tools: list[ToolSpec],
        system_prompt: str,
        config: ExecutorConfig | None = None,
    ) -> AsyncIterator[ExecutorEvent]:
        """Run one agent turn by spawning ``gemini`` as a subprocess.

        :param messages: Conversation history from Omnigent.
        :param tools: Tool schemas to expose via the MCP bridge.
        :param system_prompt: System prompt (informational; Gemini's own
            prompt handles this internally).
        :param config: Per-turn config (model override, etc.).
        :yields: :class:`TextChunk`, :class:`TurnComplete`, and
            :class:`ExecutorError` events.
        """
        key = _session_key(messages)
        if key not in self._session_states:
            self._session_states[key] = _GeminiSessionState()
        state = self._session_states[key]

        prompt = _extract_last_user_message(messages)
        if not prompt:
            yield TurnComplete(response=None)
            return

        if system_prompt and system_prompt.strip():
            prompt = f"{system_prompt.strip()}\n\n{prompt}"
            # ponytail: system prompt prepended as text; GEMINI.md injection is the upgrade path

        model = (config.model if config else None) or self._model

        # Write the .gemini/settings.json MCP bridge config when we have a
        # workspace and tools to expose.
        workspace = self._cwd
        if workspace:
            server_url = os.environ.get("RUNNER_SERVER_URL", "").rstrip("/")
            try:
                _build_gemini_settings(
                    workspace,
                    tools,
                    server_url=server_url,
                    session_id=self._conv_id,
                )
            except OSError as exc:
                _logger.warning("GeminiExecutor: could not write .gemini/settings.json: %s", exc)

        # ponytail: --session-id starts fresh; --resume reloads history (Gemini CLI convention)
        session_flag = "--session-id" if state.first_turn else "--resume"
        args = [
            self._gemini_path,
            "-p",
            prompt,
            "-o",
            "stream-json",
            session_flag,
            state.gemini_session_id,
        ]
        if model:
            args.extend(["-m", model])
        if tools and workspace:
            args.extend(["--allowed-mcp-server-names", "omnigent"])

        proc_env: dict[str, str] | None = dict(os.environ) if self._os_env else None

        _logger.debug("GeminiExecutor: spawning %s", " ".join([*args[:4], "..."]))

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._cwd,
                env=proc_env,
            )
        except FileNotFoundError:
            yield ExecutorError(
                message=(
                    f"Gemini CLI not found at '{self._gemini_path}'. "
                    "Install from https://github.com/google-gemini/gemini-cli"
                ),
                retryable=False,
            )
            return
        except OSError as exc:
            yield ExecutorError(
                message=f"Failed to spawn Gemini subprocess: {exc}",
                retryable=True,
            )
            return

        assert proc.stdout is not None
        assert proc.stderr is not None

        accumulated_text: list[str] = []
        yielded_complete = False

        async def _drain_stderr() -> None:
            async for raw in proc.stderr:  # type: ignore[union-attr]
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line:
                    _logger.debug("gemini stderr: %s", line)

        stderr_task = asyncio.create_task(_drain_stderr())

        try:
            async with asyncio.timeout(_GEMINI_TURN_TIMEOUT_S):
                async for raw_line in proc.stdout:
                    line = raw_line.decode("utf-8", errors="replace").rstrip()
                    if not line:
                        continue
                    try:
                        event: dict[str, Any] = json.loads(line)  # type: ignore[explicit-any]
                    except json.JSONDecodeError:
                        _logger.debug("GeminiExecutor: unparseable line: %s", line[:200])
                        continue

                    etype = event.get("type", "")

                    if etype in ("content", "message"):
                        # Skip user-role echoes; only yield assistant output
                        if event.get("role") not in (None, "assistant", "model"):
                            continue
                        text = event.get("text") or event.get("content") or ""
                        if isinstance(text, str) and text:
                            accumulated_text.append(text)
                            yield TextChunk(text=text)

                    elif etype == "result":
                        result_text = event.get("result") or event.get("text") or ""
                        if not isinstance(result_text, str):
                            result_text = json.dumps(result_text)
                        # Prefer the accumulated streaming text when available
                        final = "".join(accumulated_text) or result_text or None
                        state.first_turn = False  # must set before yield
                        yield TurnComplete(response=final, usage=_extract_usage(event))
                        yielded_complete = True

                    elif etype == "error":
                        msg = event.get("message") or event.get("error") or "Gemini error"
                        yield ExecutorError(message=str(msg), retryable=False)
                        yielded_complete = True

                    # init / tool_use / tool_result → skip (Gemini handles internally)

        except asyncio.TimeoutError:
            yield ExecutorError(
                message=f"Gemini subprocess timed out after {_GEMINI_TURN_TIMEOUT_S}s",
                retryable=True,
            )
            yielded_complete = True
        finally:
            stderr_task.cancel()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                with __import__("contextlib").suppress(ProcessLookupError):
                    proc.kill()

        if not yielded_complete:
            if proc.returncode != 0 and proc.returncode is not None:
                yield ExecutorError(
                    message=f"Gemini exited with code {proc.returncode}",
                    retryable=True,
                )
            else:
                final = "".join(accumulated_text) or None
                state.first_turn = False
                yield TurnComplete(response=final)

    async def close_session(self, session_key: str) -> None:
        """Release per-session state.

        :param session_key: The key identifying the session to clear.
        """
        self._session_states.pop(session_key, None)


def _extract_usage(event: dict[str, Any]) -> dict[str, Any] | None:  # type: ignore[explicit-any]
    """Extract token usage from a Gemini ``result`` event if present.

    :param event: The parsed JSONL result event.
    :returns: An Omnigent-compatible usage dict, or ``None`` when the
        event carries no usage data.
    """
    usage = event.get("usage") or event.get("usageMetadata")
    if not isinstance(usage, dict):
        return None
    input_tokens = int(usage.get("promptTokenCount") or usage.get("input_tokens") or 0)
    output_tokens = int(usage.get("candidatesTokenCount") or usage.get("output_tokens") or 0)
    if not (input_tokens or output_tokens):
        return None
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": int(usage.get("totalTokenCount") or (input_tokens + output_tokens)),
    }


def build_gemini_executor() -> GeminiExecutor:
    """Construct a :class:`GeminiExecutor` from env-var config.

    Called lazily by :class:`ExecutorAdapter` on the first turn.

    Env vars read:

    - ``HARNESS_GEMINI_MODEL``   → ``model``
    - ``HARNESS_GEMINI_PATH``    → ``gemini_path``
    - ``HARNESS_GEMINI_CWD``     → ``cwd`` (falls back to
      ``OMNIGENT_RUNNER_WORKSPACE``)
    - ``HARNESS_GEMINI_OS_ENV``  → ``os_env`` (truthy: ``"1"``,
      ``"true"``, ``"yes"``)

    :returns: A configured :class:`GeminiExecutor` instance.
    """
    model = os.environ.get("HARNESS_GEMINI_MODEL") or None
    gemini_path = os.environ.get("HARNESS_GEMINI_PATH") or "gemini"
    cwd = (
        os.environ.get("HARNESS_GEMINI_CWD") or os.environ.get("OMNIGENT_RUNNER_WORKSPACE") or None
    )
    os_env_raw = os.environ.get("HARNESS_GEMINI_OS_ENV", "").strip().lower()
    os_env = os_env_raw in ("1", "true", "yes")

    return GeminiExecutor(
        gemini_path=gemini_path,
        cwd=cwd,
        model=model,
        os_env=os_env,
    )

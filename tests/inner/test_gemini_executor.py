"""
Unit tests for :class:`GeminiExecutor` and its helpers.

Drives ``run_turn`` against a fake ``gemini`` subprocess (a stand-in for
``asyncio.create_subprocess_exec``) that emits a scripted ``-o
stream-json`` JSONL stream, so the executor's event mapping and
error handling are exercised without the real Gemini CLI.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from omnigent.inner.executor import (
    ExecutorError,
    ReasoningChunk,
    TextChunk,
    ToolCallComplete,
    ToolCallRequest,
    ToolCallStatus,
    TurnComplete,
)
from omnigent.inner.gemini_executor import GeminiExecutor, _escape_at_commands


class _FakeStream:
    """Async-iterable over pre-baked byte lines (mimics proc.stdout/stderr)."""

    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines

    def __aiter__(self) -> AsyncIterator[bytes]:
        async def _gen() -> AsyncIterator[bytes]:
            for line in self._lines:
                yield line

        return _gen()


def _fake_proc(stdout_events: list[dict], *, returncode: int = 0, stderr: list[str] | None = None):
    """Build a MagicMock standing in for an asyncio subprocess."""
    proc = MagicMock()
    proc.returncode = returncode
    proc.stdout = _FakeStream([json.dumps(e).encode() + b"\n" for e in stdout_events])
    proc.stderr = _FakeStream([s.encode() + b"\n" for s in (stderr or [])])
    proc.wait = AsyncMock(return_value=returncode)
    proc.kill = MagicMock()
    return proc


async def _collect(executor: GeminiExecutor, proc) -> list:
    with patch.object(asyncio, "create_subprocess_exec", new=AsyncMock(return_value=proc)):
        return [
            ev
            async for ev in executor.run_turn(
                messages=[{"role": "user", "content": "Hi"}],
                tools=[],
                system_prompt="",
            )
        ]


def test_escape_at_commands_escapes_only_path_like_tokens() -> None:
    assert _escape_at_commands("joe@uhstray.io") == "joe\\@uhstray.io"
    assert _escape_at_commands("@scope/pkg") == "\\@scope/pkg"
    # A bare @ followed by whitespace is not an at-command trigger — left alone.
    assert _escape_at_commands("meet @ noon") == "meet @ noon"
    # Already-escaped @ must not be double-escaped (matches Gemini's (?<!\\) rule).
    assert _escape_at_commands("\\@already") == "\\@already"


@pytest.mark.asyncio
async def test_tool_and_thought_events_emit_progress(tmp_path) -> None:
    """tool_use/tool_result/thought must surface as events (idle-watchdog fix)."""
    executor = GeminiExecutor(gemini_path="/bin/fake-gemini", cwd=str(tmp_path))
    proc = _fake_proc(
        [
            {"type": "thought", "thought": "let me think"},
            {"type": "tool_use", "tool_name": "search", "tool_id": "c1", "parameters": {"q": "x"}},
            {"type": "tool_result", "tool_id": "c1", "status": "success", "output": "done"},
            {"type": "message", "role": "assistant", "content": "answer"},
            {
                "type": "result",
                "status": "success",
                "stats": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "total_tokens": 120,
                    "cached": 30,
                },
            },
        ]
    )
    events = await _collect(executor, proc)

    assert any(isinstance(e, ReasoningChunk) and e.delta == "let me think" for e in events)
    req = next(e for e in events if isinstance(e, ToolCallRequest))
    assert req.name == "search" and req.args == {"q": "x"}
    done = next(e for e in events if isinstance(e, ToolCallComplete))
    assert done.name == "search" and done.status is ToolCallStatus.SUCCESS
    assert any(isinstance(e, TextChunk) and e.text == "answer" for e in events)
    complete = events[-1]
    assert isinstance(complete, TurnComplete) and complete.response == "answer"
    # Usage is read from result.stats (not `usage`); `cached` → cache_read.
    assert complete.usage == {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120,
        "cache_read_input_tokens": 30,
    }


@pytest.mark.asyncio
async def test_result_status_error_surfaces_executor_error(tmp_path) -> None:
    """A result with status=='error' is a failure, not an empty success."""
    executor = GeminiExecutor(gemini_path="/bin/fake-gemini", cwd=str(tmp_path))
    proc = _fake_proc(
        [{"type": "result", "status": "error", "error": {"message": "boom"}}],
    )
    events = await _collect(executor, proc)

    assert len(events) == 1
    assert isinstance(events[0], ExecutorError) and "boom" in events[0].message


@pytest.mark.asyncio
async def test_exit_42_reports_fatal_input_error_with_stderr(tmp_path) -> None:
    """Nonzero exit with no result event names the code and includes stderr."""
    executor = GeminiExecutor(gemini_path="/bin/fake-gemini", cwd=str(tmp_path))
    proc = _fake_proc([], returncode=42, stderr=["Error processing the @ command."])
    events = await _collect(executor, proc)

    assert len(events) == 1
    err = events[0]
    assert isinstance(err, ExecutorError)
    assert "42" in err.message and "FatalInputError" in err.message
    assert "@ command" in err.message
    assert err.retryable is False  # bad input recurs on retry


@pytest.mark.asyncio
async def test_transient_exit_is_retryable(tmp_path) -> None:
    """Turn-limit/tool-exec exits (53/54) are transient → retryable."""
    executor = GeminiExecutor(gemini_path="/bin/fake-gemini", cwd=str(tmp_path))
    proc = _fake_proc([], returncode=54, stderr=["tool blew up"])
    events = await _collect(executor, proc)

    assert len(events) == 1
    err = events[0]
    assert isinstance(err, ExecutorError)
    assert "54" in err.message and "FatalToolExecutionError" in err.message
    assert err.retryable is True


@pytest.mark.asyncio
async def test_unknown_exit_code_has_bare_label(tmp_path) -> None:
    """An unmapped exit code uses the bare number (no parenthesized name)."""
    executor = GeminiExecutor(gemini_path="/bin/fake-gemini", cwd=str(tmp_path))
    proc = _fake_proc([], returncode=99, stderr=["mystery"])
    events = await _collect(executor, proc)

    assert len(events) == 1
    err = events[0]
    assert isinstance(err, ExecutorError)
    assert "code 99:" in err.message and "(" not in err.message
    assert err.retryable is False

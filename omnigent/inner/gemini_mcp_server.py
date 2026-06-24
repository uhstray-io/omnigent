"""
Stdio MCP server (JSON-RPC 2.0, newline-delimited) that bridges Omnigent
tools to the Gemini CLI.

Reads these env vars at startup:

- ``OMNIGENT_TOOLS_JSON``: JSON list of tool specs
  ``[{name, description, inputSchema}]`` in MCP tool format.
- ``RUNNER_SERVER_URL``: Omnigent HTTP tool dispatch base URL,
  e.g. ``"http://127.0.0.1:6767"``.
- ``OMNIGENT_SESSION_ID``: Omnigent conversation/session ID.

MCP protocol implemented (minimal subset for tool calling):

- ``initialize``              → server info + capabilities
- ``notifications/initialized`` → no response (notification)
- ``tools/list``             → tool list from ``OMNIGENT_TOOLS_JSON``
- ``tools/call``             → proxy to Omnigent ``/v1/sessions/{id}/mcp``
- anything else              → JSON-RPC -32601 error
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request
from typing import Any


def _dispatch_tool(tool_name: str, arguments: dict[str, Any]) -> str:  # type: ignore[explicit-any]
    """POST one tool call to Omnigent's MCP endpoint, return text result.

    Blocking — run via :func:`asyncio.get_running_loop().run_in_executor`.

    :param tool_name: The registered tool name, e.g. ``"sys_os_shell"``.
    :param arguments: Tool arguments as a JSON-serialisable dict.
    :returns: A string to embed in the MCP ``tools/call`` content block.
    """
    server_url = os.environ.get("RUNNER_SERVER_URL", "").rstrip("/")
    session_id = os.environ.get("OMNIGENT_SESSION_ID", "")

    url = f"{server_url}/v1/sessions/{session_id}/mcp"
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        },
        separators=(",", ":"),
    ).encode("utf-8")

    # ponytail: MCP bridge returns tool results as text only; policy ASK/input_required
    # flows are not bridged — add resultType handling here when needed
    headers: dict[str, str] = {"Content-Type": "application/json"}

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8")
        rpc = json.loads(body)
    except Exception as exc:  # noqa: BLE001 — network errors become tool error text
        return json.dumps({"error": str(exc)})

    if "error" in rpc:
        return json.dumps(rpc["error"])
    inner = rpc.get("result", {})
    # MCP tools/call result: {content: [{type: "text", text: "..."}], ...}
    if isinstance(inner, dict):
        content = inner.get("content")
        if isinstance(content, list):
            parts = [
                p.get("text", "")
                for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            ]
            return "\n".join(parts)
    return json.dumps(inner) if inner != {} else ""


async def _handle(req: dict[str, Any]) -> dict[str, Any] | None:  # type: ignore[explicit-any]
    """Dispatch one JSON-RPC request, return the response dict or None.

    :param req: Decoded JSON-RPC object from stdin.
    :returns: A JSON-RPC response dict, or ``None`` for notifications.
    """
    req_id = req.get("id")
    method = req.get("method", "")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "omnigent", "version": "1.0"},
            },
        }

    if method == "notifications/initialized":
        return None  # Notification — no response expected

    if method == "tools/list":
        raw = os.environ.get("OMNIGENT_TOOLS_JSON", "[]")
        try:
            omnigent_tools = json.loads(raw)
        except json.JSONDecodeError:
            omnigent_tools = []
        mcp_tools = [
            {
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "inputSchema": (
                    t.get("parameters")
                    or t.get("inputSchema")
                    or {"type": "object", "properties": {}}
                ),
            }
            for t in omnigent_tools
        ]
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": mcp_tools}}

    if method == "tools/call":
        params = req.get("params") or {}
        tool_name = str(params.get("name") or "")
        arguments: dict[str, Any] = params.get("arguments") or {}  # type: ignore[explicit-any]
        loop = asyncio.get_running_loop()
        result_text = await loop.run_in_executor(None, _dispatch_tool, tool_name, arguments)
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"content": [{"type": "text", "text": result_text}]},
        }

    # Unknown method — only respond for requests (req_id present), not notifications
    if req_id is not None:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
    return None


async def _main() -> None:
    """Run the MCP stdio server loop until stdin closes."""
    loop = asyncio.get_running_loop()

    while True:
        line: str = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = await _handle(req)
        if response is not None:
            out = json.dumps(response, separators=(",", ":")) + "\n"
            sys.stdout.buffer.write(out.encode("utf-8"))
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    asyncio.run(_main())

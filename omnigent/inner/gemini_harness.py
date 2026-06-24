"""
``harness: gemini`` wrap.

Thin module exposing :func:`create_app` — the entrypoint the
shared :mod:`omnigent.runtime.harnesses._runner` invokes after
the parent process resolves ``"gemini"`` or ``"gemini-cli"`` to
this module via :data:`omnigent.runtime.harnesses._HARNESS_MODULES`.

Internally, instantiates
:class:`omnigent.runtime.harnesses._executor_adapter.ExecutorAdapter`
around a :class:`omnigent.inner.gemini_executor.GeminiExecutor`
configured from env vars the parent process sets before spawning.
Mirrors the pi harness wrap (``pi_harness.py``) and hermes harness
wrap (``hermes_harness.py``).

Env vars read at startup:

- ``HARNESS_GEMINI_MODEL``  — model identifier passed as ``-m``.
  ``None`` falls back to the Gemini CLI's own default.
- ``HARNESS_GEMINI_PATH``   — absolute path to the ``gemini`` CLI
  binary.  ``None`` searches PATH.
- ``HARNESS_GEMINI_CWD``    — working directory the subprocess runs
  in.  ``None`` falls back to ``OMNIGENT_RUNNER_WORKSPACE`` then the
  subprocess's inherited cwd.
- ``HARNESS_GEMINI_OS_ENV`` — ``"1"`` / ``"true"`` / ``"yes"`` to
  pass the full ``os.environ`` to the subprocess.
"""

from __future__ import annotations

from fastapi import FastAPI

from omnigent.inner.gemini_executor import build_gemini_executor
from omnigent.runtime.harnesses._executor_adapter import ExecutorAdapter


def create_app() -> FastAPI:
    """Build the Gemini harness's FastAPI app.

    Required entry point per the harness contract — the runner
    imports this module (resolved from
    :data:`omnigent.runtime.harnesses._HARNESS_MODULES`) and
    invokes ``create_app()`` to get the app it serves.

    :returns: The FastAPI app from :class:`ExecutorAdapter`'s
        :meth:`build` method.  The wrapped :class:`GeminiExecutor`
        is constructed lazily on the first turn (so an absent
        ``gemini`` CLI surfaces as a request-time error, not a
        FastAPI app-boot crash).
    """
    adapter = ExecutorAdapter(executor_factory=build_gemini_executor)
    return adapter.build()

"""
Agent Island bridge plugin for Hermes.

When a dangerous-command approval is needed in a live Hermes session
(CLI or gateway), this plugin:

1. Writes the request to %LOCALAPPDATA%/hermes/agent-island/bridge/pending/<id>.json
2. Wraps the approval callback so the island can answer via
   bridge/decisions/<id>.json (choice: once|session|always|deny)
3. Falls back to the original Hermes UI if the island is not alive
   (no recent heartbeat) or times out.

Install path (profile plugins dir):
  %LOCALAPPDATA%/hermes/plugins/agent-island-bridge/
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

PLUGIN_NAME = "agent-island-bridge"
HEARTBEAT_MAX_AGE_S = 15.0
DECISION_POLL_S = 0.25
DEFAULT_TIMEOUT_S = 300.0


def _bridge_root() -> Path:
    local = Path.home() / "AppData" / "Local" / "hermes" / "agent-island" / "bridge"
    local.mkdir(parents=True, exist_ok=True)
    (local / "pending").mkdir(exist_ok=True)
    (local / "decisions").mkdir(exist_ok=True)
    return local


def _island_alive(root: Path) -> bool:
    hb = root / "heartbeat.json"
    if not hb.exists():
        return False
    try:
        data = json.loads(hb.read_text(encoding="utf-8"))
        at = float(data.get("at") or 0)
        return (time.time() * 1000.0 - at) <= HEARTBEAT_MAX_AGE_S * 1000.0
    except Exception:
        return False


def _write_pending(root: Path, payload: dict) -> Path:
    path = root / "pending" / f"{payload['id']}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)
    return path


def _clear_pending(root: Path, approval_id: str) -> None:
    path = root / "pending" / f"{approval_id}.json"
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass


def _read_decision(root: Path, approval_id: str) -> Optional[str]:
    path = root / "decisions" / f"{approval_id}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        choice = data.get("choice")
        if choice in {"once", "session", "always", "deny"}:
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass
            return choice
    except Exception:
        return None
    return None


def _wait_for_island_decision(
    root: Path,
    approval_id: str,
    timeout_s: float,
) -> Optional[str]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        choice = _read_decision(root, approval_id)
        if choice:
            return choice
        # If island disappears mid-wait, stop early and fall back.
        if not _island_alive(root):
            return None
        time.sleep(DECISION_POLL_S)
    return None


def _wrap_approval_callback(original: Optional[Callable[..., str]]) -> Callable[..., str]:
    def bridged(
        command: str,
        description: str,
        *,
        allow_permanent: bool = True,
        smart_denied: bool = False,
        **kwargs: Any,
    ) -> str:
        root = _bridge_root()
        approval_id = f"hermes-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        choices = ["once", "deny"] if smart_denied else (
            ["once", "session", "always", "deny"] if allow_permanent else ["once", "session", "deny"]
        )
        payload = {
            "id": approval_id,
            "command": command,
            "description": description,
            "createdAt": int(time.time() * 1000),
            "expiresAt": int((time.time() + DEFAULT_TIMEOUT_S) * 1000),
            "choices": choices,
            "surface": "cli",
            "allowPermanent": allow_permanent,
            "smartDenied": smart_denied,
        }
        pending_path = None
        try:
            if _island_alive(root):
                pending_path = _write_pending(root, payload)
                choice = _wait_for_island_decision(root, approval_id, DEFAULT_TIMEOUT_S)
                if choice:
                    return choice
        finally:
            if pending_path is not None:
                _clear_pending(root, approval_id)

        # Fallback to native Hermes UI / previous callback.
        if original is not None:
            try:
                return original(
                    command,
                    description,
                    allow_permanent=allow_permanent,
                    smart_denied=smart_denied,
                    **kwargs,
                )
            except TypeError:
                # Older callback signature.
                return original(command, description)
        return "deny"

    return bridged


def _install_wrapper() -> None:
    try:
        from tools import terminal_tool as tt
    except Exception:
        return

    # Monkeypatch set_approval_callback so whenever Hermes CLI installs its
    # native UI callback, we wrap it instead of being overwritten.
    if getattr(tt.set_approval_callback, "_agent_island_patch", False):
        # Already patched — still ensure current callback is wrapped.
        current = getattr(tt, "_get_approval_callback", lambda: None)()
        if current is not None and not getattr(current, "_agent_island_bridged", False):
            wrapped = _wrap_approval_callback(current)
            wrapped._agent_island_bridged = True  # type: ignore[attr-defined]
            tt._callback_tls.approval = wrapped  # type: ignore[attr-defined]
        return

    original_set = tt.set_approval_callback

    def set_and_wrap(cb):  # type: ignore[no-untyped-def]
        if cb is not None and getattr(cb, "_agent_island_bridged", False):
            return original_set(cb)
        wrapped = _wrap_approval_callback(cb)
        wrapped._agent_island_bridged = True  # type: ignore[attr-defined]
        return original_set(wrapped)

    set_and_wrap._agent_island_patch = True  # type: ignore[attr-defined]
    tt.set_approval_callback = set_and_wrap  # type: ignore[assignment]

    current = getattr(tt, "_get_approval_callback", lambda: None)()
    if current is not None and not getattr(current, "_agent_island_bridged", False):
        wrapped = _wrap_approval_callback(current)
        wrapped._agent_island_bridged = True  # type: ignore[attr-defined]
        original_set(wrapped)


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint."""
    # Ensure bridge dirs exist as soon as plugin loads.
    _bridge_root()

    # Wrap as early as possible and again on session start (CLI sets its
    # callback during interactive boot, which can overwrite ours).
    _install_wrapper()

    def on_session_start(**_kwargs: Any) -> None:
        _install_wrapper()

    try:
        ctx.register_hook("on_session_start", on_session_start)
    except Exception:
        pass

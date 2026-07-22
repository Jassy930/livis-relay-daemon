"""Test doubles for the narrow Hermes platform-plugin public contract.

The bridge deliberately has no runtime dependency on a separately published
Hermes Python package.  Production loads it inside Hermes, while these unit
tests provide only the public gateway types the adapter imports.  This keeps
the plugin test environment small and deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import importlib.util
from pathlib import Path
import re
from types import ModuleType, SimpleNamespace
import sys
from typing import Any

import pytest


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
ADAPTER_PATH = PLUGIN_ROOT / "adapter.py"


class Platform:
    """Minimal value-compatible stand-in for Hermes' dynamic Platform enum."""

    def __init__(self, value: str):
        self.value = value


@dataclass
class HomeChannel:
    platform: Platform
    chat_id: str
    name: str
    thread_id: str | None = None


class MessageType(Enum):
    TEXT = "text"
    COMMAND = "command"


class ProcessingOutcome(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"


@dataclass
class MessageEvent:
    text: str
    message_type: MessageType = MessageType.TEXT
    source: Any = None
    raw_message: Any = None
    message_id: str | None = None
    timestamp: Any = None


@dataclass
class SendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None
    raw_response: Any = None
    retryable: bool = False
    continuation_message_ids: tuple = ()


class BasePlatformAdapter:
    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self._message_handler = object()
        self.connected = False
        self.fatal_error = None
        self.handled_events: list[MessageEvent] = []
        self._active_sessions: dict[str, Any] = {}
        self._session_tasks: dict[str, Any] = {}

    def build_source(self, **kwargs):
        return SimpleNamespace(platform=self.platform, **kwargs)

    async def handle_message(self, event: MessageEvent) -> None:
        self.handled_events.append(event)

    def _heal_stale_session_lock(self, session_key: str) -> bool:
        if session_key not in self._active_sessions:
            return False
        task = self._session_tasks.get(session_key)
        if task is None or not task.done():
            return False
        self._active_sessions.pop(session_key, None)
        self._session_tasks.pop(session_key, None)
        return True

    def _mark_connected(self) -> None:
        self.connected = True

    def _mark_disconnected(self) -> None:
        self.connected = False

    def _set_fatal_error(self, code: str, message: str, *, retryable: bool) -> None:
        self.fatal_error = (code, message, retryable)


def _install_gateway_stubs() -> None:
    gateway = ModuleType("gateway")
    gateway.__path__ = []
    config = ModuleType("gateway.config")
    config.Platform = Platform
    config.HomeChannel = HomeChannel
    platforms = ModuleType("gateway.platforms")
    platforms.__path__ = []
    base = ModuleType("gateway.platforms.base")
    base.BasePlatformAdapter = BasePlatformAdapter
    base.MessageEvent = MessageEvent
    base.MessageType = MessageType
    base.ProcessingOutcome = ProcessingOutcome
    base.SendResult = SendResult

    restart_patterns = (
        re.compile(r"^(?:please\s+)?restart\s+(?:the\s+)?gateway[.!?\s]*$", re.IGNORECASE),
        re.compile(r"^(?:please\s+)?restart\s+(?:the\s+)?hermes\s+gateway[.!?\s]*$", re.IGNORECASE),
        re.compile(r"^(?:please\s+)?restart\s+hermes[.!?\s]*$", re.IGNORECASE),
    )

    def coerce_plaintext_gateway_command(event: MessageEvent) -> None:
        if event.message_type is not MessageType.TEXT:
            return
        text = (event.text or "").strip()
        if not text or text.startswith("/"):
            return
        if getattr(event.source, "chat_type", None) != "dm":
            return
        if any(pattern.match(text) for pattern in restart_patterns):
            event.text = "/restart"

    base.coerce_plaintext_gateway_command = coerce_plaintext_gateway_command
    tools = ModuleType("tools")
    tools.__path__ = []
    approval = ModuleType("tools.approval")
    approval.has_blocking_approval = lambda _session_key: False

    sys.modules["gateway"] = gateway
    sys.modules["gateway.config"] = config
    sys.modules["gateway.platforms"] = platforms
    sys.modules["gateway.platforms.base"] = base
    sys.modules["tools"] = tools
    sys.modules["tools.approval"] = approval


@pytest.fixture(scope="session")
def adapter_module():
    _install_gateway_stubs()
    module_name = "livis_hermes_bridge_test_adapter"
    spec = importlib.util.spec_from_file_location(module_name, ADAPTER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def clean_livis_environment(monkeypatch):
    for name in (
        "LIVIS_RELAY_SOCKET",
        "LIVIS_RELAY_TOKEN",
        "LIVIS_ALLOWED_USERS",
        "LIVIS_ALLOW_ALL_USERS",
        "LIVIS_PHASE1_READ_ONLY_ACK",
        "LIVIS_HOME_CHANNEL",
        "LIVIS_RELAY_CONNECT_TIMEOUT",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def secure_environment(monkeypatch, tmp_path):
    values = {
        "LIVIS_RELAY_SOCKET": str(tmp_path / "connector.sock"),
        "LIVIS_RELAY_TOKEN": "t" * 32,
        "LIVIS_ALLOWED_USERS": "trusted-node-1",
        "LIVIS_PHASE1_READ_ONLY_ACK": "true",
        "LIVIS_HOME_CHANNEL": "livis:test-agent-id",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return values


@pytest.fixture
def config():
    return SimpleNamespace(
        extra={},
        home_channel=None,
        gateway_restart_notification=True,
    )


@pytest.fixture
def fake_ws():
    class FakeWebSocket:
        def __init__(self):
            self.sent: list[dict] = []
            self.closed = False

        async def send(self, encoded: str) -> None:
            import json

            self.sent.append(json.loads(encoded))

        async def close(self) -> None:
            self.closed = True

    return FakeWebSocket()

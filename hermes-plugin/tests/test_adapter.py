from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest


def make_adapter(adapter_module, config, fake_ws=None):
    adapter = adapter_module.LivisBridgeAdapter(config)
    if fake_ws is not None:
        adapter._ws = fake_ws
    return adapter


async def wait_for_sent_count(fake_ws, count: int) -> None:
    async def wait_until_ready() -> None:
        while len(fake_ws.sent) < count:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_until_ready(), timeout=1)


def test_package_entrypoint_exports_register(adapter_module):
    plugin_root = Path(adapter_module.__file__).resolve().parent
    package_name = "livis_hermes_bridge_test_package"
    spec = importlib.util.spec_from_file_location(
        package_name,
        plugin_root / "__init__.py",
        submodule_search_locations=[str(plugin_root)],
    )
    assert spec is not None and spec.loader is not None
    package = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = package
    try:
        spec.loader.exec_module(package)
        assert callable(package.register)
        assert package.__all__ == ["register"]
    finally:
        sys.modules.pop(f"{package_name}.adapter", None)
        sys.modules.pop(package_name, None)


def test_register_declares_secure_final_only_contract(
    adapter_module,
    secure_environment,
    config,
):
    class Context:
        registration = None

        def register_platform(self, **kwargs):
            self.registration = kwargs

    context = Context()
    adapter_module.register(context)
    registration = context.registration

    assert registration is not None
    assert registration["name"] == "livis"
    assert registration["label"] == "LiViS Relay"
    assert registration["check_fn"] is adapter_module.check_requirements
    assert registration["validate_config"] is adapter_module.validate_config
    assert registration["is_connected"] is adapter_module.is_connected
    assert registration["allowed_users_env"] == "LIVIS_ALLOWED_USERS"
    assert registration["allow_all_env"] == "LIVIS_ALLOW_ALL_USERS"
    assert registration["max_message_length"] == 0
    assert registration["allow_update_command"] is False
    assert registration["pii_safe"] is True
    assert set(registration["required_env"]) == {
        "LIVIS_RELAY_SOCKET",
        "LIVIS_RELAY_TOKEN",
        "LIVIS_ALLOWED_USERS",
        "LIVIS_PHASE1_READ_ONLY_ACK",
    }
    assert "final-only" in registration["platform_hint"]
    assert "read-only" in registration["platform_hint"]

    produced = registration["adapter_factory"](config)
    assert isinstance(produced, adapter_module.LivisBridgeAdapter)
    assert produced.platform.value == "livis"
    assert produced.SUPPORTS_MESSAGE_EDITING is False
    assert produced.supports_async_delivery is False
    assert produced.gateway_runner is None


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("LIVIS_RELAY_SOCKET", "relative/connector.sock"),
        ("LIVIS_RELAY_TOKEN", "short"),
        ("LIVIS_RELAY_TOKEN", " " * 32),
        ("LIVIS_ALLOWED_USERS", ""),
        ("LIVIS_ALLOWED_USERS", "*"),
        ("LIVIS_ALLOW_ALL_USERS", "true"),
        ("LIVIS_PHASE1_READ_ONLY_ACK", "false"),
    ],
)
def test_secure_requirements_fail_closed(
    adapter_module,
    secure_environment,
    monkeypatch,
    name,
    value,
):
    monkeypatch.setenv(name, value)
    assert adapter_module.check_requirements() is False


def test_secure_requirements_and_validation_accept_explicit_safe_config(
    adapter_module,
    secure_environment,
    config,
):
    assert adapter_module.check_requirements() is True
    assert adapter_module.validate_config(config) is True
    assert adapter_module.is_connected(config) is True
    assert adapter_module._env_enablement() == {
        "socket_path": secure_environment["LIVIS_RELAY_SOCKET"],
        "phase1_read_only": True,
    }


def test_env_enablement_restores_persisted_livis_home_channel(
    adapter_module,
    secure_environment,
    monkeypatch,
):
    monkeypatch.setenv("LIVIS_HOME_CHANNEL", "livis:trusted-node-1")
    monkeypatch.setenv("LIVIS_HOME_CHANNEL_THREAD_ID", "thread-1")

    assert adapter_module._env_enablement() == {
        "socket_path": secure_environment["LIVIS_RELAY_SOCKET"],
        "phase1_read_only": True,
        "home_channel": {
            "chat_id": "livis:trusted-node-1",
            "name": "LiViS",
            "thread_id": "thread-1",
        },
    }


@pytest.mark.asyncio
async def test_connect_accepts_hermes_018_reconnect_lifecycle_flag(
    adapter_module,
    secure_environment,
    config,
):
    adapter = make_adapter(adapter_module, config)

    async def ready_listener():
        adapter._ready_event.set()
        await asyncio.Event().wait()

    adapter._listener_loop = ready_listener

    assert await adapter.connect(is_reconnect=True) is True
    assert adapter.connected is True

    await adapter.disconnect()

    assert adapter.connected is False
    assert not adapter._ready_event.is_set()


@pytest.mark.asyncio
async def test_disconnect_closes_each_socket_before_reconnect(
    adapter_module,
    secure_environment,
    config,
    monkeypatch,
):
    sentinel = object()

    class LoopWebSocket:
        def __init__(self):
            self.incoming = asyncio.Queue()
            self.sent = []
            self.closed = False

        def feed(self, message):
            self.incoming.put_nowait(adapter_module.json.dumps(message))

        def __aiter__(self):
            return self

        async def __anext__(self):
            message = await self.incoming.get()
            if message is sentinel:
                raise StopAsyncIteration
            return message

        async def send(self, encoded):
            message = adapter_module.json.loads(encoded)
            self.sent.append(message)
            if message.get("type") == "draining":
                self.feed({"type": "draining_ack"})

        async def close(self):
            if not self.closed:
                self.closed = True
                self.incoming.put_nowait(sentinel)

    first = LoopWebSocket()
    second = LoopWebSocket()
    for websocket in (first, second):
        websocket.feed({
            "type": "hello_ack",
            "protocolVersion": 2,
            "resultStoreTimeoutMs": 5000,
            "capabilities": {"prestartFailure": True, "draining": True},
        })
    connect = AsyncMock(side_effect=[first, second])
    monkeypatch.setattr(adapter_module, "_unix_connect", connect)
    adapter = make_adapter(adapter_module, config)

    assert await adapter.connect() is True
    assert adapter._ws is first
    await adapter.disconnect()

    assert first.closed is True
    assert adapter._ws is None

    assert await adapter.connect(is_reconnect=True) is True
    assert adapter._ws is second
    await adapter.disconnect()

    assert second.closed is True
    assert adapter._ws is None
    assert connect.await_count == 2


@pytest.mark.asyncio
async def test_disconnect_drain_budget_includes_waiting_for_send_lock(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    adapter._drain_timeout = 0.01
    writer_started = asyncio.Event()
    block_writer = asyncio.Event()

    async def blocked_send(_encoded):
        writer_started.set()
        await block_writer.wait()

    fake_ws.send = blocked_send
    writer = asyncio.create_task(adapter._send_local({"type": "accepted"}))
    await asyncio.wait_for(writer_started.wait(), timeout=1)
    assert adapter._send_lock.locked()

    try:
        await asyncio.wait_for(adapter.disconnect(), timeout=0.25)
    finally:
        writer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await writer

    assert fake_ws.closed is True
    assert adapter._ws is None
    assert adapter._draining is False


@pytest.mark.asyncio
async def test_disconnect_closes_dispatch_gate_before_replaying_deferred_proof(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    source = adapter.build_source(
        chat_id="livis:trusted-node-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-drain",
    )
    deferred = adapter_module.DeferredJob(
        job_id="job-drain",
        lease_id="lease-drain",
        chat_id="livis:trusted-node-1",
        message_id="message-drain",
        source=source,
        event=adapter_module.MessageEvent(
            text="next request",
            source=source,
            message_id="job-drain",
        ),
        session_key="agent:main:livis:dm:livis:trusted-node-1",
    )
    adapter._deferred_jobs[deferred.job_id] = deferred
    adapter._ready_event.set()

    disconnect = asyncio.create_task(adapter.disconnect())
    await wait_for_sent_count(fake_ws, 1)
    assert fake_ws.sent == [{"type": "draining"}]

    assert fake_ws.closed is False
    assert adapter._prestart_rejections == {
        "job-drain": (
            "lease-drain",
            "adapter disconnected before Hermes dispatch",
        )
    }

    await adapter._handle_daemon_message({
        "type": "draining_ack",
    })
    await wait_for_sent_count(fake_ws, 2)

    assert fake_ws.closed is False
    assert fake_ws.sent == [
        {"type": "draining"},
        {
            "type": "failed",
            "jobId": "job-drain",
            "leaseId": "lease-drain",
            "error": "adapter disconnected before Hermes dispatch",
            "retryable": False,
            "notStarted": True,
        },
    ]
    assert "job-drain" in adapter._prestart_rejections

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-drain",
        "leaseId": "lease-drain",
    })
    await disconnect

    assert fake_ws.closed is True
    assert adapter._prestart_rejections == {}


@pytest.mark.asyncio
async def test_drain_rejects_job_already_in_flight_before_ack_without_dispatch(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    adapter._ready_event.set()

    disconnect = asyncio.create_task(adapter.disconnect())
    await wait_for_sent_count(fake_ws, 1)
    assert fake_ws.sent == [{"type": "draining"}]

    await adapter._handle_daemon_message({
        "type": "job",
        "job": {
            "jobId": "job-in-flight-drain",
            "leaseId": "lease-in-flight-drain",
            "chatId": "livis:trusted-node-1",
            "text": "must not dispatch",
            "user": {
                "id": "trusted-node-1",
                "displayName": "Tester",
                "trusted": True,
            },
            "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
        },
    })

    adapter.handle_message.assert_not_awaited()
    assert fake_ws.sent == [{"type": "draining"}]
    assert adapter._prestart_rejections["job-in-flight-drain"][0] == (
        "lease-in-flight-drain"
    )

    await adapter._handle_daemon_message({"type": "draining_ack"})
    await wait_for_sent_count(fake_ws, 2)

    proof = fake_ws.sent[1]
    assert proof == {
        "type": "failed",
        "jobId": "job-in-flight-drain",
        "leaseId": "lease-in-flight-drain",
        "error": adapter._prestart_rejections["job-in-flight-drain"][1],
        "retryable": False,
        "notStarted": True,
    }
    assert fake_ws.closed is False

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-in-flight-drain",
        "leaseId": "lease-in-flight-drain",
    })
    await disconnect

    assert fake_ws.closed is True
    assert adapter._prestart_rejections == {}


@pytest.mark.asyncio
async def test_drain_wins_while_accepted_send_is_blocked_before_dispatch(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    adapter._ready_event.set()
    accepted_send_started = asyncio.Event()
    release_accepted_send = asyncio.Event()
    original_send = fake_ws.send

    async def block_accepted(encoded):
        message = adapter_module.json.loads(encoded)
        if message.get("type") == "accepted":
            accepted_send_started.set()
            await release_accepted_send.wait()
        await original_send(encoded)

    fake_ws.send = block_accepted
    source = adapter.build_source(
        chat_id="livis:trusted-node-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-accepted-drain",
    )
    job = adapter_module.DeferredJob(
        job_id="job-accepted-drain",
        lease_id="lease-accepted-drain",
        chat_id="livis:trusted-node-1",
        message_id="job-accepted-drain",
        source=source,
        event=adapter_module.MessageEvent(
            text="must not dispatch",
            source=source,
            message_id="job-accepted-drain",
        ),
        session_key="agent:main:livis:dm:livis:trusted-node-1",
    )

    dispatch = asyncio.create_task(
        adapter._dispatch_job(job, from_deferred_queue=False)
    )
    await asyncio.wait_for(accepted_send_started.wait(), timeout=1)
    disconnect = asyncio.create_task(adapter.disconnect())
    await asyncio.sleep(0)
    assert adapter._draining is True

    release_accepted_send.set()
    await dispatch
    await wait_for_sent_count(fake_ws, 2)

    adapter.handle_message.assert_not_awaited()
    assert [message["type"] for message in fake_ws.sent] == [
        "accepted",
        "draining",
    ]
    assert adapter._prestart_rejections["job-accepted-drain"][0] == (
        "lease-accepted-drain"
    )
    assert fake_ws.closed is False

    await adapter._handle_daemon_message({"type": "draining_ack"})
    await wait_for_sent_count(fake_ws, 3)
    proof = fake_ws.sent[2]
    assert proof == {
        "type": "failed",
        "jobId": "job-accepted-drain",
        "leaseId": "lease-accepted-drain",
        "error": adapter._prestart_rejections["job-accepted-drain"][1],
        "retryable": False,
        "notStarted": True,
    }

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-accepted-drain",
        "leaseId": "lease-accepted-drain",
    })
    await disconnect

    assert fake_ws.closed is True
    assert adapter._prestart_rejections == {}


@pytest.mark.asyncio
async def test_handle_message_exception_is_settled_as_not_started(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    adapter.handle_message = AsyncMock(side_effect=RuntimeError("topic recovery failed"))
    source = adapter.build_source(
        chat_id="livis:trusted-node-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-dispatch-error",
    )
    job = adapter_module.DeferredJob(
        job_id="job-dispatch-error",
        lease_id="lease-dispatch-error",
        chat_id="livis:trusted-node-1",
        message_id="message-dispatch-error",
        source=source,
        event=adapter_module.MessageEvent(
            text="plain request",
            source=source,
            message_id="job-dispatch-error",
        ),
        session_key="agent:main:livis:dm:livis:trusted-node-1",
    )

    await adapter._dispatch_job(job)

    assert fake_ws.sent == [
        {
            "type": "accepted",
            "jobId": "job-dispatch-error",
            "leaseId": "lease-dispatch-error",
        },
        {
            "type": "failed",
            "jobId": "job-dispatch-error",
            "leaseId": "lease-dispatch-error",
            "error": "Hermes dispatch never started: topic recovery failed",
            "retryable": False,
            "notStarted": True,
        },
    ]
    assert adapter._job_by_message_id == {}
    assert adapter._lease_by_job == {}
    assert adapter._prestart_rejections == {
        "job-dispatch-error": (
            "lease-dispatch-error",
            "Hermes dispatch never started: topic recovery failed",
        )
    }


@pytest.mark.asyncio
async def test_deferred_cancel_then_registration_error_uses_not_started_proof(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    registration_started = asyncio.Event()
    finish_registration = asyncio.Event()

    async def fail_registration(_event):
        registration_started.set()
        await finish_registration.wait()
        raise RuntimeError("topic recovery failed")

    adapter.handle_message = AsyncMock(side_effect=fail_registration)
    source = adapter.build_source(
        chat_id="livis:trusted-node-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-cancelled-registration",
    )
    deferred = adapter_module.DeferredJob(
        job_id="job-cancelled-registration",
        lease_id="lease-cancelled-registration",
        chat_id="livis:trusted-node-1",
        message_id="message-cancelled-registration",
        source=source,
        event=adapter_module.MessageEvent(
            text="next request",
            source=source,
            message_id="job-cancelled-registration",
        ),
        session_key="agent:main:livis:dm:livis:trusted-node-1",
    )
    adapter._deferred_jobs[deferred.job_id] = deferred
    dispatch = asyncio.create_task(
        adapter._dispatch_job(deferred, from_deferred_queue=True)
    )
    await registration_started.wait()
    assert deferred.state == "dispatching"

    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": deferred.job_id,
        "leaseId": deferred.lease_id,
    })
    finish_registration.set()
    await dispatch

    assert adapter.handle_message.await_count == 1
    assert [message["type"] for message in fake_ws.sent] == [
        "accepted",
        "failed",
    ]
    assert fake_ws.sent[1] == {
        "type": "failed",
        "jobId": deferred.job_id,
        "leaseId": deferred.lease_id,
        "error": adapter_module.REMOTE_DEFERRED_CANCELLED_ERROR,
        "retryable": False,
        "notStarted": True,
    }
    assert adapter._job_by_message_id == {}
    assert adapter._lease_by_job == {}
    assert adapter._prestart_rejections == {
        deferred.job_id: (
            deferred.lease_id,
            adapter_module.REMOTE_DEFERRED_CANCELLED_ERROR,
        )
    }


@pytest.mark.asyncio
async def test_hello_reports_actual_hermes_runtime_version(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    monkeypatch,
):
    source_runtime = SimpleNamespace(__version__="0.18.2")
    monkeypatch.setitem(sys.modules, "hermes_cli", source_runtime)
    metadata_version = Mock(side_effect=AssertionError("metadata fallback must not run"))
    monkeypatch.setattr(adapter_module.importlib.metadata, "version", metadata_version)
    adapter = make_adapter(adapter_module, config, fake_ws)

    await adapter._handle_daemon_message({"type": "hello_required", "protocolVersion": 2})

    metadata_version.assert_not_called()
    assert fake_ws.sent == [
        {
            "type": "hello",
            "protocolVersion": adapter_module.CONNECTOR_PROTOCOL_VERSION,
            "connectorId": adapter.connector_id,
            "backend": "hermes",
            "implementation": {
                "name": "livis-hermes-bridge",
                "version": adapter_module.PLUGIN_VERSION,
                "runtimeVersion": "0.18.2",
            },
            "capabilities": {
                "cancel": True,
                "finalResult": True,
                "prestartFailure": True,
                "draining": True,
                "cancelSemantics": "best_effort",
                "streaming": False,
                "approvals": False,
                "attachmentsIn": False,
                "attachmentsOut": False,
            },
        }
    ]


@pytest.mark.asyncio
async def test_old_daemon_protocol_is_rejected_before_connector_hello(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)

    with pytest.raises(ValueError, match="connector protocol mismatch"):
        await adapter._handle_daemon_message({
            "type": "hello_required",
            "protocolVersion": 1,
        })

    assert fake_ws.sent == []
    assert not adapter._ready_event.is_set()


def test_hermes_version_falls_back_to_distribution_metadata(
    adapter_module,
    monkeypatch,
):
    monkeypatch.delitem(sys.modules, "hermes_cli", raising=False)
    metadata_version = Mock(return_value="0.18.2")
    monkeypatch.setattr(adapter_module.importlib.metadata, "version", metadata_version)

    assert adapter_module._hermes_version() == "0.18.2"
    metadata_version.assert_called_once_with("hermes-agent")


@pytest.mark.asyncio
async def test_job_preserves_message_job_and_lease_correlation(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    job = {
        "jobId": "job-1",
        "leaseId": "lease-1",
        "messageId": "wire-message-1",
        "chatId": "livis:trusted-node-1",
        "text": "status",
        "timestamp": 1_700_000_000_000,
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    await adapter._handle_job(job)

    assert fake_ws.sent == [
        {"type": "accepted", "jobId": "job-1", "leaseId": "lease-1"}
    ]
    assert adapter._job_by_message_id == {
        "job-1": "job-1",
        "wire-message-1": "job-1",
    }
    assert adapter._active_job_by_chat == {"livis:trusted-node-1": "job-1"}
    assert adapter._lease_by_job == {"job-1": "lease-1"}

    event = adapter.handle_message.await_args.args[0]
    assert event.message_id == "job-1"
    assert event.source.message_id == "job-1"
    assert event.source.user_id == "trusted-node-1"
    assert event.raw_message is job

    adapter._persist_result = AsyncMock()
    result = await adapter.send(
        "livis:trusted-node-1",
        "done",
        reply_to="wire-message-1",
    )
    assert result.success is True
    adapter._persist_result.assert_awaited_once_with("job-1", "lease-1", "done")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "remote_text",
    [
        "/restart",
        "/yolo",
        "/approve always",
        "/debug",
        "/new",
        "/reset",
        "/sethome unexpected",
        "/model another-model --global",
        "/memory approval off",
        "/skills approval off",
        "/reload-mcp",
        "restart gateway",
        "Please restart the Hermes gateway!",
        "restart Hermes.",
    ],
)
async def test_remote_hermes_commands_fail_before_dispatch(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    remote_text,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    job = {
        "jobId": "job-command",
        "leaseId": "lease-command",
        "chatId": "livis:trusted-node-1",
        "text": remote_text,
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    await adapter._handle_job(job)

    adapter.handle_message.assert_not_awaited()
    assert fake_ws.sent == [
        {
            "type": "failed",
            "jobId": "job-command",
            "leaseId": "lease-command",
            "error": "LiViS phase 1 rejects remote Hermes commands",
            "retryable": False,
            "notStarted": True,
        },
    ]
    assert adapter._job_by_message_id == {}
    assert adapter._active_job_by_chat == {}
    assert adapter._lease_by_job == {}
    assert adapter._source_by_job == {}
    assert adapter._prestart_rejections == {
        "job-command": (
            "lease-command",
            "LiViS phase 1 rejects remote Hermes commands",
        )
    }

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-command",
        "leaseId": "lease-command",
    })
    assert adapter._prestart_rejections == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply",
    ["yes", "always", "approve session", "normal reply", "/sethome"],
)
async def test_remote_approval_wait_rejects_all_plain_replies(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    monkeypatch,
    reply,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    adapter.gateway_runner = SimpleNamespace(
        _session_key_for_source=lambda _source: "agent:main:livis:dm:chat"
    )
    approval = sys.modules["tools.approval"]
    monkeypatch.setattr(approval, "has_blocking_approval", Mock(return_value=True))
    job = {
        "jobId": "job-approval",
        "leaseId": "lease-approval",
        "chatId": "livis:trusted-node-1",
        "text": reply,
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    await adapter._handle_job(job)

    adapter.handle_message.assert_not_awaited()
    approval.has_blocking_approval.assert_called_once_with(
        "agent:main:livis:dm:chat"
    )
    assert fake_ws.sent == [
        {
            "type": "failed",
            "jobId": "job-approval",
            "leaseId": "lease-approval",
            "error": "LiViS phase 1 rejects remote Hermes approvals",
            "retryable": False,
            "notStarted": True,
        }
    ]


@pytest.mark.asyncio
async def test_active_hermes_session_rejects_followup_before_busy_dispatch(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    session_key = "agent:main:livis:dm:livis:trusted-node-1"
    owner = asyncio.create_task(asyncio.Event().wait())
    adapter._active_sessions[session_key] = object()
    adapter._session_tasks[session_key] = owner
    job = {
        "jobId": "job-followup",
        "leaseId": "lease-followup",
        "chatId": "livis:trusted-node-1",
        "text": "yes",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    try:
        await adapter._handle_job(job)
    finally:
        owner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await owner

    adapter.handle_message.assert_not_awaited()
    assert fake_ws.sent == [
        {
            "type": "failed",
            "jobId": "job-followup",
            "leaseId": "lease-followup",
            "error": "LiViS phase 1 rejects concurrent Hermes session input",
            "retryable": False,
            "notStarted": True,
        }
    ]


@pytest.mark.asyncio
async def test_stale_hermes_session_guard_is_healed_before_policy_check(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    session_key = "agent:main:livis:dm:livis:trusted-node-1"
    owner = asyncio.create_task(asyncio.sleep(0))
    await owner
    adapter._active_sessions[session_key] = object()
    adapter._session_tasks[session_key] = owner
    job = {
        "jobId": "job-after-stale-guard",
        "leaseId": "lease-after-stale-guard",
        "chatId": "livis:trusted-node-1",
        "text": "normal reply",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    await adapter._handle_job(job)

    adapter.handle_message.assert_awaited_once()
    assert session_key not in adapter._active_sessions
    assert fake_ws.sent == [{
        "type": "accepted",
        "jobId": "job-after-stale-guard",
        "leaseId": "lease-after-stale-guard",
    }]


@pytest.mark.asyncio
async def test_next_same_session_job_queues_while_final_owner_drains(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    chat_id = "livis:trusted-node-1"
    source = adapter.build_source(
        chat_id=chat_id,
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-first",
    )
    session_key = "agent:main:livis:dm:livis:trusted-node-1"
    release_owner = asyncio.Event()

    async def finish_owner():
        await release_owner.wait()
        adapter._active_sessions.pop(session_key, None)
        adapter._session_tasks.pop(session_key, None)

    owner = asyncio.create_task(finish_owner())
    adapter._active_sessions[session_key] = object()
    adapter._session_tasks[session_key] = owner
    adapter._job_by_message_id["job-first"] = "job-first"
    adapter._active_job_by_chat[chat_id] = "job-first"
    adapter._lease_by_job["job-first"] = "lease-first"
    adapter._source_by_job["job-first"] = source
    adapter._persist_result = AsyncMock()

    first = await adapter.send(chat_id, "first final", reply_to="job-first")
    assert first.success is True
    assert adapter._settling_job_by_session == {session_key: "job-first"}
    assert session_key in adapter._active_sessions

    adapter.handle_message = AsyncMock()
    await adapter._handle_job({
        "jobId": "job-second",
        "leaseId": "lease-second",
        "chatId": chat_id,
        "text": "next request",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    })

    deferred_task = adapter._deferred_jobs["job-second"].task
    assert deferred_task is not None
    # Let the bridge-owned deferred task actually run while the old owner is
    # still live. It must remain parked instead of entering Hermes' busy path.
    await asyncio.sleep(0)
    assert deferred_task.done() is False
    adapter.handle_message.assert_not_awaited()
    assert fake_ws.sent == []

    release_owner.set()
    await owner
    await deferred_task

    adapter.handle_message.assert_awaited_once()
    assert fake_ws.sent == [{
        "type": "accepted",
        "jobId": "job-second",
        "leaseId": "lease-second",
    }]
    await asyncio.sleep(0)
    assert session_key not in adapter._settling_job_by_session


@pytest.mark.asyncio
async def test_cancel_while_waiting_for_settling_owner_never_dispatches(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    session_key = "agent:main:livis:dm:livis:trusted-node-1"
    owner = asyncio.create_task(asyncio.Event().wait())
    adapter._active_sessions[session_key] = object()
    adapter._session_tasks[session_key] = owner
    adapter._settling_job_by_session[session_key] = "job-first"

    await adapter._handle_job({
        "jobId": "job-deferred",
        "leaseId": "lease-deferred",
        "chatId": "livis:trusted-node-1",
        "text": "next request",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    })
    deferred_task = adapter._deferred_jobs["job-deferred"].task
    assert deferred_task is not None

    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": "job-deferred",
        "leaseId": "lease-deferred",
    })
    with pytest.raises(asyncio.CancelledError):
        await deferred_task
    await asyncio.sleep(0)

    adapter.handle_message.assert_not_awaited()
    assert adapter._job_by_message_id == {}
    assert fake_ws.sent == [{
        "type": "failed",
        "jobId": "job-deferred",
        "leaseId": "lease-deferred",
        "error": adapter_module.REMOTE_DEFERRED_CANCELLED_ERROR,
        "retryable": False,
        "notStarted": True,
    }]

    owner.cancel()
    with pytest.raises(asyncio.CancelledError):
        await owner


@pytest.mark.asyncio
async def test_cancel_while_deferred_accepted_is_in_flight_stays_not_started(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    source = adapter.build_source(
        chat_id="livis:trusted-node-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-starting",
    )
    deferred = adapter_module.DeferredJob(
        job_id="job-starting",
        lease_id="lease-starting",
        chat_id="livis:trusted-node-1",
        message_id="message-starting",
        source=source,
        event=adapter_module.MessageEvent(
            text="next request",
            message_type=adapter_module.MessageType.TEXT,
            source=source,
            message_id="job-starting",
        ),
        session_key="agent:main:livis:dm:livis:trusted-node-1",
    )
    adapter._deferred_jobs[deferred.job_id] = deferred
    adapter.handle_message = AsyncMock()
    accepted_send_started = asyncio.Event()
    finish_accepted_send = asyncio.Event()
    original_send = fake_ws.send

    async def block_accepted(encoded):
        message = adapter_module.json.loads(encoded)
        if message.get("type") == "accepted":
            accepted_send_started.set()
            await finish_accepted_send.wait()
        await original_send(encoded)

    fake_ws.send = block_accepted
    dispatch = asyncio.create_task(
        adapter._dispatch_job(deferred, from_deferred_queue=True)
    )
    await accepted_send_started.wait()
    assert deferred.state == "starting"

    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": deferred.job_id,
        "leaseId": deferred.lease_id,
    })
    finish_accepted_send.set()
    await dispatch

    adapter.handle_message.assert_not_awaited()
    assert fake_ws.sent == [
        {"type": "accepted", "jobId": "job-starting", "leaseId": "lease-starting"},
        {
            "type": "failed",
            "jobId": "job-starting",
            "leaseId": "lease-starting",
            "error": adapter_module.REMOTE_DEFERRED_CANCELLED_ERROR,
            "retryable": False,
            "notStarted": True,
        },
    ]
    assert adapter._job_by_message_id == {}
    assert adapter._lease_by_job == {}


@pytest.mark.asyncio
async def test_cancel_after_deferred_registration_uses_active_stop_path(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    source = adapter.build_source(
        chat_id="livis:trusted-node-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-handoff",
    )
    event = adapter_module.MessageEvent(
        text="next request",
        message_type=adapter_module.MessageType.TEXT,
        source=source,
        message_id="job-handoff",
    )
    deferred = adapter_module.DeferredJob(
        job_id="job-handoff",
        lease_id="lease-handoff",
        chat_id="livis:trusted-node-1",
        message_id="message-handoff",
        source=source,
        event=event,
        session_key="agent:main:livis:dm:livis:trusted-node-1",
    )
    adapter._deferred_jobs[deferred.job_id] = deferred
    adapter.handle_message = AsyncMock()

    await adapter._dispatch_job(deferred, from_deferred_queue=True)

    assert deferred.state == "registered"
    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": deferred.job_id,
        "leaseId": deferred.lease_id,
    })

    assert [call.args[0].text for call in adapter.handle_message.await_args_list] == [
        "next request",
        "/stop",
    ]
    assert fake_ws.sent == [
        {"type": "accepted", "jobId": "job-handoff", "leaseId": "lease-handoff"},
        {"type": "cancelled", "jobId": "job-handoff", "leaseId": "lease-handoff"},
    ]
    assert "job-handoff" in adapter._cancelled_jobs


@pytest.mark.asyncio
async def test_disconnect_during_deferred_guard_registration_cancels_in_order(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    source = adapter.build_source(
        chat_id="livis:trusted-node-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-guard-race",
    )
    deferred = adapter_module.DeferredJob(
        job_id="job-guard-race",
        lease_id="lease-guard-race",
        chat_id="livis:trusted-node-1",
        message_id="message-guard-race",
        source=source,
        event=adapter_module.MessageEvent(
            text="next request",
            message_type=adapter_module.MessageType.TEXT,
            source=source,
            message_id="job-guard-race",
        ),
        session_key="agent:main:livis:dm:livis:trusted-node-1",
    )
    adapter._deferred_jobs[deferred.job_id] = deferred
    guard_registration_started = asyncio.Event()
    finish_guard_registration = asyncio.Event()

    async def handle(event):
        if event.text == "next request":
            guard_registration_started.set()
            await finish_guard_registration.wait()

    adapter.handle_message = AsyncMock(side_effect=handle)
    dispatch = asyncio.create_task(
        adapter._dispatch_job(deferred, from_deferred_queue=True)
    )
    await guard_registration_started.wait()

    assert adapter._cancel_deferred_before_dispatch("transport lost") == []
    await adapter._interrupt_all_active("transport lost")
    assert [call.args[0].text for call in adapter.handle_message.await_args_list] == [
        "next request"
    ]

    finish_guard_registration.set()
    await dispatch

    assert [call.args[0].text for call in adapter.handle_message.await_args_list] == [
        "next request",
        "/stop",
    ]
    assert fake_ws.sent == [
        {
            "type": "accepted",
            "jobId": "job-guard-race",
            "leaseId": "lease-guard-race",
        },
        {
            "type": "cancelled",
            "jobId": "job-guard-race",
            "leaseId": "lease-guard-race",
        },
    ]


@pytest.mark.asyncio
async def test_prestart_rejection_cancel_never_dispatches_stop(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    job = {
        "jobId": "job-command",
        "leaseId": "lease-command",
        "chatId": "livis:trusted-node-1",
        "text": "/restart",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    await adapter._handle_job(job)
    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": "job-command",
        "leaseId": "lease-command",
    })

    adapter.handle_message.assert_not_awaited()
    assert fake_ws.sent == [
        {
            "type": "failed",
            "jobId": "job-command",
            "leaseId": "lease-command",
            "error": "LiViS phase 1 rejects remote Hermes commands",
            "retryable": False,
            "notStarted": True,
        },
        {
            "type": "failed",
            "jobId": "job-command",
            "leaseId": "lease-command",
            "error": "LiViS phase 1 rejects remote Hermes commands",
            "retryable": False,
            "notStarted": True,
        },
    ]
    assert adapter._prestart_rejections["job-command"][0] == "lease-command"


@pytest.mark.asyncio
async def test_exact_sethome_bootstrap_is_the_only_remote_command_allowed(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    job = {
        "jobId": "job-sethome",
        "leaseId": "lease-sethome",
        "chatId": "livis:trusted-node-1",
        "text": "  /SeThOmE  ",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    await adapter._handle_job(job)

    event = adapter.handle_message.await_args.args[0]
    assert event.text == "/sethome"
    assert fake_ws.sent == [
        {"type": "accepted", "jobId": "job-sethome", "leaseId": "lease-sethome"}
    ]

    adapter._release_job_maps("job-sethome")
    second = dict(job, jobId="job-sethome-again", leaseId="lease-sethome-again")
    await adapter._handle_job(second)

    adapter.handle_message.assert_awaited_once()
    assert fake_ws.sent[-1] == {
        "type": "failed",
        "jobId": "job-sethome-again",
        "leaseId": "lease-sethome-again",
        "error": "LiViS phase 1 rejects remote Hermes commands",
        "retryable": False,
        "notStarted": True,
    }


@pytest.mark.asyncio
async def test_adjacent_job_then_cancel_is_dispatched_in_wire_order(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    job_registered = asyncio.Event()
    release_background = asyncio.Event()
    background_tasks = []

    async def process_in_background():
        await release_background.wait()

    async def handle(event):
        if event.text == "perform work":
            # Match Hermes 0.18.2: handle_message may yield for topic recovery,
            # then establishes the session guard, spawns processing, and returns.
            await asyncio.sleep(0)
            job_registered.set()
            background_tasks.append(asyncio.create_task(process_in_background()))
        elif event.text == "/stop":
            assert job_registered.is_set()

    adapter.handle_message = AsyncMock(side_effect=handle)
    job = {
        "jobId": "job-1",
        "leaseId": "lease-1",
        "messageId": "wire-message-1",
        "chatId": "livis:trusted-node-1",
        "text": "perform work",
        "timestamp": 1_700_000_000_000,
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    await adapter._handle_daemon_message({"type": "job", "job": job})
    assert job_registered.is_set()
    await adapter._handle_daemon_message({
        "type": "cancel",
        "jobId": "job-1",
        "leaseId": "lease-1",
    })

    assert [call.args[0].text for call in adapter.handle_message.await_args_list] == [
        "perform work",
        "/stop",
    ]
    assert fake_ws.sent == [
        {"type": "accepted", "jobId": "job-1", "leaseId": "lease-1"},
        {"type": "cancelled", "jobId": "job-1", "leaseId": "lease-1"},
    ]
    assert "job-1" in adapter._cancelled_jobs
    assert release_background.is_set() is False

    release_background.set()
    await asyncio.gather(*background_tasks)


@pytest.mark.asyncio
async def test_hermes_background_result_does_not_block_result_ack_reader(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    background_tasks = []

    async def deliver_result():
        await adapter._persist_result("job-1", "lease-1", "background result")

    async def handle(_event):
        # Match Hermes 0.18.2: the public dispatch coroutine returns after it
        # registers a background task, so the socket reader remains available
        # to consume the durable-storage ACK that task needs.
        background_tasks.append(asyncio.create_task(deliver_result()))

    adapter.handle_message = AsyncMock(side_effect=handle)
    job = {
        "jobId": "job-1",
        "leaseId": "lease-1",
        "chatId": "livis:trusted-node-1",
        "text": "perform work",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    await adapter._handle_daemon_message({"type": "job", "job": job})
    for _ in range(10):
        if "job-1" in adapter._result_waiters:
            break
        await asyncio.sleep(0)

    assert "job-1" in adapter._result_waiters
    assert fake_ws.sent == [
        {"type": "accepted", "jobId": "job-1", "leaseId": "lease-1"},
        {
            "type": "result",
            "jobId": "job-1",
            "leaseId": "lease-1",
            "text": "background result",
        },
    ]

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-1",
        "leaseId": "lease-1",
    })
    assert len(background_tasks) == 1
    await asyncio.wait_for(asyncio.gather(*background_tasks), timeout=0.5)

    adapter.handle_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_cancel_signal_is_once_when_processing_hook_runs_during_stop(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    source = SimpleNamespace(chat_id="chat-1", user_id="trusted-node-1")
    adapter._job_by_message_id["job-1"] = "job-1"
    adapter._active_job_by_chat["chat-1"] = "job-1"
    adapter._lease_by_job["job-1"] = "lease-1"
    adapter._source_by_job["job-1"] = source
    adapter._final_by_job["job-1"] = "in-flight final"
    original_event = adapter_module.MessageEvent(
        text="perform work",
        source=source,
        message_id="job-1",
    )

    async def handle(event):
        assert event.text == "/stop"
        # Hermes cancels the old background task while /stop is in flight. Its
        # completion hook therefore races the explicit cancel acknowledgement.
        await adapter.on_processing_complete(
            original_event,
            adapter_module.ProcessingOutcome.CANCELLED,
        )

    adapter.handle_message = AsyncMock(side_effect=handle)
    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": "job-1",
        "leaseId": "lease-1",
    })

    assert fake_ws.sent == [
        {"type": "cancelled", "jobId": "job-1", "leaseId": "lease-1"}
    ]
    assert adapter._job_by_message_id == {}
    assert adapter._active_job_by_chat == {}
    assert adapter._lease_by_job == {}
    assert adapter._source_by_job == {}
    assert adapter._cancelled_notifications == set()


@pytest.mark.asyncio
async def test_transport_drop_retries_cancel_interrupted_during_stop_dispatch(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    source = SimpleNamespace(chat_id="chat-1", user_id="trusted-node-1")
    adapter._lease_by_job["job-1"] = "lease-1"
    adapter._source_by_job["job-1"] = source
    adapter._active_job_by_chat["chat-1"] = "job-1"
    first_stop_started = asyncio.Event()
    keep_first_stop_running = asyncio.Event()
    stop_calls = 0

    async def handle(event):
        nonlocal stop_calls
        if event.text == "/stop":
            stop_calls += 1
            if stop_calls == 1:
                first_stop_started.set()
                await keep_first_stop_running.wait()

    adapter.handle_message = AsyncMock(side_effect=handle)
    cancel_task = asyncio.create_task(adapter._handle_cancel({
        "type": "cancel",
        "jobId": "job-1",
        "leaseId": "lease-1",
    }))
    await first_stop_started.wait()

    cancel_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancel_task
    interrupted_cancels = adapter._take_interrupted_cancel_jobs()
    await adapter._interrupt_all_active(
        "relay IPC disconnected",
        force_job_ids=interrupted_cancels,
    )

    assert interrupted_cancels == {"job-1"}
    assert [call.args[0].text for call in adapter.handle_message.await_args_list] == [
        "/stop",
        "/stop",
    ]
    assert "job-1" in adapter._cancelled_jobs
    assert fake_ws.sent == []


@pytest.mark.asyncio
async def test_result_ack_must_match_execution_lease(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()

    persist = asyncio.create_task(adapter._persist_result("job-1", "lease-1", "done"))
    await asyncio.sleep(0)
    await adapter._handle_daemon_message(
        {"type": "result_stored", "jobId": "job-1", "leaseId": "stale-lease"}
    )

    with pytest.raises(
        adapter_module.LocalRelayUnavailable,
        match="acknowledged a different execution lease",
    ):
        await persist
    assert fake_ws.sent == [
        {"type": "result", "jobId": "job-1", "leaseId": "lease-1", "text": "done"}
    ]


@pytest.mark.asyncio
async def test_same_final_is_idempotent_but_distinct_final_is_rejected(
    adapter_module,
    secure_environment,
    config,
):
    adapter = make_adapter(adapter_module, config)
    adapter._job_by_message_id["message-1"] = "job-1"
    adapter._lease_by_job["job-1"] = "lease-1"
    adapter._persist_result = AsyncMock()

    first = await adapter.send("chat-1", "same", reply_to="message-1")
    duplicate = await adapter.send("chat-1", "same", reply_to="message-1")
    conflict = await adapter.send("chat-1", "different", reply_to="message-1")

    assert first.success is True
    assert duplicate.success is True
    assert conflict.success is False
    assert conflict.retryable is False
    assert "exactly one distinct final" in conflict.error
    assert adapter._persist_result.await_count == 2
    assert adapter._persist_result.await_args_list[0].args == ("job-1", "lease-1", "same")
    assert adapter._persist_result.await_args_list[1].args == ("job-1", "lease-1", "same")


@pytest.mark.asyncio
async def test_unacknowledged_final_attempt_reports_terminal_failure_on_completion(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    source = adapter.build_source(
        chat_id="chat-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-output-rejected",
    )
    adapter._job_by_message_id["job-output-rejected"] = "job-output-rejected"
    adapter._active_job_by_chat["chat-1"] = "job-output-rejected"
    adapter._lease_by_job["job-output-rejected"] = "lease-output-rejected"
    adapter._source_by_job["job-output-rejected"] = source
    send_task = asyncio.create_task(adapter.send(
        "chat-1", "oversized result", reply_to="job-output-rejected"
    ))
    await asyncio.sleep(0)
    await adapter._handle_daemon_message({
        "type": "error",
        "code": "output_too_large",
        "jobId": "job-output-rejected",
        "message": "daemon rejected output",
    })
    result = await send_task

    assert result.success is False
    assert "job-output-rejected" not in adapter._stored_final_jobs
    assert adapter._final_by_job == {"job-output-rejected": "oversized result"}

    completion = asyncio.create_task(adapter.on_processing_complete(
        adapter_module.MessageEvent(
            text="perform work",
            source=source,
            message_id="job-output-rejected",
        ),
        adapter_module.ProcessingOutcome.FAILURE,
    ))
    await asyncio.sleep(0)
    assert adapter._lease_by_job == {
        "job-output-rejected": "lease-output-rejected"
    }
    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-output-rejected",
        "leaseId": "lease-output-rejected",
    })
    await completion

    assert fake_ws.sent == [
        {
            "type": "result",
            "jobId": "job-output-rejected",
            "leaseId": "lease-output-rejected",
            "text": "oversized result",
        },
        {
            "type": "failed",
            "jobId": "job-output-rejected",
            "leaseId": "lease-output-rejected",
            "error": "Hermes processing ended with failure",
            "retryable": False,
        },
    ]
    assert adapter._job_by_message_id == {}
    assert adapter._lease_by_job == {}
    assert adapter._stored_final_jobs == set()


@pytest.mark.asyncio
async def test_hello_ack_applies_daemon_result_store_timeout(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    assert adapter._result_store_timeout == adapter_module.DEFAULT_RESULT_STORE_TIMEOUT_SECONDS

    await adapter._handle_daemon_message({
        "type": "hello_ack",
        "protocolVersion": 2,
        "connectorId": adapter.connector_id,
        "daemonVersion": "test",
        "resultStoreTimeoutMs": 2500,
        "capabilities": {"prestartFailure": True, "draining": True},
    })

    assert adapter._ready_event.is_set()
    assert adapter._result_store_timeout == 2.5


@pytest.mark.asyncio
async def test_hello_ack_without_timeout_keeps_default(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)

    await adapter._handle_daemon_message({
        "type": "hello_ack",
        "protocolVersion": 2,
        "connectorId": adapter.connector_id,
        "daemonVersion": "test",
        "capabilities": {"prestartFailure": True, "draining": True},
    })

    assert adapter._result_store_timeout == adapter_module.DEFAULT_RESULT_STORE_TIMEOUT_SECONDS


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "capabilities",
    [
        {"draining": True},
        {"prestartFailure": True},
        {},
    ],
)
async def test_hello_ack_without_required_settlement_capabilities_fails_closed(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    capabilities,
):
    adapter = make_adapter(adapter_module, config, fake_ws)

    with pytest.raises(ValueError, match="pre-start failure/draining settlement"):
        await adapter._handle_daemon_message({
            "type": "hello_ack",
            "protocolVersion": 2,
            "connectorId": adapter.connector_id,
            "daemonVersion": "old-daemon",
            "resultStoreTimeoutMs": 2500,
            "capabilities": capabilities,
        })

    assert not adapter._ready_event.is_set()
    assert adapter._result_store_timeout == adapter_module.DEFAULT_RESULT_STORE_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_prestart_proof_survives_disconnect_and_replays_before_ready(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._prestart_rejections["job-rejected"] = (
        "lease-rejected",
        adapter_module.REMOTE_COMMAND_REJECTED_ERROR,
    )

    await adapter.disconnect()

    assert adapter._prestart_rejections == {
        "job-rejected": (
            "lease-rejected",
            adapter_module.REMOTE_COMMAND_REJECTED_ERROR,
        )
    }
    fake_ws.sent.clear()
    adapter._ws = fake_ws
    await adapter._handle_daemon_message({
        "type": "hello_ack",
        "protocolVersion": 2,
        "connectorId": adapter.connector_id,
        "daemonVersion": "current",
        "capabilities": {"prestartFailure": True, "draining": True},
    })

    assert adapter._ready_event.is_set()
    assert fake_ws.sent == [{
        "type": "failed",
        "jobId": "job-rejected",
        "leaseId": "lease-rejected",
        "error": adapter_module.REMOTE_COMMAND_REJECTED_ERROR,
        "retryable": False,
        "notStarted": True,
    }]

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-rejected",
        "leaseId": "lease-rejected",
    })
    assert adapter._prestart_rejections == {}


@pytest.mark.asyncio
async def test_failed_initial_prestart_send_keeps_proof_for_reconnect(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    original_send = fake_ws.send
    fake_ws.send = AsyncMock(
        side_effect=adapter_module.LocalRelayUnavailable("simulated UDS loss")
    )
    job = {
        "jobId": "job-send-loss",
        "leaseId": "lease-send-loss",
        "chatId": "livis:trusted-node-1",
        "text": "/restart",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    with pytest.raises(
        adapter_module.LocalRelayUnavailable,
        match="simulated UDS loss",
    ):
        await adapter._handle_job(job)

    assert adapter._prestart_rejections == {
        "job-send-loss": (
            "lease-send-loss",
            adapter_module.REMOTE_COMMAND_REJECTED_ERROR,
        )
    }
    fake_ws.send = original_send
    await adapter._handle_daemon_message({
        "type": "hello_ack",
        "protocolVersion": 2,
        "connectorId": adapter.connector_id,
        "daemonVersion": "current",
        "capabilities": {"prestartFailure": True, "draining": True},
    })

    assert fake_ws.sent == [{
        "type": "failed",
        "jobId": "job-send-loss",
        "leaseId": "lease-send-loss",
        "error": adapter_module.REMOTE_COMMAND_REJECTED_ERROR,
        "retryable": False,
        "notStarted": True,
    }]


@pytest.mark.asyncio
async def test_failed_accepted_send_keeps_nonexecution_proof_for_reconnect(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    original_send = fake_ws.send
    fake_ws.send = AsyncMock(
        side_effect=adapter_module.LocalRelayUnavailable("simulated accepted loss")
    )
    job = {
        "jobId": "job-accepted-loss",
        "leaseId": "lease-accepted-loss",
        "chatId": "livis:trusted-node-1",
        "text": "normal request",
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }

    with pytest.raises(
        adapter_module.LocalRelayUnavailable,
        match="simulated accepted loss",
    ):
        await adapter._handle_job(job)

    adapter.handle_message.assert_not_awaited()
    assert adapter._job_by_message_id == {}
    assert adapter._active_job_by_chat == {}
    assert adapter._lease_by_job == {}
    assert adapter._source_by_job == {}
    assert adapter._prestart_rejections == {
        "job-accepted-loss": (
            "lease-accepted-loss",
            "Hermes dispatch never started: simulated accepted loss",
        )
    }

    fake_ws.send = original_send
    await adapter._handle_daemon_message({
        "type": "hello_ack",
        "protocolVersion": 2,
        "connectorId": adapter.connector_id,
        "daemonVersion": "current",
        "capabilities": {"prestartFailure": True, "draining": True},
    })

    assert fake_ws.sent == [{
        "type": "failed",
        "jobId": "job-accepted-loss",
        "leaseId": "lease-accepted-loss",
        "error": "Hermes dispatch never started: simulated accepted loss",
        "retryable": False,
        "notStarted": True,
    }]


@pytest.mark.asyncio
async def test_cancel_superseded_resolves_send_as_cancelled(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    source = adapter.build_source(
        chat_id="chat-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-1",
    )
    adapter._job_by_message_id["message-1"] = "job-1"
    adapter._job_by_message_id["job-1"] = "job-1"
    adapter._lease_by_job["job-1"] = "lease-1"
    adapter._active_job_by_chat["chat-1"] = "job-1"
    adapter._source_by_job["job-1"] = source

    send_task = asyncio.create_task(adapter.send("chat-1", "final", reply_to="message-1"))
    await asyncio.sleep(0)
    await adapter._handle_daemon_message({
        "type": "error",
        "code": "cancel_superseded",
        "jobId": "job-1",
        "message": "cancel won the race",
    })
    result = await send_task

    assert result.success is True
    assert result.message_id == "cancelled:job-1"
    assert "job-1" in adapter._cancelled_jobs

    await adapter.on_processing_complete(
        adapter_module.MessageEvent(
            text="perform work",
            source=source,
            message_id="job-1",
        ),
        adapter_module.ProcessingOutcome.SUCCESS,
    )
    assert fake_ws.sent == [
        {"type": "result", "jobId": "job-1", "leaseId": "lease-1", "text": "final"},
        {"type": "cancelled", "jobId": "job-1", "leaseId": "lease-1"}
    ]
    assert adapter._lease_by_job == {}


@pytest.mark.asyncio
async def test_cancel_dispatches_stop_and_emits_cancelunknown_connector_signal(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    source = SimpleNamespace(chat_id="chat-1", user_id="trusted-node-1")
    adapter._lease_by_job["job-1"] = "lease-1"
    adapter._source_by_job["job-1"] = source
    adapter._active_job_by_chat["chat-1"] = "job-1"
    adapter.handle_message = AsyncMock()

    await adapter._handle_cancel({"type": "cancel", "jobId": "job-1", "leaseId": "lease-1"})

    event = adapter.handle_message.await_args.args[0]
    assert event.text == "/stop"
    assert event.message_type is adapter_module.MessageType.COMMAND
    assert event.source is source
    assert event.message_id == "cancel:job-1"
    # The daemon intentionally maps this best-effort acknowledgement to
    # CancelUnknown and quarantines the session.
    assert fake_ws.sent == [
        {"type": "cancelled", "jobId": "job-1", "leaseId": "lease-1"}
    ]
    assert "job-1" in adapter._cancelled_jobs

    adapter._persist_result = AsyncMock()
    late = await adapter.send("chat-1", "late final")
    assert late.success is True
    assert late.message_id == "cancelled:job-1"
    adapter._persist_result.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_with_stale_lease_is_ignored(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._lease_by_job["job-1"] = "lease-current"
    adapter._source_by_job["job-1"] = SimpleNamespace(chat_id="chat-1")
    adapter.handle_message = AsyncMock()

    await adapter._handle_cancel({"type": "cancel", "jobId": "job-1", "leaseId": "lease-stale"})

    adapter.handle_message.assert_not_awaited()
    assert fake_ws.sent == []
    assert adapter._cancelled_jobs == set()


@pytest.mark.asyncio
async def test_processing_complete_without_output_reports_terminal_failure_and_cleans_maps(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    source = SimpleNamespace(chat_id="chat-1")
    adapter._job_by_message_id["message-1"] = "job-1"
    adapter._active_job_by_chat["chat-1"] = "job-1"
    adapter._lease_by_job["job-1"] = "lease-1"
    adapter._source_by_job["job-1"] = source
    event = adapter_module.MessageEvent(
        text="request",
        source=source,
        message_id="message-1",
    )

    completion = asyncio.create_task(
        adapter.on_processing_complete(event, adapter_module.ProcessingOutcome.SUCCESS)
    )
    await asyncio.sleep(0)
    assert adapter._lease_by_job == {"job-1": "lease-1"}
    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-1",
        "leaseId": "lease-1",
    })
    await completion

    assert fake_ws.sent == [
        {
            "type": "failed",
            "jobId": "job-1",
            "leaseId": "lease-1",
            "error": "Hermes completed without a final response",
            "retryable": False,
        }
    ]
    assert adapter._job_by_message_id == {}
    assert adapter._active_job_by_chat == {}
    assert adapter._lease_by_job == {}
    assert adapter._source_by_job == {}


@pytest.mark.asyncio
async def test_cancel_supersedes_completion_failure_before_maps_are_released(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    source = adapter.build_source(
        chat_id="chat-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-failed-cancel",
    )
    adapter._job_by_message_id["job-failed-cancel"] = "job-failed-cancel"
    adapter._active_job_by_chat["chat-1"] = "job-failed-cancel"
    adapter._lease_by_job["job-failed-cancel"] = "lease-failed-cancel"
    adapter._source_by_job["job-failed-cancel"] = source
    event = adapter_module.MessageEvent(
        text="request",
        source=source,
        message_id="job-failed-cancel",
    )

    completion = asyncio.create_task(
        adapter.on_processing_complete(event, adapter_module.ProcessingOutcome.FAILURE)
    )
    await asyncio.sleep(0)
    assert adapter._lease_by_job == {
        "job-failed-cancel": "lease-failed-cancel"
    }

    await adapter._handle_daemon_message({
        "type": "error",
        "code": "cancel_superseded",
        "jobId": "job-failed-cancel",
        "message": "cancel won before completion failure",
    })
    await completion

    assert fake_ws.sent == [
        {
            "type": "failed",
            "jobId": "job-failed-cancel",
            "leaseId": "lease-failed-cancel",
            "error": "Hermes processing ended with failure",
            "retryable": False,
        },
        {
            "type": "cancelled",
            "jobId": "job-failed-cancel",
            "leaseId": "lease-failed-cancel",
        },
    ]
    assert adapter._job_by_message_id == {}
    assert adapter._lease_by_job == {}


@pytest.mark.asyncio
async def test_stop_cancels_failure_ack_wait_only_after_cancelled_handoff(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    source = adapter.build_source(
        chat_id="chat-1",
        chat_name="LiViS",
        chat_type="dm",
        user_id="trusted-node-1",
        user_name="Tester",
        message_id="job-stop-failure",
    )
    adapter._job_by_message_id["job-stop-failure"] = "job-stop-failure"
    adapter._active_job_by_chat["chat-1"] = "job-stop-failure"
    adapter._lease_by_job["job-stop-failure"] = "lease-stop-failure"
    adapter._source_by_job["job-stop-failure"] = source
    event = adapter_module.MessageEvent(
        text="request",
        source=source,
        message_id="job-stop-failure",
    )
    completion = asyncio.create_task(
        adapter.on_processing_complete(event, adapter_module.ProcessingOutcome.FAILURE)
    )
    await asyncio.sleep(0)
    assert "job-stop-failure" in adapter._result_waiters

    async def stop_owner(stop_event):
        assert stop_event.text == "/stop"
        completion.cancel()
        with pytest.raises(asyncio.CancelledError):
            await completion

    adapter.handle_message = AsyncMock(side_effect=stop_owner)
    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": "job-stop-failure",
        "leaseId": "lease-stop-failure",
    })
    await adapter._handle_daemon_message({
        "type": "error",
        "code": "cancel_superseded",
        "jobId": "job-stop-failure",
        "message": "late error after cancelled handoff",
    })

    assert fake_ws.sent == [
        {
            "type": "failed",
            "jobId": "job-stop-failure",
            "leaseId": "lease-stop-failure",
            "error": "Hermes processing ended with failure",
            "retryable": False,
        },
        {
            "type": "cancelled",
            "jobId": "job-stop-failure",
            "leaseId": "lease-stop-failure",
        },
    ]
    assert adapter._job_by_message_id == {}
    assert adapter._lease_by_job == {}
    assert adapter._result_waiters == {}


@pytest.mark.asyncio
async def test_processing_complete_for_unknown_event_emits_nothing(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    event = adapter_module.MessageEvent(text="unknown", message_id="not-a-job")

    await adapter.on_processing_complete(event, adapter_module.ProcessingOutcome.SUCCESS)

    assert fake_ws.sent == []

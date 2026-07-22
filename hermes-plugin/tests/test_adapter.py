from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest


class FakeGatewayRunner:
    def _session_key_for_source(self, source):
        return f"agent:main:livis:dm:{source.chat_id}"

    async def _handle_message(self, _event):
        return None


def make_adapter(adapter_module, config, fake_ws=None):
    adapter = adapter_module.LivisBridgeAdapter(config)
    runner = FakeGatewayRunner()
    adapter._message_handler = runner._handle_message
    adapter._test_runner = runner
    if fake_ws is not None:
        adapter._ws = fake_ws
    return adapter


def relay_job(text: str, *, job_id: str = "job-1", lease_id: str = "lease-1") -> dict:
    return {
        "jobId": job_id,
        "leaseId": lease_id,
        "messageId": f"wire-{job_id}",
        "chatId": "livis:test-agent-id",
        "text": text,
        "timestamp": 1_700_000_000_000,
        "user": {"id": "trusted-node-1", "displayName": "Tester", "trusted": True},
        "source": {"nodeId": "trusted-node-1", "nodeType": "app"},
    }


async def wait_for_sent(fake_ws, count: int) -> None:
    for _ in range(100):
        if len(fake_ws.sent) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"等待 connector 消息超时：{fake_ws.sent!r}")


async def complete_rejected_job(adapter, job: dict, fake_ws) -> None:
    adapter._ready_event.set()
    task = asyncio.create_task(adapter._handle_job(job))
    await wait_for_sent(fake_ws, 1)
    assert fake_ws.sent[0]["type"] == "failed"
    assert task.done() is False
    assert adapter._rejected_job_leases == {job["jobId"]: job["leaseId"]}

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": job["jobId"],
        "leaseId": job["leaseId"],
    })
    assert adapter._rejected_job_leases == {}
    await task
    assert adapter._result_waiters == {}


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
        "LIVIS_HOME_CHANNEL",
    }
    assert "final-only" in registration["platform_hint"]
    assert "read-only" in registration["platform_hint"]

    produced = registration["adapter_factory"](config)
    assert isinstance(produced, adapter_module.LivisBridgeAdapter)
    assert produced.platform.value == "livis"
    assert produced.SUPPORTS_MESSAGE_EDITING is False


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
        ("LIVIS_HOME_CHANNEL", ""),
        ("LIVIS_HOME_CHANNEL", "wrong:test-agent-id"),
        ("LIVIS_HOME_CHANNEL", "livis:"),
        ("LIVIS_HOME_CHANNEL", "livis:bad agent"),
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
    adapter = make_adapter(adapter_module, config)
    assert config.home_channel.platform.value == "livis"
    assert config.home_channel.chat_id == secure_environment["LIVIS_HOME_CHANNEL"]
    assert config.home_channel.thread_id is None
    assert config.gateway_restart_notification is False
    assert adapter_module._runtime_config_valid(config) is True


@pytest.mark.asyncio
async def test_conflicting_persisted_home_channel_fails_closed(
    adapter_module,
    secure_environment,
):
    config = SimpleNamespace(
        extra={},
        home_channel=adapter_module.HomeChannel(
            platform=adapter_module.Platform("livis"),
            chat_id="livis:another-agent",
            name="stale remote home",
        ),
        gateway_restart_notification=True,
    )

    assert adapter_module.validate_config(config) is False
    adapter = make_adapter(adapter_module, config)
    assert config.home_channel.chat_id == "livis:another-agent"
    assert await adapter.connect() is False
    assert adapter.fatal_error == (
        "phase1_config_invalid",
        "LiViS relay requires socket, token, allowlist, local home channel and read-only acknowledgement",
        False,
    )


@pytest.mark.asyncio
async def test_hello_reports_actual_hermes_runtime_version(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    monkeypatch,
):
    source_runtime = SimpleNamespace(__version__="0.15.1-source")
    monkeypatch.setitem(sys.modules, "hermes_cli", source_runtime)
    metadata_version = Mock(side_effect=AssertionError("metadata fallback must not run"))
    monkeypatch.setattr(adapter_module.importlib.metadata, "version", metadata_version)
    adapter = make_adapter(adapter_module, config, fake_ws)

    await adapter._handle_daemon_message({"type": "hello_required", "protocolVersion": 1})

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
                "runtimeVersion": "0.15.1-source",
            },
            "capabilities": {
                "cancel": True,
                "finalResult": True,
                "cancelSemantics": "best_effort",
                "streaming": False,
                "approvals": False,
                "attachmentsIn": False,
                "attachmentsOut": False,
            },
        }
    ]


def test_hermes_version_falls_back_to_distribution_metadata(
    adapter_module,
    monkeypatch,
):
    monkeypatch.delitem(sys.modules, "hermes_cli", raising=False)
    metadata_version = Mock(return_value="0.15.1-wheel")
    monkeypatch.setattr(adapter_module.importlib.metadata, "version", metadata_version)

    assert adapter_module._hermes_version() == "0.15.1-wheel"
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
    job = relay_job("status")

    await adapter._handle_job(job)

    assert fake_ws.sent == [
        {"type": "accepted", "jobId": "job-1", "leaseId": "lease-1"}
    ]
    assert adapter._job_by_message_id == {
        "job-1": "job-1",
        "wire-job-1": "job-1",
    }
    assert adapter._active_job_by_chat == {"livis:test-agent-id": "job-1"}
    assert adapter._lease_by_job == {"job-1": "lease-1"}

    event = adapter.handle_message.await_args.args[0]
    assert event.message_id == "job-1"
    assert event.source.message_id == "job-1"
    assert event.source.user_id == "trusted-node-1"
    assert event.raw_message is job

    adapter._persist_result = AsyncMock()
    result = await adapter.send(
        "livis:test-agent-id",
        "done",
        reply_to="wire-job-1",
    )
    assert result.success is True
    adapter._persist_result.assert_awaited_once_with("job-1", "lease-1", "done")


@pytest.mark.parametrize(
    "text",
    [
        "/sethome",
        " /stop ",
        "/restart",
        "/approve",
        "/yolo",
        "/unknown future-command",
    ],
)
@pytest.mark.asyncio
async def test_remote_slash_commands_fail_before_accept_and_mapping(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    text,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()

    await complete_rejected_job(adapter, relay_job(text), fake_ws)

    assert fake_ws.sent == [{
        "type": "failed",
        "jobId": "job-1",
        "leaseId": "lease-1",
        "error": adapter_module.REMOTE_COMMAND_REJECTED,
        "retryable": False,
    }]
    adapter.handle_message.assert_not_awaited()
    assert adapter._job_by_message_id == {}
    assert adapter._active_job_by_chat == {}
    assert adapter._lease_by_job == {}
    assert adapter._source_by_job == {}


@pytest.mark.parametrize(
    "text",
    [
        "restart gateway",
        "restart the hermes gateway",
        "restart hermes",
    ],
)
@pytest.mark.asyncio
async def test_plaintext_restart_aliases_are_normalized_then_rejected(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    text,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()

    await complete_rejected_job(adapter, relay_job(text), fake_ws)

    assert fake_ws.sent[0] == {
        "type": "failed",
        "jobId": "job-1",
        "leaseId": "lease-1",
        "error": adapter_module.REMOTE_COMMAND_REJECTED,
        "retryable": False,
    }
    adapter.handle_message.assert_not_awaited()
    assert adapter._job_by_message_id == {}


@pytest.mark.parametrize(
    "timestamp",
    [1e20, float("inf"), float("nan"), "not-a-timestamp", None],
)
@pytest.mark.asyncio
async def test_untrusted_timestamp_cannot_abort_remote_command_rejection(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    timestamp,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    job = relay_job("/stop")
    job["timestamp"] = timestamp

    await complete_rejected_job(adapter, job, fake_ws)

    assert fake_ws.sent[0]["type"] == "failed"
    assert fake_ws.sent[0]["error"] == adapter_module.REMOTE_COMMAND_REJECTED
    adapter.handle_message.assert_not_awaited()
    assert adapter._offered_job_leases == {}
    assert adapter._rejected_job_leases == {}


@pytest.mark.asyncio
async def test_active_session_rejects_new_remote_input_before_accept(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    session_key = "agent:main:livis:dm:livis:test-agent-id"
    adapter._active_sessions[session_key] = asyncio.Event()

    await complete_rejected_job(adapter, relay_job("ordinary text"), fake_ws)

    assert fake_ws.sent[0]["type"] == "failed"
    assert fake_ws.sent[0]["error"] == adapter_module.ACTIVE_SESSION_REJECTED
    adapter.handle_message.assert_not_awaited()
    assert adapter._job_by_message_id == {}


@pytest.mark.asyncio
async def test_admission_reservation_closes_accepted_to_active_guard_race(
    adapter_module,
    secure_environment,
    config,
):
    class BlockingAcceptedWebSocket:
        def __init__(self):
            self.sent: list[dict] = []
            self.first_accepted = asyncio.Event()
            self.release_first_accepted = asyncio.Event()

        async def send(self, encoded: str) -> None:
            import json

            message = json.loads(encoded)
            self.sent.append(message)
            if message["type"] == "accepted" and not self.first_accepted.is_set():
                self.first_accepted.set()
                await self.release_first_accepted.wait()

        async def close(self) -> None:
            return None

    fake_ws = BlockingAcceptedWebSocket()
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    adapter.handle_message = AsyncMock()

    first = asyncio.create_task(
        adapter._handle_job(relay_job("first", job_id="job-1", lease_id="lease-1"))
    )
    await fake_ws.first_accepted.wait()
    second = asyncio.create_task(
        adapter._handle_job(relay_job("second", job_id="job-2", lease_id="lease-2"))
    )
    await wait_for_sent(fake_ws, 2)

    assert [(message["type"], message["jobId"]) for message in fake_ws.sent] == [
        ("accepted", "job-1"),
        ("failed", "job-2"),
    ]
    assert fake_ws.sent[1]["error"] == adapter_module.ACTIVE_SESSION_REJECTED
    assert adapter._active_job_by_chat == {"livis:test-agent-id": "job-1"}
    assert adapter._lease_by_job == {"job-1": "lease-1"}
    assert second.done() is False

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-2",
        "leaseId": "lease-2",
    })
    await second
    fake_ws.release_first_accepted.set()
    await first

    adapter.handle_message.assert_awaited_once()
    assert adapter.handle_message.await_args.args[0].message_id == "job-1"
    assert adapter._admitted_sessions == set()


@pytest.mark.asyncio
async def test_cancel_while_accepted_is_blocked_never_enters_hermes(
    adapter_module,
    secure_environment,
    config,
):
    class BlockingAcceptedWebSocket:
        def __init__(self):
            self.sent: list[dict] = []
            self.accepted_started = asyncio.Event()
            self.release_accepted = asyncio.Event()

        async def send(self, encoded: str) -> None:
            import json

            message = json.loads(encoded)
            self.sent.append(message)
            if message["type"] == "accepted":
                self.accepted_started.set()
                await self.release_accepted.wait()

        async def close(self) -> None:
            return None

    fake_ws = BlockingAcceptedWebSocket()
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    task = asyncio.create_task(adapter._handle_job(relay_job("ordinary text")))
    await fake_ws.accepted_started.wait()

    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": "job-1",
        "leaseId": "lease-1",
    })
    assert [message["type"] for message in fake_ws.sent] == ["accepted", "cancelled"]

    fake_ws.release_accepted.set()
    await task

    adapter.handle_message.assert_not_awaited()
    assert adapter._job_by_message_id == {}
    assert adapter._active_job_by_chat == {}
    assert adapter._lease_by_job == {}
    assert adapter._source_by_job == {}
    assert adapter._offered_job_leases == {}
    assert adapter._offered_job_cancels == set()
    assert adapter._admitted_sessions == set()


@pytest.mark.asyncio
async def test_cancel_racing_with_remote_rejection_never_dispatches_internal_stop(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    adapter.handle_message = AsyncMock()
    task = asyncio.create_task(adapter._handle_job(relay_job("/stop")))
    await wait_for_sent(fake_ws, 1)
    assert task.done() is False

    await adapter._handle_cancel({
        "type": "cancel",
        "jobId": "job-1",
        "leaseId": "lease-1",
    })
    assert [message["type"] for message in fake_ws.sent] == ["failed", "cancelled"]
    await adapter._handle_daemon_message({
        "type": "error",
        "code": "cancel_superseded",
        "jobId": "job-1",
        "message": "cancel won the race",
    })
    await task

    adapter.handle_message.assert_not_awaited()
    assert adapter._rejected_job_leases == {}
    assert adapter._rejection_cancelled_jobs == set()
    assert adapter._result_waiters == {}
    assert adapter._job_by_message_id == {}


@pytest.mark.asyncio
async def test_rejection_ack_with_stale_lease_closes_connector_and_cleans_state(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    adapter.handle_message = AsyncMock()
    task = asyncio.create_task(adapter._handle_job(relay_job("/stop")))
    await wait_for_sent(fake_ws, 1)
    reconnected_ws = type(fake_ws)()
    adapter._ws = reconnected_ws
    adapter._ready_event.set()

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-1",
        "leaseId": "stale-lease",
    })
    await task

    assert fake_ws.closed is True
    assert reconnected_ws.closed is False
    assert reconnected_ws.sent == []
    assert fake_ws.sent == [{
        "type": "failed",
        "jobId": "job-1",
        "leaseId": "lease-1",
        "error": adapter_module.REMOTE_COMMAND_REJECTED,
        "retryable": False,
    }]
    adapter.handle_message.assert_not_awaited()
    assert adapter._result_waiters == {}
    assert adapter._rejected_job_leases == {}
    assert adapter._rejection_cancelled_jobs == set()
    assert adapter._job_by_message_id == {}


@pytest.mark.asyncio
async def test_buffered_cancel_before_job_task_runs_uses_offer_tombstone(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    adapter.handle_message = AsyncMock()
    job = relay_job("ordinary text")

    await adapter._handle_daemon_message({"type": "job", "job": job})
    await adapter._handle_daemon_message({
        "type": "cancel",
        "jobId": "job-1",
        "leaseId": "lease-1",
    })
    pending = list(adapter._background_dispatches)
    if pending:
        await asyncio.gather(*pending)

    assert fake_ws.sent == [
        {"type": "cancelled", "jobId": "job-1", "leaseId": "lease-1"}
    ]
    adapter.handle_message.assert_not_awaited()
    assert adapter._offered_job_leases == {}
    assert adapter._offered_job_cancels == set()
    assert adapter._job_by_message_id == {}
    assert adapter._lease_by_job == {}


@pytest.mark.asyncio
async def test_stale_done_session_guard_is_healed_before_dispatch(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    session_key = "agent:main:livis:dm:livis:test-agent-id"
    adapter._active_sessions[session_key] = asyncio.Event()
    adapter._session_tasks[session_key] = SimpleNamespace(done=lambda: True)

    await adapter._handle_job(relay_job("ordinary text"))

    assert fake_ws.sent == [
        {"type": "accepted", "jobId": "job-1", "leaseId": "lease-1"}
    ]
    adapter.handle_message.assert_awaited_once()
    assert session_key not in adapter._active_sessions
    assert session_key not in adapter._session_tasks


@pytest.mark.parametrize("text", ["yes", "always", "ordinary text"])
@pytest.mark.asyncio
async def test_blocking_approval_rejects_every_remote_reply(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    monkeypatch,
    text,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    monkeypatch.setattr(adapter_module, "_has_blocking_approval", lambda _key: True)

    await complete_rejected_job(adapter, relay_job(text), fake_ws)

    assert fake_ws.sent[0]["type"] == "failed"
    assert fake_ws.sent[0]["error"] == adapter_module.BLOCKING_APPROVAL_REJECTED
    adapter.handle_message.assert_not_awaited()
    assert adapter._job_by_message_id == {}


@pytest.mark.parametrize(
    "failure",
    ["coerce", "channel", "runner", "session", "heal", "active", "approval"],
)
@pytest.mark.asyncio
async def test_unreadable_hermes_safety_state_fails_closed(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
    monkeypatch,
    failure,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter.handle_message = AsyncMock()
    job = relay_job("ordinary text")
    if failure == "coerce":
        monkeypatch.setattr(
            adapter_module,
            "coerce_plaintext_gateway_command",
            Mock(side_effect=RuntimeError("command normalization unavailable")),
        )
    elif failure == "channel":
        job["chatId"] = "livis:another-agent"
    elif failure == "runner":
        adapter._message_handler = object()
    elif failure == "session":
        adapter._test_runner._session_key_for_source = Mock(
            side_effect=RuntimeError("session state unavailable")
        )
    elif failure == "heal":
        adapter._heal_stale_session_lock = Mock(
            side_effect=RuntimeError("session guard unavailable")
        )
    elif failure == "active":
        adapter._active_sessions = object()
    else:
        monkeypatch.setattr(
            adapter_module,
            "_has_blocking_approval",
            Mock(side_effect=RuntimeError("approval state unavailable")),
        )

    await complete_rejected_job(adapter, job, fake_ws)

    assert fake_ws.sent[0]["type"] == "failed"
    assert fake_ws.sent[0]["error"] == adapter_module.SAFETY_STATE_UNAVAILABLE
    adapter.handle_message.assert_not_awaited()
    assert adapter._job_by_message_id == {}


@pytest.mark.asyncio
async def test_durable_ack_timeout_cancels_and_removes_waiter(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    adapter._result_store_timeout = 0

    with pytest.raises(
        adapter_module.LocalRelayUnavailable,
        match="durable rejection storage",
    ):
        await adapter._persist_rejection(
            "job-rejected",
            "lease-rejected",
            "rejected",
            websocket=fake_ws,
        )
    assert adapter._result_waiters == {}

    with pytest.raises(
        adapter_module.LocalRelayUnavailable,
        match="durable result storage",
    ):
        await adapter._persist_result("job-result", "lease-result", "done")
    assert adapter._result_waiters == {}

    await adapter._handle_daemon_message({
        "type": "result_stored",
        "jobId": "job-rejected",
        "leaseId": "lease-rejected",
    })
    assert adapter._result_waiters == {}


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
        "protocolVersion": 1,
        "connectorId": adapter.connector_id,
        "daemonVersion": "test",
        "resultStoreTimeoutMs": 2500,
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
        "protocolVersion": 1,
        "connectorId": adapter.connector_id,
        "daemonVersion": "test",
    })

    assert adapter._result_store_timeout == adapter_module.DEFAULT_RESULT_STORE_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_cancel_superseded_resolves_send_as_cancelled(
    adapter_module,
    secure_environment,
    config,
    fake_ws,
):
    adapter = make_adapter(adapter_module, config, fake_ws)
    adapter._ready_event.set()
    adapter._job_by_message_id["message-1"] = "job-1"
    adapter._lease_by_job["job-1"] = "lease-1"
    adapter._active_job_by_chat["chat-1"] = "job-1"
    adapter._source_by_job["job-1"] = SimpleNamespace(chat_id="chat-1")

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
    assert fake_ws.sent == [
        {"type": "result", "jobId": "job-1", "leaseId": "lease-1", "text": "final"}
    ]


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

    await adapter.on_processing_complete(event, adapter_module.ProcessingOutcome.SUCCESS)

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

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

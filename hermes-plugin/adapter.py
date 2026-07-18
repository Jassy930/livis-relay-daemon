"""Final-only Hermes adapter for the local livis-relayd Unix socket.

This module deliberately contains no LiViS OAuth or remote relay logic.  It
only converts the daemon's backend-neutral job contract to Hermes
``MessageEvent`` and persists final ``SendResult`` values back through IPC.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone
import importlib.metadata
import json
import logging
import os
import platform as platform_module
import random
import socket
from typing import Any, Dict, Optional

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
)

logger = logging.getLogger(__name__)

CONNECTOR_PROTOCOL_VERSION = 1
PLUGIN_VERSION = "0.1.0"
MAX_FRAME_BYTES = 1024 * 1024
RETRY_INITIAL_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
DEFAULT_RESULT_STORE_TIMEOUT_SECONDS = 5.0


class LocalRelayUnavailable(RuntimeError):
    """Raised when the daemon didn't durably acknowledge a connector result."""


class ResultSupersededByCancel(RuntimeError):
    """Raised when the daemon dropped a final result because cancel already won."""


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _hermes_version() -> str:
    # Hermes is commonly run straight from its source checkout/managed venv,
    # where distribution metadata may be absent even though the runtime has an
    # authoritative version constant.
    try:
        from hermes_cli import __version__ as runtime_version

        if str(runtime_version).strip():
            return str(runtime_version).strip()
    except (ImportError, AttributeError):
        pass
    for distribution in ("hermes-agent", "hermes_agent"):
        try:
            return importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            continue
    return "unknown"


async def _unix_connect(path: str, token: str):
    """Connect through the public websockets Unix-socket client API."""
    import websockets

    kwargs = {
        "uri": "ws://localhost/v1/connectors/hermes",
        "ping_interval": 20,
        "ping_timeout": 20,
        "max_size": MAX_FRAME_BYTES,
        "open_timeout": 10,
        "close_timeout": 5,
    }
    headers = {"Authorization": f"Bearer {token}"}
    try:
        return await websockets.unix_connect(path, additional_headers=headers, **kwargs)
    except TypeError:
        # websockets <= 13 used ``extra_headers``.
        return await websockets.unix_connect(path, extra_headers=headers, **kwargs)


class LivisBridgeAdapter(BasePlatformAdapter):
    """Hermes platform adapter backed by a local versioned relay daemon."""

    SUPPORTS_MESSAGE_EDITING = False

    def __init__(self, config, **_kwargs):
        super().__init__(config=config, platform=Platform("livis"))
        extra = getattr(config, "extra", {}) or {}
        self.socket_path = str(
            os.getenv("LIVIS_RELAY_SOCKET") or extra.get("socket_path", "")
        ).strip()
        self.connector_token = os.getenv("LIVIS_RELAY_TOKEN", "").strip()
        self.connect_timeout = float(os.getenv("LIVIS_RELAY_CONNECT_TIMEOUT", "10"))
        self.connector_id = (
            f"hermes-{socket.gethostname()}-{os.getpid()}"
        )

        self._ws = None
        self._listener_task: Optional[asyncio.Task] = None
        self._ready_event = asyncio.Event()
        self._running = False
        self._result_store_timeout = DEFAULT_RESULT_STORE_TIMEOUT_SECONDS
        self._send_lock = asyncio.Lock()
        self._result_waiters: Dict[str, asyncio.Future] = {}
        self._job_by_message_id: Dict[str, str] = {}
        self._active_job_by_chat: Dict[str, str] = {}
        self._lease_by_job: Dict[str, str] = {}
        self._source_by_job: Dict[str, Any] = {}
        self._final_by_job: Dict[str, str] = {}
        self._cancelled_jobs: set[str] = set()
        self._background_dispatches: set[asyncio.Task] = set()

    @property
    def name(self) -> str:
        return "LiViS Relay"

    async def connect(self) -> bool:
        if not check_requirements():
            self._set_fatal_error(
                "phase1_config_invalid",
                "LiViS relay requires socket, token, allowlist and read-only acknowledgement",
                retryable=False,
            )
            return False
        self._running = True
        self._listener_task = asyncio.create_task(self._listener_loop())
        try:
            await asyncio.wait_for(self._ready_event.wait(), timeout=self.connect_timeout)
        except asyncio.TimeoutError:
            await self.disconnect()
            self._set_fatal_error(
                "daemon_unavailable",
                f"livis-relayd not ready at {self.socket_path}",
                retryable=True,
            )
            return False
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._running = False
        self._ready_event.clear()
        await self._interrupt_all_active("adapter disconnect")
        if self._listener_task and self._listener_task is not asyncio.current_task():
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
        self._listener_task = None
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None
        for waiter in self._result_waiters.values():
            if not waiter.done():
                waiter.set_exception(LocalRelayUnavailable("livis-relayd disconnected"))
        self._result_waiters.clear()
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        del metadata
        job_id = self._resolve_job(chat_id, reply_to)
        if not job_id:
            return SendResult(success=False, error=f"No active LiViS job for chat {chat_id}")
        if job_id in self._cancelled_jobs:
            # Suppress /stop confirmation and any late final after cancel won.
            return SendResult(success=True, message_id=f"cancelled:{job_id}")
        lease_id = self._lease_by_job.get(job_id)
        if not lease_id:
            return SendResult(success=False, error=f"No active lease for LiViS job {job_id}")
        existing = self._final_by_job.get(job_id)
        if existing is not None and existing != content:
            return SendResult(
                success=False,
                error="LiViS phase 1 permits exactly one distinct final result per job",
                retryable=False,
            )
        self._final_by_job[job_id] = content
        try:
            await self._persist_result(job_id, lease_id, content)
        except ResultSupersededByCancel:
            # The daemon-side cancel won the race before this final arrived.
            # Mirror the local cancel path: report success so Hermes doesn't
            # retry a result that will never be delivered.
            self._cancelled_jobs.add(job_id)
            self._cleanup_completed(job_id, chat_id)
            return SendResult(success=True, message_id=f"cancelled:{job_id}")
        except LocalRelayUnavailable as exc:
            return SendResult(success=False, error=str(exc), retryable=True)
        self._cleanup_completed(job_id, chat_id)
        return SendResult(success=True, message_id=f"livis:{job_id}")

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        del chat_id, metadata

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        del image_url, caption, reply_to, metadata
        return SendResult(
            success=False,
            error=f"LiViS phase 1 rejects attachments for chat {chat_id}",
            retryable=False,
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"chat_id": chat_id, "name": chat_id, "type": "dm"}

    async def on_processing_complete(
        self,
        event: MessageEvent,
        outcome: ProcessingOutcome,
    ) -> None:
        """Close the lease only when Hermes' background task actually ends."""
        job_id = self._job_by_message_id.get(str(event.message_id or ""))
        if not job_id:
            return
        lease_id = self._lease_by_job.get(job_id)
        if not lease_id:
            return
        try:
            if job_id in self._final_by_job:
                return
            if outcome is ProcessingOutcome.CANCELLED or job_id in self._cancelled_jobs:
                await self._send_local({"type": "cancelled", "jobId": job_id, "leaseId": lease_id})
                return
            detail = (
                "Hermes completed without a final response"
                if outcome is ProcessingOutcome.SUCCESS
                else f"Hermes processing ended with {outcome.value}"
            )
            await self._send_local({
                "type": "failed",
                "jobId": job_id,
                "leaseId": lease_id,
                "error": detail,
                "retryable": False,
            })
        finally:
            self._release_job_maps(job_id)

    async def _listener_loop(self) -> None:
        backoff = RETRY_INITIAL_SECONDS
        while self._running:
            try:
                ws = await _unix_connect(self.socket_path, self.connector_token)
                self._ws = ws
                backoff = RETRY_INITIAL_SECONDS
                async for raw in ws:
                    if not self._running:
                        break
                    if isinstance(raw, bytes):
                        if len(raw) > MAX_FRAME_BYTES:
                            raise ValueError("connector frame too large")
                        raw = raw.decode("utf-8")
                    elif len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
                        raise ValueError("connector frame too large")
                    message = json.loads(raw)
                    await self._handle_daemon_message(message)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                if self._running:
                    logger.warning("LiViS relay IPC disconnected: %s", exc)
            finally:
                self._ready_event.clear()
                self._ws = None
                if self._running:
                    await self._interrupt_all_active("relay IPC disconnected")
            if self._running:
                await asyncio.sleep(backoff + random.random() * backoff * 0.2)
                backoff = min(backoff * 2, RETRY_MAX_SECONDS)

    async def _handle_daemon_message(self, message: dict) -> None:
        message_type = message.get("type")
        if message_type == "hello_required":
            await self._send_local({
                "type": "hello",
                "protocolVersion": CONNECTOR_PROTOCOL_VERSION,
                "connectorId": self.connector_id,
                "backend": "hermes",
                "implementation": {
                    "name": "livis-hermes-bridge",
                    "version": PLUGIN_VERSION,
                    "runtimeVersion": _hermes_version(),
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
            })
            return
        if message_type == "hello_ack":
            if message.get("protocolVersion") != CONNECTOR_PROTOCOL_VERSION:
                raise ValueError("daemon connector protocol mismatch")
            timeout_ms = message.get("resultStoreTimeoutMs")
            if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
                self._result_store_timeout = float(timeout_ms) / 1000.0
            self._ready_event.set()
            return
        if message_type == "job":
            task = asyncio.create_task(self._handle_job(message["job"]))
            self._background_dispatches.add(task)
            task.add_done_callback(self._background_dispatches.discard)
            return
        if message_type == "cancel":
            await self._handle_cancel(message)
            return
        if message_type == "result_stored":
            waiter = self._result_waiters.get(str(message.get("jobId", "")))
            if waiter and not waiter.done():
                waiter.set_result(str(message.get("leaseId", "")))
            return
        if message_type == "error":
            job_id = str(message.get("jobId", ""))
            waiter = self._result_waiters.get(job_id)
            if waiter and not waiter.done():
                detail = str(message.get("message", "daemon rejected result"))
                if message.get("code") == "cancel_superseded":
                    waiter.set_exception(ResultSupersededByCancel(detail))
                else:
                    waiter.set_exception(LocalRelayUnavailable(detail))
            return
        if message_type == "ping":
            await self._send_local({"type": "pong", "timestamp": message.get("timestamp")})

    async def _handle_job(self, job: dict) -> None:
        job_id = str(job["jobId"])
        lease_id = str(job["leaseId"])
        chat_id = str(job["chatId"])
        message_id = str(job.get("messageId") or job_id)
        user = job.get("user") or {}
        source_data = job.get("source") or {}
        source = self.build_source(
            chat_id=chat_id,
            chat_name="LiViS",
            chat_type="dm",
            user_id=str(user.get("id") or source_data.get("nodeId") or "livis-user"),
            user_name=str(user.get("displayName") or "LiViS user"),
            message_id=job_id,
        )
        self._job_by_message_id[job_id] = job_id
        self._job_by_message_id[message_id] = job_id
        self._active_job_by_chat[chat_id] = job_id
        self._lease_by_job[job_id] = lease_id
        self._source_by_job[job_id] = source
        await self._send_local({"type": "accepted", "jobId": job_id, "leaseId": lease_id})
        try:
            await self.handle_message(
                MessageEvent(
                    text=str(job["text"]),
                    message_type=MessageType.TEXT,
                    source=source,
                    message_id=job_id,
                    raw_message=job,
                    timestamp=datetime.fromtimestamp(
                        float(job.get("timestamp", 0)) / 1000,
                        tz=timezone.utc,
                    ) if job.get("timestamp") else datetime.now(tz=timezone.utc),
                )
            )
        except Exception as exc:
            await self._send_local({
                "type": "failed",
                "jobId": job_id,
                "leaseId": lease_id,
                "error": f"Hermes dispatch failed: {exc}",
                "retryable": False,
            })

    async def _handle_cancel(self, message: dict) -> None:
        job_id = str(message.get("jobId", ""))
        lease_id = str(message.get("leaseId", ""))
        if self._lease_by_job.get(job_id) != lease_id:
            return
        source = self._source_by_job.get(job_id)
        if source is None:
            return
        self._cancelled_jobs.add(job_id)
        await self.handle_message(
            MessageEvent(
                text="/stop",
                message_type=MessageType.COMMAND,
                source=source,
                message_id=f"cancel:{job_id}",
                raw_message=message,
                timestamp=datetime.now(tz=timezone.utc),
            )
        )
        # This confirms only that /stop was dispatched.  The daemon records
        # CancelUnknown and quarantines the session until an operator verifies
        # that non-cooperative tool threads have exited.
        await self._send_local({"type": "cancelled", "jobId": job_id, "leaseId": lease_id})

    async def _persist_result(self, job_id: str, lease_id: str, content: str) -> None:
        if not self._ready_event.is_set() or self._ws is None:
            raise LocalRelayUnavailable("livis-relayd connector isn't ready")
        loop = asyncio.get_running_loop()
        waiter = self._result_waiters.get(job_id)
        if waiter is None or waiter.done():
            waiter = loop.create_future()
            self._result_waiters[job_id] = waiter
        async with self._send_lock:
            await self._send_local({
                "type": "result",
                "jobId": job_id,
                "leaseId": lease_id,
                "text": content,
            })
        try:
            acknowledged_lease = await asyncio.wait_for(
                asyncio.shield(waiter), timeout=self._result_store_timeout
            )
        except asyncio.TimeoutError as exc:
            raise LocalRelayUnavailable("livis-relayd didn't acknowledge durable result storage") from exc
        finally:
            if waiter.done():
                self._result_waiters.pop(job_id, None)
        if acknowledged_lease != lease_id:
            raise LocalRelayUnavailable("livis-relayd acknowledged a different execution lease")

    async def _send_local(self, message: dict) -> None:
        if self._ws is None:
            raise LocalRelayUnavailable("livis-relayd IPC is disconnected")
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ValueError("connector frame too large")
        await self._ws.send(encoded)

    async def _interrupt_all_active(self, reason: str) -> None:
        active = list(self._source_by_job.items())
        for job_id, source in active:
            if job_id in self._cancelled_jobs:
                continue
            self._cancelled_jobs.add(job_id)
            try:
                await self.handle_message(
                    MessageEvent(
                        text="/stop",
                        message_type=MessageType.COMMAND,
                        source=source,
                        message_id=f"disconnect:{job_id}",
                        raw_message={"reason": reason},
                    )
                )
            except Exception:
                logger.debug("Failed to interrupt Hermes job %s", job_id, exc_info=True)

    def _resolve_job(self, chat_id: str, reply_to: Optional[str]) -> Optional[str]:
        if reply_to:
            direct = self._job_by_message_id.get(str(reply_to))
            if direct:
                return direct
        return self._active_job_by_chat.get(chat_id)

    def _cleanup_completed(self, job_id: str, chat_id: str) -> None:
        if self._active_job_by_chat.get(chat_id) == job_id:
            self._active_job_by_chat.pop(chat_id, None)
        self._source_by_job.pop(job_id, None)

    def _release_job_maps(self, job_id: str) -> None:
        for message_id, mapped_job in list(self._job_by_message_id.items()):
            if mapped_job == job_id:
                self._job_by_message_id.pop(message_id, None)
        for chat_id, mapped_job in list(self._active_job_by_chat.items()):
            if mapped_job == job_id:
                self._active_job_by_chat.pop(chat_id, None)
        self._source_by_job.pop(job_id, None)
        self._lease_by_job.pop(job_id, None)
        self._result_waiters.pop(job_id, None)
        self._final_by_job.pop(job_id, None)
        self._cancelled_jobs.discard(job_id)


def check_requirements() -> bool:
    socket_path = os.getenv("LIVIS_RELAY_SOCKET", "").strip()
    if not socket_path or not os.path.isabs(socket_path):
        return False
    if len(os.getenv("LIVIS_RELAY_TOKEN", "").strip()) < 32:
        return False
    allowed_users = {
        user_id.strip()
        for user_id in os.getenv("LIVIS_ALLOWED_USERS", "").split(",")
        if user_id.strip()
    }
    if not allowed_users or "*" in allowed_users:
        return False
    if _truthy(os.getenv("LIVIS_ALLOW_ALL_USERS")):
        return False
    if not _truthy(os.getenv("LIVIS_PHASE1_READ_ONLY_ACK")):
        return False
    try:
        import websockets  # noqa: F401
    except ImportError:
        return False
    return True


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    socket_path = os.getenv("LIVIS_RELAY_SOCKET") or extra.get("socket_path", "")
    return bool(socket_path and os.path.isabs(socket_path) and check_requirements())


def is_connected(config) -> bool:
    return validate_config(config)


def _env_enablement() -> dict | None:
    socket_path = os.getenv("LIVIS_RELAY_SOCKET", "").strip()
    if not socket_path or not check_requirements():
        return None
    return {"socket_path": socket_path, "phase1_read_only": True}


def register(ctx) -> None:
    """Register the public Hermes platform interface, not core internals."""
    ctx.register_platform(
        name="livis",
        label="LiViS Relay",
        adapter_factory=lambda cfg: LivisBridgeAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[
            "LIVIS_RELAY_SOCKET",
            "LIVIS_RELAY_TOKEN",
            "LIVIS_ALLOWED_USERS",
            "LIVIS_PHASE1_READ_ONLY_ACK",
        ],
        install_hint="Install websockets with uv and start livis-relayd first",
        env_enablement_fn=_env_enablement,
        allowed_users_env="LIVIS_ALLOWED_USERS",
        allow_all_env="LIVIS_ALLOW_ALL_USERS",
        max_message_length=0,
        emoji="🚗",
        pii_safe=True,
        allow_update_command=False,
        platform_hint=(
            "You are replying through LiViS phase 1. Use concise plain text. "
            "This channel is final-only, read-only, and doesn't support "
            "approvals, attachments, tool-progress messages, or remote admin commands."
        ),
    )

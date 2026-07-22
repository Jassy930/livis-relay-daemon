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
import math
import os
import platform as platform_module
import random
import socket
from typing import Any, Dict, Optional

from gateway.config import HomeChannel, Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
    coerce_plaintext_gateway_command,
)

logger = logging.getLogger(__name__)

CONNECTOR_PROTOCOL_VERSION = 1
PLUGIN_VERSION = "0.1.1"
MAX_FRAME_BYTES = 1024 * 1024
RETRY_INITIAL_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
DEFAULT_RESULT_STORE_TIMEOUT_SECONDS = 5.0
REMOTE_COMMAND_REJECTED = "LiViS 远程渠道不允许执行 Hermes 命令"
ACTIVE_SESSION_REJECTED = "Hermes session 正在执行，LiViS 新输入已拒绝"
BLOCKING_APPROVAL_REJECTED = "Hermes session 正在等待审批，LiViS 输入已拒绝"
SAFETY_STATE_UNAVAILABLE = "Hermes 安全状态不可验证，LiViS 输入已拒绝"


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


def _event_timestamp(value: Any) -> datetime:
    """将不可信 job 毫秒时间戳归一化为可构造的 UTC 时间。"""
    try:
        timestamp_ms = float(value)
        if not math.isfinite(timestamp_ms):
            raise ValueError("job timestamp must be finite")
        return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return datetime.now(tz=timezone.utc)


def _configured_home_channel() -> str | None:
    """返回本地固定的 LiViS home channel；无效配置一律失败关闭。"""
    value = os.getenv("LIVIS_HOME_CHANNEL", "").strip()
    if not value.startswith("livis:"):
        return None
    agent_id = value.removeprefix("livis:")
    if not agent_id or len(value.encode("utf-8")) > 256:
        return None
    if any(character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        return None
    return value


def _home_channel_matches(config, expected: str, *, allow_missing: bool) -> bool:
    home = getattr(config, "home_channel", None)
    if home is None:
        return allow_missing
    platform = getattr(getattr(home, "platform", None), "value", None)
    chat_id = str(getattr(home, "chat_id", ""))
    thread_id = getattr(home, "thread_id", None)
    return platform == "livis" and chat_id == expected and not thread_id


def _has_blocking_approval(session_key: str) -> bool:
    """延迟导入 Hermes 审批状态；导入或读取异常由调用方失败关闭。"""
    from tools.approval import has_blocking_approval

    return bool(has_blocking_approval(session_key))


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
        self.home_channel = _configured_home_channel()
        existing_home = getattr(config, "home_channel", None)
        if self.home_channel and existing_home is None:
            config.home_channel = HomeChannel(
                platform=self.platform,
                chat_id=self.home_channel,
                name="LiViS",
            )
        # 该 connector 没有主动推送 job；禁止 Hermes 在启停时向 home channel
        # 发送无法关联 lease 的通知。
        config.gateway_restart_notification = False
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
        self._rejected_job_leases: Dict[str, str] = {}
        self._rejection_cancelled_jobs: set[str] = set()
        self._offered_job_leases: Dict[str, str] = {}
        self._offered_job_cancels: set[str] = set()
        self._admitted_sessions: set[str] = set()
        self._background_dispatches: set[asyncio.Task] = set()

    @property
    def name(self) -> str:
        return "LiViS Relay"

    async def connect(self) -> bool:
        if not _runtime_config_valid(self.config):
            self._set_fatal_error(
                "phase1_config_invalid",
                "LiViS relay requires socket, token, allowlist, local home channel and read-only acknowledgement",
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
        self._rejected_job_leases.clear()
        self._rejection_cancelled_jobs.clear()
        self._offered_job_leases.clear()
        self._offered_job_cancels.clear()
        self._admitted_sessions.clear()
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
            job = message["job"]
            job_websocket = self._ws
            if job_websocket is None:
                raise LocalRelayUnavailable("livis-relayd IPC is disconnected")
            self._reserve_job_offer(job)
            task = asyncio.create_task(
                self._handle_job(job, websocket=job_websocket)
            )
            self._background_dispatches.add(task)
            task.add_done_callback(self._background_dispatches.discard)
            return
        if message_type == "cancel":
            await self._handle_cancel(message)
            return
        if message_type == "result_stored":
            job_id = str(message.get("jobId", ""))
            lease_id = str(message.get("leaseId", ""))
            if self._rejected_job_leases.get(job_id) == lease_id:
                self._rejected_job_leases.pop(job_id, None)
            waiter = self._result_waiters.get(job_id)
            if waiter and not waiter.done():
                waiter.set_result(lease_id)
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

    async def _handle_job(self, job: dict, *, websocket=None) -> None:
        job_websocket = websocket if websocket is not None else self._ws
        job_id = str(job["jobId"])
        lease_id = str(job["leaseId"])
        self._reserve_job_offer(job)
        if job_id in self._offered_job_cancels:
            self._release_job_offer(job_id, lease_id)
            return
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
        event = MessageEvent(
            text=str(job["text"]),
            message_type=MessageType.TEXT,
            source=source,
            message_id=job_id,
            raw_message=job,
            timestamp=_event_timestamp(job.get("timestamp")),
        )
        rejection, session_key = self._remote_input_admission(event)
        if rejection is not None:
            # 该 tombstone 必须在首次 await 前存在，使并发 cancel 能证明
            # Hermes 尚未开始执行，并避免误派内部 /stop。
            self._rejected_job_leases[job_id] = lease_id
            self._release_job_offer(job_id, lease_id)
            try:
                await self._persist_rejection(
                    job_id,
                    lease_id,
                    rejection,
                    websocket=job_websocket,
                )
            except ResultSupersededByCancel:
                if job_id not in self._rejection_cancelled_jobs:
                    await self._send_local({
                        "type": "cancelled",
                        "jobId": job_id,
                        "leaseId": lease_id,
                    }, websocket=job_websocket)
            except LocalRelayUnavailable as exc:
                logger.warning("LiViS 输入拒绝结果未获得 durable ACK：%s", exc)
                if job_websocket is not None:
                    try:
                        await job_websocket.close()
                    except Exception:
                        logger.debug("关闭未确认拒绝结果的 connector 失败", exc_info=True)
            finally:
                if self._rejected_job_leases.get(job_id) == lease_id:
                    self._rejected_job_leases.pop(job_id, None)
                self._rejection_cancelled_jobs.discard(job_id)
            return

        if session_key is None:
            raise RuntimeError("Hermes input admission did not return a session key")
        # 单线程事件循环中，从 admission 返回到写 reservation 之间没有 await；
        # 该 reservation 关闭 accepted 与 Hermes _active_sessions 建立之间的窗口。
        self._admitted_sessions.add(session_key)
        try:
            self._job_by_message_id[job_id] = job_id
            self._job_by_message_id[message_id] = job_id
            self._active_job_by_chat[chat_id] = job_id
            self._lease_by_job[job_id] = lease_id
            self._source_by_job[job_id] = source
            try:
                await self._send_local(
                    {"type": "accepted", "jobId": job_id, "leaseId": lease_id},
                    websocket=job_websocket,
                )
            except Exception:
                self._release_job_maps(job_id)
                self._release_job_offer(job_id, lease_id)
                raise
            if job_id in self._offered_job_cancels:
                self._release_job_maps(job_id)
                self._release_job_offer(job_id, lease_id)
                return
            self._release_job_offer(job_id, lease_id)
            try:
                await self.handle_message(event)
            except Exception as exc:
                await self._send_local({
                    "type": "failed",
                    "jobId": job_id,
                    "leaseId": lease_id,
                    "error": f"Hermes dispatch failed: {exc}",
                    "retryable": False,
                }, websocket=job_websocket)
        finally:
            self._admitted_sessions.discard(session_key)

    def _remote_input_admission(self, event: MessageEvent) -> tuple[str | None, str | None]:
        """在 Hermes dispatcher、job 映射和 accepted 之前关闭控制入口。"""
        try:
            coerce_plaintext_gateway_command(event)
        except Exception:
            logger.warning("Hermes 远程命令归一化状态不可读", exc_info=True)
            return SAFETY_STATE_UNAVAILABLE, None

        if str(event.text or "").strip().startswith("/"):
            return REMOTE_COMMAND_REJECTED, None

        try:
            source = event.source
            if self.home_channel is None or str(getattr(source, "chat_id", "")) != self.home_channel:
                return SAFETY_STATE_UNAVAILABLE, None

            handler = self._message_handler
            runner = getattr(handler, "__self__", None)
            session_key_for_source = getattr(runner, "_session_key_for_source", None)
            if runner is None or not callable(session_key_for_source):
                return SAFETY_STATE_UNAVAILABLE, None
            session_key = session_key_for_source(source)
            if not isinstance(session_key, str) or not session_key:
                return SAFETY_STATE_UNAVAILABLE, None

            heal_stale_session_lock = getattr(self, "_heal_stale_session_lock", None)
            if not callable(heal_stale_session_lock):
                return SAFETY_STATE_UNAVAILABLE, None
            heal_stale_session_lock(session_key)

            active_sessions = getattr(self, "_active_sessions", None)
            if not isinstance(active_sessions, dict):
                return SAFETY_STATE_UNAVAILABLE, None
            if session_key in active_sessions or session_key in self._admitted_sessions:
                return ACTIVE_SESSION_REJECTED, None
            if _has_blocking_approval(session_key):
                return BLOCKING_APPROVAL_REJECTED, None
        except Exception:
            logger.warning("Hermes session/审批安全状态不可读", exc_info=True)
            return SAFETY_STATE_UNAVAILABLE, None
        return None, session_key

    def _reserve_job_offer(self, job: dict) -> None:
        job_id = str(job["jobId"])
        lease_id = str(job["leaseId"])
        existing = self._offered_job_leases.get(job_id)
        if existing is not None and existing != lease_id:
            raise ValueError("daemon reused a pending jobId with a different lease")
        self._offered_job_leases[job_id] = lease_id

    def _release_job_offer(self, job_id: str, lease_id: str) -> None:
        if self._offered_job_leases.get(job_id) == lease_id:
            self._offered_job_leases.pop(job_id, None)
        self._offered_job_cancels.discard(job_id)

    async def _handle_cancel(self, message: dict) -> None:
        job_id = str(message.get("jobId", ""))
        lease_id = str(message.get("leaseId", ""))
        if self._rejected_job_leases.get(job_id) == lease_id:
            self._rejection_cancelled_jobs.add(job_id)
            await self._send_local({"type": "cancelled", "jobId": job_id, "leaseId": lease_id})
            return
        if self._offered_job_leases.get(job_id) == lease_id:
            self._offered_job_cancels.add(job_id)
            await self._send_local({"type": "cancelled", "jobId": job_id, "leaseId": lease_id})
            return
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

    async def _persist_rejection(
        self,
        job_id: str,
        lease_id: str,
        error: str,
        *,
        websocket,
    ) -> None:
        if (
            not self._ready_event.is_set()
            or websocket is None
            or self._ws is not websocket
        ):
            raise LocalRelayUnavailable("livis-relayd connector isn't ready")
        loop = asyncio.get_running_loop()
        waiter = self._result_waiters.get(job_id)
        if waiter is None or waiter.done():
            waiter = loop.create_future()
            self._result_waiters[job_id] = waiter
        async with self._send_lock:
            if self._ws is not websocket:
                raise LocalRelayUnavailable("livis-relayd connector generation changed")
            await self._send_local({
                "type": "failed",
                "jobId": job_id,
                "leaseId": lease_id,
                "error": error,
                "retryable": False,
            }, websocket=websocket)
        try:
            acknowledged_lease = await asyncio.wait_for(
                asyncio.shield(waiter), timeout=self._result_store_timeout
            )
        except asyncio.TimeoutError as exc:
            raise LocalRelayUnavailable(
                "livis-relayd didn't acknowledge durable rejection storage"
            ) from exc
        finally:
            if self._result_waiters.get(job_id) is waiter:
                self._result_waiters.pop(job_id, None)
            if not waiter.done():
                waiter.cancel()
        if acknowledged_lease != lease_id:
            raise LocalRelayUnavailable("livis-relayd acknowledged a different rejection lease")

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
            if self._result_waiters.get(job_id) is waiter:
                self._result_waiters.pop(job_id, None)
            if not waiter.done():
                waiter.cancel()
        if acknowledged_lease != lease_id:
            raise LocalRelayUnavailable("livis-relayd acknowledged a different execution lease")

    async def _send_local(self, message: dict, *, websocket=None) -> None:
        target_websocket = websocket if websocket is not None else self._ws
        if target_websocket is None:
            raise LocalRelayUnavailable("livis-relayd IPC is disconnected")
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ValueError("connector frame too large")
        await target_websocket.send(encoded)

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
    if _configured_home_channel() is None:
        return False
    try:
        import websockets  # noqa: F401
    except ImportError:
        return False
    return True


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    socket_path = os.getenv("LIVIS_RELAY_SOCKET") or extra.get("socket_path", "")
    expected_home = _configured_home_channel()
    return bool(
        socket_path
        and os.path.isabs(socket_path)
        and expected_home
        and check_requirements()
        and _home_channel_matches(config, expected_home, allow_missing=True)
    )


def _runtime_config_valid(config) -> bool:
    expected_home = _configured_home_channel()
    return bool(
        expected_home
        and validate_config(config)
        and _home_channel_matches(config, expected_home, allow_missing=False)
        and getattr(config, "gateway_restart_notification", None) is False
    )


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
            "LIVIS_HOME_CHANNEL",
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

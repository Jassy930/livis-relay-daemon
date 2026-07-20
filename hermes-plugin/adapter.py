"""Final-only Hermes adapter for the local livis-relayd Unix socket.

This module deliberately contains no LiViS OAuth or remote relay logic.  It
only converts the daemon's backend-neutral job contract to Hermes
``MessageEvent`` and persists final ``SendResult`` values back through IPC.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass
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
from gateway.session import build_session_key
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
    coerce_plaintext_gateway_command,
)

logger = logging.getLogger(__name__)

CONNECTOR_PROTOCOL_VERSION = 2
PLUGIN_VERSION = "0.1.0"
MAX_FRAME_BYTES = 1024 * 1024
RETRY_INITIAL_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
DEFAULT_RESULT_STORE_TIMEOUT_SECONDS = 5.0
DRAIN_TIMEOUT_SECONDS = 2.0
ALLOWED_REMOTE_COMMAND = "/sethome"
REMOTE_COMMAND_REJECTED_ERROR = "LiViS phase 1 rejects remote Hermes commands"
REMOTE_APPROVAL_REJECTED_ERROR = "LiViS phase 1 rejects remote Hermes approvals"
REMOTE_BUSY_REJECTED_ERROR = "LiViS phase 1 rejects concurrent Hermes session input"
REMOTE_DEFERRED_CANCELLED_ERROR = "LiViS job cancelled before Hermes dispatch"
REMOTE_DRAINING_REJECTED_ERROR = "adapter disconnected before Hermes dispatch"


class LocalRelayUnavailable(RuntimeError):
    """Raised when the daemon didn't durably acknowledge a connector result."""


class ResultSupersededByCancel(RuntimeError):
    """Raised when the daemon dropped a final result because cancel already won."""


@dataclass
class DeferredJob:
    job_id: str
    lease_id: str
    chat_id: str
    message_id: str
    source: Any
    event: MessageEvent
    session_key: str
    state: str = "waiting"
    cancel_requested: bool = False
    task: Optional[asyncio.Task] = None


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
    supports_async_delivery = False

    def __init__(self, config, **_kwargs):
        super().__init__(config=config, platform=Platform("livis"))
        # Hermes 0.18.2 injects its runner only when the adapter declares this
        # attribute. Without it, orphaned blocking approvals could not be
        # inspected after the active-session guard has gone away.
        self.gateway_runner = None
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
        self._drain_ack_event = asyncio.Event()
        self._prestart_ack_event = asyncio.Event()
        self._running = False
        self._draining = False
        self._drain_timeout = DRAIN_TIMEOUT_SECONDS
        self._result_store_timeout = DEFAULT_RESULT_STORE_TIMEOUT_SECONDS
        self._send_lock = asyncio.Lock()
        self._result_waiters: Dict[str, asyncio.Future] = {}
        self._job_by_message_id: Dict[str, str] = {}
        self._active_job_by_chat: Dict[str, str] = {}
        self._lease_by_job: Dict[str, str] = {}
        self._source_by_job: Dict[str, Any] = {}
        self._final_by_job: Dict[str, str] = {}
        self._stored_final_jobs: set[str] = set()
        self._cancelled_jobs: set[str] = set()
        self._cancelled_notifications: set[tuple[str, str]] = set()
        self._interrupted_cancel_jobs: set[str] = set()
        self._prestart_rejections: Dict[str, tuple[str, str]] = {}
        self._settling_job_by_session: Dict[str, str] = {}
        self._deferred_jobs: Dict[str, DeferredJob] = {}
        self._home_bootstrap_claimed = getattr(config, "home_channel", None) is not None

    @property
    def name(self) -> str:
        return "LiViS Relay"

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        # Hermes 0.18.2 passes this keyword from both cold-start and reconnect
        # lifecycle paths. The relay owns replay on its durable daemon side, so
        # this adapter has no gateway-side queue whose handling depends on it.
        del is_reconnect
        if not check_requirements():
            self._set_fatal_error(
                "phase1_config_invalid",
                "LiViS relay requires socket, token, allowlist and read-only acknowledgement",
                retryable=False,
            )
            return False
        self._draining = False
        self._drain_ack_event.clear()
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
        was_ready = self._ready_event.is_set()
        ws = self._ws
        self._draining = bool(ws is not None and was_ready)
        self._running = False
        self._ready_event.clear()
        self._cancel_deferred_before_dispatch(
            REMOTE_DRAINING_REJECTED_ERROR
        )
        try:
            if self._draining:
                try:
                    await asyncio.wait_for(
                        self._drain_connector(),
                        timeout=self._drain_timeout,
                    )
                except Exception as exc:
                    # Retain any unacknowledged tombstone. A transport reconnect in
                    # the same adapter lifetime replays it; if the process exits,
                    # the daemon remains conservatively quarantined rather than
                    # claiming a task was never executed without proof.
                    logger.warning("LiViS connector drain incomplete: %s", exc)
        finally:
            await self._finish_disconnect(ws)

    async def _drain_connector(self) -> None:
        """Close dispatch and durably settle known non-execution in one budget."""
        # The daemon flips connector.ready=false before acknowledging this
        # frame. It can still accept and ACK terminal proof frames, but
        # dispatchPending cannot offer another job to a reader that is shutting
        # down. disconnect() wraps this entire sequence in one deadline so a
        # writer stalled before the gate cannot hang Hermes shutdown forever.
        self._drain_ack_event.clear()
        await self._send_local({"type": "draining"})
        await self._drain_ack_event.wait()
        proofs = [
            (job_id, lease_id, error)
            for job_id, (lease_id, error) in self._prestart_rejections.items()
        ]
        for job_id, lease_id, error in proofs:
            await self._send_prestart_rejection(job_id, lease_id, error)
        await self._wait_for_prestart_acks(
            proofs,
            timeout=min(
                self._drain_timeout,
                self._result_store_timeout,
            ),
        )

    async def _finish_disconnect(self, ws: Any) -> None:
        """Close one connector generation even if drain itself is cancelled."""
        if ws:
            try:
                await ws.close()
            except Exception:
                pass
        self._draining = False
        if self._listener_task and self._listener_task is not asyncio.current_task():
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
        self._listener_task = None
        await self._interrupt_all_active(
            "adapter disconnect",
            force_job_ids=self._take_interrupted_cancel_jobs(),
        )
        if self._ws is ws:
            self._ws = None
        for waiter in self._result_waiters.values():
            if not waiter.done():
                waiter.set_exception(LocalRelayUnavailable("livis-relayd disconnected"))
        self._result_waiters.clear()
        # A hello_ack handler that was already in flight can briefly set this
        # event after disconnect() cleared it at entry. The listener is now
        # fully joined, so clear once more before a future connect() observes it.
        self._ready_event.clear()
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
        # Mark before transmitting the final. The daemon sends result_stored
        # and may immediately offer the next job on the same session in two
        # adjacent UDS frames; its reader can observe that job before this
        # coroutine is resumed by the ACK. Hermes' live guard is safe to queue
        # behind only after the current job has produced its unique final.
        self._mark_job_settling(job_id)
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
        self._stored_final_jobs.add(job_id)
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
            if outcome is ProcessingOutcome.CANCELLED or job_id in self._cancelled_jobs:
                await self._send_cancelled_once(job_id, lease_id)
                return
            if job_id in self._stored_final_jobs:
                return
            detail = (
                "Hermes completed without a final response"
                if outcome is ProcessingOutcome.SUCCESS
                else f"Hermes processing ended with {outcome.value}"
            )
            self._mark_job_settling(job_id)
            try:
                await self._persist_failure(job_id, lease_id, detail)
            except ResultSupersededByCancel:
                # Cancel reached the daemon before this completion fallback.
                # Keep the lease until one cancelled signal is handed back;
                # otherwise the queued cancel frame would become a no-op and
                # leave the daemon stuck in Cancelling.
                self._cancelled_jobs.add(job_id)
                await self._send_cancelled_once(job_id, lease_id)
            except asyncio.CancelledError:
                # Hermes /stop cancels the owner task that is currently waiting
                # for this failure ACK. _dispatch_registered_cancel marks the
                # job before invoking /stop, so hand the cancelled signal to the
                # daemon while the lease is still mapped, then preserve the
                # owner's cancellation outcome.
                if job_id in self._cancelled_jobs:
                    try:
                        await asyncio.shield(
                            self._send_cancelled_once(job_id, lease_id)
                        )
                    except Exception:
                        logger.debug(
                            "Failed to settle cancelled LiViS completion",
                            exc_info=True,
                        )
                raise
            except LocalRelayUnavailable:
                # We cannot safely claim terminal settlement without the ACK.
                # Closing this connector generation makes the daemon apply its
                # conservative Interrupted/quarantine recovery before any new
                # work can use the session.
                ws = self._ws
                if ws is not None:
                    try:
                        await ws.close()
                    except Exception:
                        logger.debug(
                            "Failed to close unacknowledged LiViS connector",
                            exc_info=True,
                        )
        finally:
            self._release_job_maps(job_id)

    async def _listener_loop(self) -> None:
        backoff = RETRY_INITIAL_SECONDS
        while self._running:
            ws = None
            try:
                ws = await _unix_connect(self.socket_path, self.connector_token)
                self._ws = ws
                backoff = RETRY_INITIAL_SECONDS
                async for raw in ws:
                    if not self._running and not self._draining:
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
                if ws:
                    try:
                        await ws.close()
                    except Exception:
                        pass
                owns_session = self._ws is ws
                if owns_session:
                    self._cancel_deferred_before_dispatch(
                        "relay IPC disconnected before Hermes dispatch"
                    )
                    self._ready_event.clear()
                    self._ws = None
                    if self._running:
                        await self._interrupt_all_active(
                            "relay IPC disconnected",
                            force_job_ids=self._take_interrupted_cancel_jobs(),
                        )
            if self._running:
                await asyncio.sleep(backoff + random.random() * backoff * 0.2)
                backoff = min(backoff * 2, RETRY_MAX_SECONDS)

    async def _handle_daemon_message(self, message: dict) -> None:
        message_type = message.get("type")
        if message_type == "hello_required":
            if message.get("protocolVersion") != CONNECTOR_PROTOCOL_VERSION:
                raise ValueError("daemon connector protocol mismatch")
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
                    "prestartFailure": True,
                    "draining": True,
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
            capabilities = message.get("capabilities")
            if (
                not isinstance(capabilities, dict)
                or capabilities.get("prestartFailure") is not True
                or capabilities.get("draining") is not True
            ):
                raise ValueError("daemon lacks pre-start failure/draining settlement")
            timeout_ms = message.get("resultStoreTimeoutMs")
            if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
                self._result_store_timeout = float(timeout_ms) / 1000.0
            # A failed.notStarted frame may have reached the daemon immediately
            # before the UDS transport closed while its result_stored ACK did
            # not make the return trip. Keep these proof tombstones for the
            # lifetime of the adapter and replay them before accepting new work
            # on each transport generation. The daemon can then reconcile a
            # disconnect/restart quarantine for a job that provably never ran.
            for job_id, (lease_id, error) in list(
                self._prestart_rejections.items()
            ):
                await self._send_prestart_rejection(job_id, lease_id, error)
            self._ready_event.set()
            return
        if message_type == "draining_ack":
            self._drain_ack_event.set()
            return
        if message_type == "job":
            await self._handle_job(message["job"])
            return
        if message_type == "cancel":
            await self._handle_cancel(message)
            return
        if message_type == "result_stored":
            job_id = str(message.get("jobId", ""))
            lease_id = str(message.get("leaseId", ""))
            rejected = self._prestart_rejections.get(job_id)
            if rejected and rejected[0] == lease_id:
                self._prestart_rejections.pop(job_id, None)
                self._prestart_ack_event.set()
                return
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

    async def _handle_job(self, job: dict) -> None:
        job_id = str(job["jobId"])
        lease_id = str(job["leaseId"])
        if self._draining:
            # A job already queued on the daemon's outbound WebSocket can arrive
            # immediately before draining_ack. It has not been accepted and must
            # never cross into Hermes after disconnect has closed the dispatch
            # gate. The drain path flushes and waits for this exact proof before
            # closing the transport.
            self._prestart_rejections[job_id] = (
                lease_id,
                REMOTE_DRAINING_REJECTED_ERROR,
            )
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
            timestamp=datetime.fromtimestamp(
                float(job.get("timestamp", 0)) / 1000,
                tz=timezone.utc,
            ) if job.get("timestamp") else datetime.now(tz=timezone.utc),
        )
        # Hermes 0.18.2 turns a small set of plain DM phrases such as
        # "restart gateway" into slash commands before its normal dispatcher
        # applies command authorization.  Apply that same normalization here,
        # then fail closed before any remote command reaches Hermes.  The exact
        # /sethome bootstrap command is the sole phase-1 exception.  Connector
        # cancellation uses _handle_cancel() directly and is therefore not
        # exposed through this remote text path.
        coerce_plaintext_gateway_command(event)
        normalized_text = (event.text or "").strip()
        session_state, session_key = self._remote_session_state(source)
        policy_error: Optional[str] = None
        if session_state in {"busy", "unsafe"}:
            # Phase 1 has one final and no control lane for a Hermes turn that
            # remains active after sending an interim prompt (notably tool
            # approval). Never enter Hermes' busy-message dispatcher from a
            # second LiViS job; this also closes the approval TOCTOU window.
            policy_error = REMOTE_BUSY_REJECTED_ERROR
        elif self._has_blocking_remote_approval(source):
            # A busy Hermes session upgrades bare words such as "yes" and
            # "always" into /approve. Phase 1 has no approval control lane,
            # so reject every remote reply while such a wait exists instead of
            # trying to mirror Hermes' evolving alias list.
            policy_error = REMOTE_APPROVAL_REJECTED_ERROR
        elif normalized_text.startswith("/"):
            sethome_available = not self._home_bootstrap_claimed
            if (
                normalized_text.casefold() == ALLOWED_REMOTE_COMMAND
                and sethome_available
            ):
                # Claim synchronously before the first await. Hermes executes
                # command handlers in a background task, so consulting only
                # config.home_channel would let an adjacent second /sethome
                # pass before the first task persists the home target.
                self._home_bootstrap_claimed = True
                # Hermes' MessageEvent.is_command() intentionally doesn't strip
                # whitespace. Canonicalize the one allowed bootstrap command so
                # the policy decision and Hermes dispatch cannot disagree.
                event.text = ALLOWED_REMOTE_COMMAND
            else:
                policy_error = REMOTE_COMMAND_REJECTED_ERROR

        if policy_error:
            self._prestart_rejections[job_id] = (lease_id, policy_error)
            await self._send_prestart_rejection(job_id, lease_id, policy_error)
            return

        deferred = DeferredJob(
            job_id=job_id,
            lease_id=lease_id,
            chat_id=chat_id,
            message_id=message_id,
            source=source,
            event=event,
            session_key=session_key,
        )
        if session_state == "settling":
            self._defer_job(deferred)
            return
        await self._dispatch_job(deferred)

    async def _dispatch_job(
        self,
        job: DeferredJob,
        *,
        from_deferred_queue: bool = False,
    ) -> None:
        self._job_by_message_id[job.job_id] = job.job_id
        self._job_by_message_id[job.message_id] = job.job_id
        self._active_job_by_chat[job.chat_id] = job.job_id
        self._lease_by_job[job.job_id] = job.lease_id
        self._source_by_job[job.job_id] = job.source
        if from_deferred_queue:
            job.state = "starting"
        try:
            await self._send_local({
                "type": "accepted",
                "jobId": job.job_id,
                "leaseId": job.lease_id,
            })
        except Exception as exc:
            self._release_job_maps(job.job_id)
            self._prestart_rejections[job.job_id] = (
                job.lease_id,
                f"Hermes dispatch never started: {exc}",
            )
            if not from_deferred_queue:
                # The transport is no longer trustworthy, so force the owner
                # listener through teardown/reconnect. The retained proof is
                # replayed on the next v2 hello and can reconcile the daemon's
                # conservative Interrupted quarantine for this exact lease.
                raise
            return

        if self._draining:
            # disconnect() can begin while the accepted frame is waiting on
            # transport backpressure. accepted means only that this adapter
            # generation took ownership; Hermes has still not seen the event.
            # Convert that narrow handoff into an exact non-execution proof.
            self._release_job_maps(job.job_id)
            self._prestart_rejections[job.job_id] = (
                job.lease_id,
                REMOTE_DRAINING_REJECTED_ERROR,
            )
            return

        if from_deferred_queue and job.cancel_requested:
            self._release_job_maps(job.job_id)
            self._prestart_rejections[job.job_id] = (
                job.lease_id,
                REMOTE_DEFERRED_CANCELLED_ERROR,
            )
            await self._send_prestart_rejection(
                job.job_id,
                job.lease_id,
                REMOTE_DEFERRED_CANCELLED_ERROR,
            )
            return

        if from_deferred_queue:
            job.state = "dispatching"
        try:
            # Hermes 0.18.2 installs the session guard and spawns its background
            # processing task before this coroutine returns. Awaiting that
            # registration step keeps a following cancel behind the job while
            # leaving result delivery in Hermes' background task.
            await self.handle_message(job.event)
        except Exception as exc:
            # In the reviewed 0.18.2 contract, handle_message returns only after
            # _start_session_processing has installed the guard and owner task.
            # An exception instead means registration never completed, so this
            # exact lease is provably not started. This distinction is crucial
            # when a Relay cancel already moved the daemon to Cancelling: an
            # ordinary failed frame would be superseded and strand that state.
            error = (
                REMOTE_DEFERRED_CANCELLED_ERROR
                if job.cancel_requested
                else f"Hermes dispatch never started: {exc}"
            )
            self._release_job_maps(job.job_id)
            self._prestart_rejections[job.job_id] = (job.lease_id, error)
            await self._send_prestart_rejection(job.job_id, job.lease_id, error)
            return
        if from_deferred_queue:
            # Transfer cancel ownership synchronously before the deferred task
            # can finish. Its done callback removes _deferred_jobs on a later
            # loop turn; a cancel in that narrow handoff window must therefore
            # fall through to the registered active-job path instead of merely
            # setting a flag that nobody will inspect again.
            job.state = "registered"
            if job.cancel_requested:
                await self._dispatch_registered_cancel(
                    job.job_id,
                    job.lease_id,
                    job.source,
                    {"type": "cancel", "jobId": job.job_id, "leaseId": job.lease_id},
                )

    def _defer_job(self, job: DeferredJob) -> None:
        existing = self._deferred_jobs.get(job.job_id)
        if existing is not None and existing.lease_id == job.lease_id:
            return
        self._deferred_jobs[job.job_id] = job
        task = asyncio.create_task(self._run_deferred_job(job))
        job.task = task

        def finish_deferred(completed: asyncio.Task) -> None:
            if self._deferred_jobs.get(job.job_id) is job:
                self._deferred_jobs.pop(job.job_id, None)
            try:
                error = completed.exception()
            except asyncio.CancelledError:
                return
            if error is not None:
                logger.error(
                    "Deferred LiViS job %s failed before cold dispatch: %s",
                    job.job_id,
                    error,
                    exc_info=(type(error), error, error.__traceback__),
                )

        task.add_done_callback(finish_deferred)

    async def _run_deferred_job(self, job: DeferredJob) -> None:
        await self._wait_for_session_release(job.session_key)
        if job.cancel_requested:
            return
        # The previous owner can finish with an orphaned blocking approval.
        # Recheck at the actual cold-dispatch boundary, not only when this job
        # was first offered by the daemon.
        if self._has_blocking_remote_approval(job.source):
            self._prestart_rejections[job.job_id] = (
                job.lease_id,
                REMOTE_APPROVAL_REJECTED_ERROR,
            )
            await self._send_prestart_rejection(
                job.job_id,
                job.lease_id,
                REMOTE_APPROVAL_REJECTED_ERROR,
            )
            return
        await self._dispatch_job(job, from_deferred_queue=True)

    async def _wait_for_session_release(self, session_key: str) -> None:
        while True:
            self._heal_stale_session_lock(session_key)
            if session_key not in self._active_sessions:
                self._settling_job_by_session.pop(session_key, None)
                return
            owner = self._session_tasks.get(session_key)
            if owner is None:
                await asyncio.sleep(0)
                continue
            try:
                await asyncio.shield(owner)
            except asyncio.CancelledError:
                current = asyncio.current_task()
                if current is not None and current.cancelling():
                    raise
            except Exception:
                pass

    def _cancel_deferred_before_dispatch(
        self,
        error: str,
    ) -> list[tuple[str, str, str]]:
        proofs: list[tuple[str, str, str]] = []
        for job in list(self._deferred_jobs.values()):
            if job.state == "dispatching":
                # handle_message may still be awaiting topic recovery before it
                # installs Hermes' guard. Keep cancel ownership with this task:
                # racing a new /stop from listener teardown could cold-register
                # the stop first and let the original job execute afterwards.
                job.cancel_requested = True
                continue
            if job.state not in {"waiting", "starting"}:
                continue
            job.cancel_requested = True
            if job.state == "starting":
                self._release_job_maps(job.job_id)
            self._prestart_rejections[job.job_id] = (job.lease_id, error)
            proofs.append((job.job_id, job.lease_id, error))
            if job.task is not None:
                job.task.cancel()
        return proofs

    def _take_interrupted_cancel_jobs(self) -> set[str]:
        interrupted = set(self._interrupted_cancel_jobs)
        self._interrupted_cancel_jobs.clear()
        return interrupted

    async def _handle_cancel(self, message: dict) -> None:
        job_id = str(message.get("jobId", ""))
        lease_id = str(message.get("leaseId", ""))
        rejected = self._prestart_rejections.get(job_id)
        if rejected and rejected[0] == lease_id:
            # The daemon may receive cancel before it commits our pre-start
            # failure. Reassert the non-execution fact; it can then settle the
            # job as Cancelled without quarantining a Hermes session that never
            # ran. Do not synthesize /stop for this path.
            await self._send_prestart_rejection(job_id, lease_id, rejected[1])
            return
        deferred = self._deferred_jobs.get(job_id)
        if (
            deferred is not None
            and deferred.lease_id == lease_id
            and deferred.state != "registered"
        ):
            deferred.cancel_requested = True
            if deferred.state == "waiting":
                self._prestart_rejections[job_id] = (
                    lease_id,
                    REMOTE_DEFERRED_CANCELLED_ERROR,
                )
                if deferred.task is not None:
                    deferred.task.cancel()
                await self._send_prestart_rejection(
                    job_id,
                    lease_id,
                    REMOTE_DEFERRED_CANCELLED_ERROR,
                )
            # A starting job checks this flag immediately after accepted; a
            # dispatching job checks it after Hermes registers its guard. Both
            # paths settle without racing /stop ahead of the original event.
            return
        if self._lease_by_job.get(job_id) != lease_id:
            return
        source = self._source_by_job.get(job_id)
        if source is None:
            return
        await self._dispatch_registered_cancel(job_id, lease_id, source, message)

    async def _dispatch_registered_cancel(
        self,
        job_id: str,
        lease_id: str,
        source: Any,
        message: dict,
    ) -> None:
        self._cancelled_jobs.add(job_id)
        try:
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
            await self._send_cancelled_once(job_id, lease_id)
        except asyncio.CancelledError:
            self._interrupted_cancel_jobs.add(job_id)
            raise

    async def _send_cancelled_once(self, job_id: str, lease_id: str) -> None:
        """Emit at most one cancellation signal for the current execution lease."""
        if self._lease_by_job.get(job_id) != lease_id:
            return
        notification = (job_id, lease_id)
        if notification in self._cancelled_notifications:
            return
        self._cancelled_notifications.add(notification)
        sent = False
        try:
            await self._send_local({
                "type": "cancelled",
                "jobId": job_id,
                "leaseId": lease_id,
            })
            sent = True
        finally:
            if not sent:
                self._cancelled_notifications.discard(notification)

    async def _send_prestart_rejection(
        self,
        job_id: str,
        lease_id: str,
        error: str,
    ) -> None:
        await self._send_local({
            "type": "failed",
            "jobId": job_id,
            "leaseId": lease_id,
            "error": error,
            "retryable": False,
            "notStarted": True,
        })

    async def _wait_for_prestart_acks(
        self,
        proofs: list[tuple[str, str, str]],
        *,
        timeout: float,
    ) -> None:
        """Wait until every drain snapshot proof has an exact durable ACK."""
        pending = {(job_id, lease_id) for job_id, lease_id, _error in proofs}
        if not pending:
            return
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            self._prestart_ack_event.clear()
            remaining = {
                (job_id, lease_id)
                for job_id, lease_id in pending
                if self._prestart_rejections.get(job_id, (None, None))[0] == lease_id
            }
            if not remaining:
                return
            delay = deadline - loop.time()
            if delay <= 0:
                raise LocalRelayUnavailable(
                    "livis-relayd didn't acknowledge pre-start failure storage"
                )
            try:
                await asyncio.wait_for(
                    self._prestart_ack_event.wait(),
                    timeout=delay,
                )
            except asyncio.TimeoutError as exc:
                raise LocalRelayUnavailable(
                    "livis-relayd didn't acknowledge pre-start failure storage"
                ) from exc

    def _has_blocking_remote_approval(self, source: Any) -> bool:
        runner = getattr(self, "gateway_runner", None)
        if runner is None:
            return False
        try:
            from tools.approval import has_blocking_approval

            session_key = runner._session_key_for_source(source)
            return bool(has_blocking_approval(session_key))
        except Exception:
            # A configured runner whose approval state cannot be read is not a
            # safe reason to expose remote approval shortcuts.
            logger.exception("Unable to verify LiViS remote approval state")
            return True

    def _remote_session_state(self, source: Any) -> tuple[str, str]:
        try:
            session_key = self._build_remote_session_key(source)
            # Mirror Hermes' own handle_message on-entry self-heal before
            # consulting its guard. A completed owner task must not turn this
            # phase-1 fail-closed check into a permanent denial of service.
            self._heal_stale_session_lock(session_key)
        except Exception:
            logger.exception("Unable to resolve LiViS Hermes session guard")
            return "unsafe", ""
        if session_key not in self._active_sessions:
            self._settling_job_by_session.pop(session_key, None)
            return "idle", session_key
        # Once the current job has emitted its unique final/failed signal, the
        # daemon may legitimately offer the next same-session job before the
        # owner task finishes cleanup. Keep it out of Hermes' busy-message
        # path: that path can emit an interim acknowledgement which phase 1
        # would mistake for the job's unique final. A bridge-owned deferred
        # task waits for a true cold-dispatch boundary while the socket reader
        # remains free for cancel, ACK and heartbeat frames.
        if session_key in self._settling_job_by_session:
            return "settling", session_key
        return "busy", session_key

    def _build_remote_session_key(self, source: Any) -> str:
        extra = getattr(self.config, "extra", {}) or {}
        return build_session_key(
            source,
            group_sessions_per_user=extra.get("group_sessions_per_user", True),
            thread_sessions_per_user=extra.get("thread_sessions_per_user", False),
        )

    def _mark_job_settling(self, job_id: str) -> None:
        source = self._source_by_job.get(job_id)
        if source is None:
            return
        try:
            session_key = self._build_remote_session_key(source)
        except Exception:
            logger.exception("Unable to mark LiViS Hermes session as settling")
            return
        if self._settling_job_by_session.get(session_key) == job_id:
            return
        self._settling_job_by_session[session_key] = job_id
        owner = self._session_tasks.get(session_key)
        if owner is None:
            return

        def clear_when_owner_finishes(_task) -> None:
            if self._settling_job_by_session.get(session_key) == job_id:
                self._settling_job_by_session.pop(session_key, None)

        owner.add_done_callback(clear_when_owner_finishes)

    async def _persist_result(self, job_id: str, lease_id: str, content: str) -> None:
        await self._persist_terminal({
            "type": "result",
            "jobId": job_id,
            "leaseId": lease_id,
            "text": content,
        })

    async def _persist_failure(self, job_id: str, lease_id: str, error: str) -> None:
        await self._persist_terminal({
            "type": "failed",
            "jobId": job_id,
            "leaseId": lease_id,
            "error": error,
            "retryable": False,
        })

    async def _persist_terminal(self, message: dict) -> None:
        job_id = str(message["jobId"])
        lease_id = str(message["leaseId"])
        if not self._ready_event.is_set() or self._ws is None:
            raise LocalRelayUnavailable("livis-relayd connector isn't ready")
        loop = asyncio.get_running_loop()
        waiter = self._result_waiters.get(job_id)
        if waiter is None or waiter.done():
            waiter = loop.create_future()
            self._result_waiters[job_id] = waiter
        await self._send_local(message)
        try:
            acknowledged_lease = await asyncio.wait_for(
                asyncio.shield(waiter), timeout=self._result_store_timeout
            )
        except asyncio.CancelledError:
            if self._result_waiters.get(job_id) is waiter:
                self._result_waiters.pop(job_id, None)
            if not waiter.done():
                waiter.cancel()
            raise
        except asyncio.TimeoutError as exc:
            raise LocalRelayUnavailable("livis-relayd didn't acknowledge durable result storage") from exc
        finally:
            if waiter.done():
                self._result_waiters.pop(job_id, None)
        if acknowledged_lease != lease_id:
            raise LocalRelayUnavailable("livis-relayd acknowledged a different execution lease")

    async def _send_local(self, message: dict) -> None:
        ws = self._ws
        if ws is None:
            raise LocalRelayUnavailable("livis-relayd IPC is disconnected")
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ValueError("connector frame too large")
        # Serialize every WebSocket write. In particular, an accepted frame
        # already waiting on local backpressure must remain ahead of the later
        # draining gate; concurrent websockets.send calls are not a supported
        # ordering primitive across library versions.
        async with self._send_lock:
            if self._ws is not ws:
                raise LocalRelayUnavailable("livis-relayd IPC generation changed")
            await ws.send(encoded)

    async def _interrupt_all_active(
        self,
        reason: str,
        *,
        force_job_ids: Optional[set[str]] = None,
    ) -> None:
        forced = force_job_ids or set()
        active = list(self._source_by_job.items())
        for job_id, source in active:
            deferred = self._deferred_jobs.get(job_id)
            if deferred is not None and deferred.state == "dispatching":
                # The deferred task will issue /stop immediately after the
                # original handle_message call has registered the correct guard.
                # Do not let teardown race a standalone /stop ahead of it.
                deferred.cancel_requested = True
                continue
            if job_id in self._cancelled_jobs and job_id not in forced:
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
        for notification in list(self._cancelled_notifications):
            if notification[0] == job_id:
                self._cancelled_notifications.discard(notification)
        self._result_waiters.pop(job_id, None)
        self._final_by_job.pop(job_id, None)
        self._stored_final_jobs.discard(job_id)
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
    enabled = {"socket_path": socket_path, "phase1_read_only": True}
    home_channel = os.getenv("LIVIS_HOME_CHANNEL", "").strip()
    if home_channel:
        thread_id = os.getenv("LIVIS_HOME_CHANNEL_THREAD_ID", "").strip()
        enabled["home_channel"] = {
            "chat_id": home_channel,
            "name": "LiViS",
            "thread_id": thread_id or None,
        }
    return enabled


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
            "approvals, attachments, tool-progress messages, or remote admin commands "
            "apart from the one-time /sethome bootstrap."
        ),
    )

"""真实连接 Bun ConnectorServer 的跨语言 UDS 测试客户端。"""

from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

import websockets


async def receive_json(websocket: Any, expected_type: str, timeout: float) -> dict[str, Any]:
    raw = await asyncio.wait_for(websocket.recv(), timeout=timeout)
    message = json.loads(raw)
    if not isinstance(message, dict):
        raise AssertionError(f"{expected_type} 不是 JSON object：{message!r}")
    if message.get("type") != expected_type:
        raise AssertionError(f"期待 {expected_type}，实际收到：{message!r}")
    return message


async def connect(socket_path: str, token: str):
    options = {
        "uri": "ws://localhost/v1/connectors/hermes",
        "open_timeout": 5,
        "close_timeout": 2,
        "ping_interval": None,
    }
    headers = {"Authorization": f"Bearer {token}"}
    try:
        return await websockets.unix_connect(
            socket_path,
            additional_headers=headers,
            **options,
        )
    except TypeError:
        return await websockets.unix_connect(
            socket_path,
            extra_headers=headers,
            **options,
        )


async def run(args: argparse.Namespace) -> None:
    async with await connect(args.socket, args.token) as websocket:
        hello_required = await receive_json(websocket, "hello_required", args.timeout)
        if hello_required.get("protocolVersion") != 1:
            raise AssertionError(f"不兼容的 hello protocol：{hello_required!r}")

        await websocket.send(
            json.dumps(
                {
                    "type": "hello",
                    "protocolVersion": 1,
                    "connectorId": args.connector_id,
                    "backend": "hermes",
                    "implementation": {
                        "name": "livis-hermes-bridge",
                        "version": "0.1.0",
                        "runtimeVersion": "0.15.1",
                    },
                    "capabilities": {"cancel": True, "finalResult": True},
                }
            )
        )

        hello_ack = await receive_json(websocket, "hello_ack", args.timeout)
        if hello_ack != {
            "type": "hello_ack",
            "protocolVersion": 1,
            "connectorId": args.connector_id,
            "daemonVersion": "test",
            "resultStoreTimeoutMs": 5000,
        }:
            raise AssertionError(f"hello_ack 字段不匹配：{hello_ack!r}")

        offered = await receive_json(websocket, "job", args.timeout)
        if offered.get("protocolVersion") != 1:
            raise AssertionError(f"不兼容的 job protocol：{offered!r}")
        job = offered.get("job")
        if not isinstance(job, dict):
            raise AssertionError(f"job payload 缺失：{offered!r}")
        if job.get("jobId") != args.job_id or job.get("leaseId") != args.lease_id:
            raise AssertionError(f"job/lease 关联错误：{offered!r}")
        if job.get("text") != args.expected_text:
            raise AssertionError(f"job 文本错误：{offered!r}")

        await websocket.send(
            json.dumps(
                {
                    "type": "accepted",
                    "jobId": args.job_id,
                    "leaseId": args.lease_id,
                }
            )
        )
        await websocket.send(
            json.dumps(
                {
                    "type": "result",
                    "jobId": args.job_id,
                    "leaseId": args.lease_id,
                    "text": args.result_text,
                }
            )
        )

        result_stored = await receive_json(websocket, "result_stored", args.timeout)
        if result_stored != {
            "type": "result_stored",
            "jobId": args.job_id,
            "leaseId": args.lease_id,
        }:
            raise AssertionError(f"result_stored 关联错误：{result_stored!r}")

    print(
        json.dumps(
            {
                "connectorId": args.connector_id,
                "jobId": args.job_id,
                "leaseId": args.lease_id,
                "resultStored": True,
            }
        ),
        flush=True,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--connector-id", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--lease-id", required=True)
    parser.add_argument("--expected-text", required=True)
    parser.add_argument("--result-text", required=True)
    parser.add_argument("--timeout", type=float, default=5.0)
    return parser.parse_args()


if __name__ == "__main__":
    asyncio.run(run(parse_args()))

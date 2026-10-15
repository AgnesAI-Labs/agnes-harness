"""Real heartbeat/reconnect timing; run centrally with the heavy protocol checks."""
import asyncio
import json
import unittest
from agnes_mhs import Device, connect_device
from websockets.asyncio.server import serve

class ConnectionTimingTests(unittest.IsolatedAsyncioTestCase):
    async def test_ping_reconnect_and_replacement(self):
        registrations = 0
        ping = asyncio.Event()
        replaced = asyncio.Event()
        async def handler(ws):
            nonlocal registrations
            if ws.request.path == "/ws/nerve":
                await ws.recv()
                await ws.wait_closed()
                return
            await ws.recv()
            registrations += 1
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": "register", "result": {}}))
            if registrations == 1:
                await ws.close()
                return
            async for raw in ws:
                message = json.loads(raw)
                if message.get("method") == "mhs/ping":
                    ping.set()
                    await ws.send(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}))
                    await ws.close(4001, "replaced")
                    replaced.set()
                    return
        device = Device({"protocol": "mhs/v1", "device": {"id": "timing", "kind": "sensor"}})
        async with serve(handler, "127.0.0.1", 0, subprotocols=["mhs.v1"]) as server:
            task = asyncio.create_task(connect_device(device, f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"))
            try:
                await asyncio.wait_for(ping.wait(), 7)
                await asyncio.wait_for(replaced.wait(), 2)
                result = await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 2)
                self.assertIsInstance(result[0], Exception)
                self.assertEqual(registrations, 2)
                self.assertTrue(device.closed)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_execution_deadline_includes_time_queued_for_a_resource(self):
        device = Device({"protocol": "mhs/v1", "device": {"id": "queued", "kind": "sensor"},
            "resources": {"worker": "queue"}, "tools": [
                {"name": "block", "description": "Hold worker", "timeout": 1, "uses": ["worker"], "inputSchema": {"type": "object"}},
                {"name": "quick", "description": "Short deadline", "timeout": .02, "uses": ["worker"], "inputSchema": {"type": "object"}}]})
        gate = asyncio.Event()
        async def block(args, call):
            await gate.wait()
        async def quick(args, call):
            return "must not start while queued"
        device.tool("block", block).tool("quick", quick)
        _, first = device.call("first", "block", {})
        _, queued = device.call("queued", "quick", {})
        try:
            self.assertEqual(await queued, {"status": "error", "reason": "timeout"})
        finally:
            gate.set()
            await first
            await device.disconnect()

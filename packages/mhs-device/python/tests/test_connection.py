import asyncio
import json
import unittest
from agnes_mhs import Device, connect_device
from websockets.asyncio.server import serve


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_dual_channels_state_call_and_stop(self):
        registered = asyncio.Event()
        paired = asyncio.Event()
        completed = asyncio.Future()
        command = None
        stops = []
        description = {"protocol": "mhs/v1", "device": {"id": "sensor", "kind": "sensor"}, "state": {"temperature": {"type": "number"}}, "tools": [{"name": "read", "description": "Read", "timeout": 1, "inputSchema": {"type": "object"}}]}
        device = Device(description)
        device.update({"temperature": 22})
        async def read(_args, _call):
            return {"temperature": 22}
        device.tool("read", read)
        async def handler(ws):
            nonlocal command
            if ws.request.path == "/ws/nerve":
                hello = json.loads(await ws.recv())
                self.assertEqual(hello, {"type": "hello", "device": "sensor"})
                paired.set()
                await ws.wait_closed()
                return
            command = ws
            register = json.loads(await ws.recv())
            self.assertEqual(register["method"], "mhs/register")
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": "register", "result": {"session": "test", "hub": {"name": "fake", "version": "1"}, "time": 1}}))
            registered.set()
            async for raw in ws:
                message = json.loads(raw)
                if message.get("method") == "mhs/result" and not completed.done():
                    completed.set_result(message["params"])
                if message.get("id") == "stop":
                    stops.append(message)
        async with serve(handler, "127.0.0.1", 0, subprotocols=["mhs.v1"]) as server:
            port = server.sockets[0].getsockname()[1]
            task = asyncio.create_task(connect_device(device, f"ws://127.0.0.1:{port}"))
            try:
                await asyncio.wait_for(registered.wait(), 2)
                await asyncio.wait_for(paired.wait(), 2)
                await command.send(json.dumps({"jsonrpc": "2.0", "id": "call", "method": "mhs/call", "params": {"name": "read", "arguments": {}}}))
                self.assertEqual((await asyncio.wait_for(completed, 2))["data"], {"temperature": 22})
                await command.send(json.dumps({"jsonrpc": "2.0", "id": "stop", "method": "mhs/stop", "params": {}}))
                for _ in range(20):
                    if stops:
                        break
                    await asyncio.sleep(.01)
                self.assertTrue(stops)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                self.assertTrue(device.closed)

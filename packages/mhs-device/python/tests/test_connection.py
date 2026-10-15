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
        frames = asyncio.Future()
        nerve_socket = None
        command = None
        stops = []
        description = {"protocol": "mhs/v1", "device": {"id": "sensor", "kind": "sensor"}, "sources": [{"id": "camera", "kind": "image", "description": "Camera"}], "state": {"temperature": {"type": "number"}}, "tools": [{"name": "read", "description": "Read", "timeout": 1, "inputSchema": {"type": "object"}}]}
        device = Device(description)
        device.update({"temperature": 22})
        async def read(_args, _call):
            return {"temperature": 22}
        device.tool("read", read)
        async def handler(ws):
            nonlocal command, nerve_socket
            if ws.request.path == "/ws/nerve":
                nerve_socket = ws
                hello = json.loads(await ws.recv())
                self.assertEqual(hello, {"type": "hello", "device": "sensor"})
                paired.set()
                header = json.loads(await ws.recv())
                payload = await ws.recv()
                frames.set_result((header, payload))
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
                await device.configure({"camera": {"on": True}})
                self.assertTrue(await device.publish("camera", {"w": 1, "h": 1}, b"\x01\x02", "image/png"))
                header, payload = await asyncio.wait_for(frames, 2)
                self.assertEqual(header["bytes"], 2)
                self.assertEqual(payload, b"\x01\x02")
                await nerve_socket.send(json.dumps({"type": "clip", "id": "speech", "rate": 24000, "channels": 1}))
                await nerve_socket.send(b"\x01\x00")
                for _ in range(20):
                    if device.clip("speech"):
                        break
                    await asyncio.sleep(0)
                self.assertEqual(device.clip("speech")["pcm"], b"\x01\x00")
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

    async def test_refuses_clip_binary_order_and_format(self):
        for frames in ([b"\x00\x00"], [{"type": "clip", "id": "bad", "rate": 24000, "channels": 0}], [{"type": "clip", "id": "bad", "rate": 24000, "channels": 1}, {"type": "manual", "axes": {}}]):
            with self.subTest(frames=frames):
                async def handler(ws):
                    if ws.request.path == "/ws/nerve":
                        await ws.recv()
                        for frame in frames:
                            await ws.send(frame if isinstance(frame, bytes) else json.dumps(frame))
                        await ws.wait_closed()
                        return
                    await ws.recv()
                    await ws.send(json.dumps({"jsonrpc": "2.0", "id": "register", "result": {}}))
                    await ws.wait_closed()
                device = Device({"protocol": "mhs/v1", "device": {"id": "refusal", "kind": "sensor"}})
                async with serve(handler, "127.0.0.1", 0, subprotocols=["mhs.v1"]) as server:
                    from agnes_mhs import MhsError
                    with self.assertRaises(MhsError):
                        await asyncio.wait_for(connect_device(device, f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"), 2)
                    self.assertTrue(device.closed)
                    self.assertIsNone(device.clip("bad"))

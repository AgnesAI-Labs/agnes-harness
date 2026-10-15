import asyncio
import unittest
import json
from pathlib import Path
from agnes_mhs import Device, MhsError, prepare, registration

DESCRIPTION = {"protocol": "mhs/v1", "device": {"id": "rover", "kind": "robot"}, "resources": {"drive": "reject"}, "manual": {"axes": [{"id": "vx", "min": -1, "max": 1}], "deadman_s": .1}, "tools": [{"name": "move", "description": "Move", "timeout": 2, "motion": True, "uses": ["drive"], "inputSchema": {"type": "object", "properties": {"x": {"type": "number", "minimum": -2, "maximum": 2}}, "required": ["x"]}}]}


class DeviceTests(unittest.IsolatedAsyncioTestCase):
    async def test_resources_stop_and_safety_refusal(self):
        stopped = []
        class Safety:
            def arm(self, ms):
                pass
            async def stop(self, reason):
                stopped.append(reason)
        device = Device(DESCRIPTION, Safety())
        async def move(args, call):
            await asyncio.sleep(30)
        device.tool("move", move)
        acceptance, task = device.call("one", "move", {"x": 99})
        self.assertTrue(acceptance["accepted"])
        self.assertEqual(device.call("two", "move", {"x": 1})[0], {"accepted": False, "reason": "busy", "holder": {"call": "one", "tool": "move"}})
        await asyncio.sleep(0)
        await device.stop()
        self.assertEqual((await task)["status"], "interrupted")
        self.assertIn("stop", stopped)
        unsafe = Device(DESCRIPTION).tool("move", move)
        self.assertEqual(unsafe.call("one", "move", {"x": 1})[0]["reason"], "unsafe")

    async def test_pause_progress_after_rest(self):
        from agnes_mhs.device import Call
        progress = []
        call = Call("paused")
        call.progress = lambda data: progress.append(data)
        call.paused.clear()
        checkpoint = asyncio.create_task(call.checkpoint())
        await call.rested.wait()
        self.assertEqual(progress, [{"state": "paused"}])
        call.paused.set()
        await checkpoint
        self.assertEqual(progress[-1], {"state": "running"})

    async def test_manual_clamps_and_zeros_on_disconnect(self):
        seen = []
        class Safety:
            def arm(self, ms):
                self.ms = ms
            async def stop(self, reason):
                seen.append(reason)
        device = Device(DESCRIPTION, Safety())
        async def manual(axes):
            seen.append(axes)
        device.on_manual = manual
        await device.manual({"vx": 99})
        self.assertEqual(seen[-1], {"vx": 1})
        device.receive_clip("audio", 24000, 1, b"\x00\x00")
        self.assertEqual(device.clip("audio")["pcm"], b"\x00\x00")
        sensor = Device({"protocol": "mhs/v1", "device": {"id": "sensor", "kind": "sensor"}, "sources": [{"id": "text", "kind": "text", "description": "Text"}]})
        await sensor.configure({"text": {"on": False}})
        self.assertFalse(await sensor.publish("text", {"text": "hidden"}))
        await device.disconnect()
        self.assertEqual(seen[-1], {"vx": 0})
        with self.assertRaises(MhsError):
            await device.manual({"vx": 1})

    async def test_queue_and_needs(self):
        description = {**DESCRIPTION, "resources": {"drive": "queue"}, "sources": [{"id": "pose", "kind": "pose", "description": "Position"}, {"id": "camera", "kind": "image", "description": "Camera"}], "tools": [{**DESCRIPTION["tools"][0], "needs": ["camera"]}]}
        class Safety:
            def arm(self, ms):
                pass
            async def stop(self, reason):
                pass
        device = Device(description, Safety())
        gate = asyncio.Event()
        started = []
        async def move(args, call):
            started.append(call.id)
            await gate.wait()
        device.tool("move", move)
        self.assertEqual(device.call("missing", "move", {"x": 1})[0], {"accepted": False, "reason": "needs", "needs": ["camera"]})
        await device.configure({"camera": {"on": True}})
        _, first = device.call("first", "move", {"x": 1})
        _, second = device.call("second", "move", {"x": 1})
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        for _ in range(3):
            await asyncio.sleep(0)
        self.assertEqual(started, ["first"])
        gate.set()
        self.assertEqual((await first)["status"], "done")
        self.assertEqual((await second)["status"], "done")
        self.assertEqual(started, ["first", "second"])
        await device.disconnect()

    def test_schema_and_arguments(self):
        cases = json.loads((Path(__file__).parents[2] / "test" / "arguments.json").read_text())
        for row in cases:
            if row.get("error"):
                with self.assertRaises(MhsError):
                    prepare(row["schema"], row["value"])
            else:
                self.assertEqual(prepare(row["schema"], row["value"]), row["expected"])
        from agnes_mhs.validation import observation
        for source, data, payload in (({"kind": "scan"}, {"angle_min": 0, "angle_inc": 1, "ranges": ["invalid"]}, None), ({"kind": "audio"}, {"rate": 24000, "channels": 2}, b"\x00\x00"), ({"kind": "pose"}, {"map": "site", "x": 0, "y": 0, "yaw": 0, "ok": True, "cov": [-1, 0, 0, 0, 0, 0, 0, 0, 0]}, None)):
            with self.assertRaises(MhsError):
                observation(source, data, payload)
        self.assertEqual(registration(DESCRIPTION)["device"]["id"], "rover")
        self.assertEqual(prepare(DESCRIPTION["tools"][0]["inputSchema"], {"x": 99, "extra": True}), {"x": 2})
        for invalid in (True, float("nan"), "1"):
            with self.assertRaises(MhsError):
                prepare({"type": "number"}, invalid)
        with self.assertRaises(MhsError):
            registration({**DESCRIPTION, "manual": {**DESCRIPTION["manual"], "deadman_s": 3}})

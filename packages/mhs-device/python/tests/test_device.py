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
        self.assertEqual(device.call("two", "move", {"x": 1})[0]["reason"], "busy")
        await asyncio.sleep(0)
        await device.stop()
        self.assertEqual((await task)["status"], "interrupted")
        self.assertIn("stop", stopped)
        unsafe = Device(DESCRIPTION).tool("move", move)
        self.assertEqual(unsafe.call("one", "move", {"x": 1})[0]["reason"], "unsafe")

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
        await device.disconnect()
        self.assertEqual(seen[-1], {"vx": 0})
        with self.assertRaises(MhsError):
            await device.manual({"vx": 1})

    def test_schema_and_arguments(self):
        cases = json.loads((Path(__file__).parents[2] / "test" / "arguments.json").read_text())
        for row in cases:
            if row.get("error"):
                with self.assertRaises(MhsError):
                    prepare(row["schema"], row["value"])
            else:
                self.assertEqual(prepare(row["schema"], row["value"]), row["expected"])
        self.assertEqual(registration(DESCRIPTION)["device"]["id"], "rover")
        self.assertEqual(prepare(DESCRIPTION["tools"][0]["inputSchema"], {"x": 99, "extra": True}), {"x": 2})
        for invalid in (True, float("nan"), "1"):
            with self.assertRaises(MhsError):
                prepare({"type": "number"}, invalid)
        with self.assertRaises(MhsError):
            registration({**DESCRIPTION, "manual": {**DESCRIPTION["manual"], "deadman_s": 3}})

import asyncio
import json
from typing import Any, Callable

from websockets.asyncio.server import serve

from agnes_mhs import Device, is_valid
from kit import make_device


class FakeHub:
    """A hub speaking both channels by hand, so each test controls every message."""

    def __init__(self) -> None:
        self.cmd: Any = None
        self.nerve: Any = None
        self.registrations = 0
        self.registered = asyncio.Event()
        self.cmd_in: list[dict] = []
        self.nerve_in: list[Any] = []
        self.close_code: int | None = None
        self._next = 0

    async def start(self) -> str:
        self.server = await serve(self._handler, "127.0.0.1", 0, subprotocols=["mhs.v1"])
        port = self.server.sockets[0].getsockname()[1]
        return f"ws://127.0.0.1:{port}"

    async def _handler(self, ws: Any) -> None:
        if ws.request.path == "/ws/mhs":
            register = json.loads(await ws.recv())
            assert register["method"] == "mhs/register" and is_valid("RegisterParams", register["params"])
            self.description = register["params"]
            self.cmd = ws
            if self.close_code is not None:
                await ws.close(self.close_code)
                return
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": "1", "result": {"session": "s1", "hub": {"name": "fake", "version": "0"}, "time": 0}}))
            self.registrations += 1
            self.registered.set()
            async for raw in ws:
                self.cmd_in.append(json.loads(raw))
        else:
            hello = json.loads(await ws.recv())
            assert hello == {"type": "hello", "device": "dev-01"}
            self.nerve = ws
            async for raw in ws:
                self.nerve_in.append(raw if isinstance(raw, bytes) else json.loads(raw))

    async def expect(self, inbox: list, match: Callable[[Any], bool], timeout: float = 2.0) -> Any:
        for _ in range(int(timeout / 0.01)):
            for i, m in enumerate(inbox):
                if match(m):
                    return inbox.pop(i)
            await asyncio.sleep(0.01)
        raise AssertionError(f"no matching message in {inbox}")

    async def request(self, method: str, params: dict) -> dict:
        self._next += 1
        rid = f"h{self._next}"
        await self.cmd.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
        return (await self.expect(self.cmd_in, lambda m: m.get("id") == rid))["result"]

    async def call(self, name: str, args: dict) -> tuple[str, dict]:
        self._next += 1
        rid = f"c{self._next}"
        await self.cmd.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": "mhs/call", "params": {"name": name, "arguments": args}}))
        return rid, (await self.expect(self.cmd_in, lambda m: m.get("id") == rid))["result"]

    async def result(self, call_id: str) -> dict:
        msg = await self.expect(self.cmd_in, lambda m: m.get("method") == "mhs/result" and m["params"]["call"] == call_id)
        assert is_valid("ResultParams", msg["params"])
        return msg["params"]


def run(test: Callable[[FakeHub, Device, dict], Any]) -> None:
    async def main() -> None:
        hub = FakeHub()
        url = await hub.start()
        dev, seen = make_device()
        task = asyncio.ensure_future(dev.run(url))
        try:
            await asyncio.wait_for(hub.registered.wait(), 5)
            for _ in range(100):
                if hub.nerve is not None:
                    break
                await asyncio.sleep(0.01)
            await test(hub, dev, seen)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            hub.server.close()

    asyncio.run(main())


def test_a_call_is_accepted_checked_and_reported():
    async def body(hub, dev, seen):
        call_id, reply = await hub.call("say", {"text": "hello world", "volume": 3})
        assert reply == {"accepted": True}
        result = await hub.result(call_id)
        assert result["status"] == "done" and result["detail"] == "said hello"
        assert result["notes"] == ["dropped unknown parameter volume", "text was truncated to 5 characters"]
        assert result["after"]["odometry"]["x"] == 0
        _, invalid = await hub.call("move", {})
        assert invalid["reason"] == "invalid"
        _, unknown = await hub.call("dance", {})
        assert unknown["reason"] == "invalid"
        jam_id, _ = await hub.call("jam", {})
        assert (await hub.result(jam_id))["reason"] == "stuck"
    run(body)


def test_busy_names_the_holder_and_queue_waits():
    async def body(hub, dev, seen):
        first, _ = await hub.call("move", {"x": 1})
        _, busy = await hub.call("move", {"x": 1})
        assert busy["reason"] == "busy" and busy["holder"] == {"call": first, "tool": "move"}
        a, _ = await hub.call("say", {"text": "a"})
        b, reply = await hub.call("say", {"text": "b"})
        assert reply == {"accepted": True}
        assert (await hub.result(a))["status"] == "done" and (await hub.result(b))["status"] == "done"
    run(body)


def test_stop_zeroes_motion_first_and_interrupts_motion_calls():
    async def body(hub, dev, seen):
        move_id, _ = await hub.call("move", {"x": 1})
        await asyncio.sleep(0.05)
        assert await hub.request("mhs/stop", {}) == {"stopped": [move_id]}
        assert seen["stops"] == 1
        assert (await hub.result(move_id))["reason"] == "stop"
        assert await hub.request("mhs/cancel", {"call": move_id}) == {"cancelled": False}
    run(body)


def test_cancel_pause_and_resume():
    async def body(hub, dev, seen):
        move_id, _ = await hub.call("move", {"x": 1})
        assert await hub.request("mhs/pause", {"call": move_id}) == {"paused": True}
        await hub.expect(hub.cmd_in, lambda m: m.get("params", {}).get("state") == "paused")
        assert await hub.request("mhs/resume", {"call": move_id}) == {"resumed": True}
        await hub.expect(hub.cmd_in, lambda m: m.get("params", {}).get("state") == "running")
        assert await hub.request("mhs/cancel", {"call": move_id}) == {"cancelled": True}
        assert (await hub.result(move_id))["reason"] == "cancel"
        say_id, _ = await hub.call("say", {"text": "x"})
        assert await hub.request("mhs/pause", {"call": say_id}) == {"paused": False}
    run(body)


def test_manual_input_takes_over_and_the_deadman_stops_it():
    async def body(hub, dev, seen):
        move_id, _ = await hub.call("move", {"x": 1})
        await hub.nerve.send(json.dumps({"type": "manual", "axes": {"vx": 3}}))
        assert (await hub.result(move_id))["reason"] == "manual"
        assert seen["manual"][0] == {"vx": 0.5}
        _, busy = await hub.call("move", {"x": 1})
        assert busy["holder"] == {"manual": True}
        await asyncio.sleep(0.4)
        assert seen["manual"][-1] == {"vx": 0.0}
        _, reply = await hub.call("move", {"x": 1})
        assert reply == {"accepted": True}
    run(body)


def test_sources_follow_configure_and_send_binary_after_their_message():
    async def body(hub, dev, seen):
        cam = seen["cam"]
        assert await hub.request("mhs/configure", {"sources": {"cam": {"on": True, "hz": 50}}}) == {"sources": {"cam": {"on": True, "hz": 10}}}
        assert cam.send({"w": 2, "h": 2}, b"\xff\xd8")
        data = await hub.expect(hub.nerve_in, lambda m: isinstance(m, dict) and m.get("type") == "data")
        assert data["bin"] is True and data["seq"] == 0 and is_valid("NerveData", data)
        assert await hub.expect(hub.nerve_in, lambda m: isinstance(m, bytes)) == b"\xff\xd8"
        await hub.request("mhs/configure", {"sources": {"cam": {"on": False}}})
        assert not cam.send({"w": 2, "h": 2}, b"\x00")
    run(body)


def test_time_keyframe_and_clips():
    async def body(hub, dev, seen):
        assert isinstance((await hub.request("mhs/time", {}))["t"], float)
        assert await hub.request("mhs/keyframe", {"sources": ["cam"]}) == {"sources": []}
        await hub.nerve.send(json.dumps({"type": "clip", "id": "a1", "rate": 24000, "channels": 1}))
        await hub.nerve.send(b"\x01\x00")
        await asyncio.sleep(0.05)
        clip = dev.clip("a1")
        assert clip is not None and clip.pcm == b"\x01\x00" and clip.rate == 24000
    run(body)


def test_losing_the_command_channel_stops_and_ends_calls_then_reconnects():
    async def body(hub, dev, seen):
        await hub.call("move", {"x": 1})
        await hub.cmd.close()
        for _ in range(200):
            if hub.registrations == 2:
                break
            await asyncio.sleep(0.01)
        assert hub.registrations == 2
        assert seen["stops"] == 1
        assert not dev._calls
    run(body)


def test_a_replaced_device_does_not_reconnect():
    async def main():
        hub = FakeHub()
        hub.close_code = 4001
        url = await hub.start()
        dev, _ = make_device()
        await asyncio.wait_for(dev.run(url), 5)
        hub.server.close()

    asyncio.run(main())


def test_state_is_reported_in_full_then_on_change_and_settings_are_checked():
    async def body(hub, dev, seen):
        first = await hub.expect(hub.cmd_in, lambda m: m.get("method") == "mhs/state")
        assert first["params"]["values"] == {"problem": None, "faults": [], "mode": "idle", "battery": 90, "speed": 0.5}
        dev.update(battery=89, mode="idle")
        change = await hub.expect(hub.cmd_in, lambda m: m.get("method") == "mhs/state")
        assert change["params"]["values"] == {"battery": 89}
        result = await hub.request("mhs/set", {"values": {"speed": 3, "battery": 50, "ghost": 1}})
        assert result == {"values": {"speed": 1}, "notes": ["speed was 3, clamped to 1"],
                          "refused": {"battery": "not writable", "ghost": "not a state field"}}
        assert is_valid("SetResult", result)
        set_change = await hub.expect(hub.cmd_in, lambda m: m.get("method") == "mhs/state")
        assert set_change["params"]["values"] == {"speed": 1} and seen["speed"] == 1

        def broken(name: str, value: object) -> None:
            raise RuntimeError("motor controller offline")

        dev.on_set = broken
        result = await hub.request("mhs/set", {"values": {"speed": 0.7}})
        assert result == {"values": {}, "refused": {"speed": "could not apply: motor controller offline"}}
        assert dev.state["speed"] == 1
    run(body)

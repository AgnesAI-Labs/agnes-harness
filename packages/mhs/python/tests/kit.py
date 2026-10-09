"""A device for the tests: tools that take time, a reject and a queue resource, manual control, a
camera with a detector, odometry, and state with a writable field. It is not a product; the demo
devices live in the 3D world."""

import asyncio
import struct
import zlib
from typing import Any

from agnes_mhs import CallError, Device


def png(w: int, h: int) -> bytes:
    """A gray PNG of w x h pixels."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\x00" + bytes([128] * w) for _ in range(h))
    header = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def make_device(per_meter: float = 1.0) -> tuple[Device, dict]:
    """The device and what it saw; seen["produce"] is the loop that moves it and streams. A move
    takes about per_meter seconds per meter."""
    seen: dict[str, Any] = {"stops": 0, "manual": []}
    sim = {"v": 0.0, "x": 0.0}
    dev = Device("dev-01", "car", mobile=True, resources={"chassis": "reject", "speaker": "queue"},
                 manual={"axes": [{"id": "vx", "role": "forward", "unit": "m/s", "min": -0.5, "max": 0.5}], "rate_hz": 10, "deadman_s": 0.2},
                 state={"mode": {"type": "string", "enum": ["idle", "moving"]},
                        "battery": {"type": "integer", "unit": "%", "min": 0, "max": 100},
                        "speed": {"type": "number", "unit": "m/s", "min": 0.1, "max": 1, "writable": True}})  # fmt: skip
    dev.update(mode="idle", battery=90, speed=0.5)
    dev.on_set = lambda name, value: seen.__setitem__(name, value)
    dev.after = lambda: {"odometry": {"x": round(sim["x"], 3), "y": 0, "yaw": 0, "v": sim["v"], "w": 0}}

    def stop() -> None:
        seen["stops"] += 1
        sim["v"] = 0.0

    def manual(axes: dict[str, float]) -> None:
        seen["manual"].append(axes)
        sim["v"] = axes.get("vx", 0.0)

    dev.on_stop = stop
    dev.on_manual = manual
    cam = dev.source("cam", "image", "front camera", mime="image/png", hz=10, size=[4, 4], fov_deg=[60, 40],
                     mount={"xyz": [0.1, 0, 0.2], "rpy": [0, 0, 0]})  # fmt: skip
    people = dev.source("people", "detections", "people in the front camera", of="cam", hz=10, model={"name": "test-det", "version": "1"})
    odometry = dev.source("odometry", "odometry", "wheel odometry", hz=20)
    seen["cam"] = cam
    picture = png(4, 4)

    async def produce() -> None:
        while True:
            await asyncio.sleep(0.02)
            sim["x"] += sim["v"] * 0.02
            if odometry.wants():
                odometry.send({"x": round(sim["x"], 3), "y": 0, "yaw": 0, "v": sim["v"], "w": 0})
            if cam.wants() and cam.send({"w": 4, "h": 4}, picture):
                item = {"label": "person", "conf": 0.9, "box": [1, 1, 3, 3], "bearing": 5}
                people.send({"w": 4, "h": 4, "items": [item]}, t=cam.sent["t"], of_seq=cam.sent["seq"])

    seen["produce"] = produce

    @dev.tool("Drive straight.", params={"x": {"type": "number", "minimum": -2, "maximum": 2}}, required=["x"],
              uses=["chassis"], motion=True, pausable=True, timeout=30)  # fmt: skip
    async def move(call, x):
        steps = int(abs(x) * 100 * per_meter) + 20  # a wrong type fails here, as on a real device
        try:
            for i in range(steps):
                await call.checkpoint(rest=lambda: sim.__setitem__("v", 0.0))
                sim["v"] = 0.5 if x >= 0 else -0.5
                call.progress(done=i, total=steps)
                await asyncio.sleep(0.01)
        finally:
            sim["v"] = 0.0
        return {"detail": f"moved {x} m", "data": {"x": x}}

    @dev.tool("Say something, or play an audio clip.", params={"text": {"type": "string", "maxLength": 5}, "clip": {"type": "string"}},
              uses=["speaker"], timeout=10)  # fmt: skip
    async def say(call, text="", clip=None):
        await asyncio.sleep(0.05)
        if clip is not None and dev.clip(clip) is None:
            return {"detail": f"said {text}", "notes": [f"clip {clip} not found; said the text instead"]}
        return f"played clip {clip}" if clip else f"said {text}"

    @dev.tool("Fail on purpose.", timeout=5)
    async def jam(call):
        raise CallError("stuck", "jammed")

    return dev, seen


def make_fixed(places: list | None = None, placement: dict | None = None) -> Device:
    """A fixed device that defines the map it is installed on."""
    door = {"id": "door", "name": "Door", "at": [0, 5], "yaw": 180}
    return Device("fixed-01", "sensor", localization="fixed", placement=placement or {"map": "floor", "x": 1, "y": 2, "yaw": 90},
                  maps=[{"id": "floor", "name": "Floor", "bounds": [0, 0, 10, 10], "places": places or [door]}])  # fmt: skip

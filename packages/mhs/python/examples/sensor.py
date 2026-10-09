"""The smallest device worth checking: a simulated room sensor in Agnes MHS.

    uv run python examples/sensor.py [ws://127.0.0.1:8800]

It streams the air in the room (a values source) and a door contact (a switch, sent on change and at
least every 2 s), keeps its battery and a writable LED brightness in its state, and has one tool,
blink. It passes the Core, Perception and Streaming profiles of mhs-check:

    uv run python -m agnes_mhs.check --profile core,perception,streaming
"""

from __future__ import annotations

import asyncio
import math
import sys
import time
from typing import Any, Awaitable, Callable

from agnes_mhs import Device


def make_sensor() -> tuple[Device, Callable[[], Awaitable[None]]]:
    """The device, and the loop that measures and streams; run both."""
    dev = Device(
        "sensor-01",
        "sensor",
        name="Room sensor",
        model="Example Air 1",
        state={
            "battery": {"type": "integer", "unit": "%", "min": 0, "max": 100, "role": "battery", "alert": {"warn": 20, "bad": 10, "below": True}},
            "led": {"type": "integer", "unit": "%", "min": 0, "max": 100, "writable": True, "description": "status LED brightness"},
        },
    )
    dev.update(battery=87, led=50)
    air = dev.source(
        "air",
        "values",
        "air at desk height",
        hz=10,
        default=True,
        fields={
            "temperature": {"type": "number", "unit": "°C", "min": -10, "max": 50, "role": "temperature", "of": "air", "alert": {"warn": 30, "bad": 35}},
            "humidity": {"type": "number", "unit": "%", "min": 0, "max": 100},
            "co2": {"type": "integer", "unit": "ppm", "min": 300, "max": 5000, "alert": {"warn": 1000, "bad": 1500}},
        },
    )
    door = dev.source("door", "switch", "door contact", fields={"open": {"type": "boolean"}})

    @dev.tool("Blink the status LED to find the sensor.", params={"times": {"type": "integer", "minimum": 1, "maximum": 5}}, required=["times"], timeout=5)
    async def blink(call: Any, times: int) -> str:
        for i in range(times):
            await call.checkpoint()
            call.progress(done=i, total=times)
            await asyncio.sleep(0.2)
        return f"blinked {times} times"

    async def measure() -> None:
        last_door = 0.0
        was_open = None
        while True:
            now = time.time()
            if air.wants():
                air.send({
                    "temperature": round(22 + math.sin(now / 60), 2),
                    "humidity": round(41 + 3 * math.sin(now / 90), 1),
                    "co2": int(700 + 200 * math.sin(now / 120)),
                })
            is_open = int(now / 20) % 3 == 0
            if door.wants() and (is_open != was_open or now - last_door >= 2):
                if door.send({"open": is_open}):
                    was_open, last_door = is_open, now
            await asyncio.sleep(0.02)

    return dev, measure


async def main(url: str) -> None:
    dev, measure = make_sensor()
    streaming = asyncio.ensure_future(measure())
    try:
        await dev.run(url)
    finally:
        streaming.cancel()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8800"))

"""Synthetic device for the real South cross-language heavy test; no external services."""
import asyncio
import sys
from agnes_mhs import Device, connect_device

async def main():
    device = Device({"protocol": "mhs/v1", "device": {"id": "python-sensor", "kind": "sensor"},
        "sources": [{"id": "camera", "kind": "image", "description": "Camera", "hz": 2}],
        "tools": [{"name": "echo", "description": "Read received clip", "timeout": .1,
            "inputSchema": {"type": "object", "properties": {"clip": {"type": "string"}}}},
            {"name": "hang", "description": "Timeout", "timeout": .02, "inputSchema": {"type": "object"}}]})
    async def echo(args, call):
        clip = device.clip(args.get("clip", ""))
        return {"pcm": list(clip["pcm"]) if clip else []}
    device.tool("echo", echo)
    async def hang(args, call):
        await asyncio.Future()
    device.tool("hang", hang)
    async def publish():
        while True:
            await device.publish("camera", {"w": 1, "h": 1}, b"\x01\x02", "image/png")
            await asyncio.sleep(.05)
    producer = asyncio.create_task(publish())
    try:
        await connect_device(device, sys.argv[1])
    finally:
        producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)

asyncio.run(main())

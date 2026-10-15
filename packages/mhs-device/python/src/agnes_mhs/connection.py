"""Two outbound channels. No command or lease is replayed after a channel loss."""
import asyncio
import json
import time
from urllib.parse import urlsplit, urlunsplit
from .validation import MhsError


async def connect_device(device, base):
    from websockets.asyncio.client import connect
    if any(key not in device.values for key in device.description.get("state", {})):
        raise MhsError("initial-state-required")
    parts = urlsplit(base)
    if parts.scheme not in ("ws", "wss") or parts.username or parts.password:
        raise MhsError("invalid-hub-url")
    url = lambda path: urlunsplit((parts.scheme, parts.netloc, path, "", ""))
    delay = .5
    while True:
        try:
            device.closed = False
            async with connect(url("/ws/mhs"), subprotocols=["mhs.v1"], max_size=65536, ping_interval=2, ping_timeout=3) as command:
                await command.send(json.dumps({"jsonrpc": "2.0", "id": "register", "method": "mhs/register", "params": device.description}))
                registered = json.loads(await asyncio.wait_for(command.recv(), 5))
                if "result" not in registered:
                    raise MhsError("registration-refused")
                async with connect(url("/ws/nerve"), subprotocols=["mhs.v1"], max_size=16 << 20, ping_interval=2, ping_timeout=3) as nerve:
                    await nerve.send(json.dumps({"type": "hello", "device": device.description["device"]["id"]}))
                    writer = asyncio.Lock()
                    async def observation(header, payload):
                        async with writer:
                            await publish_observation(nerve, header, payload)
                    device.on_observation = observation
                    async def send(message):
                        await command.send(json.dumps(message, allow_nan=False))
                    device.on_state = lambda values: asyncio.create_task(send({"jsonrpc": "2.0", "method": "mhs/state", "params": {"t": time.time(), "values": values}}))
                    device.on_progress = lambda call, data: asyncio.create_task(send({"jsonrpc": "2.0", "method": "mhs/progress", "params": {"call": call, "data": data}}))
                    device.on_state(device.values)
                    async def result(call_id, task):
                        outcome = await task
                        await send({"jsonrpc": "2.0", "method": "mhs/result", "params": {"call": call_id, **outcome}})
                    async def commands():
                        async for raw in command:
                            msg = json.loads(raw)
                            method, params = msg.get("method"), msg.get("params", {})
                            answer = {}
                            if method == "mhs/call":
                                answer, task = device.call(msg["id"], params["name"], params.get("arguments", {}))
                                if task:
                                    asyncio.create_task(result(msg["id"], task))
                            elif method == "mhs/stop":
                                await device.stop()
                            elif method == "mhs/set":
                                answer = device.set(params["values"])
                            elif method == "mhs/cancel":
                                entry = device.running.get(params.get("call"))
                                if entry:
                                    if entry["tool"].get("motion"):
                                        await device.safety.stop("cancel")
                                    entry["task"].cancel()
                            elif method == "mhs/pause":
                                await device.pause(params.get("call"))
                            elif method == "mhs/resume":
                                device.resume(params.get("call"))
                            elif method == "mhs/configure":
                                answer = await device.configure(params.get("sources", {}))
                            elif method == "mhs/keyframe" and device.on_keyframe:
                                await device.on_keyframe(params.get("source"))
                            elif method == "mhs/time":
                                answer = {"t": time.time()}
                            elif method != "mhs/ping":
                                continue
                            await send({"jsonrpc": "2.0", "id": msg.get("id"), "result": answer})
                    async def controls():
                        clip = None
                        async for raw in nerve:
                            if isinstance(raw, bytes):
                                if clip is None:
                                    raise MhsError("unexpected-binary")
                                device.receive_clip(clip["id"], clip["rate"], clip["channels"], raw)
                                clip = None
                                continue
                            if clip is not None:
                                raise MhsError("missing-binary")
                            msg = json.loads(raw)
                            if msg.get("type") == "clip":
                                clip = msg
                            if msg.get("type") == "manual":
                                await device.manual(msg["axes"])
                    tasks = [asyncio.create_task(commands()), asyncio.create_task(controls())]
                    try:
                        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                        for task in done:
                            task.result()
                    finally:
                        for task in tasks:
                            task.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if getattr(exc, "code", None) in (4001, 4003) or isinstance(exc, MhsError):
                raise
        finally:
            device.on_observation = None
            device.on_state = lambda values: None
            device.on_progress = lambda call, data: None
            await device.disconnect()
        await asyncio.sleep(delay)
        delay = min(5, delay * 2)


async def publish_observation(socket, observation, payload=None):
    if payload is not None and (len(payload) > 16 << 20 or observation.get("bytes") != len(payload)):
        raise MhsError("invalid-binary")
    # One writer per Nerve socket must serialize this header/payload pair.
    await socket.send(json.dumps(observation, allow_nan=False))
    if payload is not None:
        await socket.send(payload)

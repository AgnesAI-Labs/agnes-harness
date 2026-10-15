"""Two outbound channels. No command or lease is replayed after a channel loss."""
import asyncio
import json
import time
from urllib.parse import urlsplit, urlunsplit
from .validation import MhsError, validate_wire


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
                validate_wire(registered, "commandResponse")
                if registered.get("id") != "register" or not isinstance(registered.get("result"), dict):
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
                    last_reply = time.monotonic()
                    background = set()
                    def start(coroutine):
                        task = asyncio.create_task(coroutine)
                        background.add(task)
                        def done(task):
                            background.discard(task)
                            if not task.cancelled():
                                task.exception()
                        task.add_done_callback(done)
                    async def handle(msg):
                        method, params = msg.get("method"), msg.get("params", {})
                        answer = {}
                        try:
                            if method == "mhs/call":
                                answer, task = device.call(msg["id"], params["name"], params.get("arguments", {}), params.get("meta", {}).get("caller"))
                                if task:
                                    start(result(msg["id"], task))
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
                                raise MhsError("unsupported-command")
                            await send({"jsonrpc": "2.0", "id": msg["id"], "result": answer})
                        except Exception:
                            await send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32602, "message": "invalid-or-unsafe"}})
                    async def commands():
                        nonlocal last_reply
                        async for raw in command:
                            msg = json.loads(raw)
                            validate_wire(msg, "commandRequest", "commandResponse")
                            last_reply = time.monotonic()
                            if "method" not in msg:
                                continue
                            if len(background) >= 128:
                                raise MhsError("command-capacity")
                            start(handle(msg))
                    async def heartbeat():
                        while True:
                            await asyncio.sleep(2)
                            if time.monotonic() - last_reply > 5:
                                await command.close()
                                return
                            await send({"jsonrpc": "2.0", "id": f"ping-{time.monotonic()}", "method": "mhs/ping", "params": {}})
                    async def controls():
                        clip = None
                        async for raw in nerve:
                            if isinstance(raw, bytes):
                                if clip is None:
                                    raise MhsError("unexpected-binary")
                                device.receive_clip(clip["id"], clip["rate"], clip["channels"], raw)
                                await send({"jsonrpc": "2.0", "method": "mhs/clip-received", "params": {"id": clip["id"]}})
                                clip = None
                                continue
                            if clip is not None:
                                raise MhsError("missing-binary")
                            msg = json.loads(raw)
                            validate_wire(msg, "nerveMessage")
                            if msg.get("type") == "clip":
                                clip = msg
                            if msg.get("type") == "manual":
                                await device.manual(msg["axes"])
                    tasks = [asyncio.create_task(commands()), asyncio.create_task(controls()), asyncio.create_task(heartbeat())]
                    try:
                        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                        for task in done:
                            task.result()
                    finally:
                        for task in [*tasks, *background]:
                            task.cancel()
                        await asyncio.gather(*tasks, *background, return_exceptions=True)
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

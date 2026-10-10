"""The device side of mhs/v1: declare tools and sources, and the library speaks the protocol.

    dev = Device("robot-01", "car", mobile=True, resources={"chassis": "reject"})

    @dev.tool("Drive straight, x forward, in meters.", params={"x": {"type": "number", "minimum": -2, "maximum": 2}},
              required=["x"], uses=["chassis"], motion=True, pausable=True, timeout=30)
    async def move(call, x):
        ...
        await call.checkpoint()          # leaves on cancel or stop; waits here while paused
        call.progress(done=d, total=x)
        return "moved 0.5 m"

    asyncio.run(dev.run("ws://127.0.0.1:4180"))

The library takes care of registration, reconnecting, argument checks (TOOL-2), resources, acceptance,
progress and results, cancel, stop, pause and resume, manual control with its deadman, state reports
and settings (MHS 10.1), configure, keyframe requests, clock replies and audio clips. Section numbers
refer to the MHS specification unless marked MOS.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from .args import InvalidArguments, prepare_arguments
from .schema import PROTOCOL

log = logging.getLogger("agnes_mhs")

SUBPROTOCOL = "mhs.v1"
CLOSE_REPLACED = 4001
CLOSE_BAD_VERSION = 4003
INTERRUPT_REASONS = ("stop", "cancel", "manual", "estop", "pause_timeout")
PAUSE_WAIT = 1.5  # seconds a pausable tool has to reach a checkpoint, within the hub's 2 s (CTL-5)
CLIPS_KEPT = 8  # at least the 4 most recent (STR-8)

Handler = Callable[..., Any]


class CallError(Exception):
    """Raise from a tool to end its call with an error, or as interrupted for an interrupt reason
    such as estop. Custom reasons use x_<name> (RES-1)."""

    def __init__(self, reason: str, detail: str, *, status: str | None = None, data: dict | None = None):
        super().__init__(detail)
        self.reason = reason
        self.detail = detail
        self.status = status or ("interrupted" if reason in INTERRUPT_REASONS else "error")
        self.data = data


class Refused(Exception):
    """The hub refused the registration; retrying would not help."""


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


@dataclass
class Clip:
    rate: int
    channels: int
    pcm: bytes
    received: float


class Call:
    """One running call, handed to the tool as its first argument."""

    def __init__(self, device: Device, call_id: str, name: str, args: dict[str, Any], decl: dict[str, Any]):
        self.id = call_id
        self.name = name
        self.args = args
        self.motion = bool(decl.get("motion"))
        self.pausable = bool(decl.get("pausable"))
        self.uses: list[str] = list(decl.get("uses", []))
        self.notes: list[str] = []
        self.task: asyncio.Task | None = None
        self.end_reason: str | None = None
        self._device = device
        self._generation = device._generation
        self._pause_requested = False
        self._at_rest = asyncio.Event()
        self._resume = asyncio.Event()
        self._resume.set()
        self._last_progress = 0.0

    @property
    def paused(self) -> bool:
        return self._pause_requested

    def progress(self, done: float | None = None, total: float | None = None, text: str | None = None, data: dict | None = None) -> None:
        """Reports progress; at most 2 per second are sent (CALL-4), the rest are dropped."""
        now = time.monotonic()
        if now - self._last_progress < 0.5:
            return
        self._last_progress = now
        params: dict[str, Any] = {"call": self.id}
        for key, value in (("done", done), ("total", total), ("text", text), ("data", data)):
            if value is not None:
                params[key] = value
        self._device._notify(self, "mhs/progress", params)

    async def checkpoint(self, rest: Callable[[], Any] | None = None) -> None:
        """Call often from a long tool. Raises CancelledError when the call is cancelled or stopped.
        While paused, calls rest (bring the motion to rest) once and waits for resume."""
        if self._pause_requested:
            if rest is not None:
                await _maybe_await(rest())
            self._at_rest.set()
            await self._resume.wait()
        await asyncio.sleep(0)

    def _interrupt(self, reason: str) -> None:
        if self.task is not None and not self.task.done():
            self.end_reason = self.end_reason or reason
            self.task.cancel()


class Source:
    """A data source (MOS 3). send() streams one message when the hub wants this source."""

    def __init__(self, device: Device, decl: dict[str, Any]):
        self.id: str = decl["id"]
        self.kind: str = decl["kind"]
        self.decl = decl
        self.on = True
        self.bitrate_kbps: float | None = (decl.get("bitrate_kbps") or [None])[0]
        self.size: list[int] | None = decl.get("size")
        self.hz: float | None = self._default_hz()
        # The next picture of a video source must be a keyframe: the hub asked, or a picture was dropped (VID-7).
        self.keyframe_requested = False
        # The last message queued, whose seq and t a derived result names (MOS PER-4).
        self.sent: dict[str, Any] | None = None
        # Called with the applied settings after mhs/configure, for example to release a camera.
        self.on_configure: Callable[[dict[str, Any]], Any] | None = None
        self._device = device
        self._seq = 0
        self._last = 0.0
        self._need_key = False

    def _default_hz(self) -> float | None:
        """Rates before the first mhs/configure (14.5)."""
        declared = self.decl.get("hz")
        if self.kind == "image":
            return 1.0
        if self.kind == "video":
            return 5.0
        return None if declared is None else min(declared, 2.0)

    def wants(self) -> bool:
        """Whether a message sent now would go out: the source is on and its rate allows it."""
        if not self.on:
            return False
        return self.hz is None or time.monotonic() - self._last >= 0.9 / self.hz

    def send(self, data: dict[str, Any], binary: bytes | None = None, *, t: float | None = None, of_seq: int | None = None, lag: float | None = None) -> bool:
        """Queues one message; returns False when it was not wanted. An unsent older message of this
        source is replaced, latest wins (STR-6), and its seq is skipped (STR-1). After any dropped
        video picture, pictures are held back until a keyframe (VID-7)."""
        if not self.wants():
            return False
        if self.kind == "video" and self._need_key and not data.get("key"):
            self._seq += 1
            return False
        self._last = time.monotonic()
        msg: dict[str, Any] = {"type": "data", "source": self.id, "seq": self._seq, "t": time.time() if t is None else t, "data": data}
        self._seq += 1
        if binary is not None:
            msg["bin"] = True
        if of_seq is not None:
            msg["of_seq"] = of_seq
        if lag is not None:
            msg["lag"] = lag
        self.sent = msg
        if self.kind == "video" and data.get("key"):
            self._need_key = False
            self.keyframe_requested = False
        if self._device._queue(self, msg, binary) and self.kind == "video":
            self._need_key = self.keyframe_requested = True
        return True

    def _configure(self, setting: dict[str, Any]) -> dict[str, Any]:
        if "on" in setting:
            self.on = bool(setting["on"])
        if "hz" in setting and setting["hz"] > 0:
            declared = self.decl.get("hz")
            self.hz = min(setting["hz"], declared) if declared else setting["hz"]
        span = self.decl.get("bitrate_kbps")
        if "bitrate_kbps" in setting and span:
            self.bitrate_kbps = max(span[0], min(span[1], setting["bitrate_kbps"]))
        if "size" in setting and setting["size"] in self.decl.get("sizes", []):
            self.size = setting["size"]
        applied: dict[str, Any] = {"on": self.on}
        if self.hz is not None:
            applied["hz"] = self.hz
        if self.bitrate_kbps is not None:
            applied["bitrate_kbps"] = self.bitrate_kbps
        if self.size is not None and "sizes" in self.decl:
            applied["size"] = self.size
        return applied


@dataclass
class _Tool:
    decl: dict[str, Any]
    fn: Handler


class Device:
    """One device: its description, its tools and sources, and its two connections to a hub."""

    def __init__(
        self,
        id: str,
        kind: str,
        *,
        name: str | None = None,
        model: str | None = None,
        vendor: str | None = None,
        firmware: str | None = None,
        mobile: bool = False,
        radius: float | None = None,
        profile: dict[str, Any] | None = None,
        localization: str = "none",
        placement: dict[str, Any] | None = None,
        maps: list[dict[str, Any]] | None = None,
        resources: dict[str, str] | None = None,
        manual: dict[str, Any] | None = None,
        state: dict[str, dict[str, Any]] | None = None,
        ui: dict[str, Any] | None = None,
    ):
        device: dict[str, Any] = {"id": id, "kind": kind, "mobile": mobile}
        for key, value in (("name", name), ("model", model), ("vendor", vendor), ("firmware", firmware), ("radius", radius)):
            if value is not None:
                device[key] = value
        self.id = id
        self._device = device
        self._profile = profile
        self._localization = localization
        self._placement = placement  # {map, x, y, yaw} of a fixed device (REG-4)
        self._maps = list(maps or [])  # maps this device defines (MOS 3.5)
        self._resources = dict(resources or {})
        self._manual = manual
        self._state_decl = dict(state or {})
        # Declared fields get their first value from update() before run(); problem and faults are standard.
        self._state: dict[str, Any] = {"problem": None, "faults": []}
        self._ui = ui
        self._tools: dict[str, _Tool] = {}
        self._sources: dict[str, Source] = {}

        # Hooks a device sets. Each may be a plain function or a coroutine function.
        self.on_stop: Callable[[], Any] | None = None  # zero all motion (CTL-3, SAFE-2)
        self.on_manual: Callable[[dict[str, float]], Any] | None = None  # clamped axes; zeros after the deadman
        self.after: Callable[[], dict[str, Any]] | None = None  # snapshot added to every result (7.3)
        self.unsafe: Callable[[str], str | None] | None = None  # why tool cannot run now, or None
        # Applies a writable state field set by the hub; returns the value in effect, or None to keep it.
        self.on_set: Callable[[str, Any], Any] | None = None

        self._calls: dict[str, Call] = {}
        self._holders: dict[str, dict[str, Any]] = {}
        self._released = asyncio.Condition()
        self._clips: OrderedDict[str, Clip] = OrderedDict()
        self._cmd: ClientConnection | None = None
        self._nerve: ClientConnection | None = None
        self._outbox: OrderedDict[str, tuple[dict[str, Any], bytes | None]] = OrderedDict()
        self._wake = asyncio.Event()
        self._generation = 0
        self._finished = False
        self._manual_last = 0.0
        self._manual_nonzero = 0.0
        self._manual_moving = False

    # Declaring

    def tool(
        self,
        description: str,
        *,
        timeout: float,
        name: str | None = None,
        params: dict[str, Any] | None = None,
        required: list[str] | None = None,
        uses: list[str] | None = None,
        motion: bool = False,
        read_only: bool = False,
        pausable: bool = False,
        needs: list[str] | None = None,
        ui: dict[str, Any] | None = None,
    ) -> Callable[[Handler], Handler]:
        """Declares a tool (6.1). The function gets the Call, then the checked arguments as keywords;
        it returns None, a detail string, or a dict with detail, data and notes."""

        def register(fn: Handler) -> Handler:
            schema: dict[str, Any] = {"type": "object"}
            if params:
                schema["properties"] = params
            if required:
                schema["required"] = required
            decl: dict[str, Any] = {"name": name or fn.__name__, "description": description, "inputSchema": schema, "timeout": timeout}
            for key, value in (("uses", uses), ("needs", needs), ("ui", ui)):
                if value:
                    decl[key] = value
            for key, value in (("motion", motion), ("readOnly", read_only), ("pausable", pausable)):
                if value:
                    decl[key] = True
            self._tools[decl["name"]] = _Tool(decl, fn)
            return fn

        return register

    def source(self, id: str, kind: str, description: str, **meta: Any) -> Source:
        """Declares a data source (13.1); meta holds hz, mount, fields and the kind's metadata."""
        source = Source(self, {"id": id, "kind": kind, "description": description, **meta})
        self._sources[id] = source
        return source

    def description(self) -> dict[str, Any]:
        """The params of mhs/register (5)."""
        d: dict[str, Any] = {"protocol": PROTOCOL, "device": self._device, "localization": self._localization}
        if self._profile:
            d["profile"] = self._profile
        if self._placement:
            d["placement"] = self._placement
        if self._maps:
            d["maps"] = self._maps
        if self._resources:
            d["resources"] = self._resources
        if self._sources:
            d["sources"] = [s.decl for s in self._sources.values()]
        if self._tools:
            d["tools"] = [t.decl for t in self._tools.values()]
        if self._manual:
            d["manual"] = self._manual
        if self._state_decl:
            d["state"] = self._state_decl
        if self._ui:
            d["ui"] = self._ui
        return d

    def clip(self, clip_id: str) -> Clip | None:
        """An audio clip the hub sent (14.8), if it is still kept."""
        return self._clips.get(clip_id)

    # State (MHS 10.1)

    @property
    def state(self) -> dict[str, Any]:
        """The current state values, including problem and faults."""
        return dict(self._state)

    def update(self, **values: Any) -> None:
        """Changes state values; the changed ones go to the hub at once (STATE-2)."""
        changed = {}
        for name, value in values.items():
            if name not in self._state_decl and name not in ("problem", "faults"):
                raise KeyError(f"{name} is not a declared state field")
            if self._state.get(name, object()) != value:
                self._state[name] = value
                changed[name] = value
        if changed and self._cmd is not None:
            self._send_command({"jsonrpc": "2.0", "method": "mhs/state", "params": {"t": time.time(), "values": changed}})

    @property
    def problem(self) -> str | None:
        return self._state["problem"]

    @problem.setter
    def problem(self, value: str | None) -> None:
        self.update(problem=value)

    @property
    def faults(self) -> list[str]:
        return list(self._state["faults"])

    @faults.setter
    def faults(self, value: list[str]) -> None:
        self.update(faults=list(value))

    # Running

    async def run(self, url: str) -> None:
        """Connects to the hub at url (ws://host:port) and keeps both channels up until the device is
        replaced by another instance with its id (CONN-8) or the hub refuses it."""
        base = url.rstrip("/")
        loops = [self._command_loop(base + "/ws/mhs")]
        if self._needs_nerve():
            loops.append(self._nerve_loop(base + "/ws/nerve"))
        loops.append(self._deadman())
        tasks = [asyncio.create_task(loop) for loop in loops]
        try:
            await tasks[0]
        finally:
            self._finished = True
            for task in tasks[1:]:
                task.cancel()
            await asyncio.gather(*tasks[1:], return_exceptions=True)

    def _needs_nerve(self) -> bool:
        clip = any("clip" in t.decl["inputSchema"].get("properties", {}) for t in self._tools.values())
        return bool(self._sources) or self._manual is not None or clip

    async def _command_loop(self, url: str) -> None:
        delay = 0.5
        while True:
            code = None
            try:
                async with connect(url, subprotocols=[SUBPROTOCOL], ping_interval=2, ping_timeout=3) as ws:
                    self._generation += 1
                    await self._register(ws)
                    self._cmd = ws
                    # STATE-1: every field right after registration; fields never set are left out.
                    full = {k: v for k, v in self._state.items() if k in ("problem", "faults") or v is not None}
                    missing = [k for k in self._state_decl if k not in full]
                    if missing:
                        log.warning("%s: state fields without a value yet: %s", self.id, ", ".join(missing))
                    self._send_command({"jsonrpc": "2.0", "method": "mhs/state", "params": {"t": time.time(), "values": full}})
                    delay = 0.5
                    log.info("%s: registered", self.id)
                    async for raw in ws:
                        self._on_command(raw)
            except ConnectionClosed as e:
                code = e.rcvd.code if e.rcvd else None
            except (OSError, InvalidHandshake, asyncio.TimeoutError) as e:
                log.info("%s: cannot reach the hub: %s", self.id, e)
            except Refused as e:
                log.error("%s: registration refused: %s", self.id, e)
                await self._command_lost()
                return
            await self._command_lost()
            if code == CLOSE_REPLACED:
                log.error("%s: replaced by another connection with the same id; not reconnecting", self.id)
                return
            if code == CLOSE_BAD_VERSION:
                log.error("%s: the hub does not speak %s", self.id, PROTOCOL)
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5.0)

    async def _register(self, ws: ClientConnection) -> None:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": "1", "method": "mhs/register", "params": self.description()}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if msg.get("id") == "1" and "method" not in msg:
                if "error" in msg:
                    error = msg["error"]
                    if error.get("code") in (-32001, -32602):
                        raise Refused(error.get("message", "refused"))
                    raise OSError(f"registration failed: {error.get('message')}")
                return
            # Before registration completes, only stop is answered (CONN-3, CTL-2).
            if msg.get("method") == "mhs/stop":
                await self._halt()
                await ws.send(json.dumps({"jsonrpc": "2.0", "id": msg.get("id"), "result": {"stopped": []}}))

    async def _command_lost(self) -> None:
        """SAFE-2: stop all motion and end every call; their results cannot be sent any more."""
        self._cmd = None
        if self._calls:
            await self._halt()
            for call in list(self._calls.values()):
                call._interrupt("disconnect")

    async def _halt(self) -> None:
        if self.on_stop is not None:
            try:
                await _maybe_await(self.on_stop())
            except Exception:
                log.exception("%s: on_stop failed", self.id)

    def _send_command(self, message: dict[str, Any]) -> None:
        ws = self._cmd
        if ws is not None:
            asyncio.ensure_future(self._safe_send(ws, json.dumps(message)))

    async def _safe_send(self, ws: ClientConnection, payload: str | bytes) -> None:
        try:
            await ws.send(payload)
        except ConnectionClosed:
            pass

    def _reply(self, request_id: Any, result: dict[str, Any]) -> None:
        self._send_command({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _notify(self, call: Call, method: str, params: dict[str, Any]) -> None:
        if call._generation == self._generation:
            self._send_command({"jsonrpc": "2.0", "method": method, "params": params})

    def _on_command(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        method, request_id, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
        if method is None or request_id is None:
            return
        handlers: dict[str, Callable[[Any, dict[str, Any]], Awaitable[None]]] = {
            "mhs/call": self._on_call,
            "mhs/cancel": self._on_cancel,
            "mhs/stop": self._on_stop,
            "mhs/pause": self._on_pause,
            "mhs/resume": self._on_resume,
            "mhs/configure": self._on_configure,
            "mhs/keyframe": self._on_keyframe,
            "mhs/time": self._on_time,
            "mhs/set": self._on_set,
        }
        handler = handlers.get(method)
        if handler is None:
            self._send_command({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"unknown method {method}"}})
            return
        asyncio.ensure_future(handler(request_id, params))

    # Calls (7, 8)

    async def _on_call(self, request_id: Any, params: dict[str, Any]) -> None:
        def reject(reason: str, detail: str, holder: dict[str, Any] | None = None) -> None:
            result: dict[str, Any] = {"accepted": False, "status": "rejected", "reason": reason, "detail": detail}
            if holder is not None:
                result["holder"] = holder
            self._reply(request_id, result)

        name = params.get("name")
        tool = self._tools.get(name) if isinstance(name, str) else None
        if tool is None:
            return reject("invalid", f"no tool {name}")
        try:
            args, notes = prepare_arguments(tool.decl["inputSchema"], params.get("arguments", {}))
        except InvalidArguments as e:
            return reject("invalid", str(e))
        reason = self.unsafe(tool.decl["name"]) if self.unsafe else None
        if reason:
            return reject("unsafe", reason)
        for resource in tool.decl.get("uses", []):
            holder = self._holders.get(resource)
            if holder is not None and self._resources.get(resource) == "reject":
                what = "manual control" if holder.get("manual") else f"{holder['tool']} ({holder['call']})"
                return reject("busy", f"{resource} held by {what}", holder)
        call = Call(self, str(request_id), tool.decl["name"], args, tool.decl)
        call.notes = notes
        self._calls[call.id] = call
        self._reply(request_id, {"accepted": True})
        call.task = asyncio.ensure_future(self._run_call(call, tool))

    async def _run_call(self, call: Call, tool: _Tool) -> None:
        held: list[str] = []
        outcome: dict[str, Any]
        try:
            for resource in call.uses:
                async with self._released:
                    await self._released.wait_for(lambda r=resource: r not in self._holders)
                self._holders[resource] = {"call": call.id, "tool": call.name}
                held.append(resource)
            value = await _maybe_await(tool.fn(call, **call.args))
            outcome = {"status": "done", "detail": f"{call.name} done"}
            if isinstance(value, str):
                outcome["detail"] = value
            elif isinstance(value, dict):
                outcome.update({k: v for k, v in value.items() if k in ("detail", "data", "notes")})
        except asyncio.CancelledError:
            reason = call.end_reason or "cancel"
            outcome = {"status": "interrupted", "reason": reason, "detail": f"{call.name} interrupted ({reason})"}
        except CallError as e:
            outcome = {"status": e.status, "reason": e.reason, "detail": e.detail}
            if e.data is not None:
                outcome["data"] = e.data
        except Exception as e:
            log.exception("%s: tool %s failed", self.id, call.name)
            outcome = {"status": "error", "reason": "failed", "detail": f"{call.name} failed: {e}"}
        finally:
            for resource in held:
                if self._holders.get(resource, {}).get("call") == call.id:
                    del self._holders[resource]
            async with self._released:
                self._released.notify_all()
            self._calls.pop(call.id, None)
        if call.notes or outcome.get("notes"):
            outcome["notes"] = call.notes + list(outcome.get("notes", []))
        if self.after is not None:
            try:
                outcome["after"] = self.after()
            except Exception:
                log.exception("%s: after failed", self.id)
        self._notify(call, "mhs/result", {"call": call.id, **outcome})

    async def _on_cancel(self, request_id: Any, params: dict[str, Any]) -> None:
        call = self._calls.get(params.get("call"))
        if call is not None:
            call._interrupt("cancel")
        self._reply(request_id, {"cancelled": call is not None})

    async def _on_stop(self, request_id: Any, params: dict[str, Any]) -> None:
        """CTL-3: zero motion first, then interrupt every motion call, then reply."""
        await self._halt()
        stopped = [c.id for c in self._calls.values() if c.motion]
        for call_id in stopped:
            call = self._calls.get(call_id)
            if call is not None:
                call._interrupt("stop")
        self._reply(request_id, {"stopped": stopped})

    async def _on_pause(self, request_id: Any, params: dict[str, Any]) -> None:
        call = self._calls.get(params.get("call"))
        if call is None or not call.pausable or call._pause_requested:
            return self._reply(request_id, {"paused": False})
        call._pause_requested = True
        call._resume.clear()
        try:
            await asyncio.wait_for(call._at_rest.wait(), PAUSE_WAIT)
        except asyncio.TimeoutError:
            call._pause_requested = False
            call._resume.set()
            return self._reply(request_id, {"paused": False})
        self._reply(request_id, {"paused": True})
        self._notify(call, "mhs/progress", {"call": call.id, "state": "paused"})

    async def _on_resume(self, request_id: Any, params: dict[str, Any]) -> None:
        call = self._calls.get(params.get("call"))
        if call is None or not call._pause_requested:
            return self._reply(request_id, {"resumed": False})
        call._pause_requested = False
        call._at_rest.clear()
        call._resume.set()
        self._reply(request_id, {"resumed": True})
        self._notify(call, "mhs/progress", {"call": call.id, "state": "running"})

    # Streams (14)

    async def _on_configure(self, request_id: Any, params: dict[str, Any]) -> None:
        applied: dict[str, Any] = {}
        for source_id, setting in (params.get("sources") or {}).items():
            source = self._sources.get(source_id)
            if source is None or not isinstance(setting, dict):
                continue
            applied[source_id] = source._configure(setting)
            if source.on_configure is not None:
                try:
                    await _maybe_await(source.on_configure(applied[source_id]))
                except Exception:
                    log.exception("%s: on_configure of %s failed", self.id, source_id)
        self._reply(request_id, {"sources": applied})

    async def _on_keyframe(self, request_id: Any, params: dict[str, Any]) -> None:
        asked = [s for s in params.get("sources", []) if s in self._sources and self._sources[s].kind == "video"]
        for source_id in asked:
            self._sources[source_id].keyframe_requested = True
        self._reply(request_id, {"sources": asked})

    async def _on_time(self, request_id: Any, params: dict[str, Any]) -> None:
        self._reply(request_id, {"t": time.time()})

    async def _on_set(self, request_id: Any, params: dict[str, Any]) -> None:
        """STATE-3: only writable fields, checked and clamped like arguments; STATE-4: never moves."""
        applied: dict[str, Any] = {}
        notes: list[str] = []
        refused: dict[str, str] = {}
        for name, value in (params.get("values") or {}).items():
            decl = self._state_decl.get(name)
            if decl is None or not decl.get("writable"):
                refused[name] = "not a state field" if decl is None else "not writable"
                continue
            param = {"type": decl["type"]}
            for key, schema_key in (("min", "minimum"), ("max", "maximum"), ("enum", "enum")):
                if key in decl:
                    param[schema_key] = decl[key]
            try:
                checked, field_notes = prepare_arguments({"properties": {name: param}, "required": [name]}, {name: value})
            except InvalidArguments as e:
                refused[name] = str(e)
                continue
            new = checked[name]
            if self.on_set is not None:
                try:
                    result = await _maybe_await(self.on_set(name, new))
                except Exception as e:
                    refused[name] = f"could not apply: {e}"
                    continue
                if result is not None:
                    new = result
            applied[name] = new
            notes += field_notes
        reply: dict[str, Any] = {"values": applied}
        if notes:
            reply["notes"] = notes
        if refused:
            reply["refused"] = refused
        self._reply(request_id, reply)
        if applied:
            self.update(**applied)

    def _queue(self, source: Source, msg: dict[str, Any], binary: bytes | None) -> bool:
        """Puts a message in the outbox; returns True if it replaced an unsent one (a drop)."""
        dropped = source.id in self._outbox
        self._outbox.pop(source.id, None)
        if self._nerve is None:
            return True
        self._outbox[source.id] = (msg, binary)
        self._wake.set()
        return dropped


    async def _nerve_loop(self, url: str) -> None:
        delay = 0.5
        while not self._finished:
            sender: asyncio.Task | None = None
            try:
                async with connect(url, subprotocols=[SUBPROTOCOL], ping_interval=2, ping_timeout=3, max_size=16 * 1024 * 1024) as ws:
                    await ws.send(json.dumps({"type": "hello", "device": self.id}))
                    self._nerve = ws
                    sender = asyncio.ensure_future(self._nerve_sender(ws))
                    delay = 0.5
                    pending_clip: dict[str, Any] | None = None
                    async for raw in ws:
                        if isinstance(raw, bytes):
                            if pending_clip is not None:
                                self._keep_clip(pending_clip, raw)
                            pending_clip = None
                            continue
                        msg = json.loads(raw)
                        if msg.get("type") == "manual":
                            await self._on_manual(msg.get("axes") or {})
                        elif msg.get("type") == "clip":
                            pending_clip = msg
            except ConnectionClosed as e:
                if e.rcvd is not None and e.rcvd.code == CLOSE_REPLACED:
                    return
            except (OSError, InvalidHandshake, ValueError) as e:
                log.info("%s: Nerve channel: %s", self.id, e)
            finally:
                self._nerve = None
                if sender is not None:
                    sender.cancel()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5.0)

    async def _nerve_sender(self, ws: ClientConnection) -> None:
        """Sends the newest message of each source as the channel takes them (MOS STR-6)."""
        while True:
            await self._wake.wait()
            self._wake.clear()
            while self._outbox:
                _, (msg, binary) = self._outbox.popitem(last=False)
                await ws.send(json.dumps(msg))
                if binary is not None:
                    await ws.send(binary)

    def _keep_clip(self, msg: dict[str, Any], pcm: bytes) -> None:
        self._clips[str(msg.get("id"))] = Clip(int(msg.get("rate", 0)), int(msg.get("channels", 1)), pcm, time.time())
        while len(self._clips) > CLIPS_KEPT:
            self._clips.popitem(last=False)

    # Manual control (9)

    async def _on_manual(self, axes: dict[str, Any]) -> None:
        if not self._manual:
            return
        values: dict[str, float] = {}
        for axis in self._manual["axes"]:
            v = axes.get(axis["id"], 0)
            v = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0
            values[axis["id"]] = max(axis["min"], min(axis["max"], v))  # MAN-1, MAN-2
        now = time.monotonic()
        self._manual_last = now
        if any(values.values()):
            self._manual_nonzero = now
            self._manual_moving = True
            for call in list(self._calls.values()):
                if call.motion:
                    call._interrupt("manual")  # MAN-3
            for resource in self._motion_resources():
                self._holders[resource] = {"manual": True}
        if self.on_manual is not None:
            await _maybe_await(self.on_manual(values))

    def _motion_resources(self) -> set[str]:
        return {r for t in self._tools.values() if t.decl.get("motion") for r in t.decl.get("uses", [])}

    async def _deadman(self) -> None:
        """MAN-4: no manual message for deadman_s stops manual motion; holds end deadman_s after the
        last non-zero input."""
        if not self._manual:
            return
        deadman = float(self._manual["deadman_s"])
        while True:
            await asyncio.sleep(min(0.05, deadman / 4))
            now = time.monotonic()
            if self._manual_moving and now - self._manual_last > deadman:
                self._manual_moving = False
                if self.on_manual is not None:
                    await _maybe_await(self.on_manual({a["id"]: 0.0 for a in self._manual["axes"]}))
            held = [r for r, h in self._holders.items() if h.get("manual")]
            if held and now - self._manual_nonzero > deadman:
                for resource in held:
                    del self._holders[resource]
                async with self._released:
                    self._released.notify_all()

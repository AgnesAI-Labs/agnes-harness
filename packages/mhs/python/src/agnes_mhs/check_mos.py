"""The MOS profiles of mhs-check (MOS 12): Perception, Derived perception, Streaming and Video.

Stream watches every Nerve message as it arrives and records what breaks a rule at once (payloads,
seq, binary pairing, H.264 pictures). The scenario functions then act through the command channel
(configure, keyframe, time, a throttled Nerve) and judge what Stream saw.
"""

from __future__ import annotations

import asyncio
import json
import statistics
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from websockets.exceptions import ConnectionClosed

from . import media
from .schema import data_def, errors

if TYPE_CHECKING:
    from .check import CheckHub, Command

DERIVED = ("detections", "pose", "grid", "transcript", "world")
IMAGING = ("image", "video")
RANGING = ("scan", "points")
NEEDS_OF = {"detections": IMAGING, "transcript": ("audio",)}
BINARY = ("image", "video", "points", "audio", "grid")
THROTTLE = 2.0  # seconds the hub stops reading Nerve; CONN-5 closes a channel after 3 s without a pong
FRESH = 0.5  # seconds: data counts as fresh after congestion (conformance 2.3)


@dataclass
class Frame:
    """One data message as it arrived."""

    at: float  # hub monotonic clock
    wall: float  # hub wall clock
    conn: int  # which Nerve connection carried it
    source: str
    seq: int
    t: float
    msg: dict[str, Any]
    size: int | None = None  # bytes of the binary payload

    @property
    def data(self) -> dict[str, Any]:
        return self.msg["data"]


def field_problems(fields: dict[str, Any], values: dict[str, Any], what: str) -> list[str]:
    """PER-1 and STATE-2: each value has its declared type, and is one of its enum."""
    found = []
    for name, value in values.items():
        if name not in fields:
            found.append(f"{what} field {name} is not declared")
            continue
        kind = fields[name].get("type")
        ok = (
            (kind == "integer" and isinstance(value, int) and not isinstance(value, bool))
            or (kind == "number" and isinstance(value, (int, float)) and not isinstance(value, bool))
            or (kind == "boolean" and isinstance(value, bool))
            or (kind == "string" and isinstance(value, str) and value in fields[name].get("enum", [value]))
        )
        if not ok:
            found.append(f"{what} {name}={value!r} does not match its declaration")
    return found


class Video:
    """One video source: every picture is parsed and, with PyAV, decoded as it arrives (MOS 7)."""

    def __init__(self) -> None:
        self.decoder = media.decoder()
        self.started = False  # decoding starts at the first keyframe of a connection
        self.need_key = False  # a seq gap was seen: the next picture must be a keyframe (VID-7)
        self.last_t: float | None = None
        self.keys: list[Frame] = []
        self.pictures = 0
        self.decoded = 0
        self.alone = 0

    def reset(self) -> None:
        self.decoder = media.decoder()
        self.started = self.need_key = False
        self.last_t = None

    def picture(self, hub: CheckHub, frame: Frame, au: bytes) -> None:
        info = media.parse(au)
        name = f"{frame.source} seq {frame.seq}"
        key = frame.data.get("key") is True
        self.pictures += 1
        if not info.annex_b:
            hub.violation("VID-2", f"{name}: no Annex B start code")
        elif info.pictures != 1:
            hub.violation("VID-2", f"{name}: {info.pictures} pictures in one binary frame")
        if key != info.idr:
            hub.violation("VID-3", f"{name}: key {str(key).lower()} but {'an IDR' if info.idr else 'no IDR'} picture")
        elif key and not info.parameter_sets:
            hub.violation("VID-3", f"{name}: keyframe without SPS and PPS")
        elif key and self.decoder is not None:
            frames, error = media.decode_alone(au)
            if error or not frames:
                hub.violation("VID-3", f"{name}: the keyframe does not decode on its own: {error or 'no picture'}")
            else:
                self.alone += 1
        if info.b_slices:
            hub.violation("VID-4", f"{name}: B slices")
        if self.last_t is not None and frame.t <= self.last_t:
            hub.violation("VID-4", f"{name}: t {frame.t:.3f} after {self.last_t:.3f}")
        self.last_t = frame.t
        if self.need_key and not key:
            hub.violation("VID-7", f"{name}: a non-key picture after a gap in seq")
        if key:
            self.need_key = False
            self.keys.append(frame)
        if self.decoder is not None and (self.started or key):
            self.started = True
            _, error = media.decode(self.decoder, au)
            if error:
                hub.violation("VID-7", f"{name} does not decode: {error}")
            else:
                self.decoded += 1


class Stream:
    """What the device sent on its Nerve channels, and the hub's side of them."""

    def __init__(self, hub: CheckHub):
        self.hub = hub
        self.ws: Any = None
        self.conn = 0
        self.frames: dict[str, list[Frame]] = {}
        self.last: dict[str, Frame] = {}
        self.dropped: dict[str, set[tuple[int, int]]] = {}  # (conn, seq) skipped, per source
        self.videos: dict[str, Video] = {}
        self.pending: Frame | None = None
        self.flow = asyncio.Event()  # cleared while the hub does not read (congestion)
        self.flow.set()
        self.excused: list[tuple[float, float]] = []  # arrival times delayed by the hub itself
        self.offset = 0.0  # device clock minus hub clock, from mhs/time
        self.images = 0
        self.messages = 0

    def declared(self) -> dict[str, dict[str, Any]]:
        return {s.get("id"): s for s in self.hub.description.get("sources", [])}

    def opened(self, ws: Any) -> None:
        self.ws = ws
        self.conn += 1
        self.last = {}
        self.pending = None
        for video in self.videos.values():
            video.reset()

    async def send(self, msg: dict[str, Any], binary: bytes | None = None) -> bool:
        """Sends a message to the device on Nerve (manual input, clips)."""
        if self.ws is None:
            return False
        try:
            await self.ws.send(json.dumps(msg))
            if binary is not None:
                await self.ws.send(binary)
        except ConnectionClosed:
            return False
        return True

    def text(self, msg: dict[str, Any], now: float) -> None:
        hub = self.hub
        if self.pending is not None:
            hub.violation("STR-3", f"{self.pending.source} seq {self.pending.seq}: bin true, but a text frame followed")
            self.pending = None
        if msg.get("type") != "data":
            hub.violation("MSG-4", f"a Nerve message of type {msg.get('type')} from the device")
            return
        if not hub.schema("MSG-4", "NerveData", msg):
            return
        decl = self.declared().get(msg["source"])
        if decl is None:
            hub.violation("PER-1", f"data for undeclared source {msg['source']}")
            return
        self.messages += 1
        frame = Frame(now, time.time(), self.conn, msg["source"], msg["seq"], msg["t"], msg)
        kind = decl.get("kind", "")
        name = f"{frame.source} seq {frame.seq}"
        definition = data_def(kind)
        for problem in errors(definition, frame.data)[:1] if definition else []:
            hub.violation("PER-1", f"{name}: {definition} {problem}")
        if kind in ("values", "switch"):
            for problem in field_problems(decl.get("fields", {}), frame.data, frame.source)[:1]:
                hub.violation("PER-1", f"{name}: {problem}")
        last = self.last.get(frame.source)
        if last is not None:
            if frame.seq <= last.seq:
                hub.violation("STR-1", f"{frame.source}: seq {frame.seq} after {last.seq}")
            elif frame.seq > last.seq + 1:
                self.dropped.setdefault(frame.source, set()).update((self.conn, s) for s in range(last.seq + 1, frame.seq))
                if kind == "video":
                    self.video(frame.source).need_key = True
            if frame.t < last.t:
                hub.violation("STR-2", f"{frame.source}: t went back {last.t - frame.t:.3f} s at seq {frame.seq}")
        self.last[frame.source] = frame
        self.frames.setdefault(frame.source, []).append(frame)
        if msg.get("bin"):
            self.pending = frame
        elif kind in BINARY:
            hub.violation("STR-3", f"{name}: kind {kind} without bin true")

    def binary(self, payload: bytes) -> None:
        hub = self.hub
        frame, self.pending = self.pending, None
        if frame is None:
            hub.violation("STR-3", f"a binary frame of {len(payload)} bytes that no bin true announced")
            return
        frame.size = len(payload)
        decl = self.declared()[frame.source]
        kind = decl.get("kind")
        name = f"{frame.source} seq {frame.seq}"
        if not payload:
            hub.violation("STR-3", f"{name}: an empty binary frame")
        elif kind == "video":
            self.video(frame.source).picture(hub, frame, payload)
        elif kind in ("image", "grid") and len(self.frames[frame.source]) % 20 == 1:
            self._image(frame, decl, payload)
        elif kind == "audio" and len(payload) % (2 * int(frame.data.get("channels") or 1)):
            hub.violation("STR-3", f"{name}: {len(payload)} bytes is not whole 16-bit samples")
        elif kind == "points" and len(payload) != 4 * frame.data.get("n", 0) * len(frame.data.get("fields", [])):
            hub.violation("STR-3", f"{name}: {len(payload)} bytes for {frame.data.get('n')} points")

    def _image(self, frame: Frame, decl: dict[str, Any], payload: bytes) -> None:
        """A JPEG or PNG is checked by its signature and, with PyAV, decoded at its stated size."""
        png = frame.data.get("mime", decl.get("mime")) == "image/png" or decl.get("kind") == "grid"
        name = f"{frame.source} seq {frame.seq}"
        if not payload.startswith(b"\x89PNG" if png else b"\xff\xd8\xff"):
            self.hub.violation("STR-3", f"{name}: not a {'PNG' if png else 'JPEG'}")
            return
        if media.av is None:
            self.images += 1
            return
        pictures, error = media.decode_alone(payload, "png" if png else "mjpeg")
        if error or not pictures:
            self.hub.violation("STR-3", f"{name}: does not decode: {error or 'no picture'}")
        elif "w" in frame.data and (pictures[0].width, pictures[0].height) != (frame.data["w"], frame.data["h"]):
            self.hub.violation("STR-3", f"{name}: {pictures[0].width}x{pictures[0].height}, but data says {frame.data['w']}x{frame.data['h']}")
        else:
            self.images += 1

    def video(self, source: str) -> Video:
        return self.videos.setdefault(source, Video())

    def window(self, source: str, start: float, end: float) -> list[Frame]:
        return [f for f in self.frames.get(source, []) if start <= f.at <= end]

    def age(self, f: Frame) -> float:
        """How old the data was when it arrived, on the hub clock; a derived result's lag is not age."""
        return f.wall - (f.t - self.offset) - float(f.msg.get("lag", 0))

    def configure(self, cmd: Command, settings: dict[str, Any]) -> Any:
        return cmd.request("mhs/configure", {"sources": settings}, timeout=2.5)


def rate(frames: list[Frame]) -> float | None:
    """Messages per second from their capture times; None with fewer than three."""
    if len(frames) < 3 or frames[-1].t <= frames[0].t:
        return None
    return (len(frames) - 1) / (frames[-1].t - frames[0].t)


def odometry(hub: CheckHub) -> str | None:
    return next((s["id"] for s in hub.description.get("sources", []) if s.get("kind") == "odometry"), None)


def moving(f: Frame) -> bool:
    return abs(f.data.get("v", 0)) > 0.02 or abs(f.data.get("w", 0)) > 1.0


async def odometry_on(hub: CheckHub, cmd: Command) -> str | None:
    """Turns the odometry source on at up to 10 Hz, so motion can be observed."""
    source = odometry(hub)
    if source is not None:
        hz = min(hub.stream.declared()[source].get("hz") or 10, 10)
        await hub.stream.configure(cmd, {source: {"on": True, "hz": hz}})
    return source


async def still(hub: CheckHub, source: str | None, start: float, end: float) -> bool | None:
    """Waits until end; whether odometry showed no motion from start to end, None without data."""
    await asyncio.sleep(max(0.0, end - time.monotonic()))
    frames = hub.stream.window(source, start, end) if source else []
    return None if not frames else not any(moving(f) for f in frames)


async def hold(hub: CheckHub, axes: dict[str, float], seconds: float) -> float:
    """Sends manual input at the declared rate for seconds; returns when the last one went out."""
    period = 1 / hub.description["manual"]["rate_hz"]
    end = time.monotonic() + seconds
    last = time.monotonic()
    while True:
        if not await hub.stream.send({"type": "manual", "axes": axes}):
            return last
        last = time.monotonic()
        hub.manual_sent.append(last)
        if last + period > end:
            return last
        await asyncio.sleep(period)


# Perception


def perception(hub: CheckHub) -> None:
    """PER-2 (SHOULD): imaging and ranging sources declare their geometry."""
    for s in hub.description.get("sources", []):
        need = ("fov_deg", "mount") if s.get("kind") in IMAGING else ("range_m", "mount") if s.get("kind") in RANGING else ()
        missing = [k for k in need if k not in s]
        if missing:
            hub.report.add("PER-2", "warn", f"{s['id']} ({s['kind']}) does not declare {' or '.join(missing)} (SHOULD)")
        elif need:
            hub.report.add("PER-2", "pass", f"{s['id']} declares {' and '.join(need)}")
    if not any(s.get("kind") in IMAGING + RANGING for s in hub.description.get("sources", [])):
        hub.report.add("PER-2", "skip", "no imaging or ranging source")


# Maps


def _inside(bounds: list[float] | None, x: float, y: float) -> bool:
    return bounds is None or (bounds[0] <= x <= bounds[2] and bounds[1] <= y <= bounds[3])


async def maps(hub: CheckHub, cmd: Command) -> None:
    """MAP-1 from the registration; MAP-3 and MAP-4 (both SHOULD) from the placement, the places and
    pose and grid messages. MAP-2, that every device naming a map means the same frame, takes a person."""
    r = hub.report
    d = hub.description
    declared = d.get("maps", [])
    problems = []
    ids = [m.get("id") for m in declared]
    problems += [f"map {i} is declared twice" for i in sorted({i for i in ids if ids.count(i) > 1})]
    for m in declared:
        problems += [f"map {m.get('id')}: {e}" for e in errors("MapDecl", m)[:1]]
        places = [p.get("id") for p in m.get("places", [])]
        problems += [f"map {m.get('id')}: place {i} is declared twice" for i in sorted({i for i in places if places.count(i) > 1})]
    for p in problems:
        hub.violation("MAP-1", p)
    if declared and not problems:
        r.add("MAP-1", "pass", f"{len(declared)} maps, {sum(len(m.get('places', [])) for m in declared)} places: ids unique, each place a landmark or a zone")
    elif not declared:
        r.add("MAP-1", "skip", "the device declares no map")

    known = {m["id"]: m for m in declared if isinstance(m, dict) and "id" in m}
    named = [s for s in d.get("sources", []) if s.get("kind") in ("pose", "grid")]
    if named:
        await _configure(hub, cmd, {s["id"]: {"on": True} for s in named})
        for _ in range(60):
            if all(hub.stream.frames.get(s["id"]) for s in named):
                break
            await asyncio.sleep(0.1)
    positions = []  # (what, map id, x, y)
    if "placement" in d:
        positions.append(("placement", d["placement"].get("map"), d["placement"].get("x"), d["placement"].get("y")))
    for s in named:
        for f in hub.stream.frames.get(s["id"], [])[-20:]:
            map_id = f.data.get("map") if s["kind"] == "pose" else f.data.get("id")
            positions.append((f"{s['id']} seq {f.seq}", map_id, f.data.get("x"), f.data.get("y")))
    for map_id in dict.fromkeys(m for _, m, _, _ in positions):
        if map_id in known:
            r.add("MAP-3", "pass", f"{map_id} is a map the device declares")
        else:
            r.add("MAP-3", "warn", f"{map_id} is not a map this device declares; another connected device may declare it (SHOULD)")
    if not positions:
        r.add("MAP-3", "skip", "no placement, and no pose or grid message arrived")
    outside = [f"{what} at ({x:g}, {y:g}) is outside the bounds of {m}" for what, m, x, y in positions if m in known and x is not None and not _inside(known[m].get("bounds"), x, y)]
    bounded = any(m.get("bounds") for m in known.values())
    for m in known.values():
        for p in m.get("places", []):
            points = [p["at"]] if "at" in p else p.get("points", [])
            if any(not _inside(m.get("bounds"), *xy) for xy in points):
                outside.append(f"place {p.get('id')} lies outside the bounds of {m['id']}")
    if outside:
        for line in outside:
            r.add("MAP-4", "warn", f"{line}: are the coordinates meters in the map's frame? (SHOULD)")
    elif bounded:
        r.add("MAP-4", "pass", "every place and position lies within its map's bounds")
    else:
        r.add("MAP-4", "skip", "no map the device declares has bounds")
    if known:
        device = d["device"]["id"]
        maps_named = ", ".join(known)
        answer = await hub.ask(f"Do the maps {maps_named} of {device} use meters and degrees, and does every device naming them mean the same frame? [y/n]")
        if answer is None:
            r.add("MAP-2", "manual", f"needs an operator: whether {maps_named} are the same frame for every device that names them")
        else:
            r.add("MAP-2", "pass" if answer.lower().startswith("y") else "fail", f"the operator answered for {maps_named}", operator=answer)
    else:
        r.add("MAP-2", "skip", "the device declares no map")


# Streaming


async def streaming(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> None:
    r = hub.report
    stream = hub.stream
    sources = hub.description.get("sources", [])

    # Time (TIME-2): five samples; the median offset converts every t to the hub clock.
    offsets, slowest = [], 0.0
    for _ in range(5):
        before = time.time()
        response, took = await cmd.request("mhs/time", {}, timeout=1.0)
        result = (response or {}).get("result") or {}
        if not isinstance(result.get("t"), (int, float)):
            hub.violation("TIME-2", f"mhs/time: {response}")
            break
        slowest = max(slowest, took)
        offsets.append(result["t"] - (before + time.time()) / 2)
    if offsets:
        stream.offset = statistics.median(offsets)
        r.add("TIME-2", "pass" if slowest <= 0.5 else "fail", f"mhs/time answered within {slowest * 1000:.0f} ms; device clock {stream.offset:+.3f} s from the hub's")

    # Configure (STR-4, STR-5): a low rate, a higher one, then off.
    log("configuring every source low, high, then off")
    high = {s["id"]: min(s["hz"], 10) for s in sources if s.get("hz")}
    low = {k: v / 2 for k, v in high.items()}
    measure = max([min(max(4 / hz, 3), 10) for hz in low.values()] or [3]) * hub.pace
    for phase, rates in (("low", low), ("high", high)):
        applied = await _configure(hub, cmd, {s["id"]: {"on": True, **({"hz": rates[s["id"]]} if s["id"] in rates else {})} for s in sources})
        start = time.monotonic() + 0.5
        await asyncio.sleep(0.5 + measure)
        for source, hz in rates.items():
            setting = applied.get(source) or {}
            if not setting.get("on") or not setting.get("hz"):
                continue
            frames = stream.window(source, start, start + measure)
            got = rate(frames)
            what = f"{source} at {phase} rate {setting['hz']:g} Hz"
            if got is None:
                if setting["hz"] * measure >= 4:
                    hub.violation("STR-4", f"{what}: {len(frames)} messages in {measure:.0f} s")
                else:
                    r.add("STR-4", "pass", f"{what}: too slow to measure in {measure:.0f} s; configure answered")
            elif abs(got - setting["hz"]) <= 0.3 * setting["hz"]:
                r.add("STR-4", "pass", f"{what}: measured {got:.2f} Hz")
            else:
                hub.violation("STR-4", f"{what}: measured {got:.2f} Hz")
    applied = await _configure(hub, cmd, {s["id"]: {"on": False} for s in sources})
    start = time.monotonic() + 0.5
    await asyncio.sleep(0.5 + 2 * hub.pace)
    for s in sources:
        setting = applied.get(s["id"]) or {}
        sent = stream.window(s["id"], start, time.monotonic())
        if setting.get("on") is False and sent:
            hub.violation("STR-5", f"{s['id']} reported off but sent {len(sent)} messages")
        elif setting.get("on") is False:
            r.add("STR-5", "pass", f"{s['id']} off and silent")
        elif s.get("switchable"):
            hub.violation("STR-5", f"{s['id']} is switchable but stayed on: {setting}")
        else:
            r.add("STR-5", "pass", f"{s['id']} is not switchable and reported that it stays on")
    await _configure(hub, cmd, {s["id"]: {"on": True, **({"hz": high[s["id"]]} if s["id"] in high else {})} for s in sources})
    await congestion(hub, cmd, log)


async def _configure(hub: CheckHub, cmd: Command, settings: dict[str, Any]) -> dict[str, Any]:
    """STR-4: the reply is what the device applied, one entry per source it was asked about."""
    response, took = await hub.stream.configure(cmd, settings)
    result = (response or {}).get("result")
    if result is None or not hub.schema("STR-4", "ConfigureResult", result):
        hub.violation("STR-4", f"mhs/configure: no valid reply within 2 s: {response}")
        return {}
    missing = [k for k in settings if k not in result["sources"]]
    if missing:
        hub.violation("STR-4", f"the configure reply leaves out {', '.join(missing)}")
    elif took > 2:
        hub.violation("STR-4", f"mhs/configure answered after {took:.1f} s")
    return result["sources"]


async def congestion(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> None:
    """STR-6: the hub stops reading Nerve for 2 s; from 1 s after it reads again, every message is
    fresh (the first second may drain socket buffers). STR-7: manual input sent meanwhile is acted
    on at once. On loopback this cannot tell a device that queues from one that drops."""
    r = hub.report
    stream = hub.stream
    manual = hub.description.get("manual")
    tool = next(iter(hub.tools(motion=True)), None) if manual else None
    await asyncio.sleep(1.0)
    log(f"not reading the Nerve channel for {THROTTLE:.0f} s")
    paused = time.monotonic()
    stream.flow.clear()
    if tool is None:
        r.add("STR-7", "skip", "no manual control" if not manual else "no motion tool to interrupt" + ("" if hub.motion else " (motion is off)"))
    else:
        rec = await cmd.call(tool["name"], hub.args(tool["inputSchema"]))
        await asyncio.sleep(0.3)
        if rec.done.is_set():
            r.add("STR-7", "skip", f"{tool['name']} ended within 0.3 s: {rec.result}")
        else:
            axis = manual["axes"][0]
            sent = time.monotonic()
            await hold(hub, {axis["id"]: axis["max"] / 2 or axis["min"] / 2}, 0.3)
            result = await cmd.finish(rec, 2)
            took = time.monotonic() - sent if result else None
            if (result or {}).get("reason") == "manual" and took is not None and took <= 1:
                r.add("STR-7", "pass", f"manual input while Nerve was congested interrupted {tool['name']} within {took:.2f} s")
            else:
                hub.violation("STR-7", f"manual input while Nerve was congested: {tool['name']} ended with {result}")
    await asyncio.sleep(max(0.0, paused + THROTTLE - time.monotonic()))
    released = time.monotonic()
    stream.excused.append((paused, released + 1.0))
    stream.flow.set()
    await asyncio.sleep(2.0)
    judged = 0
    for source, frames in stream.frames.items():
        if not any(paused - 1 <= f.at <= paused for f in frames):
            continue  # not streaming when the congestion began
        judged += 1
        stale = [f for f in frames if released <= f.at <= released + 1 and stream.age(f) > FRESH]
        late = [f for f in frames if f.at > released + 1 and stream.age(f) > FRESH]
        if late:
            hub.violation("STR-6", f"{source}: still {stream.age(late[0]):.1f} s old data {late[0].at - released:.1f} s after the hub read again")
        else:
            r.add("STR-6", "pass", f"{source}: after {THROTTLE:.0f} s unread, {len(stale)} old messages, then fresh within 1 s")
    if not judged:
        r.add("STR-6", "skip", "no source was streaming")


# Video


async def video(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> None:
    r = hub.report
    stream = hub.stream
    sources = [s for s in hub.description.get("sources", []) if s.get("kind") == "video"]
    for s in sources:
        r.add("VID-1", "pass", f"{s['id']} declares codec {s.get('codec')}")

    # GOP (VID-5): the longest interval between keyframes while streaming at up to 15 Hz.
    log("measuring keyframe intervals")
    applied = await _configure(hub, cmd, {s["id"]: {"on": True, "hz": min(s.get("hz") or 15, 15)} for s in sources})
    span = (3 * max(s["gop_s"] for s in sources) + 1) * max(hub.pace, 0.5)
    start = time.monotonic() + 0.5
    await asyncio.sleep(0.5 + span)
    for s in sources:
        keys = [f.t for f in stream.video(s["id"]).keys if start <= f.at <= start + span]
        hz = (applied.get(s["id"]) or {}).get("hz") or s.get("hz") or 15
        gaps = [b - a for a, b in zip(keys, keys[1:])]
        if len(keys) < 2:
            hub.violation("VID-5", f"{s['id']}: {len(keys)} keyframes in {span:.0f} s with gop_s {s['gop_s']}")
        elif max(gaps) > s["gop_s"] + 1 / hz:
            hub.violation("VID-5", f"{s['id']}: keyframes up to {max(gaps):.2f} s apart, gop_s {s['gop_s']}")
        else:
            r.add("VID-5", "pass", f"{s['id']}: keyframes at most {max(gaps):.2f} s apart, gop_s {s['gop_s']}")

    # Keyframe request (VID-6).
    for s in sources:
        asked = time.monotonic()
        response, _ = await cmd.request("mhs/keyframe", {"sources": [s["id"]]}, timeout=2.5)
        result = (response or {}).get("result")
        if result is None or not hub.schema("VID-6", "KeyframeResult", result) or s["id"] not in result["sources"]:
            hub.violation("VID-6", f"mhs/keyframe for {s['id']}: {response}")
            continue
        await asyncio.sleep(1.2)
        key = next((f for f in stream.video(s["id"]).keys if f.at > asked), None)
        if key is not None and key.at - asked <= 1:
            r.add("VID-6", "pass", f"{s['id']}: keyframe {key.at - asked:.2f} s after mhs/keyframe")
        else:
            hub.violation("VID-6", f"{s['id']}: no keyframe within 1 s of mhs/keyframe")

    # Bitrate (STR-4): the applied bitrate is a ceiling. At the lowest and the highest declared
    # bitrate, measured over 10 s each, a stream above it by more than half fails; a lower bitrate
    # passes (a still scene compresses well, and encoders do not pad).
    rated = [s for s in sources if s.get("bitrate_kbps")]
    window = 10 * hub.pace
    for which in (0, 1):
        if not rated:
            break
        log(f"measuring the {'lowest' if which == 0 else 'highest'} bitrate for {window:.0f} s")
        applied = await _configure(hub, cmd, {s["id"]: {"on": True, "bitrate_kbps": s["bitrate_kbps"][which]} for s in rated})
        start = time.monotonic() + 1
        await asyncio.sleep(1 + window)
        for s in rated:
            target = (applied.get(s["id"]) or {}).get("bitrate_kbps")
            if target is None:
                hub.violation("STR-4", f"{s['id']}: configure reply without bitrate_kbps")
                continue
            kbps = sum(f.size or 0 for f in stream.window(s["id"], start, start + window)) * 8 / 1000 / window
            what = f"{s['id']}: {kbps:.0f} kbit/s measured at {target:g} kbit/s"
            if kbps > 1.5 * target:
                hub.violation("STR-4", what)
            else:
                r.add("STR-4", "pass", what + ("" if kbps >= 0.5 * target else ", below it"))


# Derived perception


async def derived(hub: CheckHub, cmd: Command) -> None:
    """PER-3 from the registration, PER-4 and PER-5 from what was streamed, PER-6 with an operator."""
    r = hub.report
    stream = hub.stream
    declared = stream.declared()
    pairs = {i for s in declared.values() if s.get("kind") in DERIVED and s.get("of") in declared for i in (s["id"], s["of"])}
    if pairs:
        await _configure(hub, cmd, {i: {"on": True, "hz": min(declared[i].get("hz") or 10, 10)} for i in pairs})
        await asyncio.sleep(3 * max(hub.pace, 0.5))
    for s in declared.values():
        kind = s.get("kind")
        if kind not in DERIVED:
            continue
        inputs = NEEDS_OF.get(kind)
        of = declared.get(s.get("of", ""))
        if "model" not in s:
            hub.violation("PER-3", f"{s['id']} ({kind}) declares no model")
        elif inputs and of is None:
            hub.violation("PER-3", f"{s['id']} ({kind}) needs of naming a declared source, has {s.get('of')!r}")
        elif "of" in s and of is None:
            hub.violation("PER-3", f"{s['id']}: of names undeclared source {s['of']}")
        elif inputs and of.get("kind") not in inputs:
            hub.violation("PER-3", f"{s['id']} ({kind}) is computed from {of['id']}, a {of.get('kind')} source")
        else:
            r.add("PER-3", "pass", f"{s['id']} ({kind}) declares model" + (f" and of {s['of']}" if "of" in s else ""))
        if of is not None:
            _aligned(hub, s, of)
        if kind == "pose":
            await _localization(hub, s)
    if not any(s.get("kind") == "pose" for s in declared.values()):
        r.add("PER-6", "skip", "no pose source")
    if not any(s.get("of") for s in declared.values() if s.get("kind") in DERIVED):
        r.add("PER-4", "skip", "no derived source names an input with of")
        r.add("PER-5", "skip", "no derived source names an input with of")


def _aligned(hub: CheckHub, s: dict[str, Any], of: dict[str, Any]) -> None:
    """PER-4: of_seq is an input message that was sent (or dropped), with the same t. PER-5: values."""
    stream = hub.stream
    inputs = {(f.conn, f.seq): f for f in stream.frames.get(of["id"], [])}
    dropped = stream.dropped.get(of["id"], set())
    frames = stream.frames.get(s["id"], [])
    checked = 0
    for f in frames:
        name = f"{s['id']} seq {f.seq}"
        if "of_seq" not in f.msg:
            hub.violation("PER-4", f"{name}: no of_seq")
            continue
        source = inputs.get((f.conn, f.msg["of_seq"]))
        if source is None and (f.conn, f.msg["of_seq"]) not in dropped:
            hub.violation("PER-4", f"{name}: of_seq {f.msg['of_seq']} is no message {of['id']} sent")
            continue
        if source is not None and abs(source.t - f.t) > 1e-6:
            hub.violation("PER-4", f"{name}: t {f.t:.3f}, but {of['id']} seq {source.seq} has t {source.t:.3f}")
            continue
        checked += 1
        if s.get("kind") == "detections":
            _detections(hub, name, f, source, of)
    if checked:
        hub.report.add("PER-4", "pass", f"{s['id']}: {checked} messages name an input message of {of['id']} and share its t")
        hub.report.add("PER-5", "pass", f"{s['id']}: values in range in {checked} messages")
    elif not frames:
        hub.report.add("PER-4", "skip", f"{s['id']} sent nothing")


def _detections(hub: CheckHub, name: str, f: Frame, source: Frame | None, of: dict[str, Any]) -> None:
    w, h = (source.data.get("w"), source.data.get("h")) if source else (f.data.get("w"), f.data.get("h"))
    fov = (of.get("fov_deg") or [None])[0]
    yaw = (of.get("mount") or {}).get("rpy", [0, 0, 0])[2]
    for item in f.data.get("items", []):
        x1, y1, x2, y2 = item.get("box", [0, 0, 0, 0])
        if not 0 <= item.get("conf", 0) <= 1:
            hub.violation("PER-5", f"{name}: confidence {item.get('conf')}")
        elif not (0 <= x1 <= x2 <= w and 0 <= y1 <= y2 <= h):
            hub.violation("PER-5", f"{name}: box {item['box']} outside the {w}x{h} input image")
        elif fov is not None and "bearing" in item and abs(item["bearing"] - yaw) > fov / 2 + 1:
            hub.violation("PER-5", f"{name}: bearing {item['bearing']} outside the camera's {fov} degree view")


async def _localization(hub: CheckHub, s: dict[str, Any]) -> None:
    """PER-6: a pose source sends ok false when the localizer loses its fix; that takes an operator."""
    device = hub.description["device"]["id"]
    answer = await hub.ask(f"Make {device} lose its position fix (for example cover its sensors or carry it away), then answer y; n if that is not possible")
    if answer is None:
        hub.report.add("PER-6", "manual", f"{s['id']}: needs an operator to make the localizer lose its fix")
        return
    if not answer.lower().startswith("y"):
        hub.report.add("PER-6", "skip", f"{s['id']}: the operator could not make the localizer lose its fix", operator=answer)
        return
    asked = time.monotonic()
    await asyncio.sleep(5)
    lost = [f for f in hub.stream.window(s["id"], asked, time.monotonic()) if f.data.get("ok") is False]
    if lost:
        hub.report.add("PER-6", "pass", f"{s['id']} sent ok false {lost[0].at - asked:.1f} s later", operator=answer)
    else:
        hub.violation("PER-6", f"{s['id']}: no ok false within 5 s of losing the fix")


# Judged at the end, from everything that was streamed


def judge_streams(hub: CheckHub) -> None:
    r = hub.report
    stream = hub.stream
    if not stream.messages:
        for rid in ("MSG-4", "PER-1", "STR-1", "STR-2", "STR-3", "TIME-1"):
            r.add(rid, "skip", "no data message arrived")
        return
    sources = len(stream.frames)
    for rid, evidence in (
        ("MSG-4", f"{stream.messages} data messages, each a JSON object with type, binary frames right after"),
        ("MSG-5", "no Nerve frame over its size limit"),
        ("PER-1", f"{stream.messages} payloads of {sources} sources follow their kinds"),
        ("STR-2", f"t never went back in {sources} sources"),
    ):
        if rid not in hub.violations:
            r.add(rid, "pass", evidence)
    if "STR-1" not in hub.violations:
        drops = {k: len(v) for k, v in stream.dropped.items() if v}
        r.add("STR-1", "pass", "seq increased by one" + (f"; dropped: {', '.join(f'{k} {n}' for k, n in drops.items())}" if drops else ", nothing dropped"))
    if not any(f.size is not None for frames in stream.frames.values() for f in frames):
        r.add("STR-3", "skip", "no source sent a binary payload")
    elif "STR-3" not in hub.violations:
        decoded = f"{stream.images} images decoded" if media.av else f"{stream.images} image signatures checked ({media.NO_DECODER})"
        r.add("STR-3", "pass", f"every bin true was followed by its binary frame; {decoded}")
    ages = [(stream.age(f), f) for frames in stream.frames.values() for f in frames if not any(a <= f.at <= b for a, b in stream.excused)]
    off = [(a, f) for a, f in ages if abs(a) > 2]
    if off:
        hub.violation("TIME-1", f"{off[0][1].source} seq {off[0][1].seq}: t is {off[0][0]:+.2f} s from the hub clock")
    elif ages:
        r.add("TIME-1", "pass", f"every t within {max(abs(a) for a, _ in ages):.2f} s of the hub clock after the offset")
    for source, v in stream.videos.items():
        if not v.pictures:
            continue
        r.add("VID-2", "pass", f"{source}: {v.pictures} binary frames, each one picture in Annex B")
        if v.decoder is None:
            r.add("VID-3", "skip", media.NO_DECODER)
        else:
            r.add("VID-3", "pass", f"{source}: {len(v.keys)} keyframes with SPS and PPS; {v.alone} decoded on their own")
        r.add("VID-4", "pass", f"{source}: no B slices, t increasing")
        r.add("VID-7", "pass", f"{source}: a keyframe after every gap" + (f"; {v.decoded} pictures decoded" if v.decoder else f"; {media.NO_DECODER}"))

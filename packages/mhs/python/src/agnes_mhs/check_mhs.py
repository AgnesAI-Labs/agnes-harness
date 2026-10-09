"""The MHS profiles of mhs-check beyond Core (MHS 15.1): Motion, Manual and Pause, and MOS's Audio clip.

Physical behavior is judged from the device's own odometry when it streams one; otherwise an operator
answers with --interactive, and without one the result is manual (conformance 2.4).
"""

from __future__ import annotations

import asyncio
import math
import struct
import time
from typing import TYPE_CHECKING, Any, Callable

from .check_mos import hold, moving, odometry, odometry_on, still
from .schema import errors

if TYPE_CHECKING:
    from .check import CheckHub, Command

SETTLE = 1.5  # seconds a device may take to come to rest after a call ends or manual input stops


async def confirm(hub: CheckHub, rid: str, question: str, evidence: str) -> None:
    """Asks the operator a yes/no question; without one the result is manual."""
    answer = await hub.ask(f"{question} [y/n]")
    if answer is None:
        hub.report.add(rid, "manual", f"needs an operator: {evidence}")
    else:
        status = "pass" if answer.lower().startswith("y") else "fail"
        hub.report.add(rid, status, evidence, operator=f"{question} {answer}")


def _long(tools: list[dict[str, Any]]) -> dict[str, Any] | None:
    return max(tools, key=lambda t: t.get("timeout", 0), default=None)


# Motion


async def motion(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> None:
    """SAFE-5 with an operator; SAFE-6 has no scenario. SAFE-2 runs with the reconnect at the end."""
    r = hub.report
    r.add("SAFE-6", "skip", "no scenario: needs an obstacle in the device's way (SHOULD)")
    tool = _long(hub.tools(motion=True))
    if tool is None:
        r.add("SAFE-5", "skip", "motion is off")
        return
    if hub.description["device"].get("mobile"):
        short = min(hub.tools(motion=True), key=lambda t: t.get("timeout", 0))
        rec = await cmd.call(short["name"], hub.args(short["inputSchema"]))
        await cmd.finish(rec, short["timeout"] + 5)  # its result must carry after.odometry (7.3)
    device = hub.description["device"]["id"]
    answer = await hub.ask(f"Does {device} have a watchdog independent of the process that speaks MHS? [y/n]")
    if answer is None:
        r.add("SAFE-5", "manual", "needs an operator to say whether there is a watchdog and to disable it")
        return
    if not answer.lower().startswith("y"):
        r.add("SAFE-5", "warn", "no independent watchdog (SHOULD)", operator=answer)
        return
    await hub.ask(f"Disable the watchdog of {device}, then press Enter")
    rec = await cmd.call(tool["name"], hub.args(tool["inputSchema"]))
    reply = rec.reply or {}
    if reply.get("reason") == "unsafe":
        r.add("SAFE-5", "pass", f"{tool['name']} rejected unsafe while the watchdog was off", operator="watchdog disabled")
    else:
        hub.violation("SAFE-5", f"{tool['name']} while the watchdog was off: {reply}")
        if reply.get("accepted"):
            await cmd.request("mhs/stop", {})
    await hub.ask(f"Enable the watchdog of {device} again, then press Enter")


async def channel_loss(hub: CheckHub, rec: Any, tool: dict[str, Any] | None, closed: float, source: str | None) -> None:
    """SAFE-2: after the command channel is lost, the device is at rest within 1 s."""
    if rec is None or tool is None or not tool.get("motion"):
        hub.report.add("SAFE-2", "skip", "no motion call ran when the channel closed" + ("" if hub.motion else " (motion is off)"))
        return
    if rec.done.is_set():
        hub.report.add("SAFE-2", "skip", f"{rec.name} ended before the channel closed")
        return
    at_rest = await still(hub, source, closed + 1.0, closed + 2.5)
    if at_rest is None:
        device = hub.description["device"]["id"]
        await confirm(hub, "SAFE-2", f"Did {device} stop within 1 s when mhs-check dropped its command channel just now?", f"{rec.name} running when the channel closed")
    elif at_rest:
        hub.report.add("SAFE-2", "pass", f"odometry at rest from 1 s after the channel closed during {rec.name}")
    else:
        hub.violation("SAFE-2", f"odometry still moving 1 s after the channel closed during {rec.name}")


async def judge_motion(hub: CheckHub) -> None:
    """SAFE-7 and STATE-4 from odometry over the whole run (or the operator); 7.3 from the results."""
    r = hub.report
    source = odometry(hub)
    frames = hub.stream.frames.get(source, []) if source else []
    end = time.monotonic()
    allowed = []
    for c in hub.all_calls:
        if (c.reply or {}).get("accepted"):
            ended = next((at for at, method, _ in c.events if method == "mhs/result"), end)
            allowed.append((c.sent, ended + SETTLE))
    deadman = (hub.description.get("manual") or {}).get("deadman_s", 0)
    allowed += [(at, at + deadman + SETTLE) for at in hub.manual_sent]
    spontaneous = [f for f in frames if moving(f) and not any(a <= f.at <= b for a, b in allowed)]
    can_move = bool([t for t in hub.description.get("tools", []) if t.get("motion")] or hub.description.get("manual"))
    if spontaneous:
        f = spontaneous[0]
        hub.violation("SAFE-7", f"moving (v {f.data.get('v')}, w {f.data.get('w')}) with no call or manual input, {len(spontaneous)} odometry messages")
    elif frames:
        r.add("SAFE-7", "pass", f"{len(frames)} odometry messages: no motion without a call or manual input")
    elif can_move and "core" in hub.profiles:
        device = hub.description["device"]["id"]
        await confirm(hub, "SAFE-7", f"Did {device} stay still whenever mhs-check was not asking it to move?", "no odometry to watch")
    else:
        r.add("SAFE-7", "skip", "no odometry, and the device declares no motion tool or manual control")
    sets = [f for at in hub.set_times for f in frames if at <= f.at <= at + 2]
    if any(moving(f) and not any(a <= f.at <= b for a, b in allowed) for f in sets):
        hub.violation("STATE-4", "odometry shows motion within 2 s of mhs/set")
    elif sets:
        r.add("STATE-4", "pass", f"odometry at rest for 2 s after mhs/set ({len(sets)} messages)")
    else:
        r.add("STATE-4", "skip", "needs odometry or an operator to see that a setting starts no motion")
    if not hub.description.get("device", {}).get("mobile"):
        r.add("7.3", "skip", "not a mobile device")
        return
    results = [c for c in hub.all_calls if c.result is not None]
    bad = [c for c in results if errors("OdometryData", (c.result.get("after") or {}).get("odometry"))]
    if bad:
        hub.violation("7.3", f"the result of {bad[0].name} ({bad[0].id}) has no valid after.odometry")
    elif results:
        r.add("7.3", "pass", f"{len(results)} results carry after.odometry")


# Manual


async def manual(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> None:
    r = hub.report
    m = hub.description["manual"]
    if not hub.motion:
        for rid in ("MAN-1", "MAN-2", "MAN-3", "MAN-4", "SAFE-3"):
            r.add(rid, "skip", "manual input moves the device: motion is off")
        await _watchdog(hub)
        return
    device = hub.description["device"]["id"]
    deadman = m["deadman_s"]
    axis = next((a for a in m["axes"] if a.get("role") == "forward"), None) or next((a for a in m["axes"] if a.get("role") == "turn"), m["axes"][0])
    value = axis["max"] / 2 if axis["max"] > 0 else axis["min"] / 2
    go = {axis["id"]: value}
    source = await odometry_on(hub, cmd)
    log(f"driving {device} by hand on {axis['id']}")

    # Interrupt (MAN-3).
    tool = _long(hub.tools(motion=True))
    if tool is None:
        r.add("MAN-3", "skip", "no motion tool to interrupt")
    else:
        rec = await cmd.call(tool["name"], hub.args(tool["inputSchema"]))
        await asyncio.sleep(0.3)
        if rec.done.is_set():
            r.add("MAN-3", "skip", f"{tool['name']} ended within 0.3 s: {rec.result}")
        else:
            await hold(hub, go, 0.3)
            result = await cmd.finish(rec, 2)
            if (result or {}).get("reason") == "manual":
                r.add("MAN-3", "pass", f"manual input interrupted {tool['name']}: interrupted/manual")
            else:
                hub.violation("MAN-3", f"manual input during {tool['name']}: {result}")

    # Busy while manual (MAN-3, CALL-3), then the deadman (MAN-4).
    reject = hub.description.get("resources", {})
    busy = next((t for t in hub.tools(motion=True) if any(reject.get(u) == "reject" for u in t.get("uses", []))), None)
    started = time.monotonic()
    holding = asyncio.ensure_future(hold(hub, go, 1.0))
    await asyncio.sleep(0.3)
    if busy is None:
        r.add("CALL-3", "skip", "no motion tool uses a reject resource")
    else:
        rec = await cmd.call(busy["name"], hub.args(busy["inputSchema"]))
        reply = rec.reply or {}
        if reply.get("reason") == "busy" and reply.get("holder") == {"manual": True}:
            r.add("MAN-3", "pass", f"{busy['name']} during manual control rejected busy, holder manual")
            r.add("CALL-3", "pass", f"{busy['name']} during manual control: holder {{manual: true}}")
        else:
            hub.violation("MAN-3", f"{busy['name']} during manual control: {reply}")
            if reply.get("accepted"):
                await cmd.request("mhs/stop", {})
    last = await holding
    moved = await still(hub, source, started, last)
    at_rest = await still(hub, source, last + deadman + 0.5, last + deadman + 1.2)
    if moved is None or moved or at_rest is None:
        await confirm(hub, "MAN-4", f"Did {device} stop by itself within {deadman + 0.5:g} s after the manual input stopped just now?", "no odometry to watch" if source is None else "odometry did not show the manual motion")
    elif at_rest:
        r.add("MAN-4", "pass", f"odometry at rest {deadman + 0.5:g} s after the last manual input (deadman_s {deadman})")
    else:
        hub.violation("MAN-4", f"odometry still moving {deadman + 0.5:g} s after the last manual input")

    # Clamping (MAN-2): three times the axis maximum.
    big = 3 * (axis["max"] if axis["max"] > 0 else axis["min"])
    started = time.monotonic()
    last = await hold(hub, {axis["id"]: big}, 1.0)
    frames = hub.stream.window(source, started + 0.3, last) if source else []
    measure = {("forward", "m/s"): "v", ("turn", "deg/s"): "w"}.get((axis.get("role"), axis.get("unit")))
    limit = max(abs(axis["min"]), abs(axis["max"]))
    if frames and measure:
        fastest = max(abs(f.data.get(measure, 0)) for f in frames)
        if fastest <= limit * 1.1 + 0.01:
            r.add("MAN-2", "pass", f"{axis['id']}={big:g} sent; odometry {measure} at most {fastest:.2f}, limit {limit:g} {axis['unit']}")
        else:
            hub.violation("MAN-2", f"{axis['id']}={big:g} sent; odometry {measure} reached {fastest:.2f}, limit {limit:g} {axis['unit']}")
    else:
        await confirm(hub, "MAN-2", f"While mhs-check sent {axis['id']} at {big:g}, did {device} stay within {limit:g} {axis['unit']}?", "no odometry for this axis")
    await asyncio.sleep(deadman + SETTLE)

    # Absent axes are zero (MAN-1): the axis, then messages without it.
    started = time.monotonic()
    await hold(hub, go, 0.6)
    moved = await still(hub, source, started, time.monotonic())
    started = time.monotonic()
    last = await hold(hub, {}, 1.0)
    at_rest = await still(hub, source, started + 0.6, last)
    if moved is None or moved or at_rest is None:
        r.add("MAN-1", "skip", "needs odometry that shows the manual motion")
    elif at_rest:
        r.add("MAN-1", "pass", f"messages without {axis['id']} brought it to rest before the deadman")
    else:
        hub.violation("MAN-1", f"still moving on messages without {axis['id']}")

    # Nerve lost while driving (SAFE-3).
    conn = hub.stream.conn
    holding = asyncio.ensure_future(hold(hub, go, 1.5))
    await asyncio.sleep(0.5)
    closed = time.monotonic()
    await hub.stream.ws.close(1001)
    await holding
    for _ in range(50):
        if hub.stream.conn > conn:
            break
        await asyncio.sleep(0.1)
    if hub.stream.conn == conn:
        hub.violation("CONN-6", "the Nerve channel did not come back within 5 s")
    at_rest = await still(hub, source, closed + deadman + 0.5, closed + deadman + 2.5)
    if at_rest is None:
        await confirm(hub, "SAFE-3", f"Did {device} stop within {deadman + 0.5:g} s when mhs-check dropped the Nerve channel while driving it just now?", "no odometry after the Nerve channel came back")
    elif at_rest:
        r.add("SAFE-3", "pass", "odometry at rest after the Nerve channel was lost during manual control")
    else:
        hub.violation("SAFE-3", "still moving after the Nerve channel was lost during manual control")
    await _watchdog(hub)
    await asyncio.sleep(deadman + SETTLE)


async def _watchdog(hub: CheckHub) -> None:
    device = hub.description["device"]["id"]
    await confirm(hub, "MAN-5", f"Does the deadman of {device} keep working when its MHS process stops responding?", "mhs-check cannot verify that the deadman survives a hung process (conformance 2.4)")


# Pause


async def pause(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> None:
    r = hub.report
    tool = _long([t for t in hub.tools() if t.get("pausable")])
    if tool is None:
        for rid in ("CTL-5", "CTL-6"):
            r.add(rid, "skip", "every pausable tool is a motion tool: motion is off")
    else:
        await _pause_resume(hub, cmd, tool)
        await _stop_paused(hub, cmd, tool)
    other = _long([t for t in hub.tools() if not t.get("pausable")])
    if other is None:
        r.add("8.3", "skip", "no tool that is not pausable" + ("" if hub.motion else " (motion is off)"))
        return
    rec = await cmd.call(other["name"], hub.args(other["inputSchema"]))
    response, _ = await cmd.request("mhs/pause", {"call": rec.id}, timeout=2.5)
    if ((response or {}).get("result") or {}).get("paused") is False:
        r.add("8.3", "pass", f"pausing {other['name']}, which is not pausable: paused false")
    else:
        hub.violation("8.3", f"pausing {other['name']}, which is not pausable: {response}")
    await cmd.request("mhs/cancel", {"call": rec.id})
    await cmd.finish(rec, 5)


async def _pause_resume(hub: CheckHub, cmd: Command, tool: dict[str, Any]) -> None:
    """CTL-5: at rest before the pause reply, progress paused; after resume progress running, then
    a result (done, interrupted or error) within the tool's timeout + 5 s, the hub's limit for a
    result. A call that stays paused or never ends fails."""
    source = odometry(hub)
    rec = await cmd.call(tool["name"], hub.args(tool["inputSchema"]))
    await asyncio.sleep(0.3)
    if rec.done.is_set():
        hub.report.add("CTL-5", "skip", f"{tool['name']} ended within 0.3 s: {rec.result}")
        return
    response, took = await cmd.request("mhs/pause", {"call": rec.id}, timeout=2.5)
    paused_at = time.monotonic()
    paused = ((response or {}).get("result") or {}).get("paused")
    at_rest = await still(hub, source, paused_at + 0.2, paused_at + 1.0) if tool.get("motion") else None
    ended_while_paused = rec.done.is_set()
    response, _ = await cmd.request("mhs/resume", {"call": rec.id}, timeout=2.5)
    resumed = ((response or {}).get("result") or {}).get("resumed")
    deadline = tool["timeout"] + 5
    result = await cmd.finish(rec, deadline)
    states = [p.get("state") for _, method, p in rec.events if method == "mhs/progress" and "state" in p]
    problems = []
    if paused is not True or took > 2:
        problems.append(f"pause answered {paused} in {took:.1f} s")
    if at_rest is False:
        problems.append("odometry moving while paused")
    if ended_while_paused:
        problems.append("the call ended while paused")
    if resumed is not True:
        problems.append(f"resume answered {resumed}")
    if states[:2] != ["paused", "running"]:
        problems.append(f"progress states {states}" + ("; still paused after resume" if "running" not in states else ""))
    if result is None:
        problems.append(f"no result within {deadline:g} s of resuming")
    elif result.get("status") not in ("done", "interrupted", "error"):
        problems.append(f"result status {result.get('status')}")
    if problems:
        hub.violation("CTL-5", f"{tool['name']}: {'; '.join(problems)}")
    else:
        rest = "at rest, " if at_rest else ""
        ended = result["status"] + (f"/{result['reason']}" if "reason" in result else "")
        hub.report.add("CTL-5", "pass", f"{tool['name']} paused in {took * 1000:.0f} ms ({rest}progress paused), resumed (progress running), then ended {ended}")


async def _stop_paused(hub: CheckHub, cmd: Command, tool: dict[str, Any]) -> None:
    """CTL-6: a paused call is still running; stop (motion) or cancel ends it."""
    rec = await cmd.call(tool["name"], hub.args(tool["inputSchema"]))
    await asyncio.sleep(0.3)
    response, _ = await cmd.request("mhs/pause", {"call": rec.id}, timeout=2.5)
    if rec.done.is_set() or ((response or {}).get("result") or {}).get("paused") is not True:
        hub.report.add("CTL-6", "skip", f"{tool['name']} could not be paused: {response}")
        await cmd.request("mhs/cancel", {"call": rec.id})
        await cmd.finish(rec, 5)
        return
    how = "stop" if tool.get("motion") else "cancel"
    await cmd.request(f"mhs/{how}", {} if how == "stop" else {"call": rec.id}, timeout=2.5)
    result = await cmd.finish(rec, 5)
    if (result or {}).get("status") == "interrupted" and result.get("reason") == how:
        hub.report.add("CTL-6", "pass", f"{how} while {tool['name']} was paused: interrupted/{how}")
    else:
        hub.violation("CTL-6", f"{how} while {tool['name']} was paused: {result}")


# Audio clip


def tone(seconds: float = 2.0, rate: int = 24000) -> bytes:
    """A 440 Hz tone as 16-bit little-endian mono PCM."""
    n = int(seconds * rate)
    return struct.pack(f"<{n}h", *(int(8000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(n)))


async def clip(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> None:
    """STR-8: a clip sent first is played; an unknown clip id falls back or ends error/dependency."""
    r = hub.report
    tools = [t for t in hub.tools() if "clip" in t["inputSchema"].get("properties", {})]
    if not tools:
        r.add("STR-8", "skip", "every tool taking a clip is a motion tool: motion is off")
        return
    tool = tools[0]
    clip_id = hub.new_id("clip")
    await hub.stream.send({"type": "clip", "id": clip_id, "rate": 24000, "channels": 1}, tone())
    await asyncio.sleep(0.3)
    rec = await cmd.call(tool["name"], {**hub.args(tool["inputSchema"]), "clip": clip_id})
    result = await cmd.finish(rec, tool["timeout"] + 5)
    fallback = [n for n in (result or {}).get("notes", []) if clip_id in n]
    if (result or {}).get("status") == "done" and not fallback:
        r.add("STR-8", "pass", f"{tool['name']} played the 2 s clip {clip_id}: done")
    elif fallback:
        hub.violation("STR-8", f"{tool['name']} did not use the clip {clip_id} just sent: {fallback[0]}")
    else:
        hub.violation("STR-8", f"{tool['name']} with the clip {clip_id} just sent: {rec.reply if result is None else result}")
    rec = await cmd.call(tool["name"], {**hub.args(tool["inputSchema"]), "clip": "no-such-clip"})
    result = await cmd.finish(rec, tool["timeout"] + 5) or {}
    if (result.get("status") == "done" and result.get("notes")) or result.get("reason") == "dependency":
        r.add("STR-8", "pass", f"{tool['name']} with an unknown clip: {result.get('status')} {result.get('reason') or result.get('notes')}")
    else:
        hub.violation("STR-8", f"{tool['name']} with an unknown clip: neither a fallback in notes nor error/dependency: {result or rec.reply}")

"""mhs-check: a test hub that runs the conformance scenarios against one device.

    python -m agnes_mhs.check [--port 8800] [--profile core,video] [--no-motion] [--interactive]
                              [--report report.json] [--replace-wait 30] [--check-version]

Point the device at ws://<host>:8800 and start it. mhs-check takes its registration, works out which
profiles apply (MHS 15.1, MOS 12), runs their scenarios of mhs-conformance.md 2.3 in order and
reports, for each requirement id of those profiles, pass, fail, warn, skip or manual with its
evidence. The last scenarios close the device's connections on purpose (reconnect, version refusal,
replacement), so the device ends up stopped. The exit status is non-zero when any requirement failed.

Scenarios that make the device move are skipped with --no-motion; skipped is never passed. Physical
checks without odometry ask the operator with --interactive, and are manual without it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from websockets.asyncio.server import ServerConnection, serve

from . import check_mhs, check_mos
from .check_mos import DERIVED, Stream, field_problems
from .schema import HUB_ONLY_REASONS, PROTOCOL, errors

CORE = [
    "MSG-1", "MSG-2", "MSG-3", "MSG-6", "MSG-7", "ID-1",
    "CONN-1", "CONN-2", "CONN-3", "CONN-5", "CONN-6", "CONN-7", "CONN-8", "CONN-9",
    "REG-1", "REG-2", "REG-3", "REG-4", "TOOL-1", "TOOL-2", "CALL-1", "CALL-2", "CALL-3", "CALL-4", "CALL-5",
    "CTL-1", "CTL-2", "CTL-3", "CTL-4", "STATE-1", "STATE-2", "STATE-3", "STATE-4",
    "RES-1", "SAFE-1", "SAFE-4", "SAFE-7",
]  # fmt: skip
# Requirement ids by profile (MHS 15.1, MOS 12). 7.3 and 8.3 are sections whose rules carry no id.
PROFILES = {
    "core": CORE,
    "motion": ["SAFE-2", "SAFE-5", "SAFE-6", "7.3"],
    "manual": ["MAN-1", "MAN-2", "MAN-3", "MAN-4", "MAN-5", "SAFE-3"],
    "pause": ["CTL-5", "CTL-6", "8.3"],
    "perception": ["CONN-4", "MSG-4", "MSG-5", "PER-1", "PER-2"],
    "maps": ["MAP-1", "MAP-2", "MAP-3", "MAP-4"],
    "derived": ["PER-3", "PER-4", "PER-5", "PER-6"],
    "streaming": ["STR-1", "STR-2", "STR-3", "STR-4", "STR-5", "STR-6", "STR-7", "TIME-1", "TIME-2"],
    "video": ["VID-1", "VID-2", "VID-3", "VID-4", "VID-5", "VID-6", "VID-7"],
    "clip": ["CONN-4", "STR-8"],
}
RANK = {"fail": 4, "warn": 3, "manual": 2, "pass": 1, "skip": 0}
NOT_AUTOMATIC = {
    "MSG-7": "not observable: whether the device relies on fields outside this version",
    "CALL-1": "not observable: whether behavior depends on meta",
}


def applicable(d: dict[str, Any]) -> list[str]:
    """The profiles that apply to a description, in the order they run."""
    tools = d.get("tools", [])
    sources = d.get("sources", [])
    applies = {
        "core": True,
        "motion": any(t.get("motion") for t in tools),
        "manual": "manual" in d,
        "pause": any(t.get("pausable") for t in tools),
        "perception": bool(sources),
        "maps": bool(d.get("maps")) or "placement" in d or any(s.get("kind") in ("pose", "grid") for s in sources),
        "derived": any(s.get("kind") in DERIVED for s in sources),
        "streaming": bool(sources),
        "video": any(s.get("kind") == "video" for s in sources),
        "clip": any("clip" in t.get("inputSchema", {}).get("properties", {}) for t in tools),
    }
    return [p for p in PROFILES if applies[p]]


class Report:
    def __init__(self) -> None:
        self.results: dict[str, list[tuple[str, str, str | None]]] = {}

    def add(self, rid: str, status: str, evidence: str, operator: str | None = None) -> None:
        self.results.setdefault(rid, []).append((status, evidence, operator))

    def final(self, profiles: list[str] | None = None) -> list[dict[str, str]]:
        ids = list(dict.fromkeys(rid for p in profiles or ["core"] for rid in PROFILES[p]))
        out = []
        for rid in ids:
            entries = self.results.get(rid) or [("skip", NOT_AUTOMATIC.get(rid, "no scenario reached it"), None)]
            worst = max(entries, key=lambda e: RANK[e[0]])[0]
            evidence = "; ".join([e for s, e, _ in entries if s == worst][:3])
            result = {"id": rid, "status": worst, "evidence": evidence}
            operator = next((o for s, _, o in entries if s == worst and o), None)
            if operator:
                result["operator"] = operator
            out.append(result)
        return out


@dataclass
class CallRecord:
    id: str
    name: str
    args: dict[str, Any]
    sent: float
    reply: dict[str, Any] | None = None
    replied: float = 0.0
    events: list[tuple[float, str, dict[str, Any]]] = field(default_factory=list)
    result: dict[str, Any] | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)


class Command:
    """One command channel of the device, read by a background task."""

    def __init__(self, ws: ServerConnection, hub: CheckHub):
        self.ws = ws
        self.hub = hub
        self.first: asyncio.Future = asyncio.get_running_loop().create_future()
        self.inbox: list[tuple[float, dict[str, Any]]] = []
        self.responses: dict[str, asyncio.Future] = {}
        self.calls: dict[str, CallRecord] = {}
        self.closed = asyncio.Event()
        self.close_code: int | None = None
        self.states: list[tuple[float, dict[str, Any]]] = []
        self.pings: list[float] = []

    def send(self, msg: dict[str, Any]) -> None:
        asyncio.ensure_future(self.ws.send(json.dumps(msg)))

    async def request(self, method: str, params: dict[str, Any], extra: dict[str, Any] | None = None, timeout: float = 5.0) -> tuple[dict[str, Any] | None, float]:
        """Sends a request; returns its response and how long it took, or (None, timeout)."""
        rid = self.hub.new_id("x")
        future = asyncio.get_running_loop().create_future()
        self.responses[rid] = future
        sent = time.monotonic()
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params, **(extra or {})})
        try:
            response = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            return None, timeout
        return response, time.monotonic() - sent

    async def call(self, name: str, args: dict[str, Any], extra_params: dict[str, Any] | None = None) -> CallRecord:
        """Sends mhs/call and waits for the reply (not the result)."""
        rid = self.hub.new_id("c")
        record = CallRecord(rid, name, args, time.monotonic())
        self.calls[rid] = record
        self.hub.all_calls.append(record)
        future = asyncio.get_running_loop().create_future()
        self.responses[rid] = future
        self.send({"jsonrpc": "2.0", "id": rid, "method": "mhs/call", "params": {"name": name, "arguments": args, **(extra_params or {})}})
        try:
            response = await asyncio.wait_for(future, 5.0)
            record.reply = response.get("result") if isinstance(response, dict) else None
        except asyncio.TimeoutError:
            record.reply = None
        record.replied = time.monotonic()
        if not (record.reply or {}).get("accepted"):
            record.done.set()
        return record

    async def finish(self, record: CallRecord, timeout: float) -> dict[str, Any] | None:
        try:
            await asyncio.wait_for(record.done.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        return record.result

    def handle(self, raw: str | bytes) -> None:
        now = time.monotonic()
        hub = self.hub
        if isinstance(raw, bytes):
            hub.violation("MSG-1", "a binary frame on the command channel")
            return
        if len(raw.encode()) > 64 * 1024:
            hub.violation("MSG-3", f"a command message of {len(raw.encode())} bytes")
        try:
            msg = json.loads(raw)
        except ValueError:
            hub.violation("MSG-1", "a command message that is not JSON")
            return
        if isinstance(msg, list):
            hub.violation("MSG-1", "a JSON-RPC batch")
            return
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            hub.violation("MSG-1", f"not a JSON-RPC 2.0 message: {raw[:80]}")
            return
        self.inbox.append((now, msg))
        if not self.first.done():
            self.first.set_result(msg)
            return
        method = msg.get("method")
        if method is None:
            future = self.responses.pop(str(msg.get("id")), None)
            if future is not None and not future.done():
                future.set_result(msg)
            return
        if "id" in msg:
            if method == "mhs/ping":
                self.pings.append(now)
                self.send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
                return
            if method == "mhs/register":
                hub.violation("REG-3", "mhs/register sent again on the same connection")
            else:
                hub.violation("MSG-1", f"unexpected request {method} from the device")
            return
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if method == "mhs/state":
            if hub.schema("STATE-2", "StateParams", params):
                for problem in state_problems(hub.description.get("state", {}), params["values"]):
                    hub.violation("STATE-2", problem)
                self.states.append((now, params))
            return
        record = self.calls.get(str(params.get("call")))
        if record is None:
            hub.violation("CALL-5", f"{method} for unknown call {params.get('call')}")
            return
        if method == "mhs/progress":
            hub.schema("MSG-1", "ProgressParams", params)
        elif method == "mhs/result":
            hub.schema("MSG-1", "ResultParams", params)
            if params.get("reason") in HUB_ONLY_REASONS:
                hub.violation("RES-1", f"call {record.id} ended with hub-only reason {params['reason']}")
        record.events.append((now, method, params))
        if method == "mhs/result":
            if record.result is not None:
                hub.violation("CALL-5", f"a second result for call {record.id}")
            record.result = params
            record.done.set()


async def no_operator(question: str) -> str | None:
    return None


class CheckHub:
    def __init__(self, motion: bool, ask: Callable[[str], Awaitable[str | None]] = no_operator, pace: float = 1.0):
        self.motion = motion
        self.ask = ask  # the operator's answer to a question, or None without --interactive
        self.pace = pace  # scales the measuring windows; the tests run faster with less
        self.report = Report()
        self.profiles: list[str] = ["core"]
        self.connections: asyncio.Queue[Command] = asyncio.Queue()
        self.connect_times: list[float] = []
        self.nerve_open = asyncio.Event()
        self.stream = Stream(self)
        self.all_calls: list[CallRecord] = []
        self.set_times: list[float] = []
        self.manual_sent: list[float] = []
        self.violations: set[str] = set()
        self.description: dict[str, Any] = {}
        self._next = 0
        self._sign: dict[str, int] = {}

    def new_id(self, prefix: str) -> str:
        self._next += 1
        return f"{prefix}{self._next}"

    def violation(self, rid: str, evidence: str) -> None:
        self.violations.add(rid)
        self.report.add(rid, "fail", evidence)

    def schema(self, rid: str, definition: str, value: Any) -> bool:
        found = errors(definition, value)
        if found:
            self.violation(rid, f"{definition}: {found[0]}")
        return not found

    async def handler(self, ws: ServerConnection) -> None:
        path = ws.request.path if ws.request else ""
        if path.startswith("/ws/nerve"):
            await self._nerve(ws)
            return
        command = Command(ws, self)
        self.connect_times.append(time.monotonic())
        await self.connections.put(command)
        try:
            async for raw in ws:
                command.handle(raw)
        except Exception:
            pass
        finally:
            command.close_code = ws.close_code
            command.closed.set()

    async def _nerve(self, ws: ServerConnection) -> None:
        first = True
        try:
            async for raw in ws:
                await self.stream.flow.wait()  # not reading while congestion is simulated (STR-6)
                now = time.monotonic()
                if isinstance(raw, bytes):
                    if len(raw) > 16 * 1024 * 1024:
                        self.violation("MSG-5", f"a binary Nerve frame of {len(raw)} bytes")
                    self.stream.binary(raw)
                    continue
                if len(raw.encode()) > 1024 * 1024:
                    self.violation("MSG-5", f"a Nerve text frame of {len(raw.encode())} bytes")
                try:
                    msg = json.loads(raw)
                except ValueError:
                    self.violation("MSG-4", "a Nerve message that is not JSON")
                    continue
                if not isinstance(msg, dict) or "type" not in msg:
                    self.violation("MSG-4", "a Nerve message without type")
                    continue
                if first:
                    first = False
                    if self.schema("CONN-4", "NerveHello", msg):
                        self.report.add("CONN-4", "pass", "the Nerve channel opened with hello")
                        self.stream.opened(ws)
                        self.nerve_open.set()
                    continue
                self.stream.text(msg, now)
        except Exception:
            pass

    # Arguments

    def sample(self, param: dict[str, Any], key: str) -> Any:
        """A valid value; numbers alternate sign so a mobile device goes back and forth."""
        if "default" in param:
            return param["default"]
        if "enum" in param:
            return param["enum"][0]
        kind = param.get("type")
        if kind in ("number", "integer"):
            lo, hi = param.get("minimum"), param.get("maximum")
            sign = self._sign.get(key, 1)
            self._sign[key] = -sign
            value = 0.5 * (hi if sign > 0 and hi is not None and hi > 0 else lo if lo is not None and lo < 0 else (hi or 1))
            if lo is not None:
                value = max(lo, value)
            if hi is not None:
                value = min(hi, value)
            return round(value) if kind == "integer" else value
        if kind == "string":
            return "test"[: param.get("maxLength", 4)] or "t"
        if kind == "boolean":
            return False
        if kind == "array":
            return [self.sample(param.get("items", {}), key + "[]") for _ in range(param.get("minItems", 0))]
        if kind == "object":
            return self.args({"properties": param.get("properties", {}), "required": param.get("required", [])}, key + ".")
        return None

    def args(self, schema: dict[str, Any], prefix: str = "") -> dict[str, Any]:
        props = schema.get("properties", {})
        return {k: self.sample(p, prefix + k) for k, p in props.items() if k in schema.get("required", [])}

    def tools(self, *, motion: bool | None = None) -> list[dict[str, Any]]:
        """The declared tools, without motion tools when motion is off."""
        out = []
        for tool in self.description.get("tools", []):
            if motion is not None and bool(tool.get("motion")) != motion:
                continue
            if tool.get("motion") and not self.motion:
                continue
            out.append(tool)
        return out


WRONG = {"number": "x", "integer": "x", "string": 12, "boolean": "yes", "array": "x", "object": "x"}


def register_problems(params: dict[str, Any]) -> list[str]:
    """REG-2 and the references a schema cannot check."""
    found = []
    for what, ids in (
        ("source", [s.get("id") for s in params.get("sources", [])]),
        ("tool", [t.get("name") for t in params.get("tools", [])]),
        ("axis", [a.get("id") for a in (params.get("manual") or {}).get("axes", [])]),
    ):
        dup = {i for i in ids if ids.count(i) > 1}
        found += [f"{what} {i} is declared twice" for i in sorted(dup)]
    resources = set(params.get("resources", {}))
    for tool in params.get("tools", []):
        found += [f"tool {tool['name']} uses undeclared resource {u}" for u in tool.get("uses", []) if u not in resources]
    return found


def needs_nerve(d: dict[str, Any]) -> bool:
    clip = any("clip" in t.get("inputSchema", {}).get("properties", {}) for t in d.get("tools", []))
    return bool(d.get("resources")) or bool(d.get("sources")) or "manual" in d or clip


async def run(
    hub: CheckHub,
    wait_device: float,
    replace_wait: float,
    check_version: bool,
    log: Callable[[str], None],
    only: list[str] | None = None,
) -> None:
    """Runs every applicable profile, or those of them in only; Core's registration always runs."""
    cmd = await _register(hub, wait_device, log)
    if cmd is None:
        return
    hub.profiles = [p for p in applicable(hub.description) if only is None or p in only]
    log(f"profiles: {', '.join(hub.profiles)}")
    run = set(hub.profiles)
    if "core" in run:
        await _core(hub, cmd)
    if "perception" in run:
        check_mos.perception(hub)
    if "maps" in run:
        await check_mos.maps(hub, cmd)
    if "streaming" in run:
        await check_mos.streaming(hub, cmd, log)
    if "video" in run:
        await check_mos.video(hub, cmd, log)
    if "derived" in run:
        await check_mos.derived(hub, cmd)
    for profile, scenarios in (("manual", check_mhs.manual), ("pause", check_mhs.pause), ("clip", check_mhs.clip), ("motion", check_mhs.motion)):
        if profile in run:
            await scenarios(hub, cmd, log)
    _check_calls(hub)
    _check_state(hub)
    check_mos.judge_streams(hub)
    await check_mhs.judge_motion(hub)
    if run & {"core", "motion"}:
        cmd = await _reconnect(hub, cmd, log)
    if "core" in run and cmd is not None:
        if check_version:
            await _version(hub, cmd, log)
        else:
            await _replacement(hub, cmd, replace_wait, log)


async def _register(hub: CheckHub, wait_device: float, log: Callable[[str], None]) -> Command | None:
    """Registration, silence and stop before the reply, the first state, settings."""
    r = hub.report
    log(f"waiting up to {wait_device:.0f} s for the device")
    cmd = await asyncio.wait_for(hub.connections.get(), wait_device)
    r.add("CONN-1", "pass", "the device reached the hub it was configured with")

    # Registration, silence before the reply, stop before the reply.
    try:
        first = await asyncio.wait_for(cmd.first, 30)
    except asyncio.TimeoutError:
        hub.violation("CONN-2", "connected, but sent nothing within 30 s")
        return None
    if first.get("method") != "mhs/register" or "id" not in first:
        hub.violation("CONN-2", f"first message was {first.get('method')}")
        return None
    r.add("CONN-2", "pass", "the first message was mhs/register")
    if not isinstance(first.get("id"), str):
        hub.violation("MSG-2", f"register id {first.get('id')!r} is not a string")
    params = first.get("params") or {}
    hub.description = params
    if hub.schema("REG-1", "RegisterParams", params):
        r.add("REG-1", "pass", "the description validates")
        r.add("TOOL-1", "pass", f"{len(params.get('tools', []))} tool parameter schemas use the 6.2 subset")
        r.add("ID-1", "pass", f"device id {params['device']['id']} has the id syntax")
    else:
        hub.violation("TOOL-1", "see REG-1")
    problems = register_problems(params)
    for p in problems:
        hub.violation("REG-2", p)
    if not problems:
        r.add("REG-2", "pass", "ids unique and uses name declared resources")
    if params.get("localization") != "fixed":
        r.add("REG-4", "skip", f"localization {params.get('localization', 'none')}: not a fixed device")
    elif hub.schema("REG-4", "Placement", params.get("placement")):
        r.add("REG-4", "pass", f"a fixed device placed on map {params['placement']['map']}")
    if params.get("protocol") != PROTOCOL:
        hub.violation("REG-1", f"protocol {params.get('protocol')}")
    device_id = params.get("device", {}).get("id")
    log(f"{device_id} registered; holding the reply 1 s and sending stop meanwhile")

    await asyncio.sleep(0.3)
    before = len(cmd.inbox)
    stop, took = await cmd.request("mhs/stop", {}, timeout=2.5)
    if stop is None or "result" not in stop:
        hub.violation("CTL-2", "no reply to mhs/stop before the register reply")
    else:
        r.add("CTL-2", "pass", f"stop before the register reply answered in {took * 1000:.0f} ms")
    await asyncio.sleep(0.7)
    others = [m for _, m in cmd.inbox[before:] if "method" in m]
    if others:
        hub.violation("CONN-3", f"{len(others)} messages before the register reply, e.g. {others[0].get('method')}")
    else:
        r.add("CONN-3", "pass", "nothing but the stop reply before the register reply")
    cmd.send({"jsonrpc": "2.0", "id": first["id"], "result": {"session": "check", "hub": {"name": "mhs-check", "version": "1.0.0"}, "time": time.time()}})

    if needs_nerve(params):
        try:
            await asyncio.wait_for(hub.nerve_open.wait(), 5)
        except asyncio.TimeoutError:
            hub.violation("CONN-4", "no Nerve channel with hello within 5 s although the device needs one (4.3)")
    else:
        r.add("CONN-4", "skip", "the device declares nothing that needs the Nerve channel")
    await _state(hub, cmd)
    return cmd


async def _core(hub: CheckHub, cmd: Command) -> None:
    """The Core scenarios on calls and control (conformance 2.3)."""
    r = hub.report

    # Unknown fields (MSG-6).
    response, _ = await cmd.request("mhs/time", {"x_probe": 1}, extra={"x_trace": "check"})
    if response and "result" in response and hub.schema("MSG-6", "TimeResult", response["result"]):
        r.add("MSG-6", "pass", "mhs/time with unknown fields was answered normally")
    else:
        hub.violation("MSG-6", "mhs/time with unknown fields was not answered normally")

    # Stop while idle.
    response, took = await cmd.request("mhs/stop", {}, timeout=2.5)
    if response and response.get("result", {}).get("stopped") == []:
        r.add("CTL-2", "pass", f"stop while idle answered in {took * 1000:.0f} ms with nothing stopped")
        r.add("CTL-4", "pass" if took <= 2 else "fail", f"stop reply {took * 1000:.0f} ms")
    else:
        hub.violation("CTL-2", f"stop while idle: {response}")

    # Wrong arguments and clamping, tool by tool.
    for tool in hub.description.get("tools", []):
        schema = tool["inputSchema"]
        props, required = schema.get("properties", {}), schema.get("required", [])
        base = hub.args(schema)
        if required:
            missing = dict(base)
            missing.pop(required[0], None)
            rec = await cmd.call(tool["name"], missing)
            _expect_invalid(hub, rec, f"{tool['name']} without {required[0]}")
        for key, param in props.items():
            wrong = WRONG.get(param.get("type", ""))
            if wrong is None:
                continue
            rec = await cmd.call(tool["name"], {**base, key: wrong})
            _expect_invalid(hub, rec, f"{tool['name']} with {key}={wrong!r}")
            break
        if tool.get("motion") and not hub.motion:
            r.add("TOOL-2", "skip", f"clamping {tool['name']}: motion is off")
            continue
        if tool.get("timeout", 0) > 60:
            r.add("TOOL-2", "skip", f"clamping {tool['name']}: timeout {tool['timeout']} s is too long to wait for")
            continue
        for key, param in props.items():
            if param.get("type") not in ("number", "integer") or "maximum" not in param:
                continue
            beyond = param["maximum"] + max(1, abs(param["maximum"]))
            if param.get("type") == "integer":
                beyond = math.ceil(beyond)
            rec = await cmd.call(tool["name"], {**hub.args(schema), key: beyond})
            if not (rec.reply or {}).get("accepted"):
                hub.violation("TOOL-2", f"{tool['name']} with {key}={beyond} beyond its maximum was not accepted: {rec.reply}")
                break
            result = await cmd.finish(rec, min(tool["timeout"] + 5, 20))
            if result is None:
                await cmd.request("mhs/cancel", {"call": rec.id})
                result = await cmd.finish(rec, 3)
            if result and result.get("notes"):
                r.add("TOOL-2", "pass", f"{tool['name']} {key}={beyond} clamped, noted: {result['notes'][0]}")
                r.add("SAFE-4", "pass", f"{tool['name']} kept {key} within its declared range")
            else:
                hub.violation("TOOL-2", f"{tool['name']} {key}={beyond}: no note about clamping in the result")
            break

    if "TOOL-2" not in r.results:
        r.add("TOOL-2", "skip", "no tool takes parameters")
    if "SAFE-4" not in r.results:
        r.add("SAFE-4", "skip", "no numeric parameter with a maximum to go beyond")

    # Busy, cancel and stop on a long call.
    long_tool = next((t for t in hub.tools() if any(hub.description.get("resources", {}).get(u) == "reject" for u in t.get("uses", []))), None)
    if long_tool is None:
        r.add("CALL-3", "skip", "no tool uses a reject resource" + ("" if hub.motion else " (or motion is off)"))
        r.add("CTL-1", "skip", "cancel runs on a tool that uses a reject resource; there is none")
    else:
        first_call = await cmd.call(long_tool["name"], hub.args(long_tool["inputSchema"]))
        second = await cmd.call(long_tool["name"], hub.args(long_tool["inputSchema"]))
        reply = second.reply or {}
        if not (first_call.reply or {}).get("accepted"):
            r.add("CALL-3", "skip", f"{long_tool['name']} was not accepted: {first_call.reply}")
        elif first_call.done.is_set():
            r.add("CALL-3", "skip", f"{long_tool['name']} finished before the second call")
        elif reply.get("reason") == "busy" and reply.get("holder") == {"call": first_call.id, "tool": long_tool["name"]}:
            r.add("CALL-3", "pass", f"second {long_tool['name']} rejected busy, holder {first_call.id}")
        else:
            hub.violation("CALL-3", f"second {long_tool['name']} while the first ran: {reply}")
        was_running = not first_call.done.is_set()
        response, took = await cmd.request("mhs/cancel", {"call": first_call.id})
        again, _ = await cmd.request("mhs/cancel", {"call": first_call.id})
        unknown, _ = await cmd.request("mhs/cancel", {"call": "no-such-call"})
        result = await cmd.finish(first_call, 5)
        cancelled = (response or {}).get("result", {}).get("cancelled")
        answered = "result" in (again or {}) and (unknown or {}).get("result", {}).get("cancelled") is False
        interrupted = cancelled is True and (result or {}).get("reason") == "cancel"
        if answered and (interrupted or not was_running):
            r.add("CTL-1", "pass", f"cancel answered in {took * 1000:.0f} ms and ended the call; cancelling twice and an unknown id were not errors")
        else:
            hub.violation("CTL-1", f"cancel: {response}, again: {again}, unknown: {unknown}, result: {result}")

    # Stop during each motion tool; non-motion calls continue.
    other = next((t for t in hub.description.get("tools", []) if not t.get("motion") and t.get("timeout", 0) <= 60), None)
    for tool in hub.tools(motion=True):
        bystander = await cmd.call(other["name"], hub.args(other["inputSchema"])) if other else None
        rec = await cmd.call(tool["name"], hub.args(tool["inputSchema"]))
        await asyncio.sleep(0.3)
        running = not rec.done.is_set()
        response, took = await cmd.request("mhs/stop", {}, timeout=2.5)
        result = await cmd.finish(rec, 5)
        stopped = (response or {}).get("result", {}).get("stopped")
        r.add("CTL-4", "pass" if response and took <= 2 else "fail", f"stop during {tool['name']} answered in {took * 1000:.0f} ms")
        if not running:
            r.add("CTL-3", "skip", f"{tool['name']} finished within 0.3 s")
        elif isinstance(stopped, list) and rec.id in stopped and (result or {}).get("reason") == "stop":
            r.add("CTL-3", "pass", f"stop during {tool['name']}: {rec.id} listed and ended interrupted/stop")
            r.add("SAFE-1", "pass", f"stop during {tool['name']} was accepted and interrupted it")
        else:
            hub.violation("CTL-3", f"stop during {tool['name']}: reply {stopped}, result {result}")
        if bystander is not None and (bystander.reply or {}).get("accepted"):
            if isinstance(stopped, list) and bystander.id in stopped:
                hub.violation("CTL-3", f"stop interrupted the non-motion call {other['name']}")
            else:
                await cmd.finish(bystander, other["timeout"] + 5)
                r.add("CTL-3", "pass", f"the non-motion call {other['name']} continued through stop")
    if not hub.tools(motion=True):
        r.add("CTL-3", "skip", "no motion tool" + ("" if hub.motion else " run (motion is off)"))
        r.add("SAFE-1", "skip", "no motion tool" + ("" if hub.motion else " run (motion is off)"))


async def _reconnect(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> Command | None:
    """Reconnect: the device registers again with the same id and nothing running (CONN-6, CONN-7).
    A motion call runs when the channel closes, so the device must also come to rest (SAFE-2)."""
    r = hub.report
    device_id = hub.description["device"]["id"]
    resources = hub.description.get("resources", {})
    tool = check_mhs._long(hub.tools(motion=True)) or next((t for t in hub.tools() if any(resources.get(u) == "reject" for u in t.get("uses", []))), None)
    source = await check_mos.odometry_on(hub, cmd)
    log("closing the command channel to check reconnecting")
    running = await cmd.call(tool["name"], hub.args(tool["inputSchema"])) if tool else None
    await asyncio.sleep(0.3)
    if not cmd.closed.is_set():
        r.add("CONN-5", "pass", "the command channel stayed up, answering pings, until mhs-check closed it")
    gaps = [b - a for a, b in zip(cmd.pings, cmd.pings[1:])]
    if not cmd.pings:
        r.add("CONN-9", "skip", "the device sends no mhs/ping; it relies on WebSocket pings (CONN-5)")
    elif max(gaps, default=0) > 3:
        hub.violation("CONN-9", f"mhs/ping gaps up to {max(gaps):.1f} s, over the 2 s interval")
    else:
        r.add("CONN-9", "pass", f"{len(cmd.pings)} mhs/ping requests, at most {max(gaps, default=0):.1f} s apart")
    closed_at = time.monotonic()
    await cmd.ws.close(1001)
    loss = asyncio.ensure_future(check_mhs.channel_loss(hub, running, tool, closed_at, source))
    try:
        cmd = await asyncio.wait_for(hub.connections.get(), 7)
        delay = time.monotonic() - closed_at
        r.add("CONN-6", "pass" if delay <= 1.5 else "fail", f"reconnected after {delay:.1f} s")
        again = await asyncio.wait_for(cmd.first, 5)
        same = (again.get("params") or {}).get("device", {}).get("id") == device_id
        r.add("ID-1", "pass" if same else "fail", f"registered again as {(again.get('params') or {}).get('device', {}).get('id')}")
        cmd.send({"jsonrpc": "2.0", "id": again.get("id"), "result": {"session": "check-2", "hub": {"name": "mhs-check", "version": "1.0.0"}, "time": time.time()}})
        await asyncio.sleep(1.5)
        late = running is not None and any(m.get("params", {}).get("call") == running.id for _, m in cmd.inbox)
        if late:
            hub.violation("CONN-7", f"the call {running.id} from before the loss was reported after reconnecting")
        if not cmd.states:
            hub.violation("STATE-1", "no full mhs/state after registering again")
        if late:
            hub.violation("SAFE-2", f"the motion call {running.id} was resumed after reconnecting")
        else:
            r.add("CONN-7", "pass", "registered again with nothing from before reported")
    except asyncio.TimeoutError:
        hub.violation("CONN-6", "no reconnection within 7 s")
        return None
    finally:
        await loss
    return cmd


async def _replacement(hub: CheckHub, cmd: Command, replace_wait: float, log: Callable[[str], None]) -> None:
    """Closing with 4001 means no reconnecting (CONN-8). The device ends up stopped."""
    log(f"closing with 4001 and watching {replace_wait:.0f} s for a reconnection")
    await cmd.ws.close(4001)
    try:
        await asyncio.wait_for(hub.connections.get(), replace_wait)
        hub.violation("CONN-8", "reconnected after being replaced (4001)")
    except asyncio.TimeoutError:
        hub.report.add("CONN-8", "pass", f"no reconnection within {replace_wait:.0f} s after 4001")


async def _version(hub: CheckHub, cmd: Command, log: Callable[[str], None]) -> None:
    """A version refusal must not make the device loop faster than its back-off (CONN-6)."""
    log("refusing the next registration with -32001 to check the back-off")
    await cmd.ws.close(1001)
    cmd = await asyncio.wait_for(hub.connections.get(), 7)
    refused = await asyncio.wait_for(cmd.first, 5)
    cmd.send({"jsonrpc": "2.0", "id": refused.get("id"), "error": {"code": -32001, "message": "mhs-check refuses this version on purpose"}})
    await cmd.ws.close(4003)
    refused_at = time.monotonic()
    try:
        await asyncio.wait_for(hub.connections.get(), 6)
        retry = time.monotonic() - refused_at
        if retry < 0.5:
            hub.violation("CONN-6", f"reconnected {retry:.2f} s after a version refusal")
        else:
            hub.report.add("CONN-6", "pass", f"after the version refusal, retried after {retry:.1f} s")
    except asyncio.TimeoutError:
        hub.report.add("CONN-6", "pass", "after the version refusal, no retry within 6 s")
    hub.report.add("CONN-8", "skip", "run without --check-version to check replacement")


def _expect_invalid(hub: CheckHub, rec: CallRecord, what: str) -> None:
    reply = rec.reply or {}
    took = rec.replied - rec.sent
    if reply.get("accepted") is False and reply.get("reason") == "invalid":
        hub.report.add("TOOL-2", "pass", f"{what}: rejected invalid")
    elif reply.get("accepted"):
        hub.violation("TOOL-2", f"{what}: accepted")
    else:
        hub.violation("TOOL-2", f"{what}: {reply or 'no reply'}")
    hub.report.add("CALL-2", "pass" if took <= 2 and rec.reply is not None else "fail", f"{what}: answered in {took * 1000:.0f} ms")


def _check_calls(hub: CheckHub) -> None:
    r = hub.report
    calls = [c for c in hub.all_calls if c.reply is not None]
    for rid, evidence in (
        ("MSG-1", "every command message was a valid JSON-RPC message in a text frame"),
        ("MSG-3", "no command message over 64 KiB"),
        ("REG-3", "no second registration on a connection"),
    ):
        if rid not in hub.violations:
            r.add(rid, "pass", evidence)
    if "MSG-1" not in hub.violations:
        r.add("MSG-2", "pass", "the device's request id was a string")
    if not calls:
        for rid in ("TOOL-2", "CALL-2", "CALL-4", "CALL-5", "CTL-1", "RES-1", "SAFE-4"):
            r.add(rid, "skip", "the device declares no tool")
        return
    slowest = max(c.replied - c.sent for c in calls)
    r.add("CALL-2", "pass" if slowest <= 2 else "fail", f"{len(calls)} calls, slowest acceptance {slowest * 1000:.0f} ms")
    for c in calls:
        hub.schema("MSG-1", "CallReply", c.reply)
    ordered = True
    for c in calls:
        results = [e for e in c.events if e[1] == "mhs/result"]
        if not (c.reply or {}).get("accepted"):
            if c.events:
                ordered = False
                hub.violation("CALL-5", f"rejected call {c.id} got {c.events[0][1]}")
            continue
        if len(results) > 1:
            ordered = False
        if results and any(e[0] > results[0][0] and e[1] == "mhs/progress" for e in c.events):
            ordered = False
            hub.violation("CALL-5", f"progress after the result of {c.id}")
        progress = [e[0] for e in c.events if e[1] == "mhs/progress" and "state" not in e[2]]
        for a, b in zip(progress, progress[2:]):
            if b - a < 0.9:
                hub.violation("CALL-4", f"{c.id}: 3 progress notifications within {b - a:.2f} s")
                break
    if ordered:
        r.add("CALL-5", "pass", f"{len(calls)} calls: reply first, at most one result each")
    if "CALL-4" not in hub.violations:
        r.add("CALL-4", "pass", "at most 2 progress notifications per second per call")
    if "RES-1" not in hub.violations:
        r.add("RES-1", "pass", "no hub-only reasons sent")


def state_problems(fields: dict[str, Any], values: dict[str, Any]) -> list[str]:
    """STATE-2: each value has its declared type and enum; problem and faults are standard."""
    found = []
    if "problem" in values and not (values["problem"] is None or isinstance(values["problem"], str)):
        found.append(f"state problem={values['problem']!r} is neither a sentence nor null")
    if "faults" in values and not isinstance(values["faults"], list):
        found.append(f"state faults={values['faults']!r} is not a list")
    return found + field_problems(fields, {k: v for k, v in values.items() if k not in ("problem", "faults")}, "state")


async def _state(hub: CheckHub, cmd: Command) -> None:
    """MHS 10.1: a full report after the register reply, then settings on writable fields."""
    r = hub.report
    fields = hub.description.get("state", {})
    for _ in range(200):
        if cmd.states:
            break
        await asyncio.sleep(0.01)
    if not cmd.states:
        hub.violation("STATE-1", "no mhs/state within 2 s of the register reply")
    else:
        missing = [k for k in [*fields, "problem", "faults"] if k not in cmd.states[0][1]["values"]]
        if missing:
            hub.violation("STATE-1", f"the first mhs/state lacks {', '.join(missing)}")
        else:
            r.add("STATE-1", "pass", f"the first mhs/state had all {len(fields)} declared fields, problem and faults")
    numeric = next((n for n, f in fields.items() if f.get("writable") and f.get("type") in ("number", "integer") and "max" in f), None)
    if numeric is None:
        r.add("STATE-3", "skip", "no writable numeric field with a maximum to set beyond its range")
    else:
        top = fields[numeric]["max"]
        beyond = top + max(1, abs(top))
        before = len(cmd.states)
        hub.set_times.append(time.monotonic())
        response, took = await cmd.request("mhs/set", {"values": {numeric: beyond}}, timeout=2.5)
        result = (response or {}).get("result")
        if result is None or not hub.schema("STATE-3", "SetResult", result):
            hub.violation("STATE-3", f"mhs/set {numeric}={beyond}: no valid reply within 2 s")
        elif result["values"].get(numeric, beyond) > top or not result.get("notes"):
            hub.violation("STATE-3", f"mhs/set {numeric}={beyond}: not clamped to {top} with a note: {result}")
        else:
            await asyncio.sleep(1.0)
            reported = any(p["values"].get(numeric) == result["values"][numeric] for _, p in cmd.states[before:])
            r.add("STATE-3", "pass" if reported else "fail", f"mhs/set {numeric}={beyond} clamped to {result['values'][numeric]} in {took * 1000:.0f} ms, {'and' if reported else 'but not'} reported in mhs/state")
    fixed = next((n for n, f in fields.items() if not f.get("writable")), "problem")
    response, _ = await cmd.request("mhs/set", {"values": {fixed: 1}}, timeout=2.5)
    refused = ((response or {}).get("result") or {}).get("refused", {})
    if fixed in refused:
        r.add("STATE-3", "pass", f"mhs/set on {fixed}, which is not writable, was refused: {refused[fixed]}")
    else:
        hub.violation("STATE-3", f"mhs/set on {fixed}, which is not writable, was not refused: {response}")


def _check_state(hub: CheckHub) -> None:
    if "STATE-2" not in hub.violations:
        hub.report.add("STATE-2", "pass", "every mhs/state followed the schema and the declared field types")


async def operator(question: str) -> str:
    return (await asyncio.to_thread(input, f"? {question} ")).strip()


async def main_async(args: argparse.Namespace) -> int:
    only = [p for p in ",".join(args.profile or []).split(",") if p] or None
    unknown = [p for p in only or [] if p not in PROFILES]
    if unknown:
        print(f"unknown profile {', '.join(unknown)}; the profiles are {', '.join(PROFILES)}")
        return 2
    hub = CheckHub(motion=not args.no_motion, ask=operator if args.interactive else no_operator)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    async with serve(hub.handler, args.host, args.port, subprotocols=["mhs.v1"], ping_interval=2, ping_timeout=3, max_size=16 * 1024 * 1024):
        print(f"mhs-check listening on ws://{args.host}:{args.port}; point the device there and start it")
        try:
            await run(hub, args.wait, args.replace_wait, args.check_version, lambda line: print(f"· {line}"), only)
        except asyncio.TimeoutError as e:
            hub.report.add("CONN-6", "fail", f"the device stopped answering: {str(e) or 'timeout'}")
    results = hub.report.final(hub.profiles)
    device = hub.description.get("device", {}).get("id")
    report = {"device": device, "protocol": PROTOCOL, "profiles": hub.profiles, "motion": hub.motion, "started": started, "tool": "mhs-check 1.0.0", "results": results}
    width = max(len(x["id"]) for x in results)
    for x in results:
        print(f"{x['status']:>6}  {x['id']:<{width}}  {x['evidence']}" + (f"  [operator: {x['operator']}]" if "operator" in x else ""))
    counts = {s: sum(1 for x in results if x["status"] == s) for s in RANK}
    print(", ".join(f"{n} {s}" for s, n in counts.items() if n))
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
    return 1 if counts["fail"] else 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="mhs-check", description="Run the Agnes MHS and MOS conformance scenarios against one device.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8800)
    parser.add_argument("--profile", action="append", help=f"run only these profiles, comma-separated: {', '.join(PROFILES)}")
    parser.add_argument("--no-motion", action="store_true", help="skip scenarios that make the device move")
    parser.add_argument("--interactive", action="store_true", help="ask the operator at the physical checks")
    parser.add_argument("--report", help="write the JSON report here")
    parser.add_argument("--wait", type=float, default=120, help="seconds to wait for the device to connect")
    parser.add_argument("--replace-wait", type=float, default=30, help="seconds to watch for a reconnection after 4001")
    parser.add_argument("--check-version", action="store_true", help="end with a version refusal instead of a replacement")
    sys.exit(asyncio.run(main_async(parser.parse_args())))


if __name__ == "__main__":
    main()

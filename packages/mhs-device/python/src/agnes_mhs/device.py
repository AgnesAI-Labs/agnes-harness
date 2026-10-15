"""Device-owned resources and cancellation; safety hooks must control real hardware."""
import asyncio
import copy
import math
import time
from .validation import MhsError, prepare, registration


class Call:
    def __init__(self, call_id, safety=None, motion=False):
        self.id = call_id
        self.safety = safety
        self.motion = motion
        self.rested = asyncio.Event()
        self.paused = asyncio.Event()
        self.paused.set()
        self.progress = lambda data: None

    async def checkpoint(self, rest=None):
        if self.motion:
            self.safety.arm(2000)
        if not self.paused.is_set():
            if rest:
                await rest()
            elif self.motion:
                await self.safety.stop("pause")
            self.rested.set()
        await self.paused.wait()
        await asyncio.sleep(0)


class Device:
    def __init__(self, description, safety=None):
        self.description = registration(description)
        self.safety = safety
        self.handlers = {}
        self.clips = {}
        self.running = {}
        self.values = {"problem": None, "faults": []}
        self.on_state = lambda values: None
        self.on_progress = lambda call, data: None
        self.on_manual = None
        self.on_observation = None
        self.sequences = {}
        self.on_configure = None
        self.on_keyframe = None
        self.manual_until = 0
        self.deadman = None
        self.closed = False

    async def publish(self, source, data, payload=None, mime=None):
        if not any(s["id"] == source for s in self.description.get("sources", [])):
            raise MhsError("unknown-source")
        if not self.on_observation:
            return False
        sequence = self.sequences.get(source, -1) + 1
        self.sequences[source] = sequence
        header = {"type": "data", "source": source, "seq": sequence, "t": time.time(), "data": data}
        if payload is not None:
            header["bytes"] = len(payload)
        if mime:
            header["mime"] = mime
        await self.on_observation(header, payload)
        return True

    def receive_clip(self, clip_id, rate, channels, pcm):
        if not isinstance(clip_id, str) or not 1 <= len(clip_id) <= 256 or type(rate) is not int or not 1 <= rate <= 384000 or type(channels) is not int or not 1 <= channels <= 8 or not 0 < len(pcm) <= 16 << 20 or len(pcm) % (channels * 2):
            raise MhsError("invalid-clip")
        self.clips.pop(clip_id, None)
        self.clips[clip_id] = {"rate": rate, "channels": channels, "pcm": bytes(pcm), "received_at": time.monotonic()}
        while len(self.clips) > 8:
            self.clips.pop(next(iter(self.clips)))

    def clip(self, clip_id):
        clip = self.clips.get(clip_id)
        if not clip or time.monotonic() - clip["received_at"] > 60:
            self.clips.pop(clip_id, None)
            return None
        return dict(clip)

    def tool(self, name, handler):
        if name in self.handlers or not any(t["name"] == name for t in self.description.get("tools", [])):
            raise MhsError("invalid-tool")
        self.handlers[name] = handler
        return self

    def update(self, values):
        next_values = {}
        for key, value in values.items():
            field = self.description.get("state", {}).get(key)
            if field:
                next_values[key] = prepare({"type": field["type"], **({"minimum": field["min"]} if "min" in field else {}), **({"maximum": field["max"]} if "max" in field else {}), **({"enum": field["enum"]} if "enum" in field else {})}, value)
            elif key == "problem" and (value is None or isinstance(value, str)):
                next_values[key] = value
            elif key == "faults" and isinstance(value, list) and all(isinstance(x, str) for x in value):
                next_values[key] = value
            else:
                raise MhsError("invalid-state")
        self.values.update(next_values)
        self.on_state(copy.deepcopy(next_values))

    def set(self, values):
        accepted, refused = {}, []
        for key, value in values.items():
            field = self.description.get("state", {}).get(key)
            if not field or not field.get("writable"):
                refused.append(key)
                continue
            try:
                self.update({key: value})
                accepted[key] = self.values[key]
            except MhsError:
                refused.append(key)
        return {"values": accepted, "refused": refused}

    def call(self, call_id, name, arguments):
        tool = next((t for t in self.description.get("tools", []) if t["name"] == name), None)
        if not tool or name not in self.handlers or call_id in self.running:
            return {"accepted": False, "reason": "invalid"}, None
        notes = []
        try:
            args = prepare(tool["inputSchema"], arguments, notes)
        except MhsError:
            return {"accepted": False, "reason": "invalid"}, None
        if self.closed or self.values["problem"] or self.values["faults"] or (tool.get("motion") and not self.safety):
            return {"accepted": False, "reason": "unsafe"}, None
        conflicts = [r for r in self.running.values() if set(r["tool"].get("uses", [])) & set(tool.get("uses", []))]
        if (tool.get("motion") and time.monotonic() < self.manual_until) or any(self.description.get("resources", {}).get(r) == "reject" for c in conflicts for r in set(c["tool"].get("uses", [])) & set(tool.get("uses", []))):
            return {"accepted": False, "reason": "busy"}, None
        call = Call(call_id, self.safety, tool.get("motion", False))
        call.progress = lambda data: self.on_progress(call_id, data)
        result = asyncio.get_running_loop().create_future()
        entry = {"tool": tool, "call": call, "reason": "cancel", "result": result}

        async def work():
            try:
                for conflict in conflicts:
                    await asyncio.shield(conflict["result"])
                if tool.get("motion"):
                    self.safety.arm(2000)
                data = await asyncio.wait_for(self.handlers[name](args, call), tool["timeout"])
                return {"status": "done", "data": data, "notes": notes}
            except asyncio.TimeoutError:
                if tool.get("motion"):
                    await self.safety.stop("timeout")
                return {"status": "error", "reason": "timeout"}
            except asyncio.CancelledError:
                return {"status": "interrupted", "reason": entry["reason"]}
            except Exception:
                if tool.get("motion"):
                    await self.safety.stop("failed")
                return {"status": "error", "reason": "failed"}
            finally:
                self.running.pop(call_id, None)

        entry["task"] = asyncio.create_task(work())
        self.running[call_id] = entry
        def settled(task):
            self.running.pop(call_id, None)
            if result.done():
                return
            if task.cancelled():
                result.set_result({"status": "interrupted", "reason": entry["reason"]})
            elif task.exception():
                self.closed = True
                result.set_result({"status": "unknown", "reason": "stop-unconfirmed"})
            else:
                result.set_result(task.result())
        entry["task"].add_done_callback(settled)
        return {"accepted": True}, result

    async def stop(self, reason="stop"):
        self.manual_until = 0
        if self.deadman:
            self.deadman.cancel()
        try:
            if self.safety:
                await self.safety.stop(reason)
            if self.on_manual:
                await self.on_manual({a["id"]: 0 for a in self.description.get("manual", {}).get("axes", [])})
        except Exception:
            self.closed = True
            raise
        finally:
            for entry in list(self.running.values()):
                if entry["tool"].get("motion"):
                    entry["reason"] = reason
                    entry["task"].cancel()

    async def pause(self, call_id):
        entry = self.running.get(call_id)
        if not entry or not entry["tool"].get("pausable"):
            raise MhsError("not-pausable")
        entry["call"].rested.clear()
        entry["call"].paused.clear()
        try:
            await asyncio.wait_for(entry["call"].rested.wait(), 1.5)
        except asyncio.TimeoutError:
            entry["reason"] = "pause_timeout"
            await self.stop("pause_timeout")
            raise MhsError("pause-timeout")

    def resume(self, call_id):
        entry = self.running.get(call_id)
        if entry:
            entry["call"].paused.set()

    async def manual(self, values):
        manual = self.description.get("manual")
        if self.closed or not manual or not self.safety or not self.on_manual:
            raise MhsError("unsafe")
        if any(type(v) not in (int, float) or not math.isfinite(v) for v in values.values()):
            raise MhsError("invalid")
        axes = {a["id"]: max(a["min"], min(a["max"], values.get(a["id"], 0))) for a in manual["axes"]}
        if any(axes.values()):
            await self.stop("manual")
            self.manual_until = time.monotonic() + manual["deadman_s"]
        self.safety.arm(manual["deadman_s"] * 1000)
        if self.deadman:
            self.deadman.cancel()
        self.deadman = asyncio.get_running_loop().call_later(manual["deadman_s"], lambda: asyncio.create_task(self.stop("deadman")))
        await self.on_manual(axes)

    async def disconnect(self):
        self.closed = True
        try:
            await self.stop("disconnect")
        finally:
            for entry in list(self.running.values()):
                entry["reason"] = "disconnect"
                entry["task"].cancel()
            await asyncio.gather(*(e["task"] for e in list(self.running.values())), return_exceptions=True)

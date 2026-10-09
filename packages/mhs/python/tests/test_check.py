"""mhs-check against devices: for each profile one that passes and one broken on purpose."""

import asyncio
import importlib.util
from pathlib import Path

from websockets.asyncio.server import serve

import agnes_mhs.device
from agnes_mhs.check import CheckHub, run
from kit import make_device, make_fixed

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


def example(name: str):
    spec = importlib.util.spec_from_file_location(f"example_{name}", EXAMPLES / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_check(dev, produce, only: list[str], answer: str | None = None) -> dict[str, dict]:
    """Runs the profiles in only against dev; answer is the operator's reply to every question."""

    async def ask(question: str) -> str | None:
        return answer

    async def main() -> dict[str, dict]:
        hub = CheckHub(motion=True, ask=ask, pace=0.3)
        async with serve(hub.handler, "127.0.0.1", 0, subprotocols=["mhs.v1"], max_size=16 * 1024 * 1024) as server:
            port = server.sockets[0].getsockname()[1]
            tasks = [asyncio.ensure_future(dev.run(f"ws://127.0.0.1:{port}"))]
            if produce is not None:
                tasks.append(asyncio.ensure_future(produce()))
            try:
                await run(hub, 10, 1, False, lambda line: None, only)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        return {r["id"]: r for r in hub.report.final(hub.profiles)}

    return asyncio.run(main())


def statuses(results: dict[str, dict]) -> dict[str, str]:
    return {rid: r["status"] for rid, r in results.items()}


def failed(results: dict[str, dict]) -> list[str]:
    return [rid for rid, r in results.items() if r["status"] == "fail"]


def car(per_meter: float = 1.0):
    dev, seen = make_device(per_meter)
    return dev, seen["produce"]


# Core


def test_a_conforming_device_passes_core():
    full = run_check(*car(), only=["core"])
    assert failed(full) == []
    results = statuses(full)
    assert results["CTL-3"] == "pass" and results["TOOL-2"] == "pass" and results["CONN-8"] == "pass"
    assert results["STATE-1"] == "pass" and results["STATE-3"] == "pass"
    assert results["SAFE-7"] == "pass" and results["STATE-4"] == "pass"  # watched through odometry


def test_a_device_that_skips_checks_and_ignores_stop_fails(monkeypatch):
    # Accept any arguments (no TOOL-2), and answer stop without interrupting anything (no CTL-3).
    monkeypatch.setattr(agnes_mhs.device, "prepare_arguments", lambda schema, args: (dict(args), []))
    dev, produce = car()

    async def lazy_stop(request_id, params):
        dev._reply(request_id, {"stopped": []})

    dev._on_stop = lazy_stop
    results = statuses(run_check(dev, produce, ["core"]))
    assert results["TOOL-2"] == "fail"
    assert results["CTL-3"] == "fail"


# Motion


def test_motion_passes_with_odometry_and_records_the_operator():
    results = run_check(*car(), only=["motion"], answer="n")
    assert failed(results) == []
    assert results["SAFE-2"]["status"] == "pass" and results["7.3"]["status"] == "pass"
    assert results["SAFE-5"]["status"] == "warn" and results["SAFE-5"]["operator"] == "n"


def test_a_device_that_keeps_moving_after_losing_the_hub_fails_motion(monkeypatch):
    async def forget(self):
        self._cmd = None  # neither stops nor ends its calls (SAFE-2)

    monkeypatch.setattr(agnes_mhs.device.Device, "_command_lost", forget)
    results = statuses(run_check(*car(per_meter=4), only=["motion"]))
    assert results["SAFE-2"] == "fail"


# Manual


def test_manual_passes_and_the_watchdog_question_goes_to_the_operator():
    results = run_check(*car(), only=["manual"], answer="y")
    assert failed(results) == []
    assert {rid: results[rid]["status"] for rid in ("MAN-1", "MAN-2", "MAN-3", "MAN-4", "SAFE-3")} == dict.fromkeys(("MAN-1", "MAN-2", "MAN-3", "MAN-4", "SAFE-3"), "pass")
    assert results["MAN-5"]["status"] == "pass" and results["MAN-5"]["operator"].endswith(" y")


def test_without_an_operator_the_watchdog_is_manual_and_a_device_without_deadman_fails(monkeypatch):
    async def no_deadman(self):
        return None

    monkeypatch.setattr(agnes_mhs.device.Device, "_deadman", no_deadman)
    results = statuses(run_check(*car(), only=["manual"]))
    assert results["MAN-4"] == "fail" and results["MAN-5"] == "manual"


# Pause


def test_pause_passes():
    results = statuses(run_check(*car(), only=["pause"]))
    assert results == {"CTL-5": "pass", "CTL-6": "pass", "8.3": "pass"}


def test_a_device_that_says_paused_but_keeps_going_fails_pause():
    dev, produce = car()

    async def fake_pause(request_id, params):
        dev._reply(request_id, {"paused": True})

    dev._on_pause = fake_pause
    results = statuses(run_check(dev, produce, ["pause"]))
    assert results["CTL-5"] == "fail"


def test_a_resumed_call_that_ends_in_a_safety_stop_passes_pause():
    dev, produce = car()
    resume = dev._on_resume

    async def resume_then_estop(request_id, params):
        await resume(request_id, params)
        await asyncio.sleep(0.1)
        dev._calls[params["call"]]._interrupt("estop")

    dev._on_resume = resume_then_estop
    results = run_check(dev, produce, ["pause"])
    assert results["CTL-5"]["status"] == "pass" and "interrupted/estop" in results["CTL-5"]["evidence"]


def test_a_call_that_stays_paused_after_resume_fails_pause():
    dev, produce = car()
    dev._tools["move"].decl["timeout"] = 2  # mhs-check waits timeout + 5 s for the result

    async def stay_paused(request_id, params):
        dev._reply(request_id, {"resumed": True})

    dev._on_resume = stay_paused
    results = run_check(dev, produce, ["pause"])
    assert results["CTL-5"]["status"] == "fail" and "still paused" in results["CTL-5"]["evidence"]


def test_a_resumed_call_without_a_result_fails_pause():
    dev, produce = car()
    dev._tools["move"].decl["timeout"] = 2
    resume, notify, resumed = dev._on_resume, dev._notify, set()

    async def remember(request_id, params):
        resumed.add(params["call"])
        await resume(request_id, params)

    def drop_results(call, method, params):
        if not (method == "mhs/result" and call.id in resumed):
            notify(call, method, params)

    dev._on_resume, dev._notify = remember, drop_results
    results = run_check(dev, produce, ["pause"])
    assert results["CTL-5"]["status"] == "fail" and "no result within 7 s" in results["CTL-5"]["evidence"]


# Perception and Streaming, with the sensor example


def sensor():
    return example("sensor").make_sensor()


def test_the_sensor_example_passes_core_perception_and_streaming():
    results = run_check(*sensor(), only=["core", "perception", "streaming"])
    assert failed(results) == []
    assert all(results[rid]["status"] == "pass" for rid in ("PER-1", "STR-1", "STR-4", "STR-5", "STR-6", "TIME-1", "TIME-2"))


def test_values_of_the_wrong_type_fail_perception():
    dev, measure = sensor()
    air = dev._sources["air"]
    send = air.send
    air.send = lambda data, binary=None, **kw: send({**data, "co2": "high"}, binary, **kw)
    results = statuses(run_check(dev, measure, ["perception"]))
    assert results["PER-1"] == "fail"


def test_a_source_that_reports_off_but_keeps_sending_fails_streaming(monkeypatch):
    configure = agnes_mhs.device.Source._configure

    def stays_on(self, setting):
        applied = configure(self, {k: v for k, v in setting.items() if k != "on"})
        return {**applied, "on": setting.get("on", applied["on"])}

    monkeypatch.setattr(agnes_mhs.device.Source, "_configure", stays_on)
    results = statuses(run_check(*sensor(), only=["streaming"]))
    assert results["STR-5"] == "fail"


# Derived perception


def test_derived_perception_passes():
    results = statuses(run_check(*car(), only=["derived"]))
    assert results == {"PER-3": "pass", "PER-4": "pass", "PER-5": "pass", "PER-6": "skip"}


def test_detections_naming_frames_never_sent_fail_derived_perception():
    dev, produce = car()
    people = dev._sources["people"]
    send = people.send
    people.send = lambda data, binary=None, **kw: send(data, binary, **{**kw, "of_seq": kw["of_seq"] + 1000})
    results = statuses(run_check(dev, produce, ["derived"]))
    assert results["PER-4"] == "fail"


# Video, with the camera example


def test_the_camera_example_passes_video():
    results = run_check(*example("camera").make_camera(), only=["core", "perception", "streaming", "video"])
    assert failed(results) == []
    assert all(results[f"VID-{n}"]["status"] == "pass" for n in range(1, 8))


def test_keyframes_further_apart_than_declared_fail_video():
    results = statuses(run_check(*example("camera").make_camera(gop_s=3), only=["video"]))
    assert results["VID-5"] == "fail"


# Audio clip


def test_clips_pass():
    results = statuses(run_check(*car(), only=["clip"]))
    assert results == {"CONN-4": "pass", "STR-8": "pass"}


def test_a_device_that_drops_clips_fails(monkeypatch):
    monkeypatch.setattr(agnes_mhs.device.Device, "_keep_clip", lambda self, msg, pcm: None)
    results = statuses(run_check(*car(), only=["clip"]))
    assert results["STR-8"] == "fail"


# Maps, and REG-4 in Core


def test_a_fixed_device_on_its_own_map_passes_maps():
    results = run_check(make_fixed(), None, ["core", "maps"], answer="y")
    assert failed(results) == []
    ids = ("REG-4", "MAP-1", "MAP-2", "MAP-3", "MAP-4")
    assert {rid: results[rid]["status"] for rid in ids} == dict.fromkeys(ids, "pass")


def test_a_fixed_device_without_placement_and_twice_the_same_place_fails():
    dev = make_fixed(places=[{"id": "door", "name": "Door", "at": [0, 5]}, {"id": "door", "name": "Back door", "at": [19, 5]}])
    dev._placement = None
    results = statuses(run_check(dev, None, ["core", "maps"]))
    assert results["REG-4"] == "fail" and results["MAP-1"] == "fail"
    assert results["MAP-4"] == "warn"  # the back door lies outside the map's bounds
    assert results["MAP-2"] == "manual"  # no operator to say the frame is the same everywhere

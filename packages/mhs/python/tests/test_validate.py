import json

from agnes_mhs.validate import LogChecker, main

REGISTER = {
    "protocol": "mhs/v1",
    "device": {"id": "env-01", "kind": "sensor"},
    "sources": [{"id": "air", "kind": "values", "description": "air", "fields": {"temperature": {"type": "number", "unit": "°C"}}}],
    "tools": [{"name": "beep", "description": "Beep once.", "inputSchema": {"type": "object"}, "timeout": 2}],
}
GOOD = [
    {"jsonrpc": "2.0", "id": "1", "method": "mhs/register", "params": REGISTER},
    {"jsonrpc": "2.0", "id": "1", "result": {"session": "s1", "hub": {"name": "hub", "version": "1"}, "time": 1.5}},
    {"type": "hello", "device": "env-01"},
    {"type": "data", "source": "air", "seq": 0, "t": 2.0, "data": {"temperature": 21.5}},
    {"jsonrpc": "2.0", "id": "c1", "method": "mhs/call", "params": {"name": "beep", "arguments": {}}},
    {"jsonrpc": "2.0", "id": "c1", "result": {"accepted": True}},
    {"jsonrpc": "2.0", "method": "mhs/result", "params": {"call": "c1", "status": "done", "detail": "beeped"}},
    {"jsonrpc": "2.0", "method": "mhs/state", "params": {"t": 2.5, "values": {"problem": None, "faults": []}}},
]


def run(messages):
    checker = LogChecker()
    return [checker.check(m) for m in messages]


def test_a_valid_session_has_no_problems():
    assert [found for _, found in run(GOOD)] == [[]] * len(GOOD)


def test_replies_payloads_and_order_are_checked():
    bad = [
        GOOD[0],
        {"jsonrpc": "2.0", "id": "1", "result": {"session": "s1"}},
        {"type": "data", "source": "air", "seq": 1, "t": 3.0, "data": {"temperature": "warm", "Bad": 1}},
        {"type": "data", "source": "lidar", "seq": 0, "t": 3.0, "data": {}},
        {"jsonrpc": "2.0", "id": "c9", "result": {"accepted": True}},
        {"jsonrpc": "2.0", "id": "x", "method": "mhs/dance", "params": {}},
    ]
    results = run(bad)
    assert results[0][1] == []
    assert results[1][0] == "reply to mhs/register" and results[1][1]
    assert results[2][1] and all(p.startswith("data/") for p in results[2][1])
    assert results[3][1] == ["source not declared in mhs/register"]
    assert results[4][1] == ["no open request with this id"]
    assert results[5][1] == ["unknown method"]


def test_command_line(tmp_path, capsys):
    log = tmp_path / "log.jsonl"
    log.write_text("\n".join(json.dumps(m) for m in GOOD) + "\n", encoding="utf-8")
    assert main([str(log)]) == 0
    log.write_text(json.dumps({"type": "hello"}) + "\nnot json\n", encoding="utf-8")
    assert main([str(log)]) == 1
    assert "2 messages, 2 with problems" in capsys.readouterr().out

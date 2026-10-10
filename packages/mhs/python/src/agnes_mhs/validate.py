"""Check a log of mhs/v1 messages against the schema.

    python -m agnes_mhs.validate messages.jsonl

Each line is one message as sent on either channel, without binary frames. Command-channel
messages carry "jsonrpc" and Nerve messages carry "type", so the channel needs no label. Replies are
checked against the method of the request with the same id, and data payloads against the kind
their source declared in mhs/register.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from .schema import NERVE, NOTIFICATIONS, REQUEST_PARAMS, RESULTS, data_def, errors


class LogChecker:
    """Checks messages in the order they were sent, remembering open requests and declared sources."""

    def __init__(self) -> None:
        self.pending: dict[str, str] = {}
        self.kinds: dict[str, str] = {}

    def check(self, msg: Any) -> tuple[str, list[str]]:
        """What the message is, and its problems (empty when it is valid)."""
        if not isinstance(msg, dict):
            return "message", ["not a JSON object"]
        if "jsonrpc" in msg:
            return self._command(msg)
        if "type" in msg:
            return self._nerve(msg)
        return "message", ["neither a JSON-RPC message nor a Nerve message"]

    def _command(self, msg: dict[str, Any]) -> tuple[str, list[str]]:
        method = msg.get("method")
        if method is None:
            found = errors("Response", msg)
            asked = self.pending.pop(str(msg.get("id")), None)
            if asked is None:
                return "response", found + ["no open request with this id"]
            if "result" in msg and asked in RESULTS:
                found += errors(RESULTS[asked], msg["result"])
            return f"reply to {asked}", found
        if "id" in msg:
            found = errors("Request", msg)
            params_def = REQUEST_PARAMS.get(method)
            if params_def is None:
                return method, found + ["unknown method"]
            self.pending[str(msg["id"])] = method
            params = msg.get("params", {})
            found += errors(params_def, params)
            if method == "mhs/register" and not found:
                self.kinds = {s["id"]: s["kind"] for s in params.get("sources", [])}
            return method, found
        found = errors("Notification", msg)
        params_def = NOTIFICATIONS.get(method)
        if params_def is None:
            return method, found + ["unknown notification"]
        return method, found + errors(params_def, msg.get("params", {}))

    def _nerve(self, msg: dict[str, Any]) -> tuple[str, list[str]]:
        kind_of_message = msg["type"]
        message_def = NERVE.get(kind_of_message)
        if message_def is None:
            return f"nerve {kind_of_message}", ["unknown Nerve message type"]
        found = errors(message_def, msg)
        if kind_of_message != "data" or found:
            return f"nerve {kind_of_message}", found
        source = msg["source"]
        kind = self.kinds.get(source)
        if kind is None:
            return f"data {source}", ["source not declared in mhs/register"]
        payload_def = data_def(kind)
        if payload_def is None:
            return f"data {source}", []
        return f"data {source} ({kind})", [f"data/{e}" for e in errors(payload_def, msg["data"])]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    stream = open(args[0], encoding="utf-8") if args else sys.stdin
    checker = LogChecker()
    total = failed = 0
    with stream:
        for number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            total += 1
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                what, found = "line", [f"not JSON: {e.msg}"]
            else:
                what, found = checker.check(msg)
            if found:
                failed += 1
                for problem in found:
                    print(f"line {number} ({what}): {problem}")
    print(f"{total} messages, {failed} with problems")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

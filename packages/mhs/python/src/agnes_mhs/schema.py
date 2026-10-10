"""The mhs/v1 schema: vocabularies and message checks.

The schema file in packages/mhs/schema is the single source; nothing here copies it. Install this
package from the repository (editable or by path) so the file can be found.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parents[3] / "schema" / "mhs-v1.json"
SCHEMA: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
DEFS: dict[str, Any] = SCHEMA["$defs"]
PROTOCOL = "mhs/v1"


def _enum(name: str) -> tuple[Any, ...]:
    """The standard entries of a vocabulary; the x_ escape is not listed."""
    node = DEFS[name]
    return tuple(node["anyOf"][0]["enum"] if "anyOf" in node else node["enum"])


KINDS = _enum("Kind")
AXIS_ROLES = _enum("AxisRole")
STATUSES = _enum("Status")
REASONS = _enum("Reason")
UNITS = _enum("Unit")
ENCODINGS = _enum("Encoding")
LOCALIZATIONS = _enum("Localization")
DEVICE_REASONS = ("busy",) + _enum("RejectReason") + _enum("InterruptReason") + _enum("ErrorReason")
HUB_ONLY_REASONS = tuple(r for r in REASONS if r not in DEVICE_REASONS)

# Which definition checks what, by method or Nerve message type (spec Appendix A).
REQUEST_PARAMS = {
    "mhs/register": "RegisterParams",
    "mhs/call": "CallParams",
    "mhs/cancel": "CallRef",
    "mhs/stop": "Empty",
    "mhs/pause": "CallRef",
    "mhs/resume": "CallRef",
    "mhs/configure": "ConfigureParams",
    "mhs/set": "SetParams",
    "mhs/keyframe": "KeyframeParams",
    "mhs/time": "Empty",
    "mhs/ping": "Empty",
}
RESULTS = {
    "mhs/register": "RegisterResult",
    "mhs/call": "CallReply",
    "mhs/cancel": "CancelResult",
    "mhs/stop": "StopResult",
    "mhs/pause": "PauseResult",
    "mhs/resume": "ResumeResult",
    "mhs/configure": "ConfigureResult",
    "mhs/set": "SetResult",
    "mhs/keyframe": "KeyframeResult",
    "mhs/time": "TimeResult",
    "mhs/ping": "Empty",
}
NOTIFICATIONS = {"mhs/progress": "ProgressParams", "mhs/result": "ResultParams", "mhs/state": "StateParams"}
NERVE = {
    "hello": "NerveHello",
    "data": "NerveData",
    "manual": "NerveManual",
    "clip": "NerveClip",
}
DATA = {kind: kind.capitalize() + "Data" for kind in KINDS}


def data_def(kind: str) -> str | None:
    """The definition that checks a data payload of this kind, or None for an unknown kind."""
    if kind.startswith("x_"):
        return "CustomData"
    return DATA.get(kind)


@lru_cache(maxsize=None)
def _validator(name: str) -> Draft202012Validator:
    if name not in DEFS:
        raise KeyError(f"no definition {name!r} in mhs-v1.json")
    return Draft202012Validator({**SCHEMA, "$ref": f"#/$defs/{name}"})


def is_valid(name: str, value: Any) -> bool:
    """Whether value satisfies the named definition, for example is_valid("RegisterParams", params)."""
    return _validator(name).is_valid(value)


def errors(name: str, value: Any) -> list[str]:
    """Why value does not satisfy the named definition: one line per problem, empty when valid."""
    found = []
    for e in _validator(name).iter_errors(value):
        where = "/".join(str(p) for p in e.absolute_path) or "(root)"
        found.append(f"{where}: {e.message}")
    return found

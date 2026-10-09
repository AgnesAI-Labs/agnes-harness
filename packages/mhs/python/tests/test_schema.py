import json
from pathlib import Path

import pytest

from agnes_mhs import HUB_ONLY_REASONS, KINDS, data_def, errors, is_valid
from agnes_mhs.schema import DATA, DEFS, NERVE, NOTIFICATIONS, REQUEST_PARAMS, RESULTS

CASES = json.loads((Path(__file__).resolve().parents[2] / "test" / "schema-cases.json").read_text(encoding="utf-8"))


# The same cases the TypeScript test runs, so both languages read the schema the same way.
@pytest.mark.parametrize("case", CASES, ids=[f"{c['def']}: {c['note']}" for c in CASES])
def test_schema_cases(case):
    assert is_valid(case["def"], case["value"]) is case["valid"]
    assert (errors(case["def"], case["value"]) == []) is case["valid"]


def test_every_mapped_definition_exists():
    for name in [*REQUEST_PARAMS.values(), *RESULTS.values(), *NOTIFICATIONS.values(), *NERVE.values(), *DATA.values()]:
        assert name in DEFS


def test_vocabularies_come_from_the_schema():
    assert "detections" in KINDS and "world" in KINDS
    assert set(HUB_ONLY_REASONS) == {"offline", "denied", "preempted", "disconnect"}
    assert data_def("x_torque_map") == "CustomData"
    assert data_def("no_such_kind") is None

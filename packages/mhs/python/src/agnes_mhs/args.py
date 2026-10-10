"""Call arguments checked the way spec 6.4 says; devices apply this themselves (TOOL-2)."""

from __future__ import annotations

import json
import math
from typing import Any


class InvalidArguments(Exception):
    """The arguments cannot be used: the call is rejected with reason invalid."""


def prepare_arguments(input_schema: dict[str, Any], args: Any) -> tuple[dict[str, Any], list[str]]:
    """Validated arguments and notes. Out-of-range numbers are clamped, long strings truncated,
    unknown parameters dropped and omitted ones defaulted, each with a note. Raises
    InvalidArguments for wrong types, missing required parameters and non-finite numbers."""
    notes: list[str] = []
    value = _object(input_schema.get("properties", {}), input_schema.get("required", []), args, "", notes)
    return value, notes


def _object(properties: dict[str, Any], required: list[str], value: Any, path: str, notes: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InvalidArguments(f"{path or 'arguments'} must be an object")
    out: dict[str, Any] = {}
    for key in value:
        if key not in properties:
            notes.append(f"dropped unknown parameter {path}{key}")
    for key, param in properties.items():
        name = path + key
        if key in value:
            out[key] = _value(param, value[key], name, notes)
        elif "default" in param:
            out[key] = param["default"]
            notes.append(f"{name} defaulted to {json.dumps(param['default'])}")
        elif key in required:
            raise InvalidArguments(f"missing required parameter {name}")
    return out


def _value(param: dict[str, Any], value: Any, name: str, notes: list[str]) -> Any:
    if "enum" in param and value not in param["enum"]:
        raise InvalidArguments(f"{name} must be one of {', '.join(json.dumps(e) for e in param['enum'])}")
    kind = param.get("type")
    if kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise InvalidArguments(f"{name} must be a finite number")
        if kind == "integer" and value != int(value):
            raise InvalidArguments(f"{name} must be an integer")
        n = value
        if "minimum" in param and n < param["minimum"]:
            n = param["minimum"]
        if "maximum" in param and n > param["maximum"]:
            n = param["maximum"]
        if n != value:
            notes.append(f"{name} was {value}, clamped to {n}")
        return n
    if kind == "string":
        if not isinstance(value, str):
            raise InvalidArguments(f"{name} must be a string")
        limit = param.get("maxLength")
        if limit is not None and len(value) > limit:
            notes.append(f"{name} was truncated to {limit} characters")
            return value[:limit]
        return value
    if kind == "boolean":
        if not isinstance(value, bool):
            raise InvalidArguments(f"{name} must be true or false")
        return value
    if kind == "array":
        if not isinstance(value, list):
            raise InvalidArguments(f"{name} must be a list")
        if len(value) < param.get("minItems", 0):
            raise InvalidArguments(f"{name} needs at least {param['minItems']} items")
        if "maxItems" in param and len(value) > param["maxItems"]:
            raise InvalidArguments(f"{name} takes at most {param['maxItems']} items")
        items = param.get("items")
        return value if items is None else [_value(items, v, f"{name}[{i}]", notes) for i, v in enumerate(value)]
    if kind == "object":
        return _object(param.get("properties", {}), param.get("required", []), value, f"{name}.", notes)
    return value

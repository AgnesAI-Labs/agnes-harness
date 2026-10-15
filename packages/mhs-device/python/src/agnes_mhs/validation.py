"""Bounded protocol validation. Unknown description fields are informational only."""
import copy
import json
import math
import re
from pathlib import Path


class MhsError(ValueError):
    pass


def prepare(schema, value, notes=None, depth=0):
    notes = notes if notes is not None else []
    if depth > 8:
        raise MhsError("invalid")
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            raise MhsError("invalid")
        result = {}
        for key, child in schema.get("properties", {}).items():
            if key in value or "default" in child:
                result[key] = prepare(child, value.get(key, child.get("default")), notes, depth + 1)
            elif key in schema.get("required", []):
                raise MhsError("invalid")
        return result
    if kind == "array":
        if not isinstance(value, list) or not schema.get("minItems", 0) <= len(value) <= min(schema.get("maxItems", 1024), 1024):
            raise MhsError("invalid")
        return [prepare(schema["items"], v, notes, depth + 1) for v in value]
    if kind in ("number", "integer"):
        if type(value) not in (int, float) or not math.isfinite(value) or (kind == "integer" and int(value) != value):
            raise MhsError("invalid")
        adjusted = max(schema.get("minimum", -math.inf), min(schema.get("maximum", math.inf), value))
        if adjusted != value:
            notes.append("clamped")
        value = adjusted
    elif kind == "string":
        if not isinstance(value, str):
            raise MhsError("invalid")
        adjusted = value[:schema.get("maxLength", 4096)]
        if adjusted != value:
            notes.append("truncated")
        value = adjusted
    elif kind == "boolean":
        if type(value) is not bool:
            raise MhsError("invalid")
    else:
        raise MhsError("invalid")
    if "enum" in schema and not any(type(v) is type(value) and v == value for v in schema["enum"]):
        raise MhsError("invalid")
    return value


def check_schema(schema, depth=0):
    allowed = {"type", "properties", "required", "default", "minimum", "maximum", "maxLength", "items", "minItems", "maxItems", "enum", "description"}
    if not isinstance(schema, dict) or depth > 8 or set(schema) - allowed:
        raise MhsError("invalid-schema")
    if schema.get("type") not in ("object", "array", "number", "integer", "string", "boolean"):
        raise MhsError("invalid-schema")
    for key in ("minimum", "maximum", "maxLength", "minItems", "maxItems"):
        if key in schema and (type(schema[key]) not in (int, float) or not math.isfinite(schema[key])):
            raise MhsError("invalid-schema")
    for key in ("maxLength", "minItems", "maxItems"):
        if key in schema and (type(schema[key]) is not int or schema[key] < 0):
            raise MhsError("invalid-schema")
    if schema.get("minimum", -math.inf) > schema.get("maximum", math.inf):
        raise MhsError("invalid-schema")
    if schema["type"] == "object":
        props = schema.get("properties", {})
        if not isinstance(props, dict) or set(props) & {"__proto__", "constructor", "prototype"}:
            raise MhsError("invalid-schema")
        for child in props.values():
            check_schema(child, depth + 1)
        if any(k not in props for k in schema.get("required", [])):
            raise MhsError("invalid-schema")
    if schema["type"] == "array":
        check_schema(schema.get("items"), depth + 1)


def _check(schema, value, depth=0):
    if depth > 32:
        raise MhsError("invalid-description")
    if schema.get("type") == "null" and value is not None:
        raise MhsError("invalid-description")
    if "anyOf" in schema:
        for branch in schema["anyOf"]:
            try:
                _check(branch, value, depth + 1)
                return
            except MhsError:
                pass
        raise MhsError("invalid-description")
    kind = schema.get("type")
    types = {"string": str, "object": dict, "array": list, "boolean": bool}
    if kind in types and type(value) is not types[kind]:
        raise MhsError("invalid-description")
    if kind in ("number", "integer"):
        if type(value) not in (int, float) or not math.isfinite(value) or (kind == "integer" and value != int(value)):
            raise MhsError("invalid-description")
        if value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf) or ("exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]):
            raise MhsError("invalid-description")
    if "const" in schema and value != schema["const"]:
        raise MhsError("invalid-description")
    if kind == "string" and (len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", math.inf) or ("pattern" in schema and not re.search(schema["pattern"], value))):
        raise MhsError("invalid-description")
    if kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", math.inf):
            raise MhsError("invalid-description")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            raise MhsError("invalid-description")
        items = schema.get("items", {})
        for index, item in enumerate(value):
            child = items[index] if isinstance(items, list) and index < len(items) else {} if isinstance(items, list) else items
            _check(child, item, depth + 1)
    if kind == "object":
        if any(k not in value for k in schema.get("required", [])):
            raise MhsError("invalid-description")
        for key, item in value.items():
            child = schema.get("properties", {}).get(key)
            if child is not None:
                _check(child, item, depth + 1)
            patterns = schema.get("patternProperties", {})
            matching = [node for pattern, node in patterns.items() if re.search(pattern, key)]
            for node in matching:
                _check(node, item, depth + 1)
            if child is None and not matching and schema.get("additionalProperties") is False:
                raise MhsError("invalid-description")


_SCHEMAS = json.loads((Path(__file__).parent / "schema.json").read_text())["$defs"]
_SCHEMA = _SCHEMAS["registration"]


def registration(value):
    if len(json.dumps(value, allow_nan=False).encode()) > 65536:
        raise MhsError("invalid-description")
    _check(_SCHEMA, value)
    for group, key in (("tools", "name"), ("sources", "id"), ("maps", "id")):
        names = [x.get(key) for x in value.get(group, [])]
        if len(names) != len(set(names)):
            raise MhsError("duplicate-id")
    resources = value.get("resources", {})
    for tool in value.get("tools", []):
        check_schema(tool["inputSchema"])
        if tool["inputSchema"]["type"] != "object" or any(r not in resources for r in tool.get("uses", [])) or (tool.get("motion") and tool.get("readOnly")) or any(source not in {s["id"] for s in value.get("sources", [])} for source in tool.get("needs", [])):
            raise MhsError("invalid-tool")
    manual = value.get("manual")
    if manual:
        axes = manual["axes"]
        if len({a["id"] for a in axes}) != len(axes) or any(not a["min"] <= 0 <= a["max"] or a["min"] >= a["max"] for a in axes):
            raise MhsError("invalid-axis")
    for field in value.get("state", {}).values():
        if field.get("min", -math.inf) > field.get("max", math.inf):
            raise MhsError("invalid-range")
    sources = value.get("sources", [])
    for source in sources:
        if "of" in source and not any(s["id"] == source["of"] and s["id"] != source["id"] for s in sources):
            raise MhsError("invalid-source")
    if value.get("localization") == "fixed" and "placement" not in value:
        raise MhsError("invalid-placement")
    return copy.deepcopy(value)


def validate_wire(value, *kinds):
    for kind in kinds:
        try:
            _check(_SCHEMAS[kind], value)
            return
        except MhsError:
            pass
    raise MhsError("invalid-wire")


def observation(source, data, payload=None, mime=None):
    kind = source["kind"]
    if kind in _SCHEMAS:
        _check(_SCHEMAS[kind], data)
    if kind in ("values", "switch"):
        if not isinstance(data, dict):
            raise MhsError("invalid-observation")
        for key, value in data.items():
            field = source.get("fields", {}).get(key)
            if not field:
                raise MhsError("invalid-observation")
            schema = {"type": field["type"], **({"minimum": field["min"]} if "min" in field else {}), **({"maximum": field["max"]} if "max" in field else {}), **({"enum": field["enum"]} if "enum" in field else {})}
            if prepare(schema, value) != value:
                raise MhsError("invalid-observation")
    if kind in ("image", "video", "audio", "points", "grid") and not payload:
        raise MhsError("missing-binary")
    if kind == "image" and mime not in ("image/png", "image/jpeg"):
        raise MhsError("invalid-image")
    if kind == "audio" and len(payload) % (data["channels"] * 2):
        raise MhsError("invalid-pcm")
    if kind == "points" and len(payload) != data["n"] * len(data["fields"]) * 4:
        raise MhsError("invalid-points")
    if kind == "pose" and any(data.get("cov", [0] * 9)[i] < 0 for i in (0, 4, 8)):
        raise MhsError("invalid-covariance")

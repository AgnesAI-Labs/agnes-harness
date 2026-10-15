# Python device SDK (preview)

[简体中文](README.zh-CN.md)

Install independently from the repository root with Python 3.11+:

```sh
python -m pip install ./packages/mhs-device/python
```

The distribution includes `agnes_mhs.Device`, `connect_device`, `publish_observation`, declaration validation and a copy of the generated MHS/MOS JSON schema. The asynchronous network adapter uses the external `websockets` distribution (BSD-3-Clause); its source is https://github.com/python-websockets/websockets. It is not vendored. There is no npm or PyPI publication promise for this preview.

```python
import asyncio
from agnes_mhs import Device, connect_device

device = Device({
    "protocol": "mhs/v1",
    "device": {"id": "sensor-01", "kind": "sensor"},
    "state": {"temperature": {"type": "number", "unit": "°C"}},
})
device.update({"temperature": 22})
asyncio.run(connect_device(device, "ws://127.0.0.1:4180"))
```

`device.tool(name, async_handler)` attaches handlers to declared tools. Handlers receive `(arguments, call)` and should call `await call.checkpoint(rest)` during interruptible work. `await device.publish(source, data, payload, mime)` emits a complete ordered MOS observation through the connection's single Nerve writer. Assign asynchronous `on_manual`, `on_configure` and `on_keyframe` callbacks as needed.

Motion and manual control refuse execution without a safety object exposing synchronous `arm(milliseconds)` and asynchronous `stop(reason)`. `arm` must arm an independent watchdog; the Python event loop is not a hardware interlock. State writes cannot start motion. Manual axes clamp and omitted axes zero. Stop, command loss and task cancellation must stop physical outputs; reconnect never resumes an old action. Read the [device safety contract](../README.md).

Run local declaration validation with `python -m agnes_mhs description.json`. This checks the declaration, not physical safety or full protocol conformance. Focused tests use synthetic state and safety adapters, without real hardware or credentials:

```sh
PYTHONPATH=packages/mhs-device/python/src python -m unittest discover -s packages/mhs-device/python/tests -v
```

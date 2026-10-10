# agnes-mhs

`agnes_mhs` is the Python side of Agnes MHS: the device library, the message schema helpers, and `mhs-check`, the test hub that checks a device against the [MHS and MOS specifications](../spec/mhs-spec.md).

- `Device` declares a device's tools, state, sources, maps and manual control, and speaks the protocol for it.
- `is_valid` and `errors` check a value against the JSON Schema; `python -m agnes_mhs.validate` checks a recorded session.
- `python -m agnes_mhs.check` is the test hub of the [conformance suite](../spec/mhs-conformance.md).
- [`examples/sensor.py`](examples/sensor.py), a room sensor, and [`examples/camera.py`](examples/camera.py), a test pattern streamed as H.264, are the smallest devices that pass it.

[Write a device](../../../docs/guide/mhs-device.md) shows how to write a device with this library or its TypeScript counterpart.

## Install

It needs Python 3.10 or later and [uv](https://docs.astral.sh/uv/). From this directory, `uv run` sets up the environment, PyAV included:

```sh
uv sync
```

In another project, install it from the repository; the `video` extra adds PyAV, which `examples/camera.py` and the video checks use:

```sh
uv pip install -e <repository>/packages/mhs/python
uv pip install -e "<repository>/packages/mhs/python[video]"
```

## Check a device

```sh
uv run python -m agnes_mhs.check                    # the test hub, waiting on ws://127.0.0.1:8800
uv run python examples/sensor.py                    # in a second terminal: the device under test
uv run python -m agnes_mhs.validate session.jsonl   # check every message of a recorded session
```

`--profile`, `--no-motion`, `--interactive` and `--report` are described in [Write and check a device](../../../docs/guide/mhs.md#write-and-check-a-device).

## Tests

```sh
uv run pytest
```

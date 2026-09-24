# Python runtime status

`@agnes/runtime-python` currently exposes the Python runtime factory and type stubs. The factory rejects execution with `E_PRESET_UNSUPPORTED`; a production Python kernel, I/O bridge, snapshot and restore backend are not implemented.

Use the supported standard task flow described in the [quickstart](../../docs/guide/quickstart.md). Installing Python dependencies alone does not enable hybrid/code execution. See [known limitations](../../docs/reference/limitations.md).

The tests preserve the factory's refusal behavior, the declared Python type surface and opt-in acceptance cases. No benchmark result or installation support is implied by these fixtures.

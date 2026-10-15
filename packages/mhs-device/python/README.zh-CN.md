# Python 设备 SDK（预览）

[English](README.md)

在仓库根目录使用 Python 3.11+ 独立安装：

```sh
python -m pip install ./packages/mhs-device/python
```

发行内容包含 `agnes_mhs.Device`、`connect_device`、`publish_observation`、声明校验及生成的 MHS/MOS JSON schema。异步网络适配器使用外部 `websockets` 发行包（BSD-3-Clause），源码为 https://github.com/python-websockets/websockets，未内嵌其源码。预览版本不承诺 npm 或 PyPI 发布。

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

`device.tool(name, async_handler)` 为已声明工具注册 handler。handler 接收 `(arguments, call)`，在可中断工作中应调用 `await call.checkpoint(rest)`。`await device.publish(source, data, payload, mime)` 经连接的唯一 Nerve writer 顺序发送完整观测。按需指定异步 `on_manual`、`on_configure` 和 `on_keyframe` 回调。

运动与人工控制在没有 safety 对象时拒绝执行。该对象必须提供同步 `arm(milliseconds)` 与异步 `stop(reason)`；`arm` 启动独立 watchdog，不能把 Python 事件循环当成硬件联锁。状态写入不得启动运动。人工轴限幅、缺省轴归零。Stop、命令断线和任务取消必须停止物理输出，重连不恢复旧动作。详见[设备安全合同](../README.zh-CN.md)。

用 `python -m agnes_mhs description.json` 本地校验声明；它不证明硬件安全或完整协议一致性。聚焦测试使用合成状态与 safety 适配器，不连接真实硬件或凭据：

```sh
PYTHONPATH=packages/mhs-device/python/src python -m unittest discover -s packages/mhs-device/python/tests -v
```

# 沙箱提供者

[English](sandbox-providers.md) | 简体中文

[文档](../README.zh-CN.md) · [安全](security.zh-CN.md) · [配置](../reference/configuration.zh-CN.md)

沙箱提供者运行一条命令并负责它的进程。宿主在进程启动时选择一个提供者。公开合同是 [`SandboxProvider`](../../packages/extension-api/src/sandbox-provider.ts)。

## 启动时选择

写在 profile 里：

```yaml
sandbox:
  provider: local
```

`local` 是默认值，也是当前的宿主沙箱：macOS 使用 Seatbelt，Linux 使用 bubblewrap，Windows 保持现有姿态。省略该字段即使用这个默认值。`docker` 是 `examples/sandbox/docker` 里的示例提供者，只有插件注册之后才会出现。

这个选择在进程的整个生命周期内保持不变。`catalog()` 给每条记录标上 `restartRequired: true`。修改 profile 不会搬走已经在跑的命令，也不会改换当前进程的目标。要换 id，需要重新启动进程。

远程工作区不能再选择另一个提供者，远程运行器保持原样。

## 能力

每个提供者声明自己真正能做的事：

| 字段 | 含义 |
| --- | --- |
| `network` | 只有调用可以请求并获得网络时才是 `true`。`false` 表示这次调用必须拒绝，而不是悄悄打开网络 |
| `fsWrite` | 提供者强制执行的绝对写入根。空的静态列表不声明写入隔离；以每次调用的 enforcement 为准 |
| `platform` | 这个提供者可以运行的操作系统 |
| `available` | 提供者不能运行命令时为 `false`。`exec` 以 `SANDBOX_UNAVAILABLE` 拒绝 |

缺少工具就是缺少能力。`docker version` 失败时，Docker 提供者把 `available` 设为 `false`，并且不会改在宿主上运行这条命令。本地提供者仅在本次授权策略允许时接受网络请求。空的静态 `fsWrite` 列表不代表已落实隔离；OS 编译器与 Host 在每次调用中提供实测姿态。没有绑定策略的直接调用会被拒绝。

## 提供者要实现什么

`exec` 接收 `argv`、`cwd`、可选的 `env` 和 `stdin`、时间和输出上限，以及一个 `AbortSignal`。它还接收 `policy`，返回退出码、捕获的输出和实际 `enforcement`。`dispose` 停止该实例启动的每个进程。取消会杀掉进程，而不是让命令继续跑并报告成功。

通过注入 `sandboxProviders` 并调用 `register` 的插件注册。重复的 id 会被拒绝。`catalog()` 列出 id、版本、来源包、能力和 `restartRequired`。

宿主操作系统的限制仍然包裹 `local` 命令。非 `local` 的提供者 id 会跳过这层包裹，避免同一条 argv 被包两次。此时 `confine` 会拒绝，而不是返回原始 argv。自己启动受限 argv 的工具需要一个会改写 argv 的提供者；这个 Docker 提供者在容器里执行 `exec`，不改写宿主 argv。

## 每次执行与工作区边界

Host 向所有提供者（包括 `local`）的 `exec` 传递本次已授权的 `policy`：工作区根、策略摘要、读取/写入允许与拒绝目录、网络模式与主机、最低 enforcement。提供者不能落实策略时必须在启动命令前拒绝；结果必须报告实际 `enforcement`，Host 不会从 id 推断隔离成功。Base 的本地 OS 编译器先生成隔离 argv，再由同一 public instance 入口执行。

启动配置支持 `sandbox: { provider: docker, options: { image: alpine:3.21 } }`；options 是提供者字符串映射。相同 provider、工作区根和有效 options 共享实例；不同工作区或 options 不复用首个实例。每个实例负责取消并排空自己的命令；底层本地 spawner 由 Host 持有。

Docker 示例仅展示进程/网络隔离，没有完整的 Host 文件拒绝策略，因此不能替换默认必需的 L1。其能力不足或策略不支持时拒绝，不退回本地执行。

显式 L0 覆盖不要求命令隔离，并报告 `level: none, scope: []`；文件工具的围栏独立生效。

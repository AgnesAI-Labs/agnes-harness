# 沙箱提供者

[English](sandbox-providers.md) | 简体中文

[文档](../README.zh-CN.md) · [安全](security.zh-CN.md) · [配置](../reference/configuration.zh-CN.md)

沙箱提供者运行一条命令并负责它的进程。宿主在进程启动时选择一个提供者。公开合同是 [`SandboxProvider`](../../packages/extension-api/src/sandbox-provider.ts)。

## 启动时选择

写在 profile 里：

```yaml
providers:
  sandbox: { provider: local }
```

`local` 是默认值，也是当前的宿主沙箱：macOS 使用 Seatbelt，Linux 使用 bubblewrap，Windows 使用 [Windows 写限制](#windows-写限制)。省略该字段即使用这个默认值。`docker` 是 `examples/sandbox/docker` 里的示例提供者，只有插件注册之后才会出现。

这个选择在进程的整个生命周期内保持不变。`catalog()` 给每条记录标上 `restartRequired: true`。修改 profile 不会搬走已经在跑的命令，也不会改换当前进程的目标。要换 id，需要重新启动进程。

`providers.sandbox: { provider }` 是选择沙箱的唯一写法；顶层 `sandbox` 块只放该提供者的 `options`。`platform` 不能被选择：平台后端归宿主所有，在提供者目录里显示为 `platform`，authority 为 `host`，任何包都不能注册或选择它。

## 远程提供者

命令在另一台机器上运行的提供者，从自己的包里导出 `sandboxProvider`。用 `@agnes/sandbox-remote` 的 `defineRemoteSandboxProvider({ id, version, openTransport })` 构造，然后用 `providers.sandbox: { provider: <id> }` 选中，通道设置写在该包的配置里（`rootTemplate`、`keepOnClose`、`providerTtlMs`，以及 `openTransport` 自己读取的内容）。宿主在启动时打开一次通道，并在其上运行自己的执行门、文件策略和工作区围栏，所以提供者实例本身从不承载命令。只有被选中的远程提供者才会打开通道。远程工作区不能再选择另一个提供者。

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

启动配置支持 `providers.sandbox: { provider: docker }` 加上 `sandbox: { options: { image: alpine:3.21 } }`；options 是提供者字符串映射。相同 provider、工作区根和有效 options 共享实例；不同工作区或 options 不复用首个实例。每个实例负责取消并排空自己的命令；底层本地 spawner 由 Host 持有。

Docker 示例仅展示进程/网络隔离，没有完整的 Host 文件拒绝策略，因此不能替换普通预设的条件 L1 要求。其能力不足或策略不支持时拒绝，不退回本地执行。

显式 L0 覆盖不要求命令隔离，并报告 `level: none, scope: []`；文件工具的围栏独立生效。

## 本机隔离中的标准设备

macOS Seatbelt 配置仅为精确路径 `/dev/null` 允许读写，并为精确路径 `/dev/zero`、`/dev/random`、`/dev/urandom` 允许读取。这使 workspace-write 下的 Git 等命令能够使用空设备，读取范围受限时也适用。它不会为其他三个设备授予写入权限，也不增加 `/dev` 整棵子树、原始磁盘、临时目录写入或额外 ioctl 权限。现有控制终端 ioctl 规则保持不变。显式路径拒绝优先于设备授权，受保护路径和工作区写入边界保留原有约束。

本机 stdio MCP 隔离复用同一编译器，因此 strict、workspace-write、network 配置具有相同设备例外。其运行时读取列表已经包含 `/dev/null` 和 `/dev/urandom`；仅有读取授权并不足以允许写入。

Linux bubblewrap 已通过 `--dev /dev` 提供隔离的最小设备树，不暴露宿主原始设备；其设备权限与 Seatbelt 的精确路径规则并不完全相同。目前 Landlock 仅用于 ABI 诊断，不是另一套命令隔离后端。Windows 尚无已实现的本机 L1 后端，Windows 编译器拒绝隔离请求。只读和可修改工作区的命令改用 [Windows 写限制](#windows-写限制)，完全访问则直接运行。本次 macOS 缺陷无需调整 Linux 或 Windows 的设备策略。

## Windows 写限制

Windows 上，`local` 对 `read-only` 和 `workspace-write` 会话的命令使用 Windows ACL 写限制：受限令牌、Low 完整性级别、NTFS ACL 授权，以及由 Host 持有的 Job Object。这是部分保护，只限制文件写入。它不是 macOS、Linux 那样完整的 L1 隔离，也不是严格的路径沙箱。需要 NTFS 工作区和可用的原生模块。

| 权限 | Windows 上的行为 |
| --- | --- |
| `read-only` | 不授予写权限：命令对工作区和临时目录都没有写权限。哪些命令可以运行仍由工具策略决定 |
| `workspace-write` | 写权限只授予工作区根目录，以及属于该会话租约的私有临时目录。例外见下方的副作用 |
| `full-access` | 以当前账户直接运行，不隔离，也不修改任何 ACL |

文件读取和网络不受限制。命令可以读取工作区外的文件，也可以访问网络。受保护路径仍由文件工具检查；任意脚本没有同等保护。

`sandbox.windows_mode` 决定这一行为，取值为 `write-restricted` 或 `require-full`。官方 `read-only` 和 `workspace-write` 权限覆盖层选择 `write-restricted`；此时 `required: true`、自定义拒绝路径、网络限制及其他更强的要求会被拒绝，不会降级为写限制。默认值 `require-full` 从不使用写限制。Windows 没有完整的本机后端，因此仍由 `on_unavailable` 决定：自定义配方使用 `allow-if-unimplemented` 时命令不经隔离直接运行，`deny` 拒绝每条命令，`required: true` 拒绝打开工作区。操作系统名称不会给自定义配方任何其他降级。

写限制无法建立时拒绝启动，命令不会直接运行。常见原因：非 NTFS 卷、磁盘根目录、UNC 路径、未验证的 junction 根目录、缺少原生模块、ACL 修改失败。

对工作区的副作用：

- 授权会一直保留在工作区上，直到被明确移除。命令结束或会话关闭都不会移除。
- 授权会在工作区目录上添加 Low 完整性标签和 Everyone 的删除子项拒绝项。它们一直保留，直到被移除；期间同一 Windows 用户下以 Low 完整性运行的其他程序也可以写入该目录。
- 工作区内的硬链接文件（例如 pnpm 存储中的文件），可通过授权从工作区外的其他名称被修改。
- 在同一卷内移动目录时，ACL 可能跟随被移动的对象。移动不会被追踪。
- 会话的额外目录和 `extra_paths` 没有写权限，命令写入那里会被拒绝访问。
- 同一路径下的工作区目录被另一个目录替换后不再被信任。会话拒绝执行命令，也不能再次打开，历史保留。确认在会话之外进行：检查新目录后运行 `agh doctor windows-acl --cwd <root> --repair`，再原地打开该会话。保存的工作区路径或 ID 已不一致的会话不属于目录被替换，任何确认都不会接受它；历史保留，需要新建会话。

每个会话有自己的租约和私有临时目录。分叉出的会话使用自己的租约，不共用父会话的；在会话某一轮内工作的子代理共用该会话的租约。写限制下，角色会话的分叉会被拒绝，因为分叉不会保留角色已捕获的限制。

旧版本创建的会话保留历史。使用官方权限覆盖层的会话在下一条命令时改用新规则；带有更严格自定义要求的会话会被拒绝，记录保留。

`agh doctor windows-acl --cwd <root>` 显示某个工作区的授权状态，并列出工作区目录被替换的会话。默认只读。`--repair` 移除 AGH 自己添加的授权项，并就地确认被替换的工作区（这是确认的唯一方式）；他人改过的项会保留并报告。仍被运行中会话使用的授权不会被移除。请在普通终端中以运行 AGH 的 Windows 用户身份执行，命令不会提权。`--json` 输出报告。

## 本机条件隔离

`l1Implementation` 表示实现支持状态（`implemented`、`unimplemented`、`unknown`），与命令是否可执行、工作区实际探测分别记录。缺字段为未知。只有可信内置本机后端可授予未实现例外；第三方声明不能授权回退本机执行。

普通预设使用 L1、`required: false`、`on_unavailable: allow-if-unimplemented`。Windows 上 L1 尚未实现：使用随附预设和官方权限覆盖层时，只读和可修改工作区的会话使用 [Windows 写限制](#windows-写限制)，无法建立时拒绝启动，不会直接运行。`windows_mode` 保持 `require-full` 的自定义配方沿用这一未实现平台策略，`allow-if-unimplemented` 时命令直接运行。完全访问不经系统隔离直接运行。macOS/Linux 必须通过真实后端探测，已实现但探测失败仍拒绝。`required: true` 优先。L0 搭配此条件值无效，原有显式 `allow`/`deny` 语义保留。远程传输沿用原来的明确策略，新本机条件不授予远程例外。

具名角色子会话保留父会话已经获准的本机降级：Host 已准入未实现平台例外时，`partial / file` 报告本身不应额外要求 L1。已经提供的系统隔离、继承的强制隔离以及角色自身更严格的沙箱要求仍然有效。只有文件约束但未获准降级的父会话不属于例外。Windows 写限制下的会话，其角色子会话也在该写限制下运行，即使角色自己的配方没有选择它；角色更严格的要求，或带自定义拒绝路径的父会话策略，会拒绝该子会话。文件工具边界、工具权限和审批限制保持不变；降级后的 shell 仍没有系统沙箱隔离。

L1 的 `loopback_serve` 声明可搭配 `deny` 或 `allow-if-unimplemented`，仍要求受限访问和空网络白名单。实际监听器只能由探测成功的本机 macOS L1 后端提供。Windows 上选择写限制的策略会被拒绝，因为写限制不限制命令网络。其他情况（包括保持 `require-full` 的 Windows 配方）下，Host 先移除不支持的监听器声明，再应用原有的未实现平台策略；这不授予受控监听器或系统网络隔离。管理端安全状态按同一判断描述每个策略。已实现后端的失败仍不得降级，`loopback_serve` 也仍不能搭配无条件 `allow`。

会话或子会话执行前，Host 持久记录实际工作区策略、provider 及版本、执行目标、实现状态与隔离结果。恢复时重新验证当前条件并核对记录。历史会话缺少执行记录时，仅当当前后端为 L1、实现为 `implemented`、探测为 `ready`、隔离为 `full` 且包含 `file` 范围，才可采用当前决策。引入记录前的会话要求操作系统隔离，因此此规则保留原有保证；Host 持久发布并复读校验记录后才继续，并用会话标识的哈希记录采用日志。其他缺失记录，以及任何损坏、不可读或不匹配的记录，仍拒绝继续执行并提示新建会话，保留历史；会话记录本身仍可读取时，可以只读查看。不改写预设意图哈希来假装用户请求了 L0。此例外不支持混合版本继续执行，也不绕过工作区及 generation 校验。

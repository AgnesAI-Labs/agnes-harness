# 验证与复现

[English](verification.md) | 简体中文

[文档导航](../README.zh-CN.md) · [支持范围](../reference/limitations.zh-CN.md) · [发布检查](release.zh-CN.md)

验证应使用与源码和文档一致的版本。下面提供可复现入口；本地确定性模型用于检查协议与执行流程，真实提供方、浏览器和跨平台体验需分别验证。

## 环境与前置步骤

从仓库根目录执行，Node/pnpm 版本见 [package.json](../../package.json)：

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
pnpm --filter @agnes/system-node build:native
```

## 静态与自动化检查

```sh
node tools/public-docs/verify.mjs
pnpm typecheck
pnpm lint
pnpm gen:check
pnpm exec vitest run tools/guards/src tools/public-docs/examples.test.ts --maxWorkers=1
```

[仓库门禁指南](../../tools/guards/README.zh-CN.md) 区分只报告的 scope 行数、硬性文件上限、
turn/generation/supervisor 的 AST 函数有效行上限，以及 Host 官方业务语义 fence。
file/function 预算与精确 Host 例外不得相对受保护 merge-base 增长，普通 remeasure 只能收紧；原 assemble/CU 门继续保留。
正反夹具验证门禁拒绝路径，不代表运行时 capability 准入或状态机迁移通过。
计数规则、保留合同、首次 seed 和独立维护者预算变更见该指南。

`pnpm test:all` 运行完整测试集；`pnpm test` 只运行快速层，`pnpm test:heavy` 只运行真实进程与大数据层（`*.e2e.test.ts`、`*.slow.test.ts`）。测试中的跳过项、平台前提与失败应保留在该版本结果中，不能用总通过数量掩盖未验证范围。

CLI 启动测试仍要求启动和创建会话成功。共享 CI 机器上的耗时会写入任务摘要，不作为通过门槛。在稳定的性能测试机器上设置 `AGH_ENFORCE_BOOT_BUDGET=1`，再运行 `pnpm exec vitest run packages/cli/test/boot-budget.test.ts --maxWorkers=1`，即可执行 300 ms 门槛检查。

Web 交付构建使用生产 React 并压缩 JavaScript；开发 watcher 保留开发诊断。聚焦用例 `packages/cli/test/build-local-web.test.ts` 遍历实际产物的静态模块图（含 import map 中的 vendor），将冷启动 JavaScript 限制为 6.75 MiB。内置主页、图表绘图引擎和离线诊断渲染器按需加载；Web 使用声明的 `@agnes/web-units/shell` 入口；包根仍保留诊断导出以兼容现有调用者。绘图加载期间仍可读取源数据表和图例。历史转录按完整值保留记录引用，并按轮次隔离渲染；全局插件贡献仍读取最新投影。聚焦的 turn 与 slot 用例约束 20 次更新期间的历史重复渲染，并保留已有滚动、选区、导航和 slot 生命周期检查。字节门具有确定性，不能代替真实浏览器的绘制、交互和转录测量。

生成的事件、协议与投影 schema 使用不可变定义和符合 CSP 的缓存引用计划。拒绝值仍使用 TypeBox 的完整错误迭代器；策略开关与已注册格式保持实时读取。调用方自建的可变 schema 继续解释式校验。`packages/protocol/test/validate.test.ts` 对结果与完整错误做差分验证，覆盖递归、畸形与策略相关输入。heavy 层 `validation-plan.slow.test.ts` 将 500 节点投影与解释器配对，要求计划校验耗时中位数低于解释器的 70%。

heavy 层 `packages/cli/test/startup-perf.e2e.test.ts` 通过 `AGNES_LOCAL_CLI` 指向现有本地构建，使用隔离的新 home 和真实 daemon/worker；CLI ready 上限为 8 秒，首次会话为 4 秒，输出测量值并在清理前停止进程。归因仍须在同机配对记录启动 spans 与 CPU profiles；宽松回归预算不能代替配对实测。账本扫描与 append watermark 语句在各自连接内复用查询计划；不缓存行、完整性决定，也不放宽提交顺序或 checkpoint 同步。


流式准备只复用来自注册表已分离、冻结定义的工具 schema scrub 结果；每个请求仍独立构造正文，并执行 provider wire 校验与准入。`packages/core/test/derive.test.ts` 覆盖冷/热 stamp 等价、源对象修改、定义替换和披露集合变化。

订阅事件后，SDK 中相同的 controls、完整 UI 投影、UI surface 和 workspace changes 读取，仅在同一会话、generation 与事件水位下共享在途 RPC。读取期间的事件会排队触发新读取，覆盖其所需水位的调用者共享该次新读取。各调用者仍独立持有结果；后续事件发起新读取，拒绝后可重试，detach、断连与 generation 变化会拒绝旧结果。聚焦的 `packages/sdk/test/session.test.ts` 和 `ui-projection-sync.test.ts` 还覆盖流开始与 turn/end 立即投影，并保持单一有序投影队列。插件会话选择由 `packages/web-client/test/web-client.test.ts` 验证。

重型门 `packages/host-infrastructure/test/adapters/table-reads.slow.test.ts` 串行测量 50 行合成数据上的五批 owner 读取，每批 3,000 次，保守上限为 150 ms。它还检查写入、schema 变更和查询计划淘汰后的最新结果，以及非法参数和 SQL 拒绝。查询计划仅在各自隔离连接内复用，不缓存数据行或授权结果。原有账本完整性与包加载门仍须执行。

包加载性能门位于 `tools/plugin-performance.slow.test.ts` 的 **gates real immutable package preparation** 用例。在性能测试机器上使用 Node 24 串行运行：

```sh
pnpm exec vitest run tools/plugin-performance.slow.test.ts --project heavy --maxWorkers=1 -t 'gates real immutable package preparation'
```

它安装、信任并固定 20 个合成包，每包包含 200 × 1 KiB 负载文件、模块、清单和两个 32 KiB 客户端资源。三轮分别测量冷/热 inventory、不可变快照、真实 Host 包装配阶段（在 native/provider 启动前停止）、只读客户端列表/资源，以及包 IO 期间 Surface 变更事件的路由发布时间。冷读使用新的 reader 和空的 loader/client 磁盘缓存，不清空操作系统缓存。Surface 传输使用合成 SDK 响应，订阅与路由查询使用生产代码；不代表已验证 daemon IPC 或浏览器渲染。

每个样本检查 wall time（通常每阶段 10 秒、冷装配 15 秒、Surface 发布 1 秒）、事件循环间隔（250 ms）、进程峰值 RSS（1536 MiB，含准备与导入阶段的高水位）及采样 RSS 增量（256 MiB）。固定上限位于 `tools/package-load/metrics.ts`，是保守的回归预算，不是实测性能宣称。用例在预算断言前输出数据规模、机器、Node 和逐轮测量；将 `AGH_PERFORMANCE_OUTPUT` 设为仓库外路径，还会保存 `<path>.package-load.json`。调整上限前应审核同一 runner 的数据。热 loader 与普通/fresh inventory 读取仍须拒绝篡改字节。快速层 `tools/package-load.test.ts` 以单包规模验证真实路径及超预算拒绝，不表示大数据性能门已通过。

在 Windows 上，检查符号链接越界的测试需要具备创建符号链接的权限（开发者模式或对应账户权限）。如果准备夹具时 `symlinkSync` 返回 `EPERM`，说明环境前提未满足，安全断言尚未执行。共享 CI 的启动耗时诊断在完整测试失败后仍会运行；测试未执行或任务取消时不会运行。

## 前一构建升级门

统一前的旧插件元数据现在必须明确拒绝并提示使用干净 home，lock、快照、pin 与信任字节保持不变。只有格式仍受支持的基线才验证续跑；闸门不再注入旧元数据或将旧信任转入新快照。

```sh
pnpm exec vitest run tools/upgrade/previous-build.e2e.test.ts --project heavy --maxWorkers=1
```

此常设重型门从当前工作树和 [distributions.mjs](../../tools/upgrade/distributions.mjs) 固定的 plugin-core 提交构建真实发行包。较新基线早于客户端规范化与内置默认包修复；另一条更早基线早于账本追加水位线。测试在隔离私有 home 中创建回环模型账号、普通/工具/附件/交付物/分叉/队列历史、可信插件、设置、日程和触发器；每条基线均覆盖正常停机与进程丢失后升级；崩溃路径等待旧 writer 租约自然到期（最多 60 秒），不删除占用记录。已有分叉夹具由较早构建创建：较新基线在创建分叉时会错误拒绝合法的 null inbox 清空记录；当前构建必须读取并继续较早分叉，包括这些清空记录。断言原历史事件不变、历史可读可续写、授权不扩张、内置包字节随发行包更新，以及必要时通过原生决策恢复托管服务。不运行 home 转换或旧产品迁移。历史呈现检查使用 Web 时间线投影，浏览器布局由独立门验证。默认包发布期间出现 `MANAGED_RESOURCE_NOT_RECOVERABLE` 时，托管恢复最多额外冷启动一次当前发行包，随后原生审批及健康检查必须成功；这一已知发布限制会明确记录。

使用 `AGH_UPGRADE_PREVIOUS_REF=<commit>` 可选择另一较新基线。Git 必须包含两个固定提交，浅克隆先执行 `git fetch --unshallow`。可选绝对目录 `AGH_UPGRADE_PREVIOUS_DIST`、`AGH_UPGRADE_LEDGER_DIST`、`AGH_UPGRADE_CURRENT_DIST` 可复用完整构建，字节须对应所选源码。默认构建将较新的前版/当前发行包版本指定为 `1.0.0`/`1.1.0`，实际触发内置包随发行升级。`AGH_UPGRADE_KEEP=1` 保留成功运行的临时产物；失败始终保留并打印位置。安装构建依赖需要访问包注册表；模型流量仅访问回环地址并使用假密钥。启动环境不继承操作者凭据，使用私有 home。串行运行，预留三套发行包的磁盘空间，并按安装指南准备原生工具链。

排障时可用 `AGH_UPGRADE_CASE=recent|legacy`、`AGH_UPGRADE_VARIANT=clean|unclean` 缩小范围；完整门应不设置这两项。

现有 CI heavy 任务自动执行：PR 覆盖 Linux，main、定时和手动运行覆盖 Linux/macOS，并获取完整 Git 历史。Windows 显式跳过此门，原生崩溃及进程树验收留待同事跟进；POSIX 通过不代表 Windows 已验证。

<a id="构建与真实本地进程"></a>

## 构建与真实本地进程

```sh
pnpm --filter @agnes/cli build:local
node agnes.mjs --help
node --import tsx tools/public-docs/smoke.mjs
```

smoke 使用隔离的临时 home、本机回环模型夹具与真实 CLI/daemon/worker，检查会话、默认助手、插件、Web 接口以及更新和清理；结束后停止自行启动的服务。它通过 HTTP/WebSocket 客户端访问 Web 接口，不代表真实浏览器视觉验收。

持续维护的 `pnpm e2e:web` 检查在 [CI](../../.github/workflows/e2e-web.yml) 的 macOS 与 Linux 上运行。它构建或校验可复用运行目录，从 `agnes.mjs serve` 启动隔离 daemon/Web，验证页面交互、持久化变更、语言/无障碍及经审阅的平台截图。Chromium 单独预装。[Web 检查指南](../../tools/e2e-web/README.md)维护 spec 清单、产物、零重试规则和基线审阅。合成场景覆盖不证明所有浏览器或部署均可用。

构建到独立输出目录或执行 PowerShell 步骤见[安装指南](../guide/install.zh-CN.md)，手动体验见[演示指南](../guide/demo.zh-CN.md)。

## 记录验证结果

每次验收记录源码 revision、OS/架构、Node/pnpm 版本、执行命令，以及通过、失败和跳过数量。修复后采用定向回归时注明覆盖范围，不将它描述成一次全仓重跑。

发布说明摘要应链接到对应版本的 CI 或经过脱敏的验收结果。浏览器、真实模型、外部 MCP、物理设备和其他平台的结果分别记录；本地回环测试不能代替这些环境的验收。

<a id="2026-09-24-源码候选验证"></a>

## 发行证据

结果应引用与版本匹配的 CI 产物和发行说明；历史源码候选的计数不构成当前验收证据。真实模型结果与确定性测试分开记录，注明模型和账号环境，但不包含凭据。macOS/Linux CI 不隐含 Windows 或物理设备验收，见[发行检查](release.zh-CN.md)。

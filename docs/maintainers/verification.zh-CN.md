# 验证与复现

[English](verification.md) | 简体中文

[文档导航](../README.zh-CN.md) · [支持范围](../reference/limitations.zh-CN.md) · [发布检查](release.zh-CN.md)

验证应使用与源码和文档一致的版本。下面提供可复现入口；本地确定性模型用于检查协议与执行流程，真实提供方、浏览器和跨平台体验需分别验证。

## 环境与前置步骤

从仓库根目录执行，先运行 `mise trust` 和 `mise install`。开发 Node 补丁版本由 [`.node-version`](../../.node-version) 固定，用户支持范围和 pnpm pin 见 [package.json](../../package.json)。安装、构建和检查统一走同一入口；它打印实际 `process.version`、`process.execPath` 并核验子进程运行时：

```sh
mise exec -- node tools/toolchain/run.mjs install --frozen-lockfile
mise exec -- node tools/toolchain/run.mjs --filter @agnes/host build:native
mise exec -- node tools/toolchain/run.mjs --filter @agnes/system-node build:native
```

仅执行 `install --frozen-lockfile` 不足以运行 fast 项目。每个 checkout 都须构建这两个原生目标，
原生源码变化后重新构建。Host 构建 PTY relay，以及 macOS 的进程身份和应用身份 helper；
system-node 构建 owner lock、socket activation 和描述符/目录树刷盘使用的原生模块。
两个 Vitest 项目在收集测试前检查这些前置条件，缺失或陈旧时输出准确的构建命令。
macOS 的原生合同必须执行；模块缺失属于环境失败，不能跳过。

构建完成后，在根目录运行完整 fast 门：

```sh
mise exec -- node tools/toolchain/run.mjs exec vitest run --project fast --maxWorkers=2
```

若继承的 mise 激活状态使其他 Node 排在前面，可为本条命令设置
`MISE_ACTIVATE_AGGRESSIVE=1 mise exec -- node tools/toolchain/run.mjs …`；入口仍须报告固定运行时。
不要修改全局 PATH。

## 静态与自动化检查

```sh
mise exec -- node tools/toolchain/run.mjs exec node tools/public-docs/verify.mjs
mise exec -- node tools/toolchain/run.mjs typecheck
mise exec -- node tools/toolchain/run.mjs lint
mise exec -- node tools/toolchain/run.mjs gen:check
mise exec -- node tools/toolchain/run.mjs exec vitest run tools/guards/src tools/public-docs/examples.test.ts --maxWorkers=1
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
mise exec -- node tools/toolchain/run.mjs exec vitest run tools/plugin-performance.slow.test.ts --project heavy --maxWorkers=1 -t 'gates real immutable package preparation'
```

它安装、信任并固定 20 个合成包，每包包含 200 × 1 KiB 负载文件、模块、清单和两个 32 KiB 客户端资源。三轮分别测量冷/热 inventory、不可变快照、真实 Host 包装配阶段（在 native/provider 启动前停止）、只读客户端列表/资源，以及包 IO 期间 Surface 变更事件的路由发布时间。冷读使用新的 reader 和空的 loader/client 磁盘缓存，不清空操作系统缓存。Surface 传输使用合成 SDK 响应，订阅与路由查询使用生产代码；不代表已验证 daemon IPC 或浏览器渲染。

每个样本检查 wall time（通常每阶段 10 秒、冷装配 15 秒、Surface 发布 1 秒）、事件循环间隔（250 ms）、进程峰值 RSS（1536 MiB，含准备与导入阶段的高水位）及采样 RSS 增量（256 MiB）。固定上限位于 `tools/package-load/metrics.ts`，是保守的回归预算，不是实测性能宣称。用例在预算断言前输出数据规模、机器、Node 和逐轮测量；将 `AGH_PERFORMANCE_OUTPUT` 设为仓库外路径，还会保存 `<path>.package-load.json`。调整上限前应审核同一 runner 的数据。热 loader 与普通/fresh inventory 读取仍须拒绝篡改字节。快速层 `tools/package-load.test.ts` 以单包规模验证真实路径及超预算拒绝，不表示大数据性能门已通过。

在 Windows 上，检查符号链接越界的测试需要具备创建符号链接的权限（开发者模式或对应账户权限）。如果准备夹具时 `symlinkSync` 返回 `EPERM`，说明环境前提未满足，安全断言尚未执行。共享 CI 的启动耗时诊断在完整测试失败后仍会运行；测试未执行或任务取消时不会运行。

## 前一构建升级门

[前一构建测试](../../tools/upgrade/previous-build.e2e.test.ts) **默认暂停**，包括 CI heavy 层。固定基线早于扩展 API 5.0 和 SQLite 数据目录闸门，夹具插件的 API 范围与持久格式均不兼容。跳过不代表升级验收通过。

维护者须先选择 API 5.0 且数据格式受支持的兼容基线，才可用 `AGH_UPGRADE_GATE=1` 和 `AGH_UPGRADE_PREVIOUS_REF` 显式启用。测试意图覆盖正常停机、进程丢失、历史／pin 保留及旧元数据拒绝；Windows 仍跳过。基线与可选分发输入见 [distributions.mjs](../../tools/upgrade/distributions.mjs)。不要强行接纳旧数据或转换信任字节。用户恢复按[数据格式恢复](../guide/install.zh-CN.md#数据格式与升级)处理，不提供运行数据迁移。

<a id="构建与真实本地进程"></a>

## 构建与真实本地进程

```sh
mise exec -- node tools/toolchain/run.mjs --filter @agnes/cli build:local
node agnes.mjs --help
node --import tsx tools/public-docs/smoke.mjs
```

smoke 使用隔离的临时 home、本机回环模型夹具与真实 CLI/daemon/worker，检查会话、默认助手、插件、Web 接口以及更新和清理；结束后停止自行启动的服务。它通过 HTTP/WebSocket 客户端访问 Web 接口，不代表真实浏览器视觉验收。

持续维护的 `pnpm e2e:web` 检查在 [CI](../../.github/workflows/e2e-web.yml) 的 macOS 与 Linux 上运行。它构建或校验可复用运行目录，从 `agnes.mjs serve` 启动隔离 daemon/Web，验证页面交互、持久化变更、语言/无障碍，截图只作为证据上传；任何操作系统上都没有像素门禁。Chromium 单独预装。[Web 检查指南](../../tools/e2e-web/README.md)维护 spec 清单、产物和零重试规则。合成场景覆盖不证明所有浏览器或部署均可用。

构建到独立输出目录或执行 PowerShell 步骤见[安装指南](../guide/install.zh-CN.md)，手动体验见[演示指南](../guide/demo.zh-CN.md)。

## 记录验证结果

每次验收记录源码 revision、OS/架构、Node/pnpm 版本、执行命令，以及通过、失败和跳过数量。修复后采用定向回归时注明覆盖范围，不将它描述成一次全仓重跑。

发布说明摘要应链接到对应版本的 CI 或经过脱敏的验收结果。浏览器、真实模型、外部 MCP、物理设备和其他平台的结果分别记录；本地回环测试不能代替这些环境的验收。

<a id="2026-09-24-源码候选验证"></a>

## 发行证据

结果应引用与版本匹配的 CI 产物和发行说明；历史源码候选的计数不构成当前验收证据。真实模型结果与确定性测试分开记录，注明模型和账号环境，但不包含凭据。macOS/Linux CI 不隐含 Windows 或物理设备验收，见[发行检查](release.zh-CN.md)。

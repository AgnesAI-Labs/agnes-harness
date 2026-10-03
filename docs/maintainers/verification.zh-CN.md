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

`pnpm test:all` 运行完整测试集；`pnpm test` 只运行快速层，`pnpm test:heavy` 只运行真实进程与大数据层（`*.e2e.test.ts`、`*.slow.test.ts`）。测试中的跳过项、平台前提与失败应保留在该版本结果中，不能用总通过数量掩盖未验证范围。

CLI 启动测试仍要求启动和创建会话成功。共享 CI 机器上的耗时会写入任务摘要，不作为通过门槛。在稳定的性能测试机器上设置 `AGH_ENFORCE_BOOT_BUDGET=1`，再运行 `pnpm exec vitest run packages/cli/test/boot-budget.test.ts --maxWorkers=1`，即可执行 300 ms 门槛检查。

在 Windows 上，检查符号链接越界的测试需要具备创建符号链接的权限（开发者模式或对应账户权限）。如果准备夹具时 `symlinkSync` 返回 `EPERM`，说明环境前提未满足，安全断言尚未执行。共享 CI 的启动耗时诊断在完整测试失败后仍会运行；测试未执行或任务取消时不会运行。

## 本地文件系统上的权威目录

[默认目录](../../packages/host/src/runtime/providers/authority-directory.ts)与[独立 SQLite reference](../../examples/runtime-reference/src/providers/authority-directory.ts)支持 Windows 固定本地 NTFS/ReFS 卷。资格判断读取实际对象句柄的卷 GUID、驱动器类型和文件系统名称；Windows Node 的 statfs.type 不能标识文件系统。UNC、映射网络盘、可移动、只读与未知卷明确拒绝。显式设备与扩展命名空间路径拒绝；普通本地长路径在系统层内部转换。

默认实现先刷新文件内容，再作同卷 write-through 替换并刷新已发布文件；reference 使用 SQLite FULL 事务，在发布定位锚前刷新复制的数据库文件。Windows 不宣称具备 POSIX 父目录 fsync 或等价的目录断电持久性，每条 Windows 符合性场景均记录此限制。POSIX 持久化行为不变。macOS 注入测试覆盖 Windows 判定、失败路径和六类场景，真实 Windows 进程恢复与并发仍需 Windows CI 分片验证。杀进程不能验证断电。


```sh
pnpm exec tsx tools/acceptance/runtime/run-conformance.ts --contracts agh.authority-directory --providers default,reference
pnpm exec vitest run packages/host/test/runtime/authority-directory.test.ts packages/host/test/runtime/authority-directory.e2e.test.ts examples/runtime-reference/src/providers/authority-directory-lock.test.ts examples/runtime-reference/src/providers/authority-directory.e2e.test.ts packages/system-node/test/windows-volume.test.ts --maxWorkers=1
```

## 构建与真实本地进程

```sh
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs --help
node --import tsx tools/public-docs/smoke.mjs
```

smoke 使用隔离的临时 home、本机回环模型夹具与真实 CLI/daemon/worker，检查会话、默认助手、插件、Web 接口以及更新和清理；结束后停止自行启动的服务。它通过 HTTP/WebSocket 客户端访问 Web 接口，不代表真实浏览器视觉验收。

构建到独立输出目录或执行 PowerShell 步骤见[安装指南](../guide/install.zh-CN.md)，手动体验见[演示指南](../guide/demo.zh-CN.md)。

## 网络与密钥提供方检查

[Host 网络提供方](../../packages/host/src/runtime/providers/network.ts)与[密钥 broker](../../packages/host/src/runtime/providers/secrets.ts)可脱离进程启动单独验证。[reference 网络](../../examples/runtime-reference/src/providers/network.ts)与[reference 密钥](../../examples/runtime-reference/src/providers/secrets.ts)采用独立的传输和存储算法。这些入口尚未接入普通 Host、daemon 或 CLI 启动。

```sh
pnpm exec tsx tools/acceptance/runtime/run-conformance.ts --contracts agh.network,agh.secrets --providers default,reference
pnpm exec vitest run packages/host/test/runtime/network-secrets.test.ts packages/host/test/runtime/secrets-legacy.e2e.test.ts packages/host/test/runtime/secrets-oauth.test.ts packages/host/test/runtime/secrets-network.e2e.test.ts packages/host/test/runtime/secrets-drain.slow.test.ts packages/host/test/runtime/network.e2e.test.ts packages/host/test/runtime/network-secrets-recovery.e2e.test.ts examples/runtime-reference/src/providers/network-secrets-lock.test.ts examples/runtime-reference/src/providers/network-cross.e2e.test.ts --maxWorkers=1
```

符合性分别执行选择、正常、拒绝、取消、恢复和释放六类场景。报告用 `restricted-effects` 标明部署授权与内容端口夹具。恢复会杀死真实子进程；网络测试使用固定回环对端与 CONNECT 代理。这些证据覆盖 broker 行为，不代表生产启动、真实 OAuth 提供方或其他操作系统已验收。

网络部署提供显式目标规则、当前身份和授权校验，以及保留响应字节的内容权威。每次连接前检查 DNS 回答和重定向。请求身份先持久化再发送；不确定的发送保持 unknown，不自动重试。默认代理通过 CONNECT 隧道访问已固定的目标地址。Reference 支持公共 IPv4 与部署显式批准的地址例外，拒绝代理和不支持的公共地址族。

密钥配置只含 `secret://` 引用、版本与用途绑定 grant。默认实现可消费现有 `composeSecrets`，保留文件优先于环境变量的行为，存储拒绝不转成环境变量回退。句柄不授予 bearer 权限：受信消费者每次使用时重新核验当前身份、scope、audience、用途、版本、期限和撤销状态。本机材料消费回调属于部署的受信消费者边界，不是普通插件端口。消费者不响应取消时，释放有界失败。

默认 refresh 与 exchange 需要部署侧受限效果端口。刷新身份和凭据锁跨崩溃保留；缺少证据返回 unknown，不重发旋转 token。回调授权码仅进入短期、单次使用的加密 escrow；exchange 可以为 `initialVersion: null` 的目录项安装首次凭据。Reference OAuth 能力明确登记为未声明，返回 incompatible/unsupported。材料扫描覆盖 broker 持久化和诊断结果；凭据来源存储不写入 broker 元数据库。

## 脱离启动路径的发布计划检查

[Host 装配计划提供方](../../packages/host/src/runtime/providers/assembly.ts)和[独立 reference](../../examples/runtime-reference/src/providers/assembly.ts)从固定计划、有效配置、包解析结果及公开 fixture 构造不可变发布锁。检查覆盖内容身份、依赖、schema 与恢复引用、必需 UI bundle、权限差异、joint-dispatch 声明和迁移前置证据。

```sh
pnpm exec tsx tools/acceptance/runtime/run-conformance.ts --contracts agh.assembly --providers default,reference
pnpm exec vitest run packages/host/test/runtime/assembly.test.ts --maxWorkers=1
```

可执行符合性覆盖仅有 plan 选择、成功构造和拒绝用例。准备、发布、drain、准入与冷恢复仍未完成；提供方未登记到普通启动路径。UI manifest、包权限请求与维护提交观察均明确使用合成 fixture，生产输入适配器尚未交付。Blob 引用只从固定 fixture 内容解析，并校验摘要和字节数；不读取 latest 文档、不调用迁移方法、不接触发布权威。

## 记录验证结果

每次验收记录源码 revision、OS/架构、Node/pnpm 版本、执行命令，以及通过、失败和跳过数量。修复后采用定向回归时注明覆盖范围，不将它描述成一次全仓重跑。

发布说明摘要应链接到对应版本的 CI 或经过脱敏的验收结果。浏览器、真实模型、外部 MCP、物理设备和其他平台的结果分别记录；本地回环测试不能代替这些环境的验收。

## 2026-09-24 源码候选验证

环境：macOS arm64、Node.js 24.20.0、pnpm 10.34.5，在独立源码目录与隔离的运行目录中验证。

| 检查 | 结果 |
| --- | --- |
| 锁定依赖安装、两个原生 helper、完整本地构建 | 通过 |
| 类型、生成一致性、文档链接与源码锚点 | 通过 |
| Biome | 0 错误；保留 30 项警告与 15 项提示 |
| 自动化测试 | 全仓首轮执行 18,682 项；其中 344 项跳过，16 项失败均已修复并通过定向回归 |
| 仓库 guards 最终复测 | 544 项通过，2 项跳过 |
| 真实本地进程 smoke | 19 个阶段通过 |

测试采用一次全仓运行加相关回归，修复后没有再做一次整仓重跑。回归覆盖全部首轮失败项、Worker、Host 装配和文档示例；跳过项仍受平台或显式环境条件限制。真实浏览器、付费模型、外部服务、物理设备与其他平台不在本次验收范围。源码或构建环境变化后应重新验证。

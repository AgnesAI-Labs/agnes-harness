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

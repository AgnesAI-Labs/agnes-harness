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

## 构建与真实本地进程

```sh
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs --help
node --import tsx tools/public-docs/smoke.mjs
```

smoke 使用隔离的临时 home、本机回环模型夹具与真实 CLI/daemon/worker，检查会话、默认助手、插件、Web 接口以及更新和清理；结束后停止自行启动的服务。它通过 HTTP/WebSocket 客户端访问 Web 接口，不代表真实浏览器视觉验收。

构建到独立输出目录或执行 PowerShell 步骤见[安装指南](../guide/install.zh-CN.md)，手动体验见[演示指南](../guide/demo.zh-CN.md)。

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

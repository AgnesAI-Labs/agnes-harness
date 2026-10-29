# 如何完成首次 npm 发布

[English](first-npm-release.md) | 简体中文

[发布检查](release.zh-CN.md) · [版本策略](versioning.zh-CN.md)

**尚未完成。** 这些脚本不代表公开 npm 发布已获批准。工作区包继续保持 private。现有候选为 `@agnes/harness`，可执行命令为 `agh`；在用户决定前保持包名不变。

本地准备需要 Node.js 24.10+、锁定的 pnpm、npm/npx 和 `tar`。Registry smoke 当前在 macOS/Linux 运行；Windows 还需要实现进程树停机，脚本会在启动前拒绝运行。本地 registry 没有上游连接；离线打包需要提前缓存锁定依赖及原生构建 headers。

- [ ] 选择并批准公开包集合、版本、npm scope 所有权和支持平台。当前打包只生成构建宿主平台的一个自包含 CLI tarball，并限制 `os`/`cpu`。同名同版本的不同平台产物不能分别发布；承诺多个平台前须审阅跨平台分发方案。
- [ ] 固定源码 revision。使用 Node.js 24.10+ 和锁定的 pnpm 10.34.5，安装锁定依赖后执行[发布检查](release.zh-CN.md)。原生构建需要平台工具链；离线构建还须预先缓存 Node headers。
- [ ] 执行 `pnpm release:pack`。审阅 `dist/release/pack-result.json` 和 tarball：名称/版本、可执行入口、exports、内嵌 manifest、原生文件、预构建 Web 资源、LICENSE、NOTICE 与第三方声明。守卫在打包前及解包后执行，拒绝 workspace/本地依赖泄漏、入口/资源缺失和仅用于开发的运行时依赖。随包提供的 esbuild 用于插件创作。
- [ ] 审阅[缓存许可来源](../../third-party/pack-licenses/README.md)、声明清单及 libvips 所带库的许可和再分发要求。部分上游包只提供 SPDX 元数据而没有完整许可声明；公开分发前须取得或批准完整归属声明。源码许可和发行物许可分别审阅。
- [ ] 执行 `pnpm release:npx-smoke`。它构建候选，仅发布到没有上游转发的临时回环 registry，再以空缓存、隔离 HOME/AGH_HOME 通过 npx 安装，检查版本、doctor、Web 健康/资源和停机，并写入 `dist/release/npx-smoke-result.json`。无需提供方账户或浏览器；运行阶段使用 npm offline 模式。已有 tarball 时可传入 `--tarball /absolute/candidate.tgz`；用 `--report /absolute/result.json` 将证据保存到其他位置。
- [ ] 在每个承诺的 OS/架构上重复验收。记录安装字节数、冷启动时间、失败和未测环境。宿主平台 smoke 不证明模型、外部 MCP、沙箱行为或其他平台通过。
- [ ] 用户批准已审阅产物及实际公开发布操作。之后发布负责人才能向明确批准的 registry 发布选定产物，在新环境验证从该 registry 安装，并更新发布说明/安装指南。Tag 与 release 需要各自的授权。

这些命令只进行本地准备和本地 registry 验证，不向 npm 发布，也不创建 tag/release。Smoke 成功是准备证据，不代表首次公开发布已经发生。

# 发布检查

[文档导航](../README.md) · [版本管理](versioning.md) · [验证与复现](verification.md)

发布基于明确的源码 revision 和经过核对的发行树。源码公开、npm 包发布与预构建安装器分别验收。

## 源码版本

- 从全新目录安装锁定依赖，构建 CLI/Web/daemon/worker，执行相关测试与本地进程验收。
- 运行文档校验、类型、lint、生成一致性和仓库 guards；记录真实失败与尚未覆盖的平台。
- 核对 README、支持范围、示例与实际代码一致；发布说明写清主要能力、安装方式和兼容变化。
- 核对待发布文件与 Git 引用，确认历史、附件和配置不包含非公开材料、凭据或私人数据。
- 保留 LICENSE、NOTICE、依赖来源及各组件随附声明；单独核对实际打包依赖、素材与二进制。

## 仓库入口

- 默认分支包含完整源码，克隆地址与 README 的步骤可用。
- Issues 接受普通反馈并显示问题/建议表单；PR 按当前项目政策限 Collaborators only。
- 受邀开发者权限、主分支审查和必需检查规则配置正确。
- 公开后启用并实测 Security → Advisories → Report a vulnerability，再按 [SECURITY.md](../../SECURITY.md) 更新报告入口状态。
- About、topics、文档入口与版本说明指向实际可用内容；演示素材来自真实运行。

## npm 分发门

以下条目由 [release-readiness guard](../../tools/guards/src/release-readiness.test.ts) 与[机器清单](../../tools/guards/release-readiness-todos.json)保持一致。它约束 npm 分发，源码许可按根 LICENSE 生效。

- [ ] `packages.private` — 选定公开包集合、赋予非占位版本，并仅对这些包移除 `private`；工具包继续保持私有发布标记。

检查通过只能说明已执行的检查范围；真实模型、外部 MCP、跨平台、设备和安装器按各自环境验收。

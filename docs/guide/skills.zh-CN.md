# Skills：把团队方法带进每一次任务

[English](skills.md) | 简体中文

[文档导航](../README.zh-CN.md) · [插件开发](../develop/plugins.zh-CN.md)

将项目约定、检查步骤和常用方法整理为 Skill，让 Agent 在任务中使用这些知识。本页从一个工作区示例开始，再介绍来源管理、同名选择和维护方式。

Skill 提供任务说明与资源，不等于执行权限。AGH 发现候选、审核版本、选择同名胜出项，再向会话暴露可用内容；不能只因磁盘上存在文件就声称模型已读取。

## 创建一个工作区 Skill

在目标项目（不是必须在 AGH 源码库）创建 `.agh/skills/review-notes/SKILL.md`：

```markdown
---
name: review-notes
description: 只读整理项目说明中的不一致之处
---
先读取 README 与相关说明，列出互相冲突的描述和对应文件。
只提出修改建议，不写文件，不安装依赖。
```

在 Web 为该项目创建会话，然后进入 Skills 管理，刷新对应工作区，核对来源、内容修订与信任状态。命令行可以查看和管理：

```sh
node packages/cli/dist/local/agnes.mjs resources list --kind skill
node packages/cli/dist/local/agnes.mjs skills refresh --root-key workspace-agnes --workspace-id WORKSPACE_ID
node packages/cli/dist/local/agnes.mjs resources get SKILL_RESOURCE_ID
node packages/cli/dist/local/agnes.mjs skills trust SKILL_RESOURCE_ID REVISION trusted
node packages/cli/dist/local/agnes.mjs resources enable SKILL_RESOURCE_ID --expected-revision REVISION
```

`WORKSPACE_ID` 是当前已登记工作区的 64 位十六进制标识，可从工作区/资源数据读取；不要把路径或另一个会话的 ID 填进去。对用户 home 的 Skill 可选择 `--root-key user-agnes`，无需把项目 Skill 移过去。读取最新资源数据后再作写入。

确认 `trust=trusted`、`desired=enabled`、`actual=ready`、`winner`，再在该工作区会话明确说“使用 review-notes 整理项目说明”。当前 Host 对明确提名且唯一匹配的可用 Skill 有预加载路径；模糊描述不是确定性的激活语法。

## 来源与冲突

磁盘来源包括工作区 `.agh/skills`、`AGH_HOME/skills`，以及操作系统用户目录下的 `.agents/skills`、`.claude/skills`、`.codex/skills`；包也可以贡献 Skill。`AGH_HOME` 不会重定位其他工具的用户目录。多工作区按会话自己的工作区读取，不以 worker 启动目录替代。

默认优先级如下，数字越大越优先：

| 来源 | 默认值 | 可设置用户覆盖 | 可永久删除 |
| --- | --- | --- | --- |
| 工作区 `.agh/skills` | 500 | 是 | 是，仅所选 Skill 目录 |
| Cordis 运行时贡献 | 450 | 否 | 否，由插件生命周期撤下 |
| `AGH_HOME/skills` | 400 | 是 | 是 |
| 用户 `.agents/skills` | 300 | 是 | 是，可能影响共用它的其他应用 |
| 用户 `.claude/skills` | 200 | 是 | 是，可能影响共用它的其他应用 |
| 用户 `.codex/skills` | 100 | 是 | 是，可能影响共用它的其他应用 |
| 包贡献 | 50 | 是 | 否，通过插件管理处理 |

同名按去除首尾空白并忽略大小写分组；非删除候选先按有效优先级降序，同分按 `sourceId` 排序。`winner` 是解析结果，仍须通过自己的 trust/desired 检查才会 ready。高优先级项未信任、被拒绝或停用时，不会仅因不可用就自动选择低优先级项。

刷新失败可能留下 stale/最近已知内容，不把 stale 当作本次扫描成功。磁盘内容改变需要重新核对 revision 与信任。

## 调整同名候选优先级

1. 在 Web 设置 → Skills，选对应工作区并打开 Skill 详情，查看来源、当前 winner、被覆盖候选和有效优先级。
2. 在“同名覆盖优先级”输入 **50–500 的整数**，点击“保存优先级”并确认。它只改变该 resourceId 在当前 profile 中的持久覆盖，不改文件内容、不授予信任或启用。
3. 等待操作完成，重新查看 winner 与 actual。若新 winner 尚未信任或启用，分别审核并处理；不要只看优先级保存成功。
4. “恢复默认优先级”清除该项覆盖，恢复上表的来源默认值。已有内容 revision 相同也可能有并行优先级修改，因此保存还校验 `expectedPriority`；冲突时刷新，不盲重试。

例如 `AGH_HOME/skills` 的用户候选默认 400、工作区候选默认 500。要使用用户项，可把工作区项降到 350；不要靠双方同为 500 来猜谁会胜出。删除高优先级项后，剩余同名候选可能接替，但不会继承已删项的信任或启用状态。活动轮次持有不可变快照，控制面成功不证明进行中的轮次已经切换；在操作结束后检查下一轮/新会话的实际状态。

## 永久删除一个磁盘 Skill

需要暂时停用时选择“停用”。**“永久删除”会删除选中的 Skill 目录及其中全部文件，不只删除 SKILL.md，也不是移入回收站。** 用户目录可能同时供其他应用使用。

1. 只在隔离实验目录演练；刷新并核对详情中的来源、工作区、内容修订和同名候选。
2. 对 workspace 或 user 来源点击“永久删除”，阅读目录整体删除和同名接替提示后确认。package/runtime 来源不能在此单独删除。
3. 保存 operation ID，等待状态 `succeeded`，核对列表/目录与剩余同名候选。API 返回 receipt 仅表示受理；部分删除后仍可能失败。
4. 若报告 `SKILL_REMOVAL_PENDING`，条目已被阻止重新启用。保留状态，排除文件占用等原因后显式重试删除；不要将失败理解为已恢复原文件。删除操作受理后不支持取消，重启也不是撤销。

后台不接受调用者提供的任意删除路径：从已登记来源与 resourceId 推导目标，核对 workspace 身份、revision、目录与文件身份。过期扫描、符号链接/目录连接、硬链接或路径替换等情况会拒绝；预检失败不会先写删除标记。执行中途失败会保留身份进度与删除标记供受限重试，进度不保存文件内容，不是备份。删除标记跨重启保留，刷新不会把同一个被删 resourceId 自动复活；当前没有恢复已删除 Skill 的接口。

## API、权限与 CLI 边界

这些管理动作可从 Web 或 Node SDK 执行；当前 shell/TUI Skills 命令不包含 `remove` / `priority` 子命令，不能把方法名直接当 CLI 语法。

- `client.skills.remove({ profile, clientId, commandId, resourceId, expectedRevision })` → `_agnes/v1/skills.remove`。
- `client.skills.prioritySet({ profile, clientId, commandId, resourceId, expectedRevision, expectedPriority, priority })` → `_agnes/v1/skills.priority.set`；`priority: null` 恢复默认。
- 两者需要服务端授予的 admin authority 与 `resources.skills.write`；JSON 参数不能授予权限。浏览器管理页通过受约束的同源 BFF 调用，不把管理 SDK 给插件。
- 使用当前实例返回的身份、revision、priority，保存 commandId 和 operation receipt；相同已受理请求使用相同 commandId 查询/重放，删除失败后的新重试则显式发起新操作。用 `client.resources.operation.get({ profile, operationId })` 或 shell `resources operation OPERATION_ID` 查询结果。

合同依据：[资源 Schema](../../packages/protocol/schema/resource-control.json)、[方法与权限](../../packages/resource-control-contracts/src/resource-control.ts)、[Node 客户端](../../packages/resource-control-client-node/src/resource-control.ts)、[持久控制与删除标记](../../packages/resource-control-store/src/skills.ts)、[Web 操作](../../packages/resource-control-web/src/admin.ts)、[Worker 接线](../../packages/resource-control-worker/src/runtime-bootstrap.ts)。原生删除由[Worker 删除实现](../../packages/resource-control-worker/src/skill-remove.ts)调用 system-node 完成。源码链接对应所在文档版本；运行旧产物时应核对相应版本的合同。

## Cordis 运行时贡献

普通受信插件可声明 `inject: ['skills']`，在 `apply` 中使用：

```js
ctx.skills.register({
  name: 'review-notes',
  description: '只读整理说明冲突',
  body: '读取相关说明，列出矛盾与证据，不修改文件。',
})
```

`register()` 返回 disposer，注册随调用方 fiber 清理。动态集合用 `registerProvider(control => ({ skills() { return [...] } }))`；数据改变后调用 `control.invalidate()`，卸载会中止 `control.signal`。服务只允许贡献，不提供列出或读取其他 Skill 的接口。

运行时贡献不进入磁盘 trust/desired 管理流程；其信任来自受信代码。与磁盘刷新、包 Skill 的加载方式区分。相同层级的独立插件重名会失败；同一行替换的后继 fiber 有专门处理，不能概括成允许任意覆盖同名 Skill。

随分发提供的 Skill Helper 插件有自己的安装请求流程；工具可申请，不意味着能绕过用户确认、来源审核和写入边界。子 agent 不能借此申请 Skill 安装。

实现依据：[发现根](../../packages/base/extensions/skills/src/discover.ts)、[候选注册表](../../packages/resource-control-runtime/src/skills.ts)、[Cordis service](../../packages/resource-control-runtime/src/skills-cordis.ts)、[会话预加载](../../packages/host/src/resources/skill-preload.ts)、[Skill Helper](../../packages/package-manager/bundled-plugins/skill-helper/README.md)。

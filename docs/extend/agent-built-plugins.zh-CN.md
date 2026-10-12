# 让 Agent 创建插件

[English](agent-built-plugins.md) | 简体中文

[作者指南](README.zh-CN.md) · [本地插件](local-plugins.zh-CN.md) · [测试](testing.zh-CN.md)

让能调用工具的模型实现可复用工具或 Skill，并提供确定性测试。内置 Demo 可离线复现显式的 `call <工具> <JSON>` 指令，不会自主设计代码。

Agent 创作的文件走 **候选 → 测试 → 人工审阅 → 发布**。Host 将有界纯文本文件集合写入 profile 的私有 `.authoring-candidates` 区。发现流程不会加载它，即使自定义发现根目录指向候选区内部。创建或提交候选不安装、不信任、不启用插件。

## 免密钥 Demo 练习

沿用[快速上手](quickstart.zh-CN.md)的独立 home 和工作区，在 Web 新建 **Demo** 会话，提交 `create a plugin` 并确认保存候选的工具审批。Demo 复制版本匹配的文本统计示例，不会根据需求设计新代码。`agh -p` 没有交互审批处理器，创作调用会被拒绝；不要通过放宽策略绕过。

在候选列表审阅生成的源码和测试，记下返回的 `proposalId`（即 `candidateId`），然后在同一个 Web 会话依次提交以下消息，把 `CANDIDATE_ID` 换成实际值，并逐次确认工具和测试执行审批：

```text
call plugin_helper_install {"action":"test","proposalId":"CANDIDATE_ID"}
call plugin_helper_install {"action":"commit","proposalId":"CANDIDATE_ID"}
```

确认候选为 `state: review`、`tests.state: passed` 且 `tests.count >= 1` 后，再使用下方 CLI 审阅命令。`draft` 的 `reviewHash` 为 `null`，不能直接批准。发布后在新会话提交 `call my_text_stats {"text":"hello world"}`，预期结果为 `{"characters":11,"words":2}`。也可按[成长演示](../../examples/demos/growing-skills/README.zh-CN.md)运行独立的离线练习。

默认 **Plugin Helper** 提供三个工具：

1. `plugin_helper_guide`（`kind: tool|skill|skin`）返回版本匹配的 JavaScript 模板和 Node 合同测试。实现需求后，加强测试，包括无效输入。
2. `plugin_helper_create`（`files: [{path, content}, …]`）仅写 Host 候选区，返回 `proposalId`（候选 ID）、`candidateHash` 和 `draft` 状态。有界 helper 接受不带依赖与生命周期脚本的自包含文本 ESM。
3. `plugin_helper_install`（`action: test`、`proposalId`）先征得明确许可，再对该摘要的私有副本执行 Node 作者测试。`action: commit` 提交通过的结果供审阅；`action: status` 查询持久候选。Commit 不再安装；旧 onboarding proposal ID 需重新创建候选。

新创作 Markdown 的 `skill_helper_create` 同样保存为可审阅的 Skill 包候选；`skill_helper_install` 对候选 ID 使用 test/commit/status。创作包在此 profile 发布；代码按会话固定，已批准的 Skill 资源实时刷新；create 不再接受原 workspace/user 范围与仅安装参数。已有 Skill 导入保留 workspace/user 导入审批流程。

可选 `agnes/plugin-creator` 扩展另有 `plugin_scaffold`（tool、tool-with-panel、mcp-skills、model-adapter、loop、skill）、`plugin_candidate_read`、`plugin_candidate_write`、`plugin_test` 和 `plugin_install_local`。写入须提供旧 `candidateHash` 并替换完整文本树；`plugin_install_local` 只提交测试通过的摘要，不将代码复制到发现根目录。

大包分步构建，每次回复的新文件文本最多 8 KiB，每次完成一个文件或带唯一标记的完整段落。写入仍替换完整树，不能只发送变化文件。存在 `run_code` 时，在 cell 内读取当前候选，程序化更新 `sourceFiles`，用新摘要写入完整数组，仅输出返回的摘要；内置 `plugin_creator_guide` 提供小型 cell 示例。没有代码工具时，将完整草稿控制在输出额度内，或配置服务商支持的更高 `model.max_tokens`。发生 `OUTPUT_LIMIT` 后，读取原候选并用更小片段接续：未完成调用已被丢弃。最终摘要必须重新测试才能提交审阅；部分草稿或输出额度提示不是测试通过的证据。

在 **设置 → 插件 → 候选** 从列表选择草稿；状态标签区分待审阅、已拒绝和已发布。摘要显示插件、来源会话与轮次、测试结果及新增权限。逐个展开文件查看新增和删除行，长文件在差异区域内滚动。默认收起的 **技术详情** 包含候选、已安装基线、审阅和测试运行的摘要，原始能力变化、会话／工具 ID 及测试输出。检查改动时，审阅页底部保持 **批准发布** 和 **拒绝** 可见。

先看源码再运行测试：作者测试在本机执行可信 JavaScript，剥离环境、限制时间和输出并支持取消，但不是恶意代码沙箱。运行器使用 Node 24 与公开作者 SDK，不运行包生命周期脚本，不将 Markdown 当命令；至少一个实际执行的测试通过后才能提交。

提交后，在现有确认弹窗中选择 **批准发布** 或 **拒绝**。审批同时绑定候选摘要与不可变审阅摘要。草稿编辑、审阅副本损坏、已安装基线改变都会拒绝旧审批；须重新测试并提交。失败测试、已拒绝候选不能发布。新增能力须遵守部署的正常能力策略并获得新的人工审批。

CLI 审阅：

```sh
agh plugins candidates list --json
agh plugins candidates show <candidate-id> --json
agh plugins candidates approve <candidate-id> --candidate-hash <sha256> --review-hash <sha256>
agh plugins candidates reject <candidate-id> --candidate-hash <sha256> --review-hash <sha256>
```

两个摘要均取自实际审阅的记录。CLI 不会悄悄批准编辑后的最新草稿。App Server 提供 `_agnes/v1/plugins.candidates.{list,show,create,write,test,submit,approve,reject}`；create/write 仅供 Host 标记的作者通道，Agent 无法自行批准／拒绝。协议 schema 维护这些方法及持久来源字段。

发布走正常包安装／更新、信任、启用和代际协调。只有运行时确认审阅摘要已 running，才能返回 `published`。新会话获得插件代码，旧会话保留固定代码代际。已批准的 Skill Markdown 属于实时资源，也可在旧会话中变为可见。来源保留 `installer=agent`、作者会话／轮次及审阅者。失败或中断的发布不自动重放；先检查实际包状态，再创建新候选。

Markdown Skill 是包内数据，全文与插件快照一起审阅。Skill 提及的脚本仍需普通工具审批。人工维护的[本地插件](local-plugins.zh-CN.md)与[热重载](hot-reload.zh-CN.md)继续作为明确的开发者信任路径；作者 helper 不向其中写草稿。已授权 shell 仍拥有正常文件系统权限。

候选只含文本（最多 64 文件、每文件 128 KiB、总计 256 KiB），每 profile 最多 128 个持久候选。创建失败会清理未发布的树；不可读或已损坏的记录会从列表隔离；没有有效记录的未完成目录不占持久候选配额。二进制资产和依赖安装走普通作者／包工作流；目前没有候选垃圾回收命令。内置实现位于 `packages/package-manager/bundled-plugins/plugin-helper`；creator 资源生成命令为 `node packages/base/extensions/plugin-creator/gen-assets.mjs`。

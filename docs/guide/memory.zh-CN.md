# 学到的文件记忆

[English](memory.md) | 简体中文

记忆保存同一工作区跨会话使用的小份偏好与约定。设置 → Agent → 记忆提供**关闭**、**写入前询问**、**自动记住**。官方文件 provider 默认安装，Agent 访问默认关闭。关闭后，下次请求既不能读取也不能写入记忆，包括文件工具与 shell 路径；已经发送给模型的内容无法撤回。

用“打开记忆文件”在现有文本编辑器中查看和修改 Markdown。关闭 Agent 访问不影响人工编辑。保存使用打开文件时的哈希；发生冲突会保留人或其他会话的改动，应重新读取、合并后保存。页面显示最后记录的写入会话与轮次；直接在此编辑器外改文件不会更新该记录。记忆在项目 checkpoint 之外，回滚代码不会回滚偏好。

## 文件与预算

文件位于 `$AGH_HOME/memory/workspaces/<规范工作区路径的 SHA256>/`。`MEMORY.md` 是索引，`conventions.md` 等平铺主题文件保存可选细节。只有索引进入现有 context contribution；Agent 用普通 read 工具按需读取主题。索引和主题读取使用每轮同一修订，包括重复请求与重试。人工编辑及 Agent 本轮刚提交的改动在下一轮可读；同轮再次修改同一文件会因基线过期发生冲突。

默认存储上限：索引 16 KiB / 200 行，主题 32 KiB，工作区合计 256 KiB。独立的注入预算是工作区 2,048 tokens、可选用户层 512 tokens，含贡献头部。provider 用 UTF-8 字节数作为保守 token 上界，每层独立遵守上界，不借用另一层的剩余额度。省略标记说明请求中缺少部分内容，磁盘文件不会被静默截断。超限写入返回 `MEMORY_CONSOLIDATION_REQUIRED`，原文件不变。应合并重复或失效偏好，避免无限追加。

可选用户偏好由人创建 `$AGH_HOME/memory/user/MEMORY.md`，通过 [SDK](../reference/api.zh-CN.md) 管理方法开启 `userEnabled`。用户层只读，使用相同索引存储上限和独立注入预算。Agent 不能修改用户文件或读取其他工作区记忆。

SDK 方法 `_agnes/v1/admin.memory` 接收 `cwd`、可选 settings 补丁，或人工编辑的 `file`、`content`、`baseHash`。可配置 `indexMaxBytes`、`indexMaxLines`、`topicMaxBytes`、`totalMaxBytes`、`tokenBudget`、`userTokenBudget`、`userEnabled`。选择 `_agnes/v1/admin.context` 返回的可用工作区。设置和编辑需要本机 owner 管理权限，插件工具不能自行开启访问。

## 审批与隐私

内置 **remembering** Skill 指导记录稳定偏好、约定和决策。不要保存凭据、令牌、秘密、私人标识、一次性任务细节或聊天记录。常见凭据检测器拒绝疑似秘密；它是保守过滤器，不是万能检测器。

询问模式下，普通 write/edit 工具生成完整文件 diff、前后哈希和来源会话/轮次。正常审批只允许该变更一次。拒绝、取消、策略改变或基线变化都不能发布旧候选。full-access 和会话授权不代替记忆审批。进程隔离拒绝访问整个记忆树，bash、别名、符号链接不能绕过 provider；不能落实此边界时拒绝未隔离执行。

跨进程写入串行化，比较精确哈希后通过同步临时文件及原子 rename 提交。先成功写入主题，再在索引加链接。多文件独立提交；主题成功而索引拒绝属于部分成功。文件已提交而元数据失败返回 `MEMORY_COMMITTED_METADATA_FAILED`，不声称文件未写入。

记忆保留在本地文件和执行工具所需的会话 ledger。记忆会话的遥测只输出结构元数据，即使已开启内容导出也如此。曾注入记忆的会话，诊断事件导出还会移除消息、工具、摘要内容，防止回显偏好泄漏。诊断包不收集记忆目录。主动保留的本地请求 trace 可能含模型输入，应与会话 ledger 一同作为私密资料管理。

## 与知识源一起使用

`AGENTS.md` 保存 Git 中的团队规则，记忆保存 Git 外的学习偏好。会话搜索回答“之前讨论了什么”；知识库通过 MCP、工具或 [FDE bundle](demo.zh-CN.md) 提供资料。这些可与一个记忆 provider 共存。AGENTS.md 和权威知识源优先；通过相同审批流程纠正冲突记忆，不将原始资料复制进记忆。

Demo 模型不推理。`显示记住的偏好` 或 `show remembered preferences` 展示该请求实际收到的记忆贡献。`call write {"path":"<记忆目录>/MEMORY.md","content":"Prefer concise summaries."}` 走与推理模型相同的普通工具和审批路径。覆盖现有文件前先 read。

可替换企业实现见[记忆 providers](../extend/memory.zh-CN.md)。

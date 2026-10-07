# MCP 与 Skills 支持范围

[English](mcp-skills-support.md) | 简体中文

[文档导航](../README.zh-CN.md) · [MCP](mcp.zh-CN.md) · [Skills](skills.zh-CN.md)

本页列出当前会话路径实际实现的行为。管理界面能保存一条定义，并不等于模型能够调用它。

## MCP

| 行为 | 会话路径 |
| --- | --- |
| stdio | 支持 |
| Streamable HTTP | 支持 |
| 旧式 SSE | 支持，用于仍然只讲 SSE 的服务 |
| `tools/list` 与 `tools/call` | 支持。每个远端工具以该服务器的前缀登记 |
| `resources/list`、`resources/templates/list`、`resources/read` | 服务在初始化时声明 `resources` 能力时支持。每个已连接服务器最多增加三个只读工具，名称是该服务器前缀加上 `res_list`、`res_tpls`、`res_read` |
| `notifications/tools/list_changed` 与 `notifications/resources/list_changed` | 支持。同一条连接上重新同步 |
| 取消 | 支持。工具调用的 signal 会传到进行中的列举或读取 |
| 重连 | 支持。现有监督器重连后重新登记工具 |
| 密钥打码与共享输出保护 | 工具与资源文本均支持 |
| 远端工具与资源桥接工具同名 | 保留远端工具，省去发生冲突的那一个资源桥接工具 |
| 资源分页 | 每次调用一页。把 `nextCursor` 作为下一次的 `cursor`。超过 256 条的页是错误 |
| 把资源图片变成模型图片块 | 不支持。文本按文本返回，二进制内容是有长度上限的 base64 |
| 提示模板（`prompts/list`、`prompts/get`） | 不支持 |
| 会话行上的 OAuth | 不支持。密钥绑定种类为 `oauth` 的定义会被跳过。管理界面里的成功检查不会让该服务出现在会话中 |

## Skills

| 行为 | 会话路径 |
| --- | --- |
| 目录技能（`<name>/SKILL.md`） | 支持 |
| 扁平文件（技能根目录下的 `<name>.md`） | 支持省略 frontmatter：名称取文件名，描述取首个非空标题或文本行；空文件或无效的显式 frontmatter 会被拒绝。同名目录优先于扁平文件；更早出现的目录优先于更晚的目录 |
| 固定根目录 | 支持：工作区 `.agh/skills`、`AGH_HOME/skills`，以及显式设置 `AGNES_SKILLS_IMPORT_USER=1` 后的操作系统用户主目录下 `.agents/skills`、`.claude/skills`、`.codex/skills`。工作区的 `.agents/skills` 与 `.claude/skills` 随工作区根一起扫描 |
| 自定义技能根 | 支持安装目录 `context.json` 的 `customSkillRoots` 或设置 → 上下文；仅接受绝对路径，在 Agnes 主目录之后扫描，沿用信任与刷新规则 |
| 相对资源路径 | 支持，位于该技能目录内。可通过 `skill_read_file`，或对 `skill_read` 给出的目录使用普通文件工具。路径必须留在该目录内 |
| 同名优先级 | 优先级高者胜出。相同优先级按 `sourceId` 决定。更高优先级的技能未受信任、已停用或对模型隐藏时，不会把这个名字让给更低优先级的技能 |
| `disable-model-invocation` | 支持。`true` 时模型目录、`skill_read`、`skill_read_file` 和 `tool_search` 都看不到它。宿主仍可读取 |
| `user-invocable` | 支持。`false` 拒绝用户显式调用但保留模型可见性。Web 与 TUI 支持 `/skill invoke NAME ARGUMENTS`，上下文页面提供调用表单 |
| `disable` | 支持。`true` 时模型和宿主读取都看不到它 |
| 省略这些字段 | 模型与用户两侧都允许 |
| 非法字段值 | 跳过该文档 |
| 内容刷新 | daemon 监视 `SKILL.md` 与相对资源文件；`skills refresh --yes` 可立即重扫 |
| 标志或正文修改 | 修改标志会改变能力哈希。修改正文会改变内容修订。现有信任/拒绝与启用/禁用决定随修改保留；新磁盘技能自动信任并启用 |
| 管理描述 | 不携带调用标志 |

调用标志接受 YAML 布尔值，或大小写不敏感的 `true`/`false`、`yes`/`no`、`on`/`off`、`1`/`0`。

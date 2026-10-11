# UI terminology

English | [简体中文](ui-glossary.zh-CN.md)

Use these terms in labels, help, accessible names, confirmations and error messages. IDs, source references, commands and third-party display names remain unchanged.

| English | 简体中文 | Use |
| --- | --- | --- |
| Skill | 技能 | Packaged or workspace instruction resource |
| MCP | MCP | Model Context Protocol service |
| Plugin | 插件 | Installable package |
| Provider kind | 插件类型 | Runtime implementation category |
| Provider | 插件实现 | A registered runtime implementation; model accounts use “model provider / 模型服务” |
| Child agent | 子代理 | Session-owned child execution |
| How the agent works (Agent Loop) | 执行方式（Agent Loop） | Show only when there is a choice; keep the technical name in parentheses |
| Bundle | 组合包 | Named session composition |
| Preset | 预设 | Named permission/configuration preset |
| Updating | 更新中 | Actionable update status; retained versions belong in details |
| Saved credential | 已保存的凭据 | Choose a saved credential; retain `secretRef` only as a protocol field |
| New session | 新会话 | A session created after changing defaults or enabling a package |

Preserve draft selections when catalog reads fail. Format dates and numbers with the active locale; translate backend failures by their code, using a localized generic failure for unknown codes. Operation notices store translation keys, so switching language also updates open dialogs and existing feedback.

Everyday screens use the following terms. Put identifiers, paths, hashes, generations and transport protocols in Technical details; leftover usage appears only in Diagnostics. Select sessions by title/workspace and credentials through a picker.

| English | 简体中文 | Use |
| --- | --- | --- |
| Activity record | 执行记录 | Related request, tool and artifact records |
| View | 界面 | Fallback; prefer the surface’s own title |
| Edit workspace | 可修改工作区 | Workspace modification permission |
| Local command / Remote service | 本地命令 / 远程服务 | MCP |
| Leftover usage | 遗留占用 | Diagnostics only |
| Refresh | 刷新 | Icon with tooltip |

Default choices show human names; put IDs, versions and sources in details or tooltips, and preserve drafts on read failure.

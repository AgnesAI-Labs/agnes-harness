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
| Agent Loop | Agent Loop | Session execution loop; never alternate between “Loop” and “循环” in Chinese labels |
| Bundle | 组合包 | Named session composition |
| Preset | 预设 | Named permission/configuration preset |
| Plugin generation | 插件代际 | Immutable running code generation; package versions remain “version / 版本” |
| Credential reference | 凭据引用 | A reference to stored credentials; internal `secretRef` fields keep their API names |
| New session | 新会话 | A session created after changing defaults or enabling a package |

Default choices display their resolved human name and secondary ID/version, with the source in a tooltip. Preserve draft selections when catalog reads fail. Format dates and numbers with the active locale; translate backend failures by their code, using a localized generic failure for unknown codes. Operation notices store translation keys, so switching language also updates open dialogs and existing feedback.

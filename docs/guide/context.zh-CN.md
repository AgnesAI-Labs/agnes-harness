# 默认上下文

[English](context.md) | 简体中文

[文档](../README.zh-CN.md) · [Skills](skills.zh-CN.md) · [默认工具](../reference/default-tools.zh-CN.md)

打开 **设置 → 上下文**，查看已注册工作区的仓库规则、配置时钟或添加可信的 Skill 目录。会话绑定固定代码代际，这些文件作为实时资源读取。

`agnes/context-rules` 先读取 `$AGH_HOME/AGENTS.md`，再读取从最近的 `.git` 项目根到会话工作目录的规则。每个目录按顺序读取 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`；同目录去掉首尾空白后内容相同的文件只保留首项。更具体的目录和本地覆盖规则在各自范围内优先。工具引用子目录中的文件时加载嵌套规则，访问过的范围在恢复会话后保留。每次模型请求前刷新，包含编辑和删除。上下文预览显示所选工作区的基础规则。

仓库文本属于从属指导，不会授予工具权限、修改授权或覆盖系统合同。项目内指向项目根之外的符号链接会跳过。单个来源上限 1 MiB，总来源读取上限 4 MiB，默认渲染上限 32 KiB。无法读取或超限的文件被跳过，预览会显示原因范围。

`agnes/time-context` 通过保持系统缓存前缀的尾部注释提供配置时区中的当前时间、IANA 时区，以及上次 turn 结束后的间隔。首个 turn 没有间隔基准。时钟基准持久化以支持恢复；同一 turn 内默认每十分钟刷新，新 turn 重新采样。显示时区不会被当作浏览器时区授权，涉及用户本地时间时应澄清。

配置保存在安装目录 `$AGH_HOME/context.json`，默认 `~/.agh/context.json`。仓库文件不能配置外部 Skill 根。例如：

```json
{
  "rulesEnabled": true,
  "instructionFiles": ["AGENTS.md", "CLAUDE.md"],
  "localInstructionFiles": ["AGENTS.local.md", "CLAUDE.local.md"],
  "maxBytes": 32768,
  "maxSourceBytes": 1048576,
  "timeEnabled": true,
  "timeZone": "Asia/Shanghai",
  "refreshIntervalMs": 600000,
  "customSkillRoots": []
}
```

将 `rulesEnabled` 或 `timeEnabled` 设为 `false` 可关闭相应贡献；`refreshIntervalMs: 0` 表示每次请求采样。无效时区、相对根目录、含路径的候选文件名和超过支持上限的预算会被拒绝。自定义目录自动重新扫描，沿用 Skill 的信任、启停、遮蔽与修订规则。只配置您信任其中说明的目录。

`ask_user_question` 默认立即继续；`timeoutMs` 最多 60000 毫秒，可选择限时等待。等待期间显示问题卡片，取消会清理等待，晚答仍作为有效的普通用户输入送达。回答不授予工具执行权限。可在 Web、TUI 中使用 `/skill invoke NAME ARGUMENTS`，也可使用上下文调用表单。

扩展作者可以在 `context` hook 返回 `refreshOnRequest: true`，让该贡献者在每次模型请求前刷新；其他贡献者仍保留每轮快照。变化的时钟信息使用 `additionalContext` 尾部注释，仓库规则使用系统 section。

`getSurface()` 中的 `messageKind` 区分真实输入和自动生成的 `runtime_context` 注释；压缩计划选择用户问题时应跳过后者。

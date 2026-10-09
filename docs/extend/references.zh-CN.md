# Composer 引用解析器

[English](references.md) | 简体中文

引用是定位符（`{ source, id }`），不授予读取权限。后端在接纳普通消息、steer 或 follow-up 时重新读取来源，并再次检查权限。注入文本位于用户消息的 **UNTRUSTED** 数据围栏中；解析器无法指定消息角色或授予权限。Ledger 的文本块保存来源、标签、SHA-256 和截断标记。

在输入框中输入 `@` 打开引用选择器。`@file 查询` 对工作区文件路径进行模糊搜索；`@session 查询` 通过 history-index 搜索有权限读取的历史会话标题与内容。使用 ↑/↓ 选择、Enter 或 Tab 确认、Esc 关闭，也可点击候选项。每条消息最多包含 8 个引用。新草稿首次搜索时会创建会话以取得后端权限。发送后显示来源 chips，会话 chip 可打开原会话。

官方 `file` 与 `session` provider 通过公开 `reference-resolver` kind 注册。第三方插件通过 `@agnes/plugin-runtime` 的 `defineProvider('reference-resolver', provider)` 和 `ctx.providers.register` 添加来源，例如知识库。完整示例见[英文版](references.md)。公开 `ReferenceContext` 提供读取者身份、可撤销的文件端口、按权限过滤的会话端口、取消信号及限制。自定义来源须自行检查其后端读取权限；搜索结果不是权限凭据。

Host 的 `referenceLimits` 选项可配置 `maxBytes`、`maxSourceBytes` 和 `headFraction`。默认每个摘录最多 32 KiB UTF-8 字节，保留 75% 头部及 25% 尾部，并显示 `[TRUNCATED: middle omitted]`。文件完整读取和 hash 上限为 16 MiB，超限或二进制文件拒绝引用；忽略规则、沙箱和私有状态目录限制在发送时再次检查。会话摘录最多保留 24 条已索引的用户/助手消息，省略时显示标记。文件 hash 对应完整文件，会话 hash 对应读取时的标题与索引摘录快照。JSON 转义防止来源内容关闭 UNTRUSTED 围栏；这些数据不会获得指令权限。

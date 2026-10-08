# 会话工作台面板

[English](workbench-panels.md) | 简体中文

工作台面板是展示层贡献。通过 `@agnes/web-client` 导入共享的 `workbenchPanels` 单例，不要打包另一份实例。渲染前向宿主语言服务注册翻译。

```tsx
import { workbenchPanels } from '@agnes/web-client'
const dispose = workbenchPanels.register({
  id: 'example.notes', order: 40, edge: 'right',
  titleKey: 'example.notes.title', component: NotesPanel,
})
```

组件收到 `{ context, headerId? }`。可选 `headerId` 指向仅用于展示的停靠面板标题栏操作容器，面板可把图标按钮通过 portal 放入其中。`context` 提供翻译函数、可选会话/资源服务以及宿主专用 `data`。将身份绑定的注销函数纳入模块生命周期。ID 必须唯一，排序值必须有限。`edge` 可为 `right` 或 `bottom`。壳负责页签、键盘导航、折叠和尺寸记忆。所选注册被移除时回退到剩余的首个面板。使用 `@agnes/web-ui` 原语并提供完整的中英文文案。

注册面板不会授予文件、进程或目标权限。通过已认证宿主客户端的受支持会话 API 操作。内置文件面板使用 `Session.workspaceList(path?)` 和 `Session.workspaceRead(path)`，路径均相对工作区。目录懒加载并遵守 `.gitignore`/`.aghignore`（通配符、目录规则与否定规则）。预览只读，上限为 1 MiB，拒绝二进制文件、符号链接和安装目录。Git 状态标记按可用情况显示。引用只向输入框添加带引号的相对路径，不提交提示词。

原有 `workbench.panel` 插槽继续挂载在右侧面板中以保持兼容。新浏览器默认关闭停靠区。桌面宽度为 240–480 像素，小屏幕使用浮层。尺寸分隔条支持方向键，页签支持方向键及 Home/End，Escape 关闭面板。

worker 在会话 workspace invocation 内执行 list/read，使用与工具一致的文件策略。native 逐层打开规范路径，拒绝链接并保留同一个经过校验的 descriptor 完成有上限的读取；native 不可用时拒绝操作。POSIX 使用 `openat`；Windows 持有真实目录句柄阻止替换并拒绝 reparse point（仅本地盘路径）。list revision 描述可见目录列表；read revision 是返回字节的 SHA-256，超大文件明确标为 `weak:mtime:size`。`observedAt` 是服务端读取时间，不保证后续预览仍然最新。Git 超时或溢出返回 `gitStatus: unavailable`，不能显示为干净状态。

忽略匹配支持注释、`*`、`?`、`**`、目录规则和按顺序生效的否定规则；不支持转义、字符组、Git 全局排除或重新包含已隐藏的父目录。查看器也明确声明这一子集。

从 `@agnes/web-client` 注册 `fileViewerActions`，条目为 `{ id, order, component }`。组件收到 `{ context, path, revision }`，可进入独立注册的 diff/review 面板并链接实际 ledger 来源，不获得写入或恢复权限。需把 disposer 绑定到模块生命周期。

## 会话终端

通过 `Session.jobsRead(jobId?)` 列举会话任务或读取有上限的输出。`Session.jobsControl(input)` 支持 open、send、resize、signal、kill；副作用使用持久化 `commandId`（SDK 默认生成，重试可显式提供）。daemon 校验会话所有者，只授予固定 jobs 服务。后台记录包含 `owner`、`ownerSessionId`、`id`、`status`、退出码和截断标记。UI 仅控制 human 终端；agent 任务只能跟随或分离。中断发送 SIGINT，终止会结束进程；明确关闭运行中的 human 页签也会结束该进程。关闭 dock、卸载面板、切换会话或断开连接仅分离 UI。进程在明确终止或其 Host/会话关闭时结束，不跨 daemon 重启保留。

打开终端和输入经过当前会话工具策略，包括 read-only 与计划模式拒绝。已认证用户的明确操作提供人工批准，不能覆盖 preset 拒绝。打开操作使用与工具执行相同的会话 sandbox，不接受调用方选择 cwd，也没有 raw-spawn 回退。改变 sandbox 权限需要新建会话；Host 会拒绝改变现有 workspace sandbox 的 preset 切换。错误和状态来自后台；每个输出流上限为 64 Ki 个字符，溢出会明确提示。`@agnes/web-ui` 的 `terminalScreen` 与 `terminalKey` 复用设置页的纯文本 VT 渲染和键盘映射，终端字节不会变成 HTML。

## 实时目标面板

注册在右侧的目标面板读取实时 timeline 中现有的 `agnes/goal` 状态 slot，显示目标内容、阶段、自动续轮数、额度和本地化阻塞原因。记录 ID 与修订号放在折叠详情中。目标快照没有有序步骤列表；轮次表示自动续轮，不表示任务完成百分比。弹窗保留快捷创建、编辑和控制操作。两个界面均通过 composer 发送现有的人类 `/goal` 命令，注册本身不授予目标权限。暂停、恢复、完成和清除遵循后端状态转换。关闭或移除面板不会影响持久目标。

## 变更文件审阅

`Session.workspaceChanges({ scope?, path?, expectedRevision? })` 返回当前会话或最近一轮的只读审阅。内置面板列出文件、增删行数与逐文件 diff；引用仅插入带引号的路径，不发送提示词。文件查看器通过注册的审阅操作传递读取修订号，面板据此提示预览之后的变化。每次请求都经过当前工作区权限与绑定 descriptor 的 native 读取，包括已缓存的账本投影；仍拒绝符号链接与安装目录。

审阅采用本会话账本中已确认的 `write`/`edit` 工具副作用。tools-core 扩展在成功写入后追加版本为 1 的 `x/agnes/tools-core/file-change` 凭据，包含相对路径、哈希及有上限的前后文本。读取端核对扩展来源、所属会话、实际工具调用与结果坐标、成功结果和授权元数据。追加凭据失败不会撤销已完成写入；缺失证据会显示覆盖不足。旧账本及其他写入方式（包括 shell 和第三方工具）不会被补造 diff。新增扩展事件保持工具参数和结果文本兼容。

读取窗口上限为 500 条相关账本记录、100 次副作用、50 个文件和 750 KiB 响应。每侧快照最多 16 KiB UTF-8，单条凭据最多 60,000 字节 JSON；diff 最多 64 KiB 和 200,000 次行比较。二进制、超大或比较成本过高时显示不可用，不伪造行数。连续哈希链可合并会话或轮次变更；链路不连续或历史截断时仅归属最近一次已确认副作用，并明确标注。新鲜度比较记录的写后哈希与当前文件修订号；当前文件过大则显示新鲜度不可用。外部修改不会进入智能体的历史 diff。

可选 `context.openPanel(id, selection)` 导航到已注册面板，不授予后端权限。可选 `context.openRecord(sessionId, callSeq, resultSeq?)` 在既有执行视图中选中实际已加载的工具记录，并返回是否找到。跨会话导航会被拒绝；记录超出已加载历史时打开执行视图并提示加载更早记录，不生成虚构轨迹。两个钩子都不授予写入、恢复或进程控制权限。

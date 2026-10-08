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

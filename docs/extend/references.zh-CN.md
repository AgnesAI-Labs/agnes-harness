# Composer 引用解析器

[English](references.md) | 简体中文

引用是定位符（`{ source, id }`），不授予读取权限。后端在接纳普通消息、steer 或 follow-up 时重新读取来源，并再次检查权限。注入文本位于用户消息的 **UNTRUSTED** 数据围栏中；解析器无法指定消息角色或授予权限。Ledger 的文本块保存来源、标签、SHA-256 和截断标记。

在输入框中输入 `@` 打开引用选择器。空 `@` 会列出工作区根目录的直接文件和目录，并保留其他引用来源。`@file 查询` 对工作区文件路径进行模糊搜索；`@session 查询` 通过 history-index 搜索有权限读取的历史会话标题与内容。以 `/` 结尾的路径（如 `@src/`）仅列出该目录的直接子项；`@src/ma` 只过滤 `src/` 下的名称。路径中的反斜杠会作为分隔符，含空格的路径可写成 `@"my folder/`。浏览不会读取后代。Web 端用 Enter 或点击进入目录，Tab 可选择目录位置链接；使用 ↑/↓ 移动，Esc 关闭。每条消息最多包含 8 个内容引用。新草稿首次搜索时会创建会话以取得后端权限。发送后显示来源 chips，会话 chip 可打开原会话。

空 `@` 菜单默认使用“速览”，精简显示文件与会话分组；可在弹窗顶部切换到按来源筛选的“分类”或先选择来源的“导航”。速览中的“查看全部”可展开对应分组；分类中的“全部”也会显示其他插件来源。这些控件只改变当前候选项的展示，输入查询后的搜索与选择行为保持一致。

`Session.workspaceBrowse(path, { signal })` 复用严格检查的一层目录列举，并跳过 Git 状态读取。`Session.searchReferences(query, { signal })` 可取消单次在途搜索，不会取消会话或提示词。旧客户端仍使用原有搜索结果形状和 `workspaceList(path)` 行为。

普通插件通过公开 `reference-resolver` kind 注册解析器。`ReferenceContext` 提供可撤销的工作区文件端口、按权限过滤的会话端口、取消信号与部署限制；官方 file/session 解析器使用相同端口。自定义来源须自行检查后端数据权限，搜索结果只含定位符和显示标签，不授予权限。

```ts
import { referenceResolverKind, type ReferenceResolver } from '@agnes/extension-api'
import { definePlugin, defineProvider } from '@agnes/plugin-runtime'

const source = defineProvider('reference-resolver', {
  id: 'kb',
  version: '1.0.0',
  async search(query, context) {
    context.signal.throwIfAborted()
    return { items: [], truncated: false }
  },
  async resolve(id, context) {
    // 在后端检查已认证读取者的当前权限。
    // 返回数据、完整来源的 SHA-256 版本以及是否截断。
    throw new Error('Document unavailable')
  },
} satisfies ReferenceResolver)

export const references = definePlugin({
  apply(ctx) { ctx.providers.register(referenceResolverKind, source) },
})
```

Host 的 `referenceLimits` 选项可配置 `maxBytes`、`maxSourceBytes` 和 `headFraction`。默认每个摘录最多 32 KiB UTF-8 字节，保留 75% 头部及 25% 尾部，并显示 `[TRUNCATED: middle omitted]`。文件完整读取和 hash 上限为 16 MiB，超限或二进制文件拒绝引用；忽略规则、沙箱和私有状态目录限制在发送时再次检查。会话摘录最多保留 24 条已索引的用户/助手消息，省略时显示标记。文件 hash 对应完整文件，会话 hash 对应读取时的标题与索引摘录快照。JSON 转义防止来源内容关闭 UNTRUSTED 围栏；这些数据不会获得指令权限。

解析后的引用块独立落账为 `system/untrusted` 消息，人类文字保留 `principal/trusted` 来源。模型请求将引用封装为不可信内容，reviewer 的人类指令排除引用。虽然输入消息先于 `turn/start` 写入，接纳输入仍会在开始 turn 时初始化 taint。

## 已存附件合同

原件复用现有 `resource_link` 内容块，包含 `uri: artifact://<sha256>`、`name`、
`mimeType` 和 `attachment` 对象。`attachment.artifact` 是公开的 `ArtifactRef`
（`sha256`、`size`、`mime`），URI 与 MIME 必须完全一致。可选的
`image: {width, height}` 标识图片原件。`thumbnail` 是单独授权、单独校验的小型
PNG/JPEG `ArtifactRef`。`receiptId` 标识一次待确认上传，只在原 session 和 lane
内提供授权。仅知道摘要不代表有权读取。客户端保留这些块时无需读取原件字节。

可选的 `ArtifactsSeam.attachments` 能力通过选定的 persistence provider 管理字节与
各次独立上传的耐久回执。Core 接受当前 session/lane 可见的精确引用（包括 fork 的
可见前缀），或匹配的待确认回执，且仅在 inbox 提交后确认回执。失败或取消的接纳仅
丢弃自己创建的回执，不影响相同字节的其他上传。GC 必须计入 inbox、fork 前缀、原件、
缩略图、request media、派生结果及待确认回执；根快照不完整时禁止删除。

Provider 可实现可选的 `AttachmentStore.storeStream(scope, source, artifact, signal)`，
按背压消费分块，并在发布前核对完整 SHA-256 与大小。消费后分块可能被复用，不得保留其引用。
默认私有本地存储使用此路径；会话接收端写入私有临时文件，在完成、取消、过期或关闭时清理。
仅实现 `store` 的 provider 保留旧字节缓冲回退路径。两条路径均适用同样的回执作用域、配额和 GC 根规则。

`ToolContext.fs.create` 是可选的独占创建能力：拒绝已有条目和符号链接祖先，执行正常的
workspace 写授权，并返回实际写入的 `size` 与 `sha256`。禁止降级为覆盖式 `write`。
`read.save_to` 使用此能力复制会话原件。

附件失败通过稳定的 `AttachmentError.code` 表达；接纳路径在 `CoreError.detail.code`
中保留该原因。客户端按 code 本地化，不展示底层文件系统或解码器错误。

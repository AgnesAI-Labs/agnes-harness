# 插件用途元数据

[English](plugin-metadata.md) | 简体中文

[插件作者工具包](README.zh-CN.md) · [双语内容表](plugin-presentation/CONTENT.zh-CN.md) · [页面设计](plugin-presentation/DESIGN.zh-CN.md)

用 `@agnes/extension-api` 导出的公开 `PluginMetadata` 契约说明插件为用户解决什么问题。支持 `package.json.agnes.metadata` 和 `package.json.agnes.plugins[].metadata`。包级元数据介绍整个包；展示独立插件行时，行级的完整元数据优先于包级介绍。第三方插件也使用这一契约，整个块可省略。

```json
{
  "agnes": {
    "metadata": {
      "displayName": "Project file search",
      "summary": "Lets the agent find project files and search their contents.",
      "description": "Find files by name and search readable project text to locate the information needed for a task.",
      "category": "tools",
      "docsUrl": "https://example.org/docs/file-search",
      "locales": {
        "zh-CN": {
          "displayName": "项目文件搜索",
          "summary": "让 Agent 查找项目文件并检索文件内容。",
          "description": "按名称查找文件并检索可读项目文本，定位任务需要的信息。"
        }
      }
    }
  }
}
```

提供元数据时必须包含 `displayName`、`summary`、`description`、`category`。名称限制为 1–80 个 Unicode 码点，摘要 1–240，短段落 1–1,200，可选文档地址 1–2,048。文本必须去除首尾空白、可打印且为单行／单段，禁止控制字符和 Unicode 换行符。摘要用一句话说明解决的问题，描述可补充范围和前提。schema 使用按码点计数的有界正则与 UTF-16 上限，让生成的校验器正确接受上限以内的补充 Unicode 字符。

分类值为 `agent-loop`、`tools`、`safety-approval`、`memory-context`、`collaboration`、`integrations`、`observability`、`ui`、`developer`、`business-agent`。分类只是编辑分组，不改变运行时类型或权限。交付一个业务流程的组合包使用 `business-agent`，客户端把这类包列为业务 Agent。`docsUrl` 只能是无凭据、空白或控制字符的绝对 HTTPS 地址。`locales` 仅接受 `en` 和 `zh-CN`，可分别覆盖名称、摘要、描述和文档地址中的部分字段。所有对象拒绝未知字段，每个完整元数据块最多 24 KiB UTF-8 JSON。

安装检查不导入插件代码即可校验包级与行级元数据，扩展准入复用同一协议 schema。通过校验的包元数据随预览、目录、锁文件和不可变运行快照保存；版本变化沿用现有完整性、信任和固定版本规则。元数据不授予能力，不进入能力哈希，不改变加载、授权或启停语义。

另有两个可选字段说明包的呈现方式：

```json
{
  "category": "business-agent",
  "samplePrompt": {
    "en": "Review the sample supplier contract clause by clause.",
    "zh-CN": "逐条审查示例供应商合同。"
  },
  "experimental": true
}
```

`samplePrompt` 是一条可以原样发送、用来试用这个包的提示。`en` 必填，`zh-CN` 可选；客户端显示当前语言，没有时回退到 `en`。每个值是一段 1–600 个码点的文字，规则与摘要相同。`experimental: true` 表示这个包的行为仍可能变化，客户端把它和稳定的包分开列出；其他情况省略该字段。两个字段都只是展示数据，不影响加载与授权。

页面逐字段读取当前语言，没有翻译时使用基础值。完全缺失时显示完整 ID、已有类型、未分类和“作者未提供用途说明”。作者文案作为纯文本展示，文档链接由用户主动打开。官方／示例来源取自现有来源记录与目录，不依据作者文案或包名猜测。

“提供什么”和“在哪里出现”读取现有注册信息与库存。作者介绍或能力声明不能证明工具已注册。未加载或暂不可读的贡献不从 ID 推断。轻量展示投影的范围见已批准设计中的 Phase B 说明。

`PackagePresentation.presets` 概括每个组合包 preset 的策略保证了什么，客户端可以在安装前如实说明：

```json
{ "bundle": "acme/research#research", "id": "research", "toolPolicy": "default", "readOnly": "yes", "confirmBeforeActions": "no", "network": "none" }
```

所有字段都由后端从包数据推导，不运行插件代码，作者不能自己填写。组合包或 preset 设置了平台的 `toolPolicy.readOnly` 时 `readOnly` 为 `yes`（任何策略服务商下都成立）；没有设置且 preset 使用默认工具策略时为 `no`。默认工具策略下是否确认取决于会话的权限模式，preset 不作保证，所以 `confirmBeforeActions` 为 `no`。preset 选择了自己的 tool-policy 服务商时，两者都是 `unknown`，因为策略由代码决定；组合包继承了其他包的组合包时 `readOnly` 也是 `unknown`。`network` 读取包声明的能力：声明了能力且没有列出主机为 `none`，列出了主机为 `allowed`，完全没有声明为 `unknown`。客户端只应对 `yes` 和 `none` 作出承诺，其余情况列出声明的能力。 只读字段遵循运行时合并顺序：先预设，再按声明顺序应用会话组合包及其父组合包，每个父组合包只应用一次；显式的 `false` 会覆盖之前的 `true`。

预览、库存和目录 DTO 的可选只读 `PackagePresentation` 字段携带有界行 ID、作者 metadata、可选公开 extension source ID 与 configSchema 是否存在。库存／目录来源由后端推导。这些静态声明不是注册信息，不参与 target、能力哈希或启停。页面结合既有 runtime/provider 与 composition 工具目录、浏览器插槽、页面链接及已验证资源描述展示实际贡献。没有可读包归属的全局设置页、命令和事件不做归属推测；既有目录分页、生命周期 blockers 与 pins 保持原样。

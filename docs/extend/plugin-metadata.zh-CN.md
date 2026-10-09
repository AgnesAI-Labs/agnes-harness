# 插件用途元数据

[English](plugin-metadata.md) | 简体中文

[插件作者工具包](README.zh-CN.md) · [双语内容表](plugin-presentation/CONTENT.md) · [页面设计](plugin-presentation/DESIGN.zh-CN.md)

用 `@agnes/extension-api` 导出的公开 `PluginMetadata` 契约说明插件为用户解决什么问题。支持 `agnes.extension.json.metadata`、`package.json.agnes.metadata` 和 `package.json.agnes.plugins[].metadata`。包级元数据介绍整个包；展示独立插件行时，行级的完整元数据优先于包级介绍。第三方插件也使用这一契约，整个块可省略。

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

分类值为 `agent-loop`、`tools`、`safety-approval`、`memory-context`、`collaboration`、`integrations`、`observability`、`ui`、`developer`。分类只是编辑分组，不改变运行时类型或权限。`docsUrl` 只能是无凭据、空白或控制字符的绝对 HTTPS 地址。`locales` 仅接受 `en` 和 `zh-CN`，可分别覆盖名称、摘要、描述和文档地址中的部分字段。所有对象拒绝未知字段，每个完整元数据块最多 24 KiB UTF-8 JSON。

安装检查不导入插件代码即可校验包级与行级元数据，扩展准入复用同一协议 schema。通过校验的包元数据随预览、目录、锁文件和不可变运行快照保存；版本变化沿用现有完整性、信任和固定版本规则。元数据不授予能力，不进入能力哈希，不改变加载、授权或启停语义。

页面逐字段读取当前语言，没有翻译时使用基础值。完全缺失时显示完整 ID、已有类型、未分类和“作者未提供用途说明”。作者文案作为纯文本展示，文档链接由用户主动打开。官方／示例来源取自现有来源记录与目录，不依据作者文案或包名猜测。

“提供什么”和“在哪里出现”读取现有注册信息与库存。作者介绍或能力声明不能证明工具已注册。未加载或暂不可读的贡献不从 ID 推断。轻量展示投影的范围见已批准设计中的 Phase B 说明。

预览、库存和目录 DTO 的可选只读 `PackagePresentation` 字段携带有界行 ID、作者 metadata、可选公开 extension source ID 与 configSchema 是否存在。库存／目录来源由后端推导。这些静态声明不是注册信息，不参与 target、能力哈希或启停。页面结合既有 runtime/provider 与 composition 工具目录、浏览器插槽、页面链接及已验证资源描述展示实际贡献。没有可读包归属的全局设置页、命令和事件不做归属推测；既有目录分页、生命周期 blockers 与 pins 保持原样。

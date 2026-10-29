# 插件元数据与声明能力

[English](plugin-metadata.md) | 简体中文

插件在 `agnes.metadata` 中提供可选展示文字，用 `agnes.provides` 声明能力标签。标签只描述包，不授予权限；权限仍由插件行 capabilities 与 Host 准入决定。

```json
{
  "agnes": {
    "provides": ["tool", "ui"],
    "metadata": {
      "displayName": "Project search",
      "summary": "Find readable project text.",
      "description": "Search files available to the session.",
      "docsUrl": "https://example.org/docs",
      "locales": { "zh-CN": { "displayName": "项目搜索" } }
    }
  }
}
```

`provides` 是可选的不重复标签集合，可用值为 `tool`、`loop`、`model-adapter`、`mcp`、`skills`、`ui`、`bundle`、`service`。仅提供 Loop 的插件不必声明 Bundle 或智能体。这组展示标签与扩展的 `provides` seam 声明、插件行的 `provide` 服务名独立。旧 `metadata.category` 和 `agnes.kinds` 均拒绝，不设兼容层。

存在 metadata 时，`displayName`、`summary`、`description` 必填，分别不超过 80、240、1,200 个 Unicode 码点；文字须去首尾空格、可打印且为单行。可选 `docsUrl` 须为无凭据 HTTPS URL，最多 2,048 个码点。`locales.en`、`locales.zh-CN` 可逐字段覆盖，缺译文逐字段回落。整块元数据不超过 24 KiB UTF-8 JSON。可选 `samplePrompt` 必须提供英文回落，可提供中文，每种最多 600 码点；`experimental` 为布尔值。作者文字按纯文本显示，文档链接仅在主动点击后打开。

<a id="what-a-package-includes"></a>

插件行可提供自己的说明。来源标签依据已核验 provenance，不能由包名或作者标签声明。静态展示可统计显式声明的工具、Skill 文件、Bundle 和界面贡献，未提供数量表示未知。静态声明与运行后的登记是独立证据。

## 智能体就是带 launch 的 Bundle

```json
{
  "agnes": {
    "provides": ["bundle"],
    "bundles": {
      "review": {
        "presets": { "safe": { "name": "safe", "extends": "standard" } },
        "launch": {
          "title": { "en": "Review", "zh-CN": "审查" },
          "description": { "en": "Review a document.", "zh-CN": "审查文档。" },
          "preset": "safe",
          "prompt": { "text": { "en": "Review this document." }, "mode": "draft" }
        }
      },
      "reuse": { "extends": ["acme/reviewer#review"] }
    }
  }
}
```

智能体引用为 `package#bundle`。`launch.title`、`description`、`preset` 必填；本地化文字必含 `en`，可含 `zh-CN`。可选 `pages` 指向同包声明的 profile 页面。草稿 prompt 每种语言不超过 16 KiB，不能包含 secret 引用。**launch 不继承**：上面的 `reuse` 只是复用积木，不是智能体。子 Bundle 可以声明完整 launch 并选择继承的 preset。`extends` 是不重复的完整引用数组，不新增内联组合语法。

静态预检分 `structural`（结构合法）、`static-references`（静态引用可解）、`deployment-dependent`（待部署验证）、`refused`（拒绝），提供原因和下一步。它不执行插件代码，会检查完整 preset、继承、launch 引用和已知 runtime 限制。预检按 Bundle 父到子覆盖后的有效 preset 链检查继承；完全已知的循环拒绝，缺少继承定义或由部署提供的 launch preset 标为待部署验证。部署准入须校验该显式 preset 及允许列表，launch 不回退默认 preset。依赖定义与运行时导出仍可能需要部署验证；安装检查通过不等于就绪，挂载、绑定、新会话、恢复保留动态检查。普通 isolated 插件行目前在导入前拒绝。

所有包的 launch 声明均进入 `capabilityHash`，修改启动信息必须重新审阅信任。旧 `metadata.launches` 拒绝。`metadata.exampleOf` 作为经依赖版本校验的受限示例关系独立保留；可选 `pageEntry` 须有此关系且对应已声明的 profile 示例页。能力标签不能赋予普通智能体示例管理权限。

## 用同一个 Acme 示例理解装配

部署执行 Profile → 插件 → 智能体 → 应用展示，各自承担一项职责：

| 层 | Acme 中的对应内容 | 谁决定、何时生效 |
| --- | --- | --- |
| 部署执行 Profile | `AGNES_PROFILE=local-dev`：模型、权限上限、默认 Loop 与运行服务 | 部署者配置执行环境；应用采纳不修改它 |
| 插件 | `@acme/operations`：工具 `acme_status`、页面、`desk` Bundle 和应用声明 | 安装、审阅信任并启用后提供候选能力 |
| 智能体 | `@acme/operations#desk`：自身的 `launch.preset=acme`、工具范围和可编辑提示草稿 | 启动审阅绑定最终运行方式、模型、权限及来源；启动后会话保留其执行绑定 |
| 应用展示 | `acme-operations`：Acme 品牌、Ava 助手名、`@acme/operations#acme-overview` 页面、隐藏自动化入口和默认／可见智能体 | 管理员在设置 → 应用预览并显式采纳；只选择展示默认值 |

本期**不分发或采纳执行 Profile 模板**。应用不是执行模板；部署者继续独立配置 Profile，切换展示不会重配已有会话。完整安装、预览与启动命令见 [Acme 参考应用](../../examples/acme/README.zh-CN.md)。

## 应用声明

完整的身份、raster 资产、接管角色和显式采纳合同见[应用](applications.zh-CN.md)。安装只产生候选；展示选择在执行解析之外保存。

固定作者主干为 29 槽：包封套 9、插件行 14、客户端绑定 2、Bundle 4。相对原 27 槽：移除 `agnes.kinds`，增加 `agnes.provides`、`agnes.application`、`bundles.*.launch`。嵌套 metadata 与 launch 子字段不在该分母内。首个工具与首个 Loop 不增加必填步骤。

# Schema 驱动的配置界面

[English](configuration-ui.md) | 简体中文

[扩展指南](README.zh-CN.md) · [设置与会话 registry](../develop/ui-extension-registries.zh-CN.md)

通过 `@agnes/web-client` 的 `settingsSections` 注册设置区域，其组件可以使用 `@agnes/web-ui` 的 `SchemaConfigForm`。宿主统一导航、布局、主题和语言服务；注册 schema 不会创建后端端点或授予配置修改权限。

```tsx
import { SchemaConfigForm, type ConfigSchema } from '@agnes/web-ui'

const schema: ConfigSchema = {
  type: 'object', additionalProperties: false,
  required: ['credentialRef', 'limit'],
  properties: {
    credentialRef: {
      type: 'string', format: 'credential-reference',
      'x-ui': { labelKey: 'example.credential', hintKey: 'example.credentialHint' },
    },
    limit: {
      type: 'integer', minimum: 1, maximum: 10,
      'x-ui': { labelKey: 'example.limit' },
    },
  },
}

// 在已注册的组件内；草稿与有权限的服务适配器由调用方提供。
<SchemaConfigForm schema={schema} value={draft} onChange={setDraft} t={context.t}
  readOnly={!canConfigure}
  onSave={async (value, { signal }) => { await saveConfiguration(value, signal) }}
  onTest={async (value, { signal }) => { await testConfiguration(value, signal) }}
  testId="example-config" />
```

`saveConfiguration`、`testConfiguration`、`draft`、`setDraft` 和 `canConfigure` 均由调用方提供。绑定到插件已声明、已授权的后端服务，沿既有 client-module service/effect 通道执行；需要确认的修改继续使用 effect 通道。普通服务调用需要活动会话。不能从 schema 推断权限，或绕过安装、信任、确认、revision 与恢复规则。后台验证仍是权威，客户端校验只改善反馈。

将 `example.*` 键注册到宿主的中英文目录。标签、说明、占位符和枚举选项声明 i18n key，不直接写译文；字段缺少翻译时拒绝操作，不显示原始 key。枚举的 `x-ui.optionKeys` 将值映射到标题 key。迁移既有页面时用 `x-ui.id` / `x-ui.testId` 保留选择器；否则 ID 从表单 test ID 和属性名生成。

## 声明并注册配置页面

`createSchemaSettingsComponent` 将 schema、读取、保存、测试和权限声明转换为现有设置 registry 的组件；无需再建导航或手写表单。适配器由插件提供，通过已声明的服务或 effect 调用执行。读取返回 `{ values, revision? }`；保存接收同一修订号并返回权威的新文档，后端继续负责冲突和权限判断。

```tsx
import { settingsSections } from '@agnes/web-client'
import { createSchemaSettingsComponent } from '@agnes/web-ui'

const component = createSchemaSettingsComponent({
  schema, testId: 'example-config',
  scope: context => resourceIdentity(context),
  canConfigure: context => hasWritePermission(context),
  load: (context, signal) => readConfiguration(context, signal),
  save: (document, context, signal) => saveConfiguration(document, context, signal),
  test: (document, context, signal) => testConfiguration(document, context, signal),
})
const unregister = settingsSections.register({
  group: 'plugins', groupTitleKey: 'example.group', id: 'example-config', titleKey: 'example.settings',
  icon: 'settings', order: 50, component,
})
```

示例中的服务适配器、权限检查和资源身份由插件实现。`scope` 是不含凭据的稳定资源标识：切换资源会取消旧操作，切换语言保留草稿并翻译字段。卸载调用 `unregister()`。读取失败提供重试；未知字段、缺失翻译和不支持的 schema 阻止提交。此声明不增加权限，也不将后台消息或凭据值写入错误提示。

## Schema 与组件合同

| API | 合同 |
| --- | --- |
| `ConfigSchema` | JSON / TypeBox JSON 子集：封闭对象、嵌套对象、必填项、字符串、布尔、有限数字/整数、enum 或 literal anyOf、字符串数组、范围/长度/条数、pattern 和去重 |
| `SchemaConfigForm` | 受控草稿；保存/测试前验证；本地化字段错误；禁用/加载；安全操作失败提示；保留修改；卸载时提供 abort signal。不会自动请求、持久化、解析凭据或套用默认值 |
| `SchemaConfigFields` | 同样的字段，不增加 form 和操作按钮，适配既有页面 handler |
| `SchemaControl` | 单个共享原生控件，保留原页面 Field / checkbox 包装 |
| `configIssues` / `configSchemaSupported` | 纯验证；错误只有路径和代码，不包含输入值或后端原始消息 |
| `ProviderConfigForm` / `providerConfigSchemas` | 沙箱、上下文压缩约束来自生成的 preset schema；持久化选择来自生成的 profile schema。调用方提供权威值与有权限的 handler；没有 handler 时只读 |

不支持的 keyword/union、开放对象、无效 pattern、循环、过深/过大声明和危险属性名会被拒绝。这不是完整 JSON Schema renderer：先解析可支持的属性 schema，再传入；不接受 `$ref`、任意 union、transform 或自由键映射。TypeBox symbol 不属于 JSON 声明。渲染期间保持声明对象稳定。`default` 仅为注释，调用方初始化草稿。

凭据字段只接受协议规定的 `secret://namespace/name` 引用。不要将明文凭据放进配置默认值、初始值、保存数据或测试日志。创建/替换凭据走专用的只写凭据存储 API；原搜索密钥入口继续独立使用该通道。MCP 保留 managed form、transport 特有检查、凭据引用验证和已审核创建流程。

运行时插件目录刻意只含描述与身份，不包含当前私有配置。此 API 不会虚构沙箱/持久化/压缩的当前值，也不增加任意配置写入器；插件注册的设置面板提供自己支持的管理适配器。


## 配置任意已安装插件

打开**设置 → 插件**，选择已安装包，再进入**配置**页签。一个包声明多个 export 时可切换插件条目。安装、信任与配置保存仍是独立操作；保存尚未启用的条目只存储配置，不启用其代码。

`agnes.plugins` 中的每个 manifest 条目可以声明 `@agnes/extension-api` 的公开 `PluginConfigContract`：

```json
{
  "export": "businessAgent",
  "id": "ext:acme/support",
  "apiRange": "^1.4.0",
  "configReload": "next-session",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["credential", "queues"],
    "properties": {
      "credential": { "type": "string", "format": "credential-reference" },
      "queues": { "type": "array", "items": { "type": "string" }, "default": [] },
      "region": { "enum": ["global", "cn"], "default": "global" }
    }
  }
}
```

Schema 使用同步 JSON Schema 2020-12、标准 format 和本地引用。安装/更新会编译 schema，拒绝非法声明、不符合 schema 的显式 `config`、非法默认值、远程引用、异步验证器及未注册的 format/keyword。`x-*` 作为注释。默认值由管理员明确选择，服务端不会自动补值或修改输入。省略 `configSchema` 等同 `true`，使用 JSON 编辑器；省略 `configReload` 使用公开的 `DEFAULT_PLUGIN_CONFIG_RELOAD`（`next-session`）。

表单支持对象、数组、枚举、`oneOf`/`anyOf` 方案选择、本地嵌套/递归引用、additionalProperties 键值编辑、说明与 format。引用展开在六层后停止。组合断言、元组、未知 UI 注释及无法忠实展示的结构，在对应子树使用 JSON 编辑器。未知键及未选方案的值保留在草稿里，不会被编辑操作过滤掉。完整验证器继续执行 `allOf`、条件、patternProperties、元组等 JSON Schema 断言。错误只返回 JSON Pointer 字段路径与代码，不回显输入值。

每个密钥字段须标注 `format: "credential-reference"`、`x-secret: true` 或 `writeOnly: true`。这些字段在方案、引用、自由键映射中也只接受 `secret://namespace/name` 引用。界面仅编辑引用；创建/替换实际凭据走凭据存储的独立只写 API。JSON 回退编辑仍受同样限制。审计隐藏引用与凭据形状的键值。插件通过授权的 secret 能力解析引用，不应期待配置已被替换为明文。

行内校验与保存都由服务端共享的 `compilePluginConfig` 验证器执行。`_agnes/v1/plugins.config.get` 返回 `{ revision, entries, audit }`；`.validate` 接收 `{ profile, id, rowId, value }`，返回 `{ issues }`；`.save` 另需 `expectedRevision`、`clientId`、`commandId`。读取/验证需要 `packages.read`，保存需要 `packages.activate` 与服务端确定的 client 身份。SDK 入口为 `client.packages.config.get/validate/save`；本地 Web 中继为 `/admin/plugins/api/config/get`、`/validate`、`/save`。

保存返回 `{ ok, revision, reason, issues, reload, refusalReason? }`，`reason` 为 `saved`、`invalid`、`conflict`、`refused` 或 `pending`；只有 `saved` 返回 `ok: true`。实时保存最多等待十秒返回响应。`pending` 表示应用仍在进行或结果未知，不能当作保存成功；界面保留草稿，提示重新读取当前配置。晚到的成功确认仍可提交，晚到的拒绝保留原 revision 与历史。保存操作在确认或 Worker 退出前保持串行。

旧 revision 不会覆盖新配置；界面保留草稿并提供重新读取。Schema 校验、工件探测或实时 Worker apply 拒绝都不修改原 desired revision、配置值与审计历史。apply 拒绝可返回限制长度的插件原因，配置字符串、密钥引用和凭据文本经过脱敏。实时保存只在授权业务 Worker 确认应用成功后，将新 desired、配置值与审计事实（操作者、时间、row、revision、脱敏前后差异）在同一事务提交。canonical-artifact probe 只校验工件，不打开业务运行时；应用结果复用现有 Worker convergence/failure 帧。保存的覆盖值在禁用后再启用时保留，并针对更新后的 manifest 重新校验，不兼容时拒绝发布，不静默重置。

`live` 在运行准入边界应用于使用同一固定代码身份的已有会话，应用被拒绝时补偿已修改容器。`next-session` 保留已有会话的配置，后续会话使用新值。页签明确说明声明的模式。配置不会替换固定代码或放宽须重启的后端边界。官方 observability 插件与[第三方示例](../../examples/third-party-plugin/package.json) 提供 manifest schema 示例。

`next-session` 的保存顺序保持不变：已有会话按合同继续使用原配置，不会应用这次保存，因此不以它们的实时确认为保存条件。禁用或未挂载条目也直接保存覆盖值，不打开插件代码。

## Guard 与验收

`tools/guards/src/frontend-ui.test.ts` 检查 JSX/HTML 显示文字、可访问性属性、presentation props、DOM 文本写入和原生确认；有 locale 绑定的静态 HTML fallback 允许保留。它也禁止 `packages/web/src` 内布局 inline styles，以及 registry 之外直接渲染内置设置页。`ui-layer.test.ts` 将 antd、私有入口和 assistant-ui 限定在 web-ui。源码检查配合 key parity 和主屏幕未解析 key 测试；运行时/插件提供的数据不当作应用固定文案。

迁移表单保留控件、DOM/test ID 和 locale 目录；验证实际保存 payload、失败与只读路径。将中英、明暗、1440×900 / 1280×800 与已验收 UI 对照，不无理由修改其他任务的视觉基线。

适配器可抛出公开 App Server 错误 envelope（包括携带 `data.messageKey` 的 SDK 错误）。共享表单通过 `appServerErrorMessage` 提供安全、随语言切换的反馈；未知错误使用通用翻译并保留草稿。HTTP 适配器传递响应的 `error` 对象，不显示原始异常文案。

插件配置验证器实现在 `@agnes/protocol`；`@agnes/extension-api` 仅保留公开声明、默认值和薄导出。官方 observability 插件的 header 配置继续使用现有 `env:NAME` 密钥引用合同（不存明文 header），schema 同时声明这些引用及遥测选项。

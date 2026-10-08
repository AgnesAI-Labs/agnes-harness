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

## Guard 与验收

`tools/guards/src/frontend-ui.test.ts` 检查 JSX/HTML 显示文字、可访问性属性、presentation props、DOM 文本写入和原生确认；有 locale 绑定的静态 HTML fallback 允许保留。它也禁止 `packages/web/src` 内布局 inline styles，以及 registry 之外直接渲染内置设置页。`ui-layer.test.ts` 将 antd、私有入口和 assistant-ui 限定在 web-ui。源码检查配合 key parity 和主屏幕未解析 key 测试；运行时/插件提供的数据不当作应用固定文案。

迁移表单保留控件、DOM/test ID 和 locale 目录；验证实际保存 payload、失败与只读路径。将中英、明暗、1440×900 / 1280×800 与已验收 UI 对照，不无理由修改其他任务的视觉基线。

适配器可抛出公开 App Server 错误 envelope（包括携带 `data.messageKey` 的 SDK 错误）。共享表单通过 `appServerErrorMessage` 提供安全、随语言切换的反馈；未知错误使用通用翻译并保留草稿。HTTP 适配器传递响应的 `error` 对象，不显示原始异常文案。

# 运行时能力提供方（seam）

[English](seams.md) | 简体中文

[作者套件](README.zh-CN.md) · [压缩引擎](compaction-engines.zh-CN.md) · [插件边界](../develop/plugins.zh-CN.md)

seam 是内核以单个类型化对象消费的必要运行时能力：审批投递、身份、计费、检查点、产物、验证器和修复策略。每一个都是普通的 provider 种类，提供方式只有一种，选择方式也只有一种。

| 种类 | 合同 | 按会话固定 |
| --- | --- | --- |
| `approval` | `ApprovalSeam` | 是 |
| `principals` | `PrincipalsSeam` | 是 |
| `billing` | `BillingSeam` | 是 |
| `checkpoint` | `CheckpointSeam` | 是 |
| `artifacts` | `ArtifactsSeam` | 是 |
| `verifier` | `VerifierSeam` | 否 |
| `repair` | `RepairSeam` | 否 |

合同在 `@agnes/extension-api/seams`。`sandbox` 是已有的[沙箱 provider](../develop/architecture-plugins.zh-CN.md)种类，`platform` 归宿主所有。

## 注册实现

在注入 `providers` 的普通 Cordis 插件里注册，与其它 provider 完全一样：

```ts
import type { ProviderPluginContext } from '@agnes/extension-api'
import type { CheckpointProvider } from '@agnes/extension-api/seams'

const checkpoint: CheckpointProvider = {
  id: 'object-store',
  version: '1.0.0',
  async create(init, signal) {
    return { snapshot, rewind, list }
  },
}

export const main = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(checkpointKind, '@example/checkpoint', checkpoint)
  },
}
```

在 `package.json` 的 `agnes.plugins` 中声明 `main` 及其 `providers` 注入。包只能以自己的包名注册。宿主把绑定行排在所有注册行之后，所以 provider 总是先注册、后被选择。

`create(init, signal)` 收到 `SeamInit`：`secrets`、`adapters` 视图、含当前 preset 的 `profile` 视图、`log` 和 `signal`。内置包可能拿到更宽的视图，你的实现不会。返回对象可带 `close()`，容器卸载时由宿主调用。宿主用计时器（`seamTimeoutMs`，默认 30 秒）与 `create` 竞速，不依赖你理会 `signal`；超时之后才返回的实例会立即被关闭。

按会话固定的种类必须可重入：容器被空闲回收后 `create` 会再次运行，并且要找回同一份持久状态（账目累计、检查点、已存产物），不能假设进程内状态延续。`principals.resolve` 发生在知道会话之前，始终使用当前实现；`authorize` 使用该会话固定的实现。

## 选择实现

配置里每个种类只有一种写法：

```yaml
seams:
  approval:   { provider: local-prompt }
  principals: { provider: local }
  billing:    { provider: budget }
  checkpoint: { provider: object-store, version: 1.0.0 }
  artifacts:  { provider: local }
  verifier:   { provider: t0 }
  repair:     { provider: default }
```

七个键都必填。选中的实现没有任何已安装的包注册时，装配以 `E_SEAM_MISSING` 失败；工厂抛错或卡死则以 `E_SEAM_INIT` 失败。seam 不会被静默跳过或补默认值。旧的包 id 字符串写法、`seams.ledger`（现为 `seams.billing`）和 `seams.harness`（不再是 seam）都是配置错误，报错会给出改法。工作区配置不能写 `seams`。

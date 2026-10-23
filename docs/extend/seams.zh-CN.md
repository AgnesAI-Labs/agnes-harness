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

Checkpoint 的 `snapshot` 接收可选的会话标识 `owner`，包装层必须保留它，以保证按会话保留快照。经校验的 `list` 行可附带 `owner` 及该检查点恢复的完整规范化路径集合 `paths`。会话撤销除核对轮次外，还要求 owner 匹配，且只包含与收据一致的一条工作区相对路径。缺少元数据、工作区外路径或更大的恢复集合都会在修改文件前拒绝撤销；既有检查点存储格式不变。

## 注册实现

在注入 `providers` 的普通 Cordis 插件里注册，与其它 provider 完全一样：

```ts
import { checkpointKind, type ProviderPluginContext } from '@agnes/extension-api'
import type { CheckpointProvider } from '@agnes/extension-api/seams'

const checkpoint: CheckpointProvider = {
  id: 'object-store',
  version: '1.0.0',
  async create(init, signal) {
    return { snapshot, rewind, list }
  },
}

export const main = {
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(checkpointKind, checkpoint)
  },
}
```

在 `package.json` 的 `agnes.plugins` 中声明 `main` 及其 `providers` 注入。包只能以自己的包名注册。宿主把绑定行排在所有注册行之后，所以 provider 总是先注册、后被选择。

`create(init, signal)` 收到 `SeamInit`：`secrets`、`adapters` 视图、含当前 preset 的 `profile` 视图、`log` 和 `signal`。内置包可能拿到更宽的视图，你的实现不会。返回对象可带 `close()`，容器卸载时由宿主调用。宿主用计时器（`seamTimeoutMs`，默认 30 秒）与 `create` 竞速，不依赖你理会 `signal`；超时之后才返回的实例会立即被关闭。

按会话固定的种类必须可重入：容器被空闲回收后 `create` 会再次运行，并且要找回同一份持久状态（账目累计、检查点、已存产物），不能假设进程内状态延续。`principals.resolve` 发生在知道会话之前，始终使用当前实现；`authorize` 使用该会话固定的实现。

## 选择实现

配置里每个种类只有一种写法：

```yaml
providers:
  approval:   { provider: local-prompt }
  principals: { provider: local }
  billing:    { provider: budget }
  checkpoint: { provider: object-store, version: 1.0.0 }
  artifacts:  { provider: local }
  verifier:   { provider: t0 }
  repair:     { provider: default }
```

七个键都必填。选中的实现没有任何已安装的包注册时，装配以 `E_SEAM_MISSING` 失败；工厂抛错或卡死则以 `E_SEAM_INIT` 失败。seam 不会被静默跳过或补默认值。这七个种类和其他 provider 种类共用 `providers` 这一张表。旧的包 id 字符串写法、`seams` 键（现为 `providers`）、`ledger`（现为 `billing`）和 `harness`（不再是种类）都是配置错误，报错会给出改法。工作区配置不能写 `providers`。

## 固定、升级与恢复

`approval`、`principals`、`billing`、`checkpoint`、`artifacts` 按会话固定。会话记录它首次绑定的 provider id、版本、来源包和包完整性摘要（固定记录，带格式版本号），它所在的代次记录构建时用的选择。因此修改 `seams.*` 或升级 provider 包只影响新会话；已有会话即使重启后也按当初绑定的实现恢复。`verifier` 和 `repair` 跟随代次。

无法继续的会话会按三个方向之一被拒绝，各有独立错误码，并给出会话 id 和原始账本所在位置：

| 错误码 | 含义 | 你可以 |
| --- | --- | --- |
| `E_SESSION_VERSION_NEWER` | 由更新版本的 AGH 写入 | 升级 AGH |
| `E_SESSION_VERSION_OLDER` | 由旧版本 AGH 创建，或固定的 provider、版本或快照已不可用（`E_SEAM_PIN_MISMATCH`、`E_GENERATION_INCOMPATIBLE` 等） | 新开一个会话；管理员可把它切换到当前版本 |
| `E_SESSION_CORRUPT` | 完整性检查失败 | 新开一个会话；保留原始账本 |

拒绝不会改动账本和固定记录。把会话切换到当前版本是明确且会被审计的操作：`agh sessions migrate <key> <kind> ...`（或管理端调用里的 `repin: ["approval"]`）列出要替换的固定种类；不列出时，会替换固定实现的迁移会以 `E_SEAM_PIN_CHANGE` 失败并列出差异。

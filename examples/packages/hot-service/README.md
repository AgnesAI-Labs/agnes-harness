# hot-service（热更新示例，新插件机制）

一个最小的 Cordis 插件，用来演示插件的完整生命周期。三个目录是**同一个包**的三个版本：

| 目录 | 版本 | 行为 |
|---|---|---|
| `v1` | 1.0.0 | 提供服务 `demoTextStats`，`stats(text)` 返回字符数与词数 |
| `v2` | 1.1.0 | 同一个服务，`engine` 变为 `v2`，`stats` 多返回行数 |
| `broken` | 1.2.0 | 提供服务后立即抛错，用来验证半挂载的插件会被完整回滚 |

## 写法

`package.json` 用 `agnes.plugins` 声明入口（不再使用 `agnes.extensions`）：

```json
"agnes": { "plugins": [{ "export": "hotService", "config": { "label": "demo" } }] }
```

`index.mjs` 导出一个普通的 Cordis 对象插件：`Config`（Standard Schema）、`provide`、`apply(ctx, config)`。
**没有任何 import**，所以安装后的快照不需要解析依赖。其它插件可以 `inject: ['demoTextStats']` 使用它。

## 演示流

1. 从 `file:./examples/packages/hot-service/v1` 安装、确认信任、启用。
2. 修改配置里的 `label`：插件按新配置重新应用，服务随之更新。
3. 更新到 `v2`：服务被替换，`engine` 变为 `v2`。
4. 更新到 `broken`：应用失败，插件不留半挂载状态，服务消失。

## 验证

- `packages/plugin-runtime/test/example-hot-service.test.ts`：四条行为用例（挂载 / 配置更新 / v1→v2 / broken 回滚）。
- `packages/package-manager/test/example-hot-service-manifest.test.ts`：三份清单都走 `agnes.plugins`，且没有 `agnes.extensions`。

**真机验证**：在真实 daemon 上，v1、v2 安装、信任后都是 `running`；broken 是 `failed`，失败原因就是插件抛出的错误。**热更新（原地 v1→v2、broken 回滚）没有验证**：CLI 没有原地更新入口。

**写法提醒**：`package.json` 的 `provide` 必须与导出里的 `provide` 一致——daemon 按清单建行，worker 挂载时再与导出核对，不一致会被拒绝（`E_ROW_METADATA`）。测试里有一条专门检查两边一致。

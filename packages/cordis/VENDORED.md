# VENDORED — @agnes/cordis

Cordis 核心（Context / fiber / reflect / registry / events / Service），前端页面内插件与后端统一插件树共用同一份。**本包改动受棘轮与 `deps.test.ts` 层级约束；每次修改必须同步更新本文件。**

## 来源

| 项 | 值 |
|---|---|
| Agnes 取用版本 | npm `@deepseek-ai/cordis@4.0.2`（2026-09-17 取用） |
| 该包构建来源 | `deepseek-ai/deepseek-harness` 仓库 `vendor/cordis` 目录（package.json `repository.directory`），生产浏览器端在用的版本 |
| 上游 lineage | cordiverse/cordis `cordis 4.0.0-rc` 系列（MIT，Shigma）；源仓库快照基于 rc.7（上游 commit `56b3d4f7`，见设计稿 WC4）。4.0.2 对应的精确上游 cordis commit 仍未核对（无上游克隆），属已知边界 |
| 与源仓库的核对 | **2026-09-18 已核对**：本包 `src/` 与参照克隆的 `vendor/cordis/src`（其 package.json 自述 4.0.1）在归一化下文两条机械改写后**逐字一致**——即 npm 4.0.2 与该快照在 `src` 上无差异，「逻辑零改动」得到外部对照证实 |
| 许可证 | MIT，见本目录 `LICENSE` |
| 为什么不用 npm `cordis` | 设计稿 WC4/A4：源版本包含已在生产浏览器端验证过的 fiber 重入卸载修补；A4 探针（2026-09-17，Node 8/8 + 真实浏览器 9/9）验证级联/异步 dispose/重入卸载行为全部符合 G4/G5 需要 |

## 源版本的本地修改清单

**已核实的修补点**：`src/fiber.ts` 重入卸载修补——`disposing` 标记 + `disposalTask` 去重（约 :425-429）、「reentrant parent unload」相关 effect 可见性处理（约 :312、`:517`）。A4 探针 P6 用例（dispose 进行中重入 dispose，父子都清理、不炸不挂）在 Node 与浏览器均通过。

源仓库相对**上游 cordis** 的完整修改清单仍未逐行列出：那需要上游 rc.7 源码，本机无上游克隆。已经关闭的是另一个问题——本包与源仓库那份是否同一份代码（见上表「与源仓库的核对」）。

## Agnes 自身修改（相对 @deepseek-ai/cordis@4.0.2 源码）

1. 相对导入扩展名 `.ts` → `.js`（仓库 tsconfig `module: NodeNext` 惯例）。**例外**：五处 `declare module './context.ts'` 的模块增补说明符保持 `.ts` 原样（TS 解析到同一文件，`tsc -b` 通过）——这是全包仅剩的 `.ts` 说明符，升级时照此处理。
2. 包名 `@deepseek-ai/cosmokit` → `@agnes/cosmokit`。
3. 新增本 `package.json`（root export 指向 `./src/index.ts` TS 源，Host-only export 见下一项）、`tsconfig.json`；`@standard-schema/spec` 按设计稿精确锁 `1.1.0`。tsconfig 在仓库 base 之上放宽 5 项（源仓库构建配置即如此，非源码改动）：`exactOptionalPropertyTypes/noUncheckedIndexedAccess/noImplicitAny/noImplicitThis/noImplicitOverride = false`；cosmokit 同理放宽前两项。
4. C1 verified installation 增加 Host-only `@agnes/cordis/host` 子路径：opaque prepared invocation 在独立 registry owner 中保存 callback/schema/规范化 inject，避免 Host 已规范化配置后再次读取作者 metadata 或重复执行 schema；公开 `ctx.plugin()` 及 root exports 保持原合同。
5. Fiber 增加未发布 mounting 窗口和 batch publication：attestation 先于 runtime/parent attach 与首个生命周期事件，pending provide 在 publish 时同步提交，失败可逆序清理 effect/store/runtime owner；prepared owner 的最后一个 fiber 释放时不触碰公开 callback registry。
6. `ReflectService.provide()` 增加写 effect/store 前的同步 `internal/provide` waterfall，并让 dependency refresh 同时覆盖私有 prepared runtime。
7. 五类事件 dispatch 在分派前统一报告 source Context、显式 listener `this` 与模块私有 system provenance；Cordis 生命周期经不可枚举/不可反射伪造的私有 dispatcher 标记，公开 `ctx.*` / `ctx.events.*` / 提取调用始终按非 system 路径处理。

## 生命周期

- 后续升级：取新版 npm 包源码，重做上述机械改写，diff 审查后更新本文件与棘轮值；跑 A4 同组级联用例回归。
- 同法复核（有研究用克隆时）：把源仓库的 `vendor/cordis/src` 拷一份，按机械改写第 1、2 条归一化后与本包 `src/` 逐字 diff；差异应只剩上面记的 `declare module` 例外。
- vendor 包内任何源码修改（含为通过仓库 strict 选项的改动）必须登记到「Agnes 自身修改」。
- 对应后端设计条款：`2026-09-17-agnes-on-cordis-design.md` SG2；前端：`2026-09-17-web-client-modules-design.md` WC4。

# VENDORED — @agnes/cosmokit

上游工具库 vendor，供 `@agnes/cordis` 与前端插件底座使用。**本包改动受棘轮与 `deps.test.ts` 层级约束；每次修改必须同步更新本文件。**

## 来源

| 项 | 值 |
|---|---|
| Agnes 取用版本 | npm `@deepseek-ai/cosmokit@1.8.3`（2026-09-17 取用） |
| 该包构建来源 | `deepseek-ai/deepseek-harness` 仓库 `vendor/cosmokit` 目录（package.json `repository.directory`） |
| 上游 lineage | cordiverse `cosmokit`（MIT，Shigma）；源仓库快照对应上游约 1.8.x，精确上游 commit 仍未核对（无上游克隆），属已知边界 |
| 与源仓库的核对 | **2026-09-18 已核对**：本包 `src/` 与参照克隆的 `vendor/cosmokit/src`（其 package.json 自述 1.8.2）在归一化下文两条机械改写后**逐字一致**，即 npm 1.8.3 与该快照在 `src` 上无差异 |
| 许可证 | MIT，见本目录 `LICENSE`（保留上游版权行） |

## 源版本的本地修改清单

源仓库相对**上游 cosmokit** 的修改清单仍未逐行列出（无上游克隆），以 npm 发布版字节为准整体取用；与源仓库那份是否同一份代码见上表「与源仓库的核对」。

## Agnes 自身修改（相对 @deepseek-ai/cosmokit@1.8.3 源码）

1. 相对导入扩展名 `.ts` → `.js`（仓库 tsconfig `module: NodeNext` 惯例）。
2. 包名 `@deepseek-ai/cosmokit` → `@agnes/cosmokit`。
3. 新增本 `package.json`（exports 指向 `./src/index.ts` TS 源）与 `tsconfig.json`。
4. 逻辑零改动。

## 生命周期

- 后续升级：取新版 npm 包源码，重做上述机械改写，diff 审查后更新本文件与棘轮值。
- 同法复核（有研究用克隆时）：把 `repos/deepseek-harness` 的 `vendor/cosmokit/src` 拷一份，按机械改写第 1、2 条归一化后与本包 `src/` 逐字 diff；应无差异。
- 对应后端设计条款：`2026-09-17-agnes-on-cordis-design.md` SG2；前端：`2026-09-17-web-client-modules-design.md` WC4。

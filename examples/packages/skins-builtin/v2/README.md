# Built-in skins

设计 §14 冻结的四套内置预设皮肤（`high-contrast` / `midnight` / `paper` / `aurora`），
走的是与第三方皮肤**完全相同**的契约：`capabilities.ui: ["skin"]` + `contributes.skins`。

- 三套零资产（`high-contrast` 纯 token、`midnight` 纯 CSS 渐变、`paper` CSS 纹理），
  因此它们只需要清单内联的样式表即可工作，不依赖资产通路。
- `aurora` 是唯一带真实背景图的预设，专门作为**资产通路的端到端样本**；
  图由脚本程序化生成，不引第三方素材。
- 每份皮肤都同时给出浅深两套。

这个扩展随 `@agnes/base` 默认装配，所以开箱即可在「设置 → 通用 → 外观 → 皮肤」里选择。

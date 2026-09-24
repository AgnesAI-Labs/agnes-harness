# skin-example v1

一份可安装的示例皮肤：样式表用 `data-agnes-region` 钩子改界面，并带一张自带资产。

- 皮肤写在 `extensions/main/agnes.client.json` 的 `skins` 里，且必须非空；皮肤能力由校验器按描述符推导，不用手写 `capabilities.ui`。
- CSS 里 `url('assets/paper.png')` 是**相对样式表**的包内路径,由宿主的同源路由提供。
- 只用 `data-agnes-region` 钩子,不依赖内部 class；作者指南见
  [`docs/develop/skins.md`](../../../../docs/develop/skins.md)。

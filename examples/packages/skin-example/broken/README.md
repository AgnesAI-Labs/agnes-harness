# skin-example broken

故意坏掉的变体：`contributes.skins` 存在但 `capabilities.ui` 不为 true。
安装预览阶段就会被 `checkManifest` 拒绝——它应当**装不进来**,而不是装进来之后没有效果。

/**
 * 平台共享单例表（WC5）：插件构建必须把以下说明符标 external，由宿主 import map 提供唯一实例。
 * `@agnes/web` 的官方构建链以本表为准做依赖图检查（共享平台模块不得内联进插件 chunk，M10）。
 */
export const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@agnes/cordis',
  '@agnes/web-client',
] as const

export type ExternalSpecifier = (typeof externals)[number]

/** 插件构建器合同版本；资源清单与构建声明携带（WC1/WC5 安装检查用）。 */
export const BUILDER_VERSION = 1

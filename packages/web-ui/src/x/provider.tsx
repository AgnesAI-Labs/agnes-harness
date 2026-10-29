import { XProvider as AntXProvider } from '@ant-design/x'
import xEnUS from '@ant-design/x/locale/en_US.js'
import xZhCN from '@ant-design/x/locale/zh_CN.js'
import { ConfigProvider } from 'antd'
import { type ReactNode, useContext, useMemo } from 'react'

/**
 * Ant Design X ships no prebuilt stylesheet, so its subtree leaves the application's zeroRuntime
 * mode. The key stays `agnes-theme`: generated variables land on the same class the theme bridge
 * in tokens.css remaps to `--agnes-*`, and the nonce, popup container and overlay layers are
 * inherited from the application provider.
 */
const X_THEME = { zeroRuntime: false, hashed: false, cssVar: { key: 'agnes-theme' } } as const

export type XProviderProps = { children?: ReactNode }

/** Required ancestor of every Ant Design X component; mount it once per conversation surface. */
export function XProvider({ children }: XProviderProps) {
  const { locale } = useContext(ConfigProvider.ConfigContext)
  // X reads its own strings from the same object Ant Design reads; keep both vocabularies.
  const merged = useMemo(() => ({ ...(locale?.locale === 'zh-cn' ? xZhCN : xEnUS), ...locale }), [locale])
  return (
    <AntXProvider theme={X_THEME} locale={merged}>
      {children}
    </AntXProvider>
  )
}

import { ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US.js'
import zhCN from 'antd/locale/zh_CN.js'
import { createElement, type ReactNode, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export type AntdRoot = Pick<Root, 'render' | 'unmount'>

const readLanguage = () => document.documentElement.lang
function subscribeLanguage(listener: () => void) {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  return () => observer.disconnect()
}
function LocalizedProvider({ children, nonce }: { children: ReactNode; nonce: string | undefined }) {
  const language = useSyncExternalStore(subscribeLanguage, readLanguage, () => 'en')
  return createElement(
    ConfigProvider,
    {
      ...(nonce ? { csp: { nonce } } : {}),
      locale: language === 'zh-CN' ? zhCN : enUS,
      button: { autoInsertSpace: false },
    },
    children,
  )
}

/** Keep Ant Design's generated styles under the nonce authorized by this document's CSP. */
export function createAntdRoot(container: Element | DocumentFragment): AntdRoot {
  const root = createRoot(container)
  const nonce = container.ownerDocument.querySelector<HTMLMetaElement>(
    'meta[name="agnes-csp-nonce"]',
  )?.content
  return {
    render(children: ReactNode) {
      root.render(createElement(LocalizedProvider, { nonce, children }))
    },
    unmount() {
      root.unmount()
    },
  }
}

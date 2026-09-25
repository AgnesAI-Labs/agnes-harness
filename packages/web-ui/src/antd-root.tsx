import { ConfigProvider } from 'antd'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export type AntdRoot = Pick<Root, 'render' | 'unmount'>

/** Keep Ant Design's generated styles under the nonce authorized by this document's CSP. */
export function createAntdRoot(container: Element | DocumentFragment): AntdRoot {
  const root = createRoot(container)
  const nonce = container.ownerDocument.querySelector<HTMLMetaElement>(
    'meta[name="agnes-csp-nonce"]',
  )?.content
  const csp = nonce ? { nonce } : undefined
  return {
    render(children: ReactNode) {
      root.render(createElement(ConfigProvider, csp ? { csp } : {}, children))
    },
    unmount() {
      root.unmount()
    },
  }
}

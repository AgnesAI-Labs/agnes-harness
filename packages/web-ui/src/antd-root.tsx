import { ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US.js'
import zhCN from 'antd/locale/zh_CN.js'
import { cloneElement, createElement, isValidElement, type ReactNode, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { retainAntdStyles } from './antd-styles.js'
import { createExternalStore } from './external-store.js'

export type AntdRoot = Pick<Root, 'render' | 'unmount'>

const readLanguage = () => document.documentElement.lang
function subscribeLanguage(listener: () => void) {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  return () => observer.disconnect()
}
export function useDocumentLanguage() {
  return useSyncExternalStore(subscribeLanguage, readLanguage, () => 'en')
}

export function LocalizedProvider({ children, nonce }: { children: ReactNode; nonce: string | undefined }) {
  const language = useSyncExternalStore(subscribeLanguage, readLanguage, () => 'en')
  return createElement(
    ConfigProvider,
    {
      ...(nonce ? { csp: { nonce } } : {}),
      locale: language === 'zh-CN' ? zhCN : enUS,
      button: { autoInsertSpace: false },
      getPopupContainer: (trigger?: HTMLElement) =>
        trigger?.closest<HTMLDialogElement>('dialog[open]') ??
        document.getElementById('agnes-overlay-container') ??
        trigger?.ownerDocument.body ??
        document.body,
      theme: { zeroRuntime: true, hashed: false, cssVar: { key: 'agnes-theme' } },
    },
    children,
  )
}

/** Keep Ant Design's generated styles under the nonce authorized by this document's CSP. */
export function createAntdRoot(container: Element | DocumentFragment): AntdRoot {
  const releaseStyles = retainAntdStyles(container.ownerDocument)
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
      releaseStyles()
    },
  }
}

type Region = { key: number; host: Element | DocumentFragment; children: ReactNode }
const applications = new WeakMap<Document, ReturnType<typeof application>>()
let nextRegionKey = 0

function application(container: Element | DocumentFragment, shell: ReactNode, ownedHost = false) {
  const regions = createExternalStore<readonly Region[]>([])
  const root = createAntdRoot(container)
  const byHost = new Map<Element | DocumentFragment, Region>()
  function RegionContent({ children }: { children: ReactNode }) {
    // Re-evaluate render-time translators even when a controller's snapshot did not change.
    useSyncExternalStore(subscribeLanguage, readLanguage, () => 'en')
    return isValidElement(children) ? cloneElement(children) : children
  }
  function Application() {
    const entries = useSyncExternalStore(regions.subscribe, regions.getSnapshot, regions.getSnapshot)
    return (
      <>
        {shell}
        {entries.map((entry) =>
          createPortal(<RegionContent>{entry.children}</RegionContent>, entry.host, String(entry.key)),
        )}
      </>
    )
  }
  flushSync(() => root.render(<Application />))
  return {
    renderer(host: Element | DocumentFragment): AntdRoot {
      let region = byHost.get(host)
      if (!region) {
        region = { key: ++nextRegionKey, host, children: null }
        byHost.set(host, region)
      }
      const entry = region
      return {
        render(children) {
          if (byHost.get(host) !== entry) return
          entry.children = children
          regions.set([...byHost.values()])
        },
        unmount() {
          if (byHost.get(host) !== entry) return
          byHost.delete(host)
          regions.set([...byHost.values()])
        },
      }
    },
    unmount() {
      flushSync(() => root.unmount())
      byHost.clear()
      applications.delete(container.ownerDocument)
      if (ownedHost) (container as Element).remove()
    },
  }
}

/** Start the page once; every controller surface below is a portal in this application tree. */
export function mountApplication(container: Element | DocumentFragment, shell: ReactNode): () => void {
  const owner = container.ownerDocument
  if (applications.has(owner)) throw new Error('React application is already mounted')
  const app = application(container, shell)
  applications.set(owner, app)
  return () => app.unmount()
}

/** Compatibility renderer for controller-owned hosts. It never creates a region React root. */
export function createRegionRenderer(host: Element | DocumentFragment): AntdRoot {
  const owner = host.ownerDocument
  let app = applications.get(owner)
  if (!app) {
    // Standalone admin pages and isolated fixtures also share one application per document.
    const container = owner.createElement('div')
    container.hidden = true
    owner.body.append(container)
    app = application(container, null, true)
    applications.set(owner, app)
  }
  return app.renderer(host)
}

/** Explicit document lifecycle for standalone hosts and test fixtures. */
export function unmountApplication(owner: Document): void {
  applications.get(owner)?.unmount()
}

import { ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US.js'
import zhCN from 'antd/locale/zh_CN.js'
import { cloneElement, isValidElement, memo, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { retainAntdStyles } from './antd-styles.js'
import { useDocumentLanguage } from './document-language.js'
import { createExternalStore, type StoreOptions, useStoreSelector } from './external-store.js'
import { getOverlayContainer, overlayLayers } from './overlay-policy.js'
import { RegionErrorBoundary } from './region-error-boundary.js'
import { createDocumentLocaleSource, UiLocaleProvider } from './ui-locale.js'

export { useDocumentLanguage } from './document-language.js'

import { createRegionHost } from './region-host.js'

export type AntdRoot = Pick<Root, 'render' | 'unmount'>
export type RegionRenderer = AntdRoot & { flush(): void }

function LocalizedProvider({
  children,
  nonce,
  owner,
}: {
  children: ReactNode
  nonce: string | undefined
  owner: Document
}) {
  const language = useDocumentLanguage(owner)
  return (
    <ConfigProvider
      {...(nonce ? { csp: { nonce } } : {})}
      locale={language === 'zh-CN' ? zhCN : enUS}
      button={{ autoInsertSpace: false }}
      // A press is a slight shrink and darken; no ripple spreads from the control.
      wave={{ disabled: true }}
      getPopupContainer={(trigger) => getOverlayContainer(trigger, owner)}
      drawer={{ styles: { root: { zIndex: 'var(--agh-z-drawer)' } } }}
      modal={{
        styles: { wrapper: { zIndex: 'var(--agh-z-modal)' }, mask: { zIndex: 'var(--agh-z-modal)' } },
      }}
      popover={{ styles: { root: { zIndex: 'var(--agh-z-dropdown)' } } }}
      tooltip={{ styles: { root: { zIndex: 'var(--agh-z-tooltip)' } } }}
      theme={{
        zeroRuntime: true,
        hashed: false,
        cssVar: { key: 'agnes-theme' },
        token: { zIndexPopupBase: overlayLayers.dropdown },
        components: {
          Popover: { zIndexPopup: overlayLayers.dropdown },
          Dropdown: { zIndexPopup: overlayLayers.dropdown },
          Select: { zIndexPopup: overlayLayers.dropdown },
          Drawer: { zIndexPopup: overlayLayers.drawer },
          Tooltip: { zIndexPopup: overlayLayers.tooltip },
          Message: { zIndexPopup: overlayLayers.notification },
          Notification: { zIndexPopup: overlayLayers.notification },
        },
      }}
    >
      {children}
    </ConfigProvider>
  )
}

/** Keep Ant Design's generated styles under the nonce authorized by this document's CSP. */
function createApplicationRoot(container: Element | DocumentFragment): AntdRoot {
  const releaseStyles = retainAntdStyles(container.ownerDocument)
  const root = createRoot(container)
  // One source for every region of this application, so `useUiText` follows the document language.
  const locale = createDocumentLocaleSource({})
  const nonce = container.ownerDocument.querySelector<HTMLMetaElement>(
    'meta[name="agnes-csp-nonce"]',
  )?.content
  return {
    render(children: ReactNode) {
      root.render(
        <LocalizedProvider nonce={nonce} owner={container.ownerDocument}>
          <UiLocaleProvider source={locale.source}>{children}</UiLocaleProvider>
        </LocalizedProvider>,
      )
    },
    unmount() {
      root.unmount()
      locale.dispose()
      releaseStyles()
    },
  }
}

type Region = {
  key: number
  host: Element | DocumentFragment
  content: ReturnType<typeof createExternalStore<ReactNode>>
}
const applications = new WeakMap<Document, ReturnType<typeof application>>()
let nextRegionKey = 0

function application(container: Element | DocumentFragment, shell: ReactNode, ownedHost = false) {
  const regions = createExternalStore<readonly Region[]>([])
  const root = createApplicationRoot(container)
  const byHost = new Map<Element | DocumentFragment, Region>()
  let disposed = false
  const RegionContent = memo(function RegionContent({ region }: { region: Region }) {
    const children = useStoreSelector(region.content, (value) => value)
    // Re-evaluate render-time translators even when a controller's snapshot did not change.
    useDocumentLanguage(container.ownerDocument)
    return isValidElement(children) ? cloneElement(children) : children
  })
  function Application() {
    const entries = useStoreSelector(regions, (value) => value)
    const content = (
      <>
        {entries.map((entry) =>
          createPortal(
            <RegionErrorBoundary
              owner={container.ownerDocument}
              region={
                entry.host.nodeType === 1
                  ? (entry.host as Element).getAttribute('data-agnes-region') ||
                    (entry.host as Element).id ||
                    'region'
                  : 'region'
              }
            >
              <RegionContent region={entry} />
            </RegionErrorBoundary>,
            entry.host,
            String(entry.key),
          ),
        )}
      </>
    )
    return isValidElement(shell) ? cloneElement(shell, undefined, content) : content
  }
  flushSync(() => root.render(<Application />))
  return {
    connected: () => container.isConnected,
    renderer(host: Element | DocumentFragment, options: StoreOptions = {}): RegionRenderer {
      let region = byHost.get(host)
      if (!region) {
        // Portals append to a host, unlike createRoot. Retire its previous native contents before
        // React takes ownership so legacy controls cannot shadow the live region's controls.
        host.replaceChildren()
        region = { key: ++nextRegionKey, host, content: createExternalStore<ReactNode>(null, options) }
        byHost.set(host, region)
        regions.set([...byHost.values()])
      }
      const entry = region
      return {
        flush() {
          flushSync(() => entry.content.flush())
        },
        render(children) {
          if (byHost.get(host) !== entry) return
          entry.content.set(children)
        },
        unmount() {
          if (byHost.get(host) !== entry) return
          byHost.delete(host)
          flushSync(() => regions.set([...byHost.values()]))
        },
      }
    },
    unmount() {
      if (disposed) return
      disposed = true
      byHost.clear()
      flushSync(() => root.unmount())
      applications.delete(container.ownerDocument)
      if (ownedHost) (container as Element).remove()
    },
  }
}

/** Start the page once; every controller surface below is a portal in this application tree. */
export function mountApplication(container: Element | DocumentFragment, shell: ReactNode): () => void {
  const owner = container.ownerDocument
  const previous = applications.get(owner)
  if (previous?.connected()) throw new Error('React application is already mounted')
  previous?.unmount()
  const app = application(container, shell)
  applications.set(owner, app)
  return () => app.unmount()
}

/** Compatibility renderer for controller-owned hosts. It never creates a region React root. */
export function createRegionRenderer(
  host: Element | DocumentFragment,
  options: StoreOptions = {},
): RegionRenderer {
  const owner = host.ownerDocument
  let app = applications.get(owner)
  if (app && !app.connected()) {
    app.unmount()
    app = undefined
  }
  if (!app) {
    // Standalone admin pages and isolated fixtures also share one application per document.
    const container = createRegionHost(owner.body, 'div')
    container.hidden = true
    app = application(container, null, true)
    applications.set(owner, app)
  }
  return app.renderer(host, options)
}

/** Explicit document lifecycle for standalone hosts and test fixtures. */
export function unmountApplication(owner: Document): void {
  applications.get(owner)?.unmount()
}

/** Compatibility export; regions join the document application rather than create a root. */
export const createAntdRoot = createRegionRenderer

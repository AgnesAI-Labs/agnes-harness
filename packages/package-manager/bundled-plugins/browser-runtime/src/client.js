import { browserViews } from '@agnes/web-client'
import { createElement as h } from 'react'
import { autoOpenBrowser } from './auto-open.js'
import { BrowserPanel } from './panel.js'

// Enabling supplies both transport and panel; viewing never launches Chromium.
export function apply(ctx) {
  const stopTransport = ctx.presentationRoles.register({
    role: 'browser-transport',
    priority: 100,
    mount: (mounted) =>
      browserViews.register({
        id: 'agh-browser',
        order: 100,
        observe: (sessionId) =>
          mounted.profile.services.query('browser.observe', { sessionId }, { sessionReads: [sessionId] }),
        watch: (ticket, signal) => mounted.profile.streams.open('browser.frames', { ticket }, { signal }),
      }),
  })
  let stopViewer
  try {
    stopViewer = ctx.presentationRoles.register({
      role: 'browser-viewer',
      // Older standalone viewers use 100. Prefer this owner without duplicate panels.
      priority: 50,
      mount: (mounted) => {
        const stopPanel = mounted.workbenchPanels.register({
          id: 'browser',
          order: 56,
          edge: 'right',
          titleKey: 'browser.title',
          title: () => (mounted.locale.locale === 'zh-CN' ? '浏览器' : 'Browser'),
          component: () => h(BrowserPanel, { ctx: mounted }),
        })
        const stopAutoOpen = autoOpenBrowser(mounted)
        return () => {
          stopAutoOpen()
          stopPanel()
        }
      },
    })
  } catch (error) {
    stopTransport()
    throw error
  }
  return () => {
    stopViewer()
    stopTransport()
  }
}

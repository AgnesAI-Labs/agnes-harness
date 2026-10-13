/** @vitest-environment happy-dom */

import type { UINode } from '@agnes/protocol'
import {
  ConversationMessages,
  type ConversationMessagesProps,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { webUiLocaleCatalog } from '../src/locales/index.js'

it('shows an omitted image as its size, not as a broken picture', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const t: ConversationMessagesProps['t'] = (key, vars) =>
    Object.entries(vars ?? {}).reduce(
      (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
      webUiLocaleCatalog.en[key] ?? key,
    )
  const user: UINode = {
    kind: 'user',
    id: 'omitted',
    seq: 1,
    content: [
      { type: 'text', text: 'see attached' },
      { type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: 3_145_728 } },
    ],
  }
  const store = createConversationProjectionStore({ sessionId: 'session', nodes: [user] })
  function Harness() {
    const runtime = useConversationRuntime(store)
    return createElement(AssistantRuntimeProvider, { runtime }, createElement(ConversationMessages, { t }))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    const article = host.querySelector<HTMLElement>('[data-node-id="omitted"]')
    expect(article).not.toBeNull()
    expect(article?.textContent).toContain('3.0 MB')
    expect(article?.querySelector('img')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

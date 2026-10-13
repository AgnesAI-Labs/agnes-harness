/** @vitest-environment happy-dom */

import type { ContentBlock, UINode } from '@agnes/protocol'
import {
  type AttachmentWindowReader,
  ConversationMessages,
  type ConversationMessagesProps,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { webUiLocaleCatalog } from '../src/locales/index.js'

const MIB = 1024 * 1024
const t: ConversationMessagesProps['t'] = (key, vars) =>
  Object.entries(vars ?? {}).reduce(
    (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
    webUiLocaleCatalog.en[key] ?? key,
  )

let host: HTMLDivElement
let created: string[]
let revoked: string[]
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  created = []
  revoked = []
  let n = 0
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => {
      const url = `blob:image-${++n}`
      created.push(url)
      return url
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn((url: string) => revoked.push(url)),
  })
})
afterEach(() => {
  host.remove()
  vi.restoreAllMocks()
})

const ref = (bytes: number, extra: Record<string, unknown> = {}) =>
  ({
    type: 'image',
    mimeType: 'image/png',
    attachment: { sha256: 'a'.repeat(64), bytes },
    width: 640,
    height: 480,
    name: 'shot.png',
    ...extra,
  }) as ContentBlock

/** A reader serving `size` bytes of the original and 9 bytes of thumbnail. */
function reader(size: number) {
  const reads: Array<Parameters<AttachmentWindowReader>[0]> = []
  const read: AttachmentWindowReader = async (input) => {
    reads.push(input)
    const total = input.thumbnail ? 9 : size
    const length = Math.min(input.length, total - input.offset)
    return {
      mimeType: input.thumbnail ? 'image/jpeg' : 'image/png',
      totalBytes: total,
      base64: Buffer.alloc(length, 1).toString('base64'),
    }
  }
  return { read, reads }
}

async function render(content: ContentBlock[], readAttachment?: AttachmentWindowReader) {
  const root = createRoot(host)
  const user: UINode = { kind: 'user', id: 'ref', seq: 7, content }
  const store = createConversationProjectionStore({ sessionId: 'session', nodes: [user] })
  function Harness() {
    const runtime = useConversationRuntime(store)
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(ConversationMessages, { t, ...(readAttachment ? { readAttachment } : {}) }),
    )
  }
  await act(async () => root.render(createElement(Harness)))
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
  return {
    article: () => host.querySelector<HTMLElement>('[data-node-id="ref"]'),
    unmount: () => act(async () => root.unmount()),
  }
}

it('reads a referenced image’s thumbnail once and shows it from a blob URL', async () => {
  const { read, reads } = reader(5 * MIB)
  const view = await render(
    [
      { type: 'text', text: 'see' },
      ref(5 * MIB, { thumbnail: { sha256: 'b'.repeat(64), bytes: 9, width: 320, height: 240 } }),
    ],
    read,
  )
  expect(reads).toEqual([{ seq: 7, kind: 'image', index: 1, offset: 0, length: 9, thumbnail: true }])
  const images = [...(view.article()?.querySelectorAll('img') ?? [])].map((img) => img.getAttribute('src'))
  expect(images.length).toBeGreaterThan(0)
  expect(images.every((src) => src?.startsWith('blob:'))).toBe(true)
  await view.unmount()
  expect(revoked.length).toBeGreaterThan(0)
  expect(revoked.every((url) => created.includes(url))).toBe(true)
})

it('reads an image of up to 8 MiB without a thumbnail in 1 MiB windows', async () => {
  const size = 2.5 * MIB
  const { read, reads } = reader(size)
  const view = await render([ref(size)], read)
  // The node renders in both of its trees; each reads the same windows.
  const windows = reads.filter((r, i) => reads.findIndex((o) => o.offset === r.offset) === i)
  expect(windows).toEqual([
    { seq: 7, kind: 'image', index: 1, offset: 0, length: MIB },
    { seq: 7, kind: 'image', index: 1, offset: MIB, length: MIB },
    { seq: 7, kind: 'image', index: 1, offset: 2 * MIB, length: 0.5 * MIB },
  ])
  expect(view.article()?.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
  await view.unmount()
})

it('names a larger image without a thumbnail instead of fetching it', async () => {
  const { read, reads } = reader(9 * MIB)
  const view = await render([ref(9 * MIB)], read)
  expect(reads).toEqual([])
  expect(view.article()?.textContent).toContain('shot.png')
  expect(view.article()?.textContent).toContain('9.0 MiB')
  expect(view.article()?.querySelector('img')).toBeNull()
  await view.unmount()
})

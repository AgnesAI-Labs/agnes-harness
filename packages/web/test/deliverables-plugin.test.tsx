/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import { Context } from '@agnes/cordis'
import {
  conversationCards,
  PresentationRoleRegistry,
  SessionService,
  SlotRegistry,
  workbenchPanels,
} from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
// @ts-expect-error Independent installable browser ESM has no TypeScript declaration.
import * as gallery from '../../../examples/community/deliverables-gallery/src/client.js'
// @ts-expect-error Shipped browser ESM is tested directly, without a release build.
import * as official from '../../package-manager/bundled-plugins/deliverables-ui/src/client.js'

const artifact = { sha256: 'a'.repeat(64), size: 6, mime: 'text/plain' }

it('takes over the complete experience, recovers history, opens/downloads through resource authorization and yields without leftover UI', async () => {
  const cordis = new Context(),
    session = new SessionService(cordis, 'session')
  const slots = new SlotRegistry(cordis),
    roles = new PresentationRoleRegistry()
  slots.declare('conversation.chat.turnTail', { kind: 'chain', scope: 'session' })
  const listeners = new Set<(...args: never[]) => void>()
  let presented = true
  const handle = {
    id: 'session',
    listeners,
    projectUI: async () => ({
      turns: [{ id: 'turn', startSeq: 1, endSeq: 10 }],
      nodes: presented ? [{ kind: 'tool', name: 'present', toolUseId: 'call', seq: 2, resultSeq: 5 }] : [],
    }),
    uiRead: async () => {
      throw new Error('Intelligent UI disabled')
    },
    readToolDetail: async () => ({
      result: {
        structured: {
          deliverables: [{ name: 'report.txt', description: 'final', ref: artifact }],
          laneId: 'main',
        },
      },
    }),
  }
  const release = vi.fn()
  const resources = {
    documents: { load: vi.fn(async () => ({ kind: 'text', content: 'saved snapshot', release })) },
    files: { load: vi.fn(async () => ({ url: 'blob:snapshot', release })) },
  }
  const client = { sessions: { get: () => handle }, on: () => () => {} }
  const context = (owner: string) =>
    Object.create(
      null,
      Object.fromEntries(
        Object.entries({
          agnes: client,
          session,
          slots,
          resources,
          locale: { locale: 'en', t: (key: string) => key },
          presentationRoles: { register: (provider: never) => roles.register(owner, provider) },
        }).map(([key, value]) => [key, { value, enumerable: false }]),
      ),
    )
  const host = document.createElement('div'),
    root = createRoot(host)
  document.body.append(host)
  const renderPanel = async (id: string) => {
    const panel = workbenchPanels.get(id)!
    await act(async () => {
      root.render(createElement(panel.component, { context: { t: (key) => key } }))
    })
    await vi.waitFor(() => expect(host.textContent).toContain('report.txt'))
  }
  let stopOfficial = official.apply(context('official'))
  let stopGallery: (() => void) | undefined
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    await renderPanel('deliverables')
    expect(slots.entriesOfSlot('conversation.chat.turnTail')).toHaveLength(1)
    await act(async () => {
      stopGallery = gallery.apply(context('gallery'))
    })
    expect(workbenchPanels.get('deliverables')).toBeUndefined()
    expect(slots.entriesOfSlot('conversation.chat.turnTail')).toHaveLength(1)
    await renderPanel('deliverables-gallery')
    await act(async () => host.querySelector<HTMLButtonElement>('.agh-list-row-title')!.click())
    expect(resources.documents.load).toHaveBeenCalledWith({ laneId: 'main', artifact, kind: 'text' })
    expect(host.textContent).toContain('saved snapshot')
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Download')!.click(),
    )
    expect(resources.files.load).toHaveBeenCalledWith({ laneId: 'main', artifact })
    expect(anchor).toHaveBeenCalled()
    // Backend refusal remains a visible failure and does not create a source-path URL.
    resources.files.load.mockRejectedValueOnce(new Error('artifact_forbidden'))
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Download')!.click(),
    )
    expect(host.textContent).toContain('artifact_forbidden')
    // Browser restart: reconstruct both modules from the same durable session, replacement wins.
    await act(async () => {
      root.render(null)
      stopGallery?.()
      stopGallery = undefined
      stopOfficial()
    })
    expect(workbenchPanels.get('deliverables-gallery')).toBeUndefined()
    expect(workbenchPanels.get('deliverables')).toBeUndefined()
    stopOfficial = official.apply(context('official'))
    stopGallery = gallery.apply(context('gallery'))
    await renderPanel('deliverables-gallery')
    await act(async () => {
      stopGallery?.()
      stopGallery = undefined
    })
    expect(workbenchPanels.get('deliverables-gallery')).toBeUndefined()
    await renderPanel('deliverables')
    // Live present after fallback uses exactly the same public contract.
    presented = false
    await act(async () => {
      for (const listener of listeners) listener()
    })
    await vi.waitFor(() => expect(host.textContent).not.toContain('report.txt'))
    presented = true
    await act(async () => {
      for (const listener of listeners) listener()
    })
    await vi.waitFor(() => expect(host.textContent).toContain('report.txt'))
  } finally {
    await act(async () => {
      root.unmount()
      stopGallery?.()
      stopOfficial()
    })
    host.remove()
    anchor.mockRestore()
  }
  expect(workbenchPanels.get('deliverables')).toBeUndefined()
  expect(workbenchPanels.get('deliverables-gallery')).toBeUndefined()
  expect(conversationCards.get('delivered-artifact')).toBeUndefined()
  expect(conversationCards.get('gallery-surfaces')).toBeUndefined()
  expect(listeners.size).toBe(0)
  expect(release).toHaveBeenCalled()
})

it('opens inline-only historical snapshots locally, reveals selected earlier versions and releases late resources', async () => {
  const host = document.createElement('div'),
    root = createRoot(host)
  const release = vi.fn()
  const load = vi.fn(async () => ({ kind: 'text', content: 'older snapshot', release }))
  const ctx = {
    locale: { locale: 'en', t: (key: string) => key },
    resources: { documents: { load } },
    selection: undefined as string | undefined,
  }
  const old = {
    id: 'old',
    sessionId: 's',
    laneId: 'main',
    source: { owner: 'writer' },
    seq: 3,
    name: 'report.txt',
    description: 'draft',
    artifact,
    inline: true,
    workbench: false,
  }
  const latest = { ...old, id: 'new', seq: 6, artifact: { ...artifact, sha256: 'b'.repeat(64) } }
  try {
    await act(async () => root.render(createElement(official.FileList, { files: [old], ctx, inline: true })))
    await act(async () => host.querySelector<HTMLButtonElement>('.agh-list-row-title')!.click())
    expect(load).toHaveBeenCalledWith({ laneId: 'main', artifact, kind: 'text' })
    expect(host.textContent).toContain('older snapshot')
    await act(async () =>
      root.render(
        createElement(official.FileList, { files: [old, latest], ctx: { ...ctx, selection: 'old' } }),
      ),
    )
    expect(host.querySelector('.agh-disclosure')?.getAttribute('data-open')).toBe('true')
    expect(host.textContent).toContain('older snapshot')
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.agh-list-row-title')[1]!.click())
    expect(host.textContent).not.toContain('older snapshot')
    await act(async () =>
      root.render(
        createElement(official.FileList, { files: [old, latest], ctx: { ...ctx, selection: { id: 'old' } } }),
      ),
    )
    expect(host.textContent).toContain('older snapshot')
    // A late loader result after provider disposal must be released without reviving the card.
    let complete!: (value: unknown) => void
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }) as never,
    )
    await act(async () =>
      root.render(createElement(official.FileCard, { file: { ...old, id: 'late' }, ctx, inline: false })),
    )
    await act(async () => host.querySelector<HTMLButtonElement>('.agh-list-row-title')!.click())
    await act(async () => root.render(null))
    await act(async () => complete({ kind: 'text', content: 'late', release }))
    expect(host.textContent).toBe('')
    expect(release).toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
  }
})

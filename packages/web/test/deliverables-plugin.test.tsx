/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import { Context } from '@agnes/cordis'
import {
  type ClientContext,
  conversationCards,
  factChainLinks,
  type PresentationProvider,
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
import { expectLocalizedDom } from './helpers/localized-dom.js'

const artifact = { sha256: 'a'.repeat(64), size: 6, mime: 'text/plain' }

it.each(['en', 'zh-CN'])('switches authorized deliverables (%s)', async (locale) => {
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
          deliverables: [{ name: 'report.txt', description: 'Saved report', ref: artifact }],
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
  const context = (owner: string): ClientContext =>
    new Proxy(
      Object.create(
        null,
        Object.fromEntries(
          Object.entries({
            agnes: client,
            session,
            slots,
            resources,
            conversationCards,
            workbenchPanels,
            locale: { locale, t: (key: string) => key },
            presentationRoles: {
              register: (provider: PresentationProvider) =>
                roles.register(owner, {
                  ...provider,
                  mount: () => provider.mount(context(owner)),
                }),
            },
          }).map(([key, value]) => [key, { value, enumerable: false }]),
        ),
      ),
      {
        get(target, key) {
          if (!Reflect.has(target, key)) throw new Error(`Uninjected service: ${String(key)}`)
          return Reflect.get(target, key)
        },
      },
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
    expectLocalizedDom(host)
    if (id === 'deliverables')
      expect(host.querySelector('.workbench-deliverables-group h4')?.textContent).toBe(
        locale === 'zh-CN' ? '文件' : 'Files',
      )
  }
  let stopOfficial = official.apply(context('official'))
  let stopGallery: (() => void) | undefined
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    await act(async () =>
      root.render(
        createElement(slots.entriesOfSlot('conversation.chat.turnTail')[0]!.component, {
          value: { turn: { id: 'turn', startSeq: 1, endSeq: 10 } },
        }),
      ),
    )
    await vi.waitFor(() => expect(host.textContent).toContain('report.txt'))
    expectLocalizedDom(host)
    await act(async () => host.querySelector<HTMLButtonElement>('.agh-list-row-title')!.click())
    await renderPanel('deliverables')
    expect(resources.documents.load).toHaveBeenCalledWith({ laneId: 'main', artifact, kind: 'text' })
    expect(host.textContent).toContain('saved snapshot')
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
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === (locale === 'zh-CN' ? '下载' : 'Download'))!
        .click(),
    )
    expect(resources.files.load).toHaveBeenCalledWith({ laneId: 'main', artifact })
    expect(anchor).toHaveBeenCalled()
    // Backend refusal remains a visible failure and does not create a source-path URL.
    resources.files.load.mockRejectedValueOnce(new Error('artifact_forbidden'))
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === (locale === 'zh-CN' ? '下载' : 'Download'))!
        .click(),
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
    expectLocalizedDom(host)
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
  const navigate = vi.fn(() => true)
  const stopNavigation = factChainLinks.register(navigate)
  const ctx = {
    locale: { locale: 'en', t: (key: string) => key },
    resources: { documents: { load } },
    selection: undefined as string | undefined,
  }
  const old = {
    id: 'old',
    sessionId: 's',
    laneId: 'main',
    source: { owner: 'writer', toolUseId: 'old-call' },
    seq: 3,
    name: 'report.txt',
    description: 'draft',
    artifact,
    inline: true,
    workbench: false,
  }
  const latest = {
    ...old,
    id: 'new',
    seq: 6,
    source: { owner: 'writer', toolUseId: 'new-call' },
    artifact: { ...artifact, sha256: 'b'.repeat(64) },
  }
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
    await act(async () =>
      host.querySelectorAll<HTMLButtonElement>('[data-testid=deliverable-open]')[1]!.click(),
    )
    expect(host.textContent).not.toContain('older snapshot')
    await act(async () =>
      root.render(
        createElement(official.FileList, { files: [old, latest], ctx: { ...ctx, selection: { id: 'old' } } }),
      ),
    )
    expect(host.textContent).toContain('older snapshot')
    // Repeating navigation to an already-open snapshot must keep the preview open.
    await act(async () =>
      root.render(
        createElement(official.FileList, { files: [old, latest], ctx: { ...ctx, selection: { id: 'old' } } }),
      ),
    )
    expect(host.textContent).toContain('older snapshot')
    // Manual historical selection updates the footer's public ledger anchor.
    await act(async () =>
      root.render(
        createElement(official.FileList, { files: [old, latest], ctx: { ...ctx, selection: { id: 'new' } } }),
      ),
    )
    await act(async () =>
      host.querySelectorAll<HTMLButtonElement>('[data-testid=deliverable-open]')[1]!.click(),
    )
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid=deliverables-source]')!.click())
    expect(navigate).toHaveBeenLastCalledWith({
      sessionId: 's',
      laneId: 'main',
      anchor: { kind: 'tool', toolUseId: 'old-call' },
    })
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
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid=deliverable-open]')!.click())
    await act(async () => root.render(null))
    await act(async () => complete({ kind: 'text', content: 'late', release }))
    expect(host.textContent).toBe('')
    expect(release).toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    stopNavigation()
  }
})

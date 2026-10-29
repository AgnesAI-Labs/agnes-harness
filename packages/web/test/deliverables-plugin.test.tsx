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
  SlotOutlet,
  SlotRegistry,
  SlotsProvider,
  workbenchNavigation,
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

it.each([
  ['text/html', 6, true, ''],
  ['text/markdown', 6, true, ''],
  ['application/pdf', 6, true, ''],
  ['image/png', 6, true, ''],
  ['application/json', 6, true, ''],
  ['application/javascript', 6, true, ''],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    6,
    false,
    'No in-app preview — click to download',
  ],
  ['text/html', 1024 * 1024 + 1, false, 'No in-app preview — click to download'],
])(
  'opens only a clicked previewable artifact (%s, %i bytes)',
  async (mime, size, previewable, unsupported) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const requestPreview = vi.fn()
    const documents = vi.fn()
    const files = vi.fn(async () => ({ url: 'blob:download', release: vi.fn() }))
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const ctx = {
      locale: { locale: 'en', t: (key: string) => key },
      resources: { documents: { load: documents }, files: { load: files } },
      requestPreview,
    }
    const file = {
      id: 'clicked-file',
      name: 'result',
      artifact: { ...artifact, mime, size },
      laneId: 'main',
      workbench: true,
    }
    try {
      await act(async () => root.render(createElement(official.FileCard, { file, ctx, inline: true })))
      // An unpreviewable card says so before the user clicks; a previewable one never claims it.
      if (unsupported) expect(host.textContent).toContain(unsupported)
      else expect(host.textContent).not.toContain('No in-app preview')
      expect(requestPreview).not.toHaveBeenCalled()
      expect(documents).not.toHaveBeenCalled()
      expect(files).not.toHaveBeenCalled()
      await act(async () => host.querySelector<HTMLButtonElement>('.agh-list-row-title')!.click())
      if (previewable) {
        expect(requestPreview).toHaveBeenCalledWith(file.id)
        expect(files).not.toHaveBeenCalled()
      } else {
        expect(requestPreview).not.toHaveBeenCalled()
        expect(documents).not.toHaveBeenCalled()
        expect(files).toHaveBeenCalledWith({ laneId: 'main', artifact: file.artifact })
        expect(anchor).toHaveBeenCalled()
        files.mockClear()
        await act(async () =>
          root.render(
            createElement(official.FileCard, { file, ctx: { ...ctx, selection: { id: file.id } } }),
          ),
        )
        expect(files).not.toHaveBeenCalled()
      }
    } finally {
      await act(async () => root.unmount())
      host.remove()
      anchor.mockRestore()
    }
  },
)

it('answers a workbench selection of an unpreviewable file with a notice instead of downloading', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const files = vi.fn(async () => ({ url: 'blob:download', release: vi.fn() }))
  const documents = vi.fn()
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const ctx = {
    locale: { locale: 'en', t: (key: string) => key },
    resources: { documents: { load: documents }, files: { load: files } },
    selection: { id: 'slides' },
  }
  const file = {
    id: 'slides',
    name: 'deck.pptx',
    artifact: {
      ...artifact,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
    laneId: 'main',
    workbench: true,
  }
  try {
    await act(async () => root.render(createElement(official.FileCard, { file, ctx })))
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid=deliverable-preview-unsupported]')).not.toBeNull(),
    )
    expect(host.textContent).toContain('This format has no in-app preview')
    // Replayed workbench selection is not a download request.
    expect(files).not.toHaveBeenCalled()
    expect(documents).not.toHaveBeenCalled()
    expect(anchor).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    anchor.mockRestore()
  }
})

it('shows the open-with menu only on workbench cards, not on a card inside an answer', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const ctx = {
    locale: { locale: 'en', t: (key: string) => key },
    resources: { documents: { load: vi.fn(async () => ({ release: vi.fn() })) } },
  }
  const file = {
    id: 'placement',
    name: 'brief.md',
    artifact: { ...artifact, mime: 'text/markdown' },
    laneId: 'main',
    workbench: true,
  }
  try {
    await act(async () => root.render(createElement(official.FileCard, { file, ctx, inline: true })))
    expect(host.querySelector('[data-testid=deliverable-open-with]')).toBeNull()
    await act(async () => root.render(createElement(official.FileCard, { file, ctx, inline: false })))
    expect(host.querySelector('[data-testid=deliverable-open-with]')).not.toBeNull()
    expect(host.querySelector('[data-testid=deliverable-open]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it.each(['en', 'zh-CN'].flatMap((locale) => ['before', 'after'].map((parent) => ({ locale, parent }))))(
  'switches authorized deliverables ($locale, parent $parent)',
  async ({ locale, parent }) => {
    const cordis = new Context(),
      session = new SessionService(cordis, 'session')
    session.setReadiness('ready')
    const slots = new SlotRegistry(cordis),
      roles = new PresentationRoleRegistry()
    slots.declare('transcript-test', { kind: 'single', scope: 'session' })
    const mountParent = () =>
      slots.register(
        {
          name: 'transcript-test',
          children: { 'conversation.chat.turnTail': { kind: 'chain', scope: 'session' } },
        },
        () => null,
      )
    let stopParent = parent === 'before' ? mountParent() : undefined
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
    const events = new Set<() => void>()
    const navigation = vi.fn(() => true)
    const stopNavigation = workbenchNavigation.register(navigation)
    const client = {
      sessions: { get: () => handle },
      on: (_name: string, listener: () => void) => {
        events.add(listener)
        return () => events.delete(listener)
      },
    }
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
    const renderTail = async () => {
      await act(async () =>
        root.render(
          createElement(
            SlotsProvider,
            { registry: slots, session },
            createElement(SlotOutlet, {
              name: 'conversation.chat.turnTail',
              owner: { turn: { id: 'turn', startSeq: 1, endSeq: 10 } },
              hideWhenEmpty: true,
            }),
          ),
        ),
      )
      await vi.waitFor(() => expect(host.textContent).toContain('report.txt'))
      expect(host.querySelectorAll('.agh-list-row-title')).toHaveLength(1)
    }
    let stopOfficial = official.apply(context('official'))
    let stopGallery: (() => void) | undefined
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      // The panel/data/card providers mount even when the conversation outlet is absent.
      expect(workbenchPanels.get('deliverables')).toBeDefined()
      expect(conversationCards.get('delivered-artifact')).toBeDefined()
      if (parent === 'after') {
        expect(slots.entriesOfSlot('conversation.chat.turnTail')).toHaveLength(0)
        await renderPanel('deliverables')
        stopParent = mountParent()
      }
      expect(listeners.size).toBe(1)
      expect(events.size).toBe(3)
      await renderTail()
      expect(navigation).not.toHaveBeenCalled()
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
      // Removing the declaration revokes the tail; rebuilding it elects only the live owner.
      await act(async () => {
        stopParent?.()
      })
      expect(slots.entriesOfSlot('conversation.chat.turnTail')).toHaveLength(0)
      expect(workbenchPanels.get('deliverables-gallery')).toBeDefined()
      await act(async () => {
        stopParent = mountParent()
      })
      expect(slots.entriesOfSlot('conversation.chat.turnTail')).toHaveLength(1)
      expect(slots.entriesOfSlot('conversation.chat.turnTail')[0]?.id).toBe('gallery-tail')
      await renderTail()
      await renderPanel('deliverables-gallery')
      expect(listeners.size).toBe(1)
      expect(events.size).toBe(3)
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
      expect(slots.entriesOfSlot('conversation.chat.turnTail')[0]?.id).toBe('deliverables-tail')
      await act(async () => {
        stopParent?.()
        stopParent = mountParent()
      })
      expect(slots.entriesOfSlot('conversation.chat.turnTail')).toHaveLength(1)
      expect(slots.entriesOfSlot('conversation.chat.turnTail')[0]?.id).toBe('deliverables-tail')
      expect(listeners.size).toBe(1)
      expect(events.size).toBe(3)
      await renderTail()
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
        // A disposed owner's inject listener must never revive on a later declaration.
        stopParent?.()
        stopParent = mountParent()
        expect(slots.entriesOfSlot('conversation.chat.turnTail')).toHaveLength(0)
        stopParent()
      })
      host.remove()
      stopNavigation()
      anchor.mockRestore()
    }
    expect(workbenchPanels.get('deliverables')).toBeUndefined()
    expect(workbenchPanels.get('deliverables-gallery')).toBeUndefined()
    expect(conversationCards.get('delivered-artifact')).toBeUndefined()
    expect(conversationCards.get('gallery-surfaces')).toBeUndefined()
    expect(roles.getSnapshot()).toEqual([])
    expect(listeners.size).toBe(0)
    expect(events.size).toBe(0)
    expect(release).toHaveBeenCalled()
  },
)

it.each(
  [official, gallery].flatMap((plugin, index) =>
    ['before', 'after'].map((parent) => ({ plugin, index, parent })),
  ),
)('cleans up failed provider $index with parent $parent', async ({ plugin, parent }) => {
  const cordis = new Context()
  const session = new SessionService(cordis, 'failed-session')
  session.setReadiness('ready')
  const slots = new SlotRegistry(cordis)
  const roles = new PresentationRoleRegistry()
  slots.declare('failure-parent', { kind: 'single', scope: 'session' })
  const mountParent = () =>
    slots.register(
      {
        name: 'failure-parent',
        children: {
          'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
        },
      },
      () => null,
    )
  let stopParent = parent === 'before' ? mountParent() : undefined
  const listeners = new Set<() => void>()
  const events = new Set<() => void>()
  const ctx = {
    slots,
    session,
    locale: { locale: 'en' },
    resources: {},
    conversationCards,
    agnes: {
      sessions: { get: () => ({ listeners, projectUI: async () => ({ turns: [], nodes: [] }) }) },
      on: (_name: string, listener: () => void) => {
        events.add(listener)
        return () => events.delete(listener)
      },
    },
    workbenchPanels: {
      register: () => {
        throw new Error('panel failed')
      },
    },
    presentationRoles: {
      register: (provider: PresentationProvider) =>
        roles.register('failed', {
          ...provider,
          mount: () => provider.mount(ctx as unknown as ClientContext),
        }),
    },
  }
  try {
    expect(() => plugin.apply(ctx)).toThrow('panel failed')
    expect(listeners.size).toBe(0)
    expect(events.size).toBe(0)
    stopParent?.()
    stopParent = mountParent()
    expect(slots.entriesOfSlot('conversation.chat.turnTail')).toHaveLength(0)
    expect(roles.resolution('deliverables').effective).toBeNull()
    expect(conversationCards.get('delivered-artifact')).toBeUndefined()
    expect(conversationCards.get('gallery-artifact')).toBeUndefined()
  } finally {
    stopParent?.()
    await cordis.fiber.dispose()
  }
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
    expect(navigate).toHaveBeenLastCalledWith(
      {
        sessionId: 's',
        laneId: 'main',
        anchor: { kind: 'tool', toolUseId: 'old-call' },
      },
      undefined,
    )
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

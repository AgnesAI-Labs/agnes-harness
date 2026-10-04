/** @vitest-environment happy-dom */
import type {
  ClientEntry,
  ClientModule,
  DomainView,
  FormattedView,
  NegotiatedClientCapabilities,
  Outcome,
  RendererContext,
  RendererDefinition,
  RendererDescriptor,
  RendererPresentation,
  RendererRegistration,
} from '@agnes/extension-api/client'
import { validateRuntime } from '@agnes/protocol/runtime'
import { act, type ReactElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientHostRuntime } from '../../src/runtime/client-host.js'
import type { ClientTarget, SelectedRenderer } from '../../src/runtime/client-selection.js'
import { createUIRegistry } from '../../src/runtime/providers/ui-registry.js'
import { createRendererPresenter } from '../../src/runtime/renderer-presentation.js'
import { formatDomainView } from '../../src/runtime/renderers/text.js'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const DIGEST = 'a'.repeat(64)
const CARD = 'acme.notes/card'
const EXTRA = 'acme.notes/extra'
const TARGETS = ['web', 'tui'] as const

type Declared = readonly [string, string, number, number]

// The renderers each module declares: id, render key and the schema revisions of acme.notes/view@1 it
// reads. base also serves the registry; the selection names base.fallback as its fallback and, with
// rows, cards.card for the card render key. base.extra is registered by base's entry but never selected.
const RENDERERS: Record<string, readonly Declared[]> = {
  base: [
    ['base.fallback', CARD, 2, 3],
    ['base.extra', EXTRA, 1, 3],
  ],
  cards: [['cards.card', CARD, 1, 1]],
}

const descriptorOf = ([id, renderKey, minRevision, maxRevision]: Declared): RendererDescriptor => ({
  id,
  packageDigest: DIGEST,
  renderKey,
  targets: [...TARGETS],
  viewSchemaRanges: [{ typeId: 'acme.notes/view@1', minRevision, maxRevision }],
  requiredFeatures: [],
  optionalFeatures: [],
  scope: 'view',
  entry: './view.js',
})

/** The descriptor `moduleId` declares for its renderer `id`. */
function declaredIn(moduleId: string, id: string): RendererDescriptor {
  const found = RENDERERS[moduleId]?.find(([entry]) => entry === id)
  if (found === undefined) throw new Error(`${moduleId} declares no renderer ${id}`)
  return descriptorOf(found)
}

const catalogModule = (moduleId: string, revision: number): ClientModule => ({
  moduleId,
  packageId: `acme.${moduleId}`,
  packageDigest: DIGEST,
  assetDigest: DIGEST,
  entryPath: `./${moduleId}.js`,
  ownerToken: `catalog-${moduleId}-${revision}`,
  authorApiMajor: 1,
  targets: [...TARGETS],
  schemas: [],
  requiredFeatures: [],
  styles: [],
  contributions: [
    ...(moduleId === 'base'
      ? [
          {
            contributionId: 'base.registry',
            kind: 'registry' as const,
            export: 'createRegistry',
            targets: [...TARGETS],
          },
        ]
      : []),
    ...(RENDERERS[moduleId] ?? []).map((declared) => ({
      contributionId: declared[0],
      kind: 'renderer' as const,
      targets: [...TARGETS],
      descriptor: descriptorOf(declared),
    })),
  ],
})

const chose = (moduleId: string, contributionId: string): SelectedRenderer => ({
  moduleId,
  packageId: `acme.${moduleId}`,
  packageDigest: DIGEST,
  entryPath: `./${moduleId}.js`,
  contributionId,
  descriptor: declaredIn(moduleId, contributionId),
})

function catalog(revision: number, target: ClientTarget, rows: boolean) {
  return {
    revision,
    modules: ['base', 'cards'].map((moduleId) => catalogModule(moduleId, revision)),
    selection: {
      kind: 'selected' as const,
      target,
      shell: null,
      registry: {
        moduleId: 'base',
        packageId: 'acme.base',
        packageDigest: DIGEST,
        entryPath: './base.js',
        contributionId: 'base.registry',
        export: 'createRegistry',
      },
      fallbackRenderer: chose('base', 'base.fallback'),
      renderers: rows ? [{ renderKey: CARD, renderer: chose('cards', 'cards.card') }] : [],
    },
  }
}

const schema = { typeId: 'acme.notes/rename@1', revision: 1, digest: 'c'.repeat(64) }

function view(revision: number, schemaRevision: number, extra: Partial<DomainView> = {}): DomainView {
  const value: DomainView = {
    kind: 'domain',
    viewId: 'note-1',
    revision,
    domainType: 'acme.notes',
    viewSchema: { typeId: 'acme.notes/view@1', revision: schemaRevision, digest: 'b'.repeat(64) },
    renderKey: CARD,
    scope: {
      kind: 'session',
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    },
    source: { eventIds: ['event-1'], projectionRevision: 4 },
    phase: 'finalized',
    fallbackText: 'Note <b>saved</b>',
    data: { html: '<img src=x>' },
    resources: [],
    actions: [
      {
        kind: 'command',
        actionKey: 'rename',
        label: 'Rename',
        requiredFeatures: [],
        availability: 'enabled',
        disabledReason: null,
        command: 'rename',
        inputSchema: schema,
      },
    ],
    ...extra,
  }
  expect(validateRuntime('DomainView', value).ok).toBe(true)
  return value
}

const capabilities = {
  clientInstanceId: 'client-1',
  target: 'web',
  features: [],
} as unknown as NegotiatedClientCapabilities

type Seen = { view: DomainView; context: RendererContext }

/**
 * A runtime over the default registry and the real presenter. The host registers the selected renderers
 * from each module's fixed exports; base's entry registers base.extra, and cards has no entry at all.
 */
async function harness(target: ClientTarget, rows: boolean) {
  const renders: Record<string, Seen[]> = {}
  const mounts: Record<string, number> = {}
  /** Renderer ids whose text format throws. */
  const failing = new Set<string>()
  const registrations: Record<string, RendererRegistration> = {}

  /** The fixed exports of the renderer `id`: a component and a format that each show its id. */
  const fixed = (id: string) => {
    function Plugin({ view, context }: Seen): ReactElement {
      renders[id] = [...(renders[id] ?? []), { view, context }]
      useEffect(() => {
        mounts[id] = (mounts[id] ?? 0) + 1
      }, [])
      return <p className="plugin">{`${id} ${view.viewId}@${view.revision}`}</p>
    }
    return {
      component: Plugin,
      format(shown: DomainView): Outcome<FormattedView> {
        if (failing.has(id)) throw new Error('broken')
        return {
          ok: true,
          value: {
            viewId: shown.viewId,
            revision: shown.revision,
            parts: [{ kind: 'text', text: id }],
            complete: true,
            unsupportedRequiredFeatures: [],
          },
        }
      },
    }
  }
  const clientEntry: ClientEntry = async (clientHost) => {
    const registered = clientHost.renderers.register({
      descriptor: declaredIn('base', 'base.extra'),
      ...fixed('base.extra'),
    } as unknown as RendererDefinition)
    if (!registered.ok) return registered
    registrations['base.extra'] = registered.value
    return { ok: true, value: { dispose: async () => {} } }
  }

  const window = new Map<string, DomainView>()
  const submit = vi.fn(async () => ({ ok: true as const, value: 'delegated' }))
  const presenter = createRendererPresenter({
    target,
    clientInstanceId: 'client-1',
    capabilities,
    locale: 'en',
    services: {
      commands: { submit, commandStatus: submit },
      locale: { locale: 'en', text: (key: string) => key, formatNumber: () => '', formatDate: () => '' },
    } as unknown as Pick<RendererContext, 'commands' | 'interactions' | 'artifacts' | 'locale'>,
    views: { current: (viewId) => window.get(viewId) },
  })
  const runtime = createClientHostRuntime({
    target,
    loader: {
      load: async (module) => ({
        ok: true,
        value:
          module.moduleId === 'base'
            ? { clientEntry, createRegistry: createUIRegistry, ...fixed('base.fallback') }
            : fixed('cards.card'),
      }),
    },
    context: {} as RendererContext,
    presenter,
  })
  expect(outcome(await runtime.activate(catalog(1, target, rows)))).toBe('ok')
  const domain = (shown: DomainView) => {
    const generation = runtime.current()
    if (generation === undefined) throw new Error('no current generation')
    return generation.presentation.domain(shown)
  }
  const hold = (...held: DomainView[]) => {
    for (const entry of held) window.set(entry.viewId, entry)
  }
  return { runtime, renders, mounts, failing, registrations, submit, domain, hold }
}

const outcome = (result: Outcome<unknown>) =>
  result.ok ? 'ok' : `${result.error.code}/${result.error.detailCode}`

function element(result: Outcome<RendererPresentation>): ReactElement {
  if (!result.ok || result.value.target !== 'web') throw new Error(`not a Web element: ${outcome(result)}`)
  return result.value.element
}

const show = (result: Outcome<RendererPresentation> | null) =>
  act(async () => root.render(result && element(result)))

/** What the host shows: the plugin renderer's text, the generic card, or nothing. */
const shown = () =>
  host.querySelector('.plugin')?.textContent ??
  (host.querySelector('.generic-domain-view') ? 'generic' : 'none')

describe('domain presentation through the client host', () => {
  it.each<[string, boolean, DomainView, string]>([
    ['the renderer selected for the render key', true, view(1, 1), 'cards.card note-1@1'],
    [
      'the selected fallback when the chosen renderer does not fit',
      true,
      view(1, 2),
      'base.fallback note-1@1',
    ],
    ['a registry match the selection chose', false, view(1, 2), 'base.fallback note-1@1'],
    [
      'the generic card for a registry match nobody selected',
      false,
      view(1, 1, { renderKey: EXTRA }),
      'generic',
    ],
    ['the generic card when no renderer reads the schema', true, view(1, 9), 'generic'],
  ])('presents %s', async (_, rows, held, expected) => {
    const h = await harness('web', rows)
    h.hold(held)
    await show(h.domain(held))
    expect(shown()).toBe(expected)
    expect(h.renders['base.extra']).toBeUndefined()
    // View data is never markup, whoever presents the view.
    expect(host.querySelector('b, img')).toBeNull()
    if (expected === 'generic') expect(host.textContent).toContain('Note <b>saved</b>')
  })

  it.each<[string, (h: Awaited<ReturnType<typeof harness>>) => void, string]>([
    ['the window lacks the view', () => {}, 'conflict/view_resync_required'],
    ['the window holds another revision', (h) => h.hold(view(2, 1)), 'conflict/view_stale'],
  ])('returns the resync refusal unchanged when %s', async (_, arrange, expected) => {
    const h = await harness('web', true)
    arrange(h)
    const result = h.domain(view(1, 1))
    expect(outcome(result)).toBe(expected)
    expect(!result.ok && result.error.retryAdvice).toEqual({ kind: 'retry_read' })
  })

  it('keeps presenting through the selected renderers when a module releases what it registered', async () => {
    const h = await harness('web', true)
    for (const registration of Object.values(h.registrations)) await registration.dispose()
    h.hold(view(1, 1))
    await show(h.domain(view(1, 1)))
    expect(shown()).toBe('cards.card note-1@1')
  })

  it('formats with the selected fallback, then the generic text when that fails', async () => {
    const h = await harness('tui', true)
    const held = view(1, 2)
    h.hold(held)
    const fallback = h.domain(held)
    expect(fallback.ok && fallback.value.target === 'tui' && fallback.value.formatted.parts).toEqual([
      { kind: 'text', text: 'base.fallback' },
    ])
    h.failing.add('base.fallback')
    const generic = formatDomainView(held, { locale: 'en', capabilities })
    if (!generic.ok) throw new Error(generic.error.message)
    expect(h.domain(held)).toEqual({ ok: true, value: { target: 'tui', formatted: generic.value } })
  })

  it('updates the same view in place, remounts for another presenter and releases on unmount', async () => {
    const h = await harness('web', true)
    h.hold(view(1, 1))
    await show(h.domain(view(1, 1)))
    const node = host.querySelector('.plugin')
    h.hold(view(2, 1))
    await show(h.domain(view(2, 1)))
    expect(shown()).toBe('cards.card note-1@2')
    expect(host.querySelector('.plugin')).toBe(node)
    expect(h.mounts['cards.card']).toBe(1)
    const contexts = new Set(h.renders['cards.card']?.map((entry) => entry.context))
    expect(contexts.size).toBe(1)
    const [card] = contexts

    // A newer revision no selected renderer reads moves the view to the generic card, which then
    // keeps its mount across revisions too.
    h.hold(view(3, 9))
    await show(h.domain(view(3, 9)))
    expect(shown()).toBe('generic')
    expect(card?.signal.aborted).toBe(true)
    const generic = host.querySelector('.generic-domain-view')
    h.hold(view(4, 9))
    await show(h.domain(view(4, 9)))
    expect(host.querySelector('.generic-domain-view')).toBe(generic)

    h.hold(view(5, 2))
    await show(h.domain(view(5, 2)))
    expect(shown()).toBe('base.fallback note-1@5')
    expect(h.mounts['base.fallback']).toBe(1)
    const fallback = h.renders['base.fallback']?.at(-1)?.context
    expect(fallback?.signal.aborted).toBe(false)
    await show(null)
    expect(fallback?.signal.aborted).toBe(true)
  })

  it("ends the generation's presentation leases when the next generation replaces it", async () => {
    const h = await harness('web', true)
    const other = view(1, 9, { viewId: 'note-2' })
    h.hold(view(1, 1), other)
    const first = element(h.domain(view(1, 1)))
    const second = element(h.domain(other))
    await act(async () =>
      root.render(
        <>
          {first}
          {second}
        </>,
      ),
    )
    const card = h.renders['cards.card']?.at(-1)?.context
    expect(card?.signal.aborted).toBe(false)

    expect(outcome(await h.runtime.activate(catalog(2, 'web', true)))).toBe('ok')
    expect(card?.signal.aborted).toBe(true)
    // The generic card's context was released as well, so its action reaches no service.
    await act(async () => host.querySelector<HTMLButtonElement>('.generic-domain-view button')?.click())
    expect(h.submit).not.toHaveBeenCalled()
    expect(host.querySelector('.generic-domain-view [role="status"]')?.textContent).toMatch(/^Refused/)

    // The next generation presents the same view through a fresh context.
    await show(h.domain(view(1, 1)))
    expect(h.renders['cards.card']?.at(-1)?.context.signal.aborted).toBe(false)
  })

  it('refuses a legacy slot', async () => {
    const h = await harness('web', true)
    const result = h.runtime.current()?.presentation.legacySlot({ name: 'composer', props: null })
    expect(result?.ok).toBe(false)
    expect(!result?.ok && result?.error.code).toBe('incompatible')
    expect(!result?.ok && result?.error.message).toContain('legacy slot presentation is not wired yet')
  })
})

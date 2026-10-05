/** @vitest-environment happy-dom */
import type {
  ClientModule,
  DomainView,
  NegotiatedClientCapabilities,
  Outcome,
  RendererContext,
  RendererDescriptor,
  RendererPresentation,
} from '@agnes/extension-api/client'
import { type RuntimeWireTypes, validateRuntime } from '@agnes/protocol/runtime'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { type ClientModuleLoader, createClientHostRuntime } from '../../src/runtime/client-host.js'
import {
  type ClientSelection,
  type ClientTarget,
  resolveClientSelection,
} from '../../src/runtime/client-selection.js'
import { createRendererPresenter } from '../../src/runtime/renderer-presentation.js'
import * as author from './fixtures/author-client/client.js'
import entrySource from './fixtures/author-client/client.tsx?raw'
import catalogEntry from './fixtures/author-client/client-module.json?raw'
import selectionText from './fixtures/author-client/selection.json?raw'
import viewText from './fixtures/author-client/view.json?raw'

// One client package as a plugin author outside this repository ships it (fixtures/author-client): its
// module, the catalog entry the server issues for it, a Web selection of it and a view it renders. Each
// is checked against the wire schema, so every refusal below is the client's own. The client recomputes
// only the asset digest, in its loader; it compares the package digest and never reads the schema digest.
function wire<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const checked = validateRuntime(name, value)
  if (!checked.ok) throw new Error(`not a valid ${name}: ${JSON.stringify(checked.errors)}`)
  return checked.value
}

const MODULE = wire('ClientModule', JSON.parse(catalogEntry))
const SELECTION = wire('ClientSelection', JSON.parse(selectionText))
const VIEW = wire('DomainView', JSON.parse(viewText))
/** The text the package serves at each entry path. */
const ENTRIES: Readonly<Record<string, string>> = { './client.tsx': entrySource }

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

type Namespace = Readonly<Record<string, unknown>>

/** Serves `namespace` as a module's entry once the entry's bytes match the module's asset digest. */
const loader = (namespace: Namespace): ClientModuleLoader => ({
  load: async (module) => {
    const source = ENTRIES[module.entryPath]
    if (source === undefined || (await sha256(source)) !== module.assetDigest)
      return {
        ok: false,
        error: {
          code: 'incompatible',
          detailCode: 'asset_digest_mismatch',
          message: `the entry ${module.entryPath} does not match its asset digest`,
          retryAdvice: { kind: 'never' },
          diagnosticId: 'author-client-fixture-test',
        },
      }
    return { ok: true, value: namespace }
  },
})

type Edit = { modules?: ClientModule[]; selection?: ClientSelection; namespace?: Namespace }

/**
 * Resolves the selection against the catalog and activates what it selects in a fresh client host over
 * the real presenter. `present` hands a view to the current generation as the window holding it.
 */
async function activate(target: ClientTarget, edit: Edit = {}) {
  const modules = edit.modules ?? [MODULE]
  const held = new Map<string, DomainView>()
  const capabilities = {
    clientInstanceId: 'client-1',
    target,
    features: [],
  } as unknown as NegotiatedClientCapabilities
  const services = {
    locale: { locale: 'en', text: (key: string) => key, formatNumber: () => '', formatDate: () => '' },
  } as unknown as Pick<RendererContext, 'commands' | 'interactions' | 'artifacts' | 'locale'>
  const runtime = createClientHostRuntime({
    target,
    loader: loader(edit.namespace ?? author),
    clientInstanceId: 'client-1',
    capabilities,
    locale: services.locale,
    presenter: createRendererPresenter({
      target,
      clientInstanceId: 'client-1',
      capabilities,
      locale: 'en',
      services,
      views: { current: (viewId) => held.get(viewId) },
    }),
  })
  const present = (view: DomainView) => {
    held.set(view.viewId, view)
    const generation = runtime.current()
    if (generation === undefined) throw new Error('no current generation')
    return generation.presentation.domain(view)
  }
  const selected = resolveClientSelection({ target, selection: edit.selection ?? SELECTION, modules })
  if (!selected.ok) return { outcome: selected, runtime, present }
  if (selected.value.kind !== 'selected') throw new Error('the selection resolved to the legacy path')
  const outcome = await runtime.activate({ revision: 1, modules, selection: selected.value })
  return { outcome, runtime, present }
}

const refused = (result: Outcome<unknown>) =>
  result.ok ? 'ok' : `${result.error.code}/${result.error.detailCode}`

const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
})
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

/** Mounts a Web presentation and returns its container. */
async function mount(result: Outcome<RendererPresentation>) {
  if (!result.ok || result.value.target !== 'web') throw new Error(`not a Web element: ${refused(result)}`)
  const container = document.createElement('div')
  const root = createRoot(container)
  roots.push(root)
  const { element } = result.value
  await act(async () => root.render(element))
  return container
}

/** The catalog entry with `edit` applied and its renderer's descriptor changed by `descriptor`. */
const variant = (edit: Partial<ClientModule>, descriptor: Partial<RendererDescriptor> = {}) =>
  wire('ClientModule', {
    ...MODULE,
    ...edit,
    contributions: MODULE.contributions?.map((entry) =>
      entry.kind === 'renderer' ? { ...entry, descriptor: { ...entry.descriptor, ...descriptor } } : entry,
    ),
  })
const NEXT = 'd'.repeat(64)

describe('an outside author client package', () => {
  it('is selected, activated and presents its view through its own renderer', async () => {
    const h = await activate('web')
    expect(refused(h.outcome)).toBe('ok')
    const generation = h.runtime.current()
    expect(generation?.shell()).toBe(author.notesShell)
    // The package's registry holds its renderer, bound under the owner token the catalog issued.
    expect(
      generation?.registry.resolve({
        renderKey: VIEW.renderKey,
        viewSchema: VIEW.viewSchema,
        target: 'web',
        requiredFeatures: [],
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: 'matched', handle: { id: 'acme.notes/note-card', ownerToken: MODULE.ownerToken } },
    })
    const card = (await mount(h.present(VIEW))).querySelector('.acme-note')
    expect(card?.querySelector('h3')?.textContent).toBe('Release checklist')
    expect(card?.querySelector('p')?.textContent).toBe('Tag the build, then publish the notes.')
  })

  it('gets handles through its own registry only for what the host registered and the window holds', async () => {
    const h = await activate('web')
    const generation = h.runtime.current()
    if (generation === undefined) throw new Error('no current generation')
    const request = {
      renderKey: VIEW.renderKey,
      viewSchema: VIEW.viewSchema,
      target: 'web' as const,
      requiredFeatures: [],
    }
    const matched = generation.registry.resolve(request)
    if (!matched.ok || matched.value.kind !== 'matched') throw new Error('the note card was not matched')
    const { handle, descriptor } = matched.value
    // The handle presents only the revision the authorized window holds now, so an older one is refused.
    h.present({ ...VIEW, revision: 2 })
    expect(refused(handle.present(VIEW))).toBe('conflict/view_stale')
    expect(refused(handle.present({ ...VIEW, viewId: 'note-2' }))).toBe('conflict/view_resync_required')
    // A definition placed in the package's registry behind the host's back gets no handle, so a view
    // under its render key shows in the generic view rather than through it.
    const forged = {
      descriptor: { ...descriptor, id: 'acme.notes/forged', renderKey: 'acme.notes/forged' },
      component: author.component,
    }
    expect(refused(generation.registry.register(forged))).toBe('ok')
    expect(refused(generation.registry.resolve({ ...request, renderKey: 'acme.notes/forged' }))).toBe(
      'denied/renderer_unbound',
    )
    const shown = await mount(
      h.present(wire('DomainView', { ...VIEW, viewId: 'note-3', renderKey: 'acme.notes/forged' })),
    )
    expect(shown.querySelector('.acme-note')).toBeNull()
    expect(shown.querySelector('.generic-domain-view .generic-domain-text')?.textContent).toBe(
      'Note: Release checklist',
    )
  })

  it('formats its view through the same renderer for a text client', async () => {
    const selection = wire('ClientSelection', {
      ...SELECTION,
      target: 'tui',
      shell: null,
      rendererSelections: SELECTION.rendererSelections.map((row) => ({ ...row, target: 'tui' })),
    })
    const h = await activate('tui', { selection })
    expect(refused(h.outcome)).toBe('ok')
    const result = h.present(VIEW)
    expect(result.ok && result.value.target === 'tui' && result.value.formatted).toEqual({
      viewId: 'note-1',
      revision: 1,
      parts: [
        { kind: 'text', text: 'Release checklist' },
        { kind: 'text', text: 'Tag the build, then publish the notes.' },
      ],
      complete: true,
      unsupportedRequiredFeatures: [],
    })
  })

  const { component: _component, ...withoutComponent } = author
  it.each<{ name: string; edit: Edit; expected: string; message?: string }>([
    {
      name: 'its descriptor names another package digest than its module',
      edit: { modules: [variant({}, { packageDigest: NEXT })] },
      expected: 'incompatible/client_selection_descriptor',
    },
    {
      name: 'its descriptor declares a target its contribution does not',
      edit: { modules: [variant({}, { targets: ['web', 'tui', 'sdk', 'im'] })] },
      expected: 'incompatible/client_selection_descriptor',
    },
    {
      name: 'the catalog holds two generations of the package',
      edit: {
        modules: [
          MODULE,
          variant(
            { moduleId: 'acme.notes/client-next', packageDigest: NEXT, ownerToken: 'acme.notes/client#2' },
            { packageDigest: NEXT },
          ),
        ],
      },
      expected: 'incompatible/client_selection_digest',
    },
    {
      name: 'its module lacks the component export a Web renderer needs',
      edit: { namespace: withoutComponent },
      expected: 'incompatible/client_export_missing',
    },
    {
      name: 'its entry bytes do not match the asset digest',
      edit: { modules: [variant({ assetDigest: NEXT })] },
      expected: 'internal/client_module_load_failed',
      message: 'does not match its asset digest',
    },
  ])('is refused when $name', async ({ edit, expected, message }) => {
    const h = await activate('web', edit)
    expect(refused(h.outcome)).toBe(expected)
    if (message !== undefined) expect(!h.outcome.ok && h.outcome.error.message).toContain(message)
    expect(h.runtime.current()).toBeUndefined()
  })

  it.each<[string, DomainView]>([
    [
      'its schema revision is outside the renderer range',
      { ...VIEW, viewSchema: { ...VIEW.viewSchema, revision: 2 } },
    ],
    [
      'an action requires a feature the renderer does not declare',
      {
        ...VIEW,
        actions: [
          {
            kind: 'command',
            actionKey: 'share',
            label: 'Share',
            requiredFeatures: ['acme.notes/share'],
            availability: 'enabled',
            disabledReason: null,
            command: 'share',
            inputSchema: { typeId: 'acme.notes/share@1', revision: 1, digest: 'e'.repeat(64) },
          },
        ],
      },
    ],
  ])('shows the generic view instead when %s', async (_name, view) => {
    const h = await activate('web')
    const container = await mount(h.present(wire('DomainView', view)))
    expect(container.querySelector('.acme-note')).toBeNull()
    expect(container.querySelector('.generic-domain-view .generic-domain-text')?.textContent).toBe(
      'Note: Release checklist',
    )
  })
})

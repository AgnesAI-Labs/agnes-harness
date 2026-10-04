/** @vitest-environment happy-dom */
import type {
  DomainView,
  FormattedView,
  NegotiatedClientCapabilities,
  Outcome,
  RendererContext,
  RendererDefinition,
  RendererDescriptor,
  RendererPresentation,
  TextRenderer,
} from '@agnes/extension-api/client'
import { validateRuntime } from '@agnes/protocol/runtime'
import { formatDomainView } from '@agnes/sdk/runtime'
import { act, type ReactElement, type ReactNode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientTarget } from '../../src/runtime/client-selection.js'
import { type AuthorizedViews, createRendererPresenter } from '../../src/runtime/renderer-presentation.js'

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
  vi.restoreAllMocks()
})

const schema = { typeId: 'acme.notes/rename@1', revision: 1, digest: 'a'.repeat(64) }

const command = (actionKey: string, requiredFeatures: string[] = []) => ({
  kind: 'command' as const,
  actionKey,
  label: actionKey,
  requiredFeatures,
  availability: 'enabled' as const,
  disabledReason: null,
  command: actionKey,
  inputSchema: schema,
})

function view(revision: number, actions = [command('rename')], extra: Partial<DomainView> = {}): DomainView {
  const value: DomainView = {
    kind: 'domain',
    viewId: 'note-1',
    revision,
    domainType: 'acme.notes',
    viewSchema: { typeId: 'acme.notes/view@1', revision: 2, digest: 'b'.repeat(64) },
    renderKey: 'acme.notes/card',
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
    data: {},
    resources: [],
    actions,
    ...extra,
  }
  expect(validateRuntime('DomainView', value).ok).toBe(true)
  return value
}

const descriptor = (extra: Partial<RendererDescriptor> = {}): RendererDescriptor => ({
  id: 'acme.notes.card',
  packageDigest: 'd'.repeat(64),
  renderKey: 'acme.notes/card',
  targets: ['web', 'tui', 'im', 'sdk'],
  viewSchemaRanges: [{ typeId: 'acme.notes/view@1', minRevision: 1, maxRevision: 3 }],
  requiredFeatures: [],
  optionalFeatures: ['acme.beta'],
  scope: 'view',
  entry: './card.js',
  ...extra,
})

/** A Web renderer that records every render and every mount. */
function card(extra: Partial<RendererDescriptor> = {}) {
  const renders: { view: DomainView; context: RendererContext }[] = []
  let mounts = 0
  function Card({ view, context }: { view: DomainView; context: RendererContext }): ReactElement {
    renders.push({ view, context })
    useEffect(() => {
      mounts += 1
    }, [])
    return <p className="card">{`card ${view.viewId}@${view.revision}`}</p>
  }
  const definition = { descriptor: descriptor(extra), component: Card } as unknown as RendererDefinition
  return { definition, renders, mounts: () => mounts, last: () => renders.at(-1) }
}

const formatted = (shown: DomainView): FormattedView => ({
  viewId: shown.viewId,
  revision: shown.revision,
  parts: [],
  complete: true,
  unsupportedRequiredFeatures: [],
})
const formattedOf = (shown: DomainView): Outcome<FormattedView> => ({ ok: true, value: formatted(shown) })

function textRenderer(write: (shown: DomainView) => Outcome<FormattedView> = formattedOf) {
  const format = vi.fn<TextRenderer['format']>(write)
  const encode = vi.fn()
  return { definition: { descriptor: descriptor(), format, encode } as RendererDefinition, format, encode }
}

const capabilities = {
  clientInstanceId: 'client-1',
  target: 'web',
  features: [],
} as unknown as NegotiatedClientCapabilities

function setup(target: ClientTarget, ...held: DomainView[]) {
  const window = new Map(held.map((entry) => [entry.viewId, entry]))
  const views: AuthorizedViews = { current: (viewId) => window.get(viewId) }
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
    views,
  })
  return { presenter, submit, hold: (entry: DomainView) => window.set(entry.viewId, entry) }
}

const outcome = (result: Outcome<unknown>) =>
  result.ok ? 'ok' : `${result.error.code}/${result.error.detailCode}`

const submitted = (context: RendererContext, actionKey: string, viewRevision: number, viewId = 'note-1') =>
  context.commands
    .submit({
      action: { viewId, actionKey, viewRevision },
      commandSchema: schema,
      input: { kind: 'inline', schema, value: {}, digest: 'c'.repeat(64), bytes: 2 },
      requestId: `${viewId}-${actionKey}-${viewRevision}`,
      expectedRevision: 4,
    })
    .then(outcome)

function element(result: Outcome<RendererPresentation>): ReactElement {
  if (!result.ok || result.value.target !== 'web') throw new Error(`not a Web element: ${outcome(result)}`)
  return result.value.element
}

const show = (node: ReactNode) => act(async () => root.render(node))
type Presenting = (view: DomainView) => Outcome<RendererPresentation>

describe('renderer presentation', () => {
  it.each<[string, (presenter: ReturnType<typeof setup>['presenter']) => { present: Presenting }]>([
    ['a renderer', (presenter) => presenter.lease({ definition: card().definition, ownerToken: 'owner-1' })],
    ['the generic view', (presenter) => presenter.generic()],
  ])('asks for a resync through %s without the view in the window or at another revision', (_, take) => {
    const { presenter, hold } = setup('web')
    const lease = take(presenter)
    const missing = lease.present(view(1))
    expect(outcome(missing)).toBe('conflict/view_resync_required')
    expect(!missing.ok && missing.error.retryAdvice).toEqual({ kind: 'retry_read' })

    hold(view(2))
    for (const revision of [1, 3]) {
      const stale = lease.present(view(revision))
      expect(outcome(stale)).toBe('conflict/view_stale')
      expect(!stale.ok && stale.error.retryAdvice).toEqual({ kind: 'retry_read' })
    }
  })

  it('presents the window copy, so a passed view cannot widen the actions', async () => {
    const { presenter, submit } = setup('web', view(1))
    const renderer = card()
    const lease = presenter.lease({ definition: renderer.definition, ownerToken: 'owner-1' })
    await show(element(lease.present(view(1, [command('rename'), command('wipe')]))))

    const shown = renderer.last()
    expect(shown?.view.actions.map((action) => action.actionKey)).toEqual(['rename'])
    const context = shown?.context as RendererContext
    expect(await submitted(context, 'wipe', 1)).toBe('denied/outside_view')
    expect(await submitted(context, 'rename', 1)).toBe('ok')
    expect(submit).toHaveBeenCalledTimes(1)
  })

  const beta = [command('rename', ['acme.beta'])]
  const text = textRenderer().definition
  const { component } = card().definition as { component: unknown }
  it.each<[string, ClientTarget, RendererDefinition, DomainView]>([
    ['another render key', 'web', card({ renderKey: 'acme.notes/list' }).definition, view(1)],
    [
      'another schema type',
      'web',
      card({ viewSchemaRanges: [{ typeId: 'acme.notes/other@1', minRevision: 1, maxRevision: 3 }] })
        .definition,
      view(1),
    ],
    [
      'a schema revision out of range',
      'web',
      card({ viewSchemaRanges: [{ typeId: 'acme.notes/view@1', minRevision: 3, maxRevision: 4 }] })
        .definition,
      view(1),
    ],
    ['an undeclared target', 'web', card({ targets: ['tui'] }).definition, view(1)],
    ['an unsupported feature', 'web', card({ optionalFeatures: [] }).definition, view(1, beta)],
    ['a Web target without a component', 'web', text, view(1)],
    ['a text target without format', 'tui', card().definition, view(1)],
    [
      'an IM target without encode',
      'im',
      { descriptor: descriptor(), format: formattedOf } as never,
      view(1),
    ],
    ['a definition without a descriptor', 'web', { component } as unknown as RendererDefinition, view(1)],
  ])('refuses %s', (_, target, definition, shown) => {
    const { presenter } = setup(target, shown)
    const result = presenter.lease({ definition, ownerToken: 'owner-1' }).present(shown)
    expect(outcome(result)).toBe('incompatible/renderer_mismatch')
  })

  it('mounts the renderer with a context for this owner, the view and an optional feature', async () => {
    const shown = view(1, beta)
    const { presenter } = setup('web', shown)
    const renderer = card()
    await show(
      element(presenter.lease({ definition: renderer.definition, ownerToken: 'owner-1' }).present(shown)),
    )
    expect(host.querySelector('.card')?.textContent).toBe('card note-1@1')
    expect(renderer.last()?.context).toMatchObject({ clientInstanceId: 'client-1', ownerToken: 'owner-1' })
  })

  it('shows the fallback text as text when the renderer throws and keeps the rest of the tree', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { presenter } = setup('web', view(1))
    const broken = {
      descriptor: descriptor(),
      component: () => {
        throw new Error('<img src=x>')
      },
    } as unknown as RendererDefinition
    const presented = element(presenter.lease({ definition: broken, ownerToken: 'owner-1' }).present(view(1)))
    await show(
      <>
        {presented}
        <span className="sibling">still here</span>
      </>,
    )
    expect(host.textContent).toBe('Note <b>saved</b>still here')
    expect(host.querySelector('b, img')).toBeNull()

    // Another definition of the same owner presenting that view mounts afresh, past the failure.
    const renderer = card({ id: 'acme.notes.other' })
    await show(
      element(presenter.lease({ definition: renderer.definition, ownerToken: 'owner-1' }).present(view(1))),
    )
    expect(host.querySelector('.card')?.textContent).toBe('card note-1@1')
  })

  it('disposes the context when the element unmounts', async () => {
    const { presenter } = setup('web', view(1))
    const renderer = card()
    await show(
      element(presenter.lease({ definition: renderer.definition, ownerToken: 'owner-1' }).present(view(1))),
    )
    const context = renderer.last()?.context as RendererContext
    await show(null)
    expect(context.signal.aborted).toBe(true)
    expect(await submitted(context, 'rename', 1)).toBe('denied/renderer_disposed')
  })

  it('moves the mounted context to a newer revision instead of remounting', async () => {
    const { presenter, hold } = setup('web', view(1))
    const renderer = card()
    const lease = presenter.lease({ definition: renderer.definition, ownerToken: 'owner-1' })
    await show(element(lease.present(view(1))))
    hold(view(2, [command('publish')]))
    await show(element(lease.present(view(2))))

    expect(host.querySelector('.card')?.textContent).toBe('card note-1@2')
    expect(renderer.mounts()).toBe(1)
    expect(new Set(renderer.renders.map((entry) => entry.context)).size).toBe(1)
    const context = renderer.last()?.context as RendererContext
    expect(await submitted(context, 'rename', 1)).toBe('denied/outside_view')
    expect(await submitted(context, 'publish', 2)).toBe('ok')
  })

  it('shows the window copy of any view in the generic card, as text only', async () => {
    const { presenter } = setup('web', view(1))
    const passed = view(1, [command('rename'), command('wipe')], { renderKey: 'acme.other/list' })
    await show(element(presenter.generic().present(passed)))
    const card = host.querySelector('.generic-domain-view')
    expect(card?.textContent).toContain('Note <b>saved</b>')
    expect(host.querySelector('b, img')).toBeNull()
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['rename'])
  })

  it.each<ClientTarget>(['tui', 'sdk', 'im'])(
    'formats the window view for %s in the generic text',
    (target) => {
      const { presenter } = setup(target, view(1))
      const result = presenter.generic().present(view(1, [command('rename'), command('wipe')]))
      const expected = formatDomainView(view(1), { locale: 'en', capabilities })
      if (!expected.ok) throw new Error(expected.error.message)
      expect(result).toEqual({ ok: true, value: { target, formatted: expected.value } })
    },
  )

  it.each<ClientTarget>(['tui', 'sdk', 'im'])(
    'formats the window view for %s and sends nothing',
    (target) => {
      const { presenter } = setup(target, view(1))
      const renderer = textRenderer()
      const result = presenter
        .lease({ definition: renderer.definition, ownerToken: 'owner-1' })
        .present(view(1, [command('rename'), command('wipe')]))
      expect(result).toEqual({ ok: true, value: { target, formatted: formatted(view(1)) } })
      const [shown, context] = renderer.format.mock.calls[0] ?? []
      expect(shown?.actions.map((action) => action.actionKey)).toEqual(['rename'])
      expect(context).toEqual({ locale: 'en', capabilities })
      expect(renderer.encode).not.toHaveBeenCalled()
    },
  )

  it.each<[string, (shown: DomainView) => Outcome<FormattedView>]>([
    [
      'throws',
      () => {
        throw new Error('broken')
      },
    ],
    [
      'refuses',
      () => ({
        ok: false,
        error: {
          code: 'conflict',
          detailCode: 'x',
          message: 'no',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'x',
        },
      }),
    ],
    ['formats another view', (shown) => formattedOf({ ...shown, viewId: 'note-2' })],
  ])('refuses a renderer whose format %s', (_, format) => {
    const { presenter } = setup('tui', view(1))
    const definition = textRenderer(format).definition
    expect(outcome(presenter.lease({ definition, ownerToken: 'owner-1' }).present(view(1)))).toBe(
      'internal/renderer_failed',
    )
  })

  it('releases one lease without touching another lease of the same definition', async () => {
    const other = view(1, [command('rename')], { viewId: 'note-2' })
    const { presenter } = setup('web', view(1), other)
    const renderer = card()
    const first = presenter.lease({ definition: renderer.definition, ownerToken: 'owner-1' })
    const second = presenter.lease({ definition: renderer.definition, ownerToken: 'owner-1' })
    const late = element(first.present(view(1)))
    await show(
      <>
        {element(first.present(view(1)))}
        {element(second.present(other))}
      </>,
    )
    const contextOf = (viewId: string) =>
      renderer.renders.findLast((entry) => entry.view.viewId === viewId)?.context as RendererContext
    const [mine, theirs] = [contextOf('note-1'), contextOf('note-2')]

    await first.dispose()
    await first.dispose()
    expect(outcome(first.present(view(1)))).toBe('cancelled/renderer_released')
    expect(mine.signal.aborted).toBe(true)
    expect(await submitted(mine, 'rename', 1)).toBe('denied/renderer_disposed')
    expect(theirs.signal.aborted).toBe(false)
    expect(await submitted(theirs, 'rename', 1, 'note-2')).toBe('ok')
    expect(outcome(second.present(other))).toBe('ok')

    // An element presented before the release and mounted after it gets a refusing context.
    const elsewhere = createRoot(document.createElement('div'))
    await act(async () => elsewhere.render(late))
    expect(renderer.last()?.context.signal.aborted).toBe(true)
    await act(async () => elsewhere.unmount())
  })
})

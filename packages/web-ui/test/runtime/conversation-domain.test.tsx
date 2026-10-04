/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import {
  type DomainTimelineEntry,
  type DomainView,
  type RuntimeConversationWindow,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { webUiLocaleCatalog } from '@agnes/web-ui'
import {
  type ConversationMessage,
  ConversationMessages,
  type ConversationMessagesProps,
  type ConversationProjection,
  type ConversationProjectionStore,
  createConversationProjectionStore,
  projectConversationMessages,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import { type AppendMessage, type AssistantRuntime, AssistantRuntimeProvider } from '@assistant-ui/react'
import { act, createContext, createElement, type ReactNode, useContext, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let host: HTMLDivElement
let root: Root
let observed: AssistantRuntime | undefined

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  observed = undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function Harness({ store, props }: { store: ConversationProjectionStore; props: ConversationMessagesProps }) {
  const runtime = useConversationRuntime(store, props.t)
  useEffect(() => {
    observed = runtime
  }, [runtime])
  return createElement(AssistantRuntimeProvider, { runtime }, createElement(ConversationMessages, props))
}

async function mount(
  store: ConversationProjectionStore,
  props: Partial<ConversationMessagesProps> = {},
  wrap = (node: ReactNode) => node,
) {
  const t: ConversationMessagesProps['t'] = (key, vars) =>
    Object.entries(vars ?? {}).reduce(
      (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
      webUiLocaleCatalog.en[key] ?? key,
    )
  await act(async () => root.render(wrap(createElement(Harness, { store, props: { t, ...props } }))))
}

async function update(store: ConversationProjectionStore, projection: ConversationProjection) {
  await act(async () => store.update(projection))
}

const card = (id: string) => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
const ids = () =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-node-id]')).map((node) => node.dataset.nodeId)
const custom = (message: ConversationMessage | undefined) => message?.metadata.custom

const usage: UITurn['usage'] = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  calls: [],
}

function turn(status: UITurn['status'], nodeIds = ['u1', 'a1']): UITurn {
  return {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    startedAt: '2026-09-25T00:00:00.000Z',
    status,
    nodeIds,
    usage,
    inherited: false,
    forkable: true,
  }
}

const user: UINode = { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'plan a trip' }] }
const assistant: UINode = { kind: 'assistant', id: 'a1', seq: 2, text: 'here is the plan' }
const schemaRef = { typeId: 'example/travel/itinerary@1', revision: 1, digest: 'c'.repeat(64) }

function domain(
  id: string,
  phase: DomainView['phase'],
  fallbackText: string,
  turnId: string | null = 'turn:1',
  revision = 1,
  extra: Partial<DomainView> = {},
): DomainTimelineEntry {
  return {
    kind: 'domain',
    id,
    turnId,
    view: {
      kind: 'domain',
      viewId: id,
      revision,
      domainType: 'travel.itinerary',
      viewSchema: schemaRef,
      renderKey: 'travel.itinerary.card',
      scope: {
        kind: 'session',
        installationId: 'install-1',
        runtimeId: 'runtime-1',
        workspaceId: 'workspace-1',
        sessionId: 'session',
      },
      source: { eventIds: [`event:${id}:${revision}`], projectionRevision: revision },
      phase,
      fallbackText,
      data: { summary: fallbackText },
      resources: [],
      actions: [],
      ...extra,
    },
  }
}

/** Builds a window and proves it is a valid wire value before any test uses it. */
function conversationWindow(
  domains: DomainTimelineEntry[],
  order: RuntimeConversationWindow['order'],
  turns: UITurn[] = [turn('running')],
  nodes: UINode[] = [user, assistant],
): RuntimeConversationWindow {
  const window: RuntimeConversationWindow = {
    sessionId: 'session',
    epoch: 'epoch-1',
    revision: 1,
    native: {
      timeline: { sessionId: 'session', upto: nodes.length, generation: 1, opState: null, nodes, turns },
      history: { hasEarlier: false, startIndex: 0, totalNodes: nodes.length },
    },
    domains,
    order,
    orderCursor: 'order-1',
    nextPageCursor: null,
    complete: true,
  }
  expect(validateRuntime('RuntimeConversationWindow', window).ok).toBe(true)
  return window
}

const native = (id: string) => ({ kind: 'native' as const, id })
const domainRef = (id: string) => ({ kind: 'domain' as const, id })
const project = (window: RuntimeConversationWindow, nodes: UINode[] = []) =>
  projectConversationMessages({ sessionId: 'session', nodes, window })

describe('conversation window with domain cards', () => {
  it('keeps two concurrent domain cards independent', async () => {
    const window = conversationWindow(
      [
        domain('domain:flight', 'provisional', 'Flight on hold'),
        domain('domain:hotel', 'finalized', 'Hotel booked'),
      ],
      [native('u1'), domainRef('domain:flight'), domainRef('domain:hotel')],
    )
    await mount(createConversationProjectionStore({ sessionId: 'session', nodes: [], window }))
    expect(ids()).toEqual(['u1', 'domain:flight', 'domain:hotel'])
    expect(card('domain:flight')?.dataset.phase).toBe('provisional')
    expect(card('domain:flight')?.dataset.status).toBe('running')
    expect(card('domain:flight')?.textContent).toBe('Flight on hold')
    expect(card('domain:hotel')?.dataset.phase).toBe('finalized')
    expect(card('domain:hotel')?.dataset.status).toBe('complete')
    expect(card('domain:hotel')?.textContent).toBe('Hotel booked')
  })

  // Cards are keyed by entry id, which the server derives from the domain type, scope and view id, so
  // cards sharing only a view id stay apart through an upsert, a removal and a reset, and a removed card
  // is not presented again.
  it('keeps cards sharing a view id apart by domain type and scope', async () => {
    const workspace: DomainView['scope'] = {
      kind: 'workspace',
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
    }
    const shared = (id: string, text: string, revision: number, extra: Partial<DomainView>) =>
      domain(id, 'provisional', text, 'turn:1', revision, { viewId: 'shared', ...extra })
    const flight = shared('domain:flight', 'Flight', 1, { domainType: 'travel.flight' })
    const hotel = shared('domain:hotel', 'Hotel', 1, { domainType: 'travel.hotel' })
    const team = shared('domain:team', 'Team flight', 1, { domainType: 'travel.flight', scope: workspace })
    const booked = shared('domain:team', 'Team flight booked', 2, {
      domainType: 'travel.flight',
      scope: workspace,
      phase: 'finalized',
    })
    const presented: string[] = []
    const texts = (...cards: DomainTimelineEntry[]) => cards.map(({ id }) => card(id)?.textContent)
    const order = (...entries: DomainTimelineEntry[]) => [
      native('u1'),
      ...entries.map(({ id }) => domainRef(id)),
    ]
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [],
      window: conversationWindow([flight, hotel, team], order(flight, hotel, team)),
    })
    await mount(store, {
      renderDomain: (view) => {
        presented.push(`${view.domainType}/${view.scope.kind}@${view.revision}`)
        return view.fallbackText
      },
    })
    expect(ids()).toEqual(['u1', 'domain:flight', 'domain:hotel', 'domain:team'])
    expect(texts(flight, hotel, team)).toEqual(['Flight', 'Hotel', 'Team flight'])

    await update(store, {
      sessionId: 'session',
      nodes: [],
      window: conversationWindow([flight, hotel, booked], order(flight, hotel, booked)),
    })
    expect(texts(flight, hotel, booked)).toEqual(['Flight', 'Hotel', 'Team flight booked'])
    expect([card('domain:flight')?.dataset.phase, card('domain:team')?.dataset.phase]).toEqual([
      'provisional',
      'finalized',
    ])

    await update(store, {
      sessionId: 'session',
      nodes: [],
      window: conversationWindow([hotel, booked], order(hotel, booked)),
    })
    expect(ids()).toEqual(['u1', 'domain:hotel', 'domain:team'])
    expect(observed?.thread.getState().messages.map((message) => message.id)).toEqual(ids())

    // assistant-ui renders the previous messages once while it catches up, so presentations are counted
    // only after the removal settled: no later update presents the removed card again.
    presented.length = 0
    await update(store, {
      sessionId: 'session',
      nodes: [],
      window: conversationWindow(
        [booked, hotel],
        [domainRef('domain:team'), native('u1'), domainRef('domain:hotel')],
      ),
    })
    expect(ids()).toEqual(['domain:team', 'u1', 'domain:hotel'])
    expect(texts(booked, hotel)).toEqual(['Team flight booked', 'Hotel'])
    expect(new Set(presented)).toEqual(new Set(['travel.flight/workspace@2', 'travel.hotel/session@1']))
  })

  it('emits messages in window order and keeps native message ids', async () => {
    const window = conversationWindow(
      [
        domain('domain:flight', 'provisional', 'Flight on hold'),
        domain('domain:hotel', 'finalized', 'Hotel'),
      ],
      [domainRef('domain:hotel'), native('u1'), domainRef('domain:flight'), native('a1')],
    )
    const plain = projectConversationMessages({
      sessionId: 'session',
      nodes: [user, assistant],
      turns: [turn('running')],
    })
    const windowed = project(window)
    expect(windowed.map((message) => message.id)).toEqual(['domain:hotel', 'u1', 'domain:flight', 'a1'])
    expect(windowed.filter((message) => custom(message)?.kind !== 'domain')).toEqual(plain)
    await mount(createConversationProjectionStore({ sessionId: 'session', nodes: [], window }))
    expect(ids()).toEqual(['domain:hotel', 'u1', 'domain:flight', 'a1'])
    expect(observed?.thread.getState().messages.map((message) => message.id)).toEqual(ids())
  })

  it.each([
    ['a native id', [domain('a1', 'provisional', 'Clash')]],
    ['another domain id', [domain('domain:x', 'provisional', 'One'), domain('domain:x', 'finalized', 'Two')]],
  ])('rejects the whole window when a domain id repeats %s', async (_, domains) => {
    const window = conversationWindow(domains, [native('u1'), ...domains.map((entry) => domainRef(entry.id))])
    expect(project(window)).toEqual([])
    expect(project(window, [user]).map((message) => message.id)).toEqual(['u1'])
    const good = conversationWindow(
      [domain('domain:flight', 'provisional', 'Flight')],
      [domainRef('domain:flight')],
    )
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [], window: good })
    await mount(store)
    expect(ids()).toEqual(['domain:flight'])
    await update(store, { sessionId: 'session', nodes: [], window })
    expect(ids()).toEqual([])
  })

  it.each([
    ['provisional', 'running'],
    ['interrupted', 'incomplete'],
    ['finalized', 'complete'],
  ] as const)('maps the %s phase to %s', (phase, status) => {
    const [message] = project(
      conversationWindow([domain('domain:flight', phase, 'Flight')], [domainRef('domain:flight')]),
    )
    expect(message?.status?.type).toBe(status)
  })

  it('shows a failed turn provisional card as interrupted without rewriting its phase', async () => {
    const owned = domain('domain:flight', 'provisional', 'Flight on hold')
    const loose = domain('domain:note', 'provisional', 'Packing list', null)
    const window = conversationWindow(
      [owned, loose],
      [native('u1'), domainRef('domain:flight'), domainRef('domain:note')],
      [turn('failed')],
    )
    const [, flight, note] = project(window)
    expect(flight?.status?.type).toBe('incomplete')
    expect(custom(flight)).toEqual({ kind: 'domain', entry: owned })
    expect(owned.view.phase).toBe('provisional')
    expect(note?.status?.type).toBe('running')
    // assistant-ui may re-render while registering native message targets. Inspect each presented
    // view's data, rather than treating React render invocations as distinct domain cards.
    const views = new Map<string, DomainView>()
    await mount(createConversationProjectionStore({ sessionId: 'session', nodes: [], window }), {
      renderDomain: (view) => {
        views.set(view.viewId, view)
        return view.fallbackText
      },
    })
    expect(card('domain:flight')?.dataset.status).toBe('incomplete')
    expect(card('domain:flight')?.dataset.phase).toBe('provisional')
    expect(card('domain:note')?.dataset.status).toBe('running')
    expect([...views.values()].map((view) => view.phase)).toEqual(['provisional', 'provisional'])
    expect([...views.values()]).toEqual([owned.view, loose.view])
    expect(ids()).toEqual(['u1', 'domain:flight', 'domain:note'])
  })

  // HTML in server strings (case 5) and an unknown action (case 4): markup stays text, and an action of a
  // kind this client does not know, forged past validation, gets no control either.
  it('renders fallback text, data and resources as inert text without renderDomain', async () => {
    const markup = '<b>x</b><img src=x onerror=alert(1)><a href="javascript:alert(1)">go</a>'
    const entry = domain('domain:flight', 'finalized', markup, 'turn:1', 1, {
      data: { html: markup },
      resources: [
        {
          artifactId: 'artifact-1',
          version: 1,
          title: `${markup}.pdf`,
          mime: 'application/pdf',
          size: 10,
          status: 'ready',
        },
      ],
      actions: [
        {
          kind: 'command',
          actionKey: 'book',
          label: markup,
          requiredFeatures: [],
          availability: 'enabled',
          disabledReason: null,
          command: 'travel.book',
          inputSchema: schemaRef,
        },
      ],
    })
    const valid = conversationWindow([entry], [domainRef('domain:flight')])
    const forged = {
      kind: 'script',
      actionKey: 'run',
      label: 'Run',
      requiredFeatures: [],
      availability: 'enabled',
      disabledReason: null,
    }
    const actions = [...entry.view.actions, forged] as unknown as DomainView['actions']
    const window = { ...valid, domains: [{ ...entry, view: { ...entry.view, actions } }] }
    await mount(createConversationProjectionStore({ sessionId: 'session', nodes: [], window }))
    expect(card('domain:flight')?.textContent).toBe(`${markup}${markup}.pdf`)
    expect(host.querySelector('b, img, script, [onerror], [href]')).toBeNull()
    expect(host.querySelector('button, a, input, form')).toBeNull()
  })

  // A cancelled turn shows the provisional card interrupted until the finalized revision arrives; the
  // text the user selected elsewhere and the focus inside the card survive both updates.
  it('reuses the card node and keeps selection and focus when the same id is upserted', async () => {
    const props: Partial<ConversationMessagesProps> = {
      renderDomain: (view) =>
        createElement(
          'label',
          null,
          view.fallbackText,
          createElement('input', { 'data-revision': String(view.revision) }),
        ),
    }
    const held = domain('domain:flight', 'provisional', 'Flight on hold')
    const first = conversationWindow([held], [native('u1'), domainRef('domain:flight')])
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [], window: first })
    await mount(store, props)
    const before = card('domain:flight')
    expect(before?.dataset.status).toBe('running')
    const walker = document.createTreeWalker(card('u1') as HTMLElement, NodeFilter.SHOW_TEXT)
    let asked = walker.nextNode()
    while (asked && asked.nodeValue !== 'plan a trip') asked = walker.nextNode()
    const range = document.createRange()
    range.selectNodeContents(asked as Node)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    await update(store, {
      sessionId: 'session',
      nodes: [],
      window: conversationWindow([held], [native('u1'), domainRef('domain:flight')], [turn('cancelled')]),
    })
    expect([ids(), card('domain:flight')?.dataset.status]).toEqual([['u1', 'domain:flight'], 'incomplete'])
    const selection = document.getSelection()
    expect([selection?.toString(), selection?.anchorNode, asked?.isConnected]).toEqual([
      'plan a trip',
      asked,
      true,
    ])
    const input = before?.querySelector('input')
    input?.focus()
    expect(document.activeElement).toBe(input)
    const next = conversationWindow(
      [
        domain('domain:hotel', 'provisional', 'Hotel'),
        domain('domain:flight', 'finalized', 'Flight booked', 'turn:1', 2),
      ],
      [native('u1'), domainRef('domain:hotel'), domainRef('domain:flight')],
      [turn('cancelled')],
    )
    await update(store, { sessionId: 'session', nodes: [], window: next })
    expect(ids()).toEqual(['u1', 'domain:hotel', 'domain:flight'])
    expect(card('domain:flight')?.dataset.status).toBe('complete')
    expect(card('domain:flight')).toBe(before)
    expect(card('domain:flight')?.querySelector('input')).toBe(input)
    expect(input?.dataset.revision).toBe('2')
    expect(card('domain:flight')?.textContent).toBe('Flight booked')
    expect(document.activeElement).toBe(input)
  })

  it('renders the renderDomain element inside the outer React tree', async () => {
    const Outer = createContext('missing')
    function Reader({ view }: { view: DomainView }) {
      return createElement('output', null, `${useContext(Outer)}:${view.viewId}`)
    }
    const window = conversationWindow(
      [domain('domain:flight', 'provisional', 'Flight')],
      [domainRef('domain:flight')],
    )
    await mount(
      createConversationProjectionStore({ sessionId: 'session', nodes: [], window }),
      { renderDomain: (view) => createElement(Reader, { view }) },
      (node) => createElement(Outer.Provider, { value: 'outer' }, node),
    )
    expect(card('domain:flight')?.querySelector('output')?.textContent).toBe('outer:domain:flight')
  })

  it('shows domain cards after the turns when the host renders by turn', async () => {
    const window = conversationWindow(
      [domain('domain:flight', 'provisional', 'Flight')],
      [native('u1'), domainRef('domain:flight'), native('a1')],
    )
    await mount(createConversationProjectionStore({ sessionId: 'session', nodes: [], window }), {
      turns: window.native.timeline.turns,
    })
    const unassigned = host.querySelector<HTMLElement>('.timeline-unassigned')
    expect(unassigned?.hidden).toBe(false)
    expect(unassigned?.querySelector('[data-node-id="domain:flight"]')?.textContent).toBe('Flight')
    expect(ids()).toEqual(['u1', 'a1', 'domain:flight'])
  })

  // The conversation UI never issues a model or network request: it renders the store and refuses input.
  it('keeps the runtime disabled and refuses new messages', async () => {
    const fetch = vi.fn()
    const socket = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('WebSocket', socket)
    const window = conversationWindow(
      [domain('domain:flight', 'provisional', 'Flight')],
      [native('u1'), domainRef('domain:flight')],
    )
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [], window })
    await mount(store)
    expect(observed?.thread.getState().isDisabled).toBe(true)
    // ThreadRuntime.append drops the store promise, so the refusal is read from the thread core.
    const thread = observed?.thread as unknown as
      | {
          __internal_threadBinding: { getState: () => { append: (message: AppendMessage) => Promise<void> } }
        }
      | undefined
    const message: AppendMessage = {
      parentId: 'domain:flight',
      sourceId: null,
      runConfig: undefined,
      role: 'user',
      content: [{ type: 'text', text: 'book it' }],
      attachments: [],
      metadata: { custom: {} },
      createdAt: new Date(),
    }
    await expect(thread?.__internal_threadBinding.getState().append(message)).rejects.toThrow(
      'cannot submit a request',
    )
    expect(ids()).toEqual(['u1', 'domain:flight'])
    await update(store, {
      sessionId: 'session',
      nodes: [],
      window: conversationWindow(
        [domain('domain:flight', 'finalized', 'Flight booked', 'turn:1', 2)],
        [native('u1'), domainRef('domain:flight')],
      ),
    })
    expect(card('domain:flight')?.textContent).toBe('Flight booked')
    expect([fetch.mock.calls, socket.mock.calls]).toEqual([[], []])
  })
})

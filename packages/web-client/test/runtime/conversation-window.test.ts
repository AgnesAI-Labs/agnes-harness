import { type UITurn, validateAgainst } from '@agnes/protocol'
import {
  type ClientConversationSubscriptionFrame,
  type DomainTimelineEntry,
  type DomainView,
  type RuntimeConversationWindow,
  RuntimeSchemas,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  type ConversationWindowMerger,
  createConversationWindow,
  type WindowStep,
} from '../../src/runtime/conversation-window.js'

type Window = RuntimeConversationWindow
type Options = {
  revision?: number
  epoch?: string
  next?: string | null
  generation?: number
  views?: Record<string, Partial<DomainView>>
  turns?: UITurn[]
}

const SESSION = 'session-1'
const SUB = 'sub-1'
const APPLIED: WindowStep = { result: 'applied' }
const IGNORED: WindowStep = { result: 'ignored' }
const RESYNC = { result: 'resync', token: expect.any(Number) }

type Check = (
  name: 'RuntimeConversationWindow' | 'ClientConversationSubscriptionFrame',
  value: unknown,
) => boolean
const wire: Check = (name, value) => validateRuntime(name, value).ok
/** The schema alone; `validateRuntime` also applies the payload codec budget, which large windows exceed. */
const schema: Check = (name, value) => validateAgainst(RuntimeSchemas[name], value).ok

function domain(id: string, view: Partial<DomainView> = {}): DomainTimelineEntry {
  const revision = view.revision ?? 1
  return {
    kind: 'domain',
    id,
    turnId: null,
    view: {
      kind: 'domain',
      viewId: id,
      revision,
      domainType: 'travel.itinerary',
      viewSchema: { typeId: 'example/travel/itinerary@1', revision: 1, digest: 'c'.repeat(64) },
      renderKey: 'travel.itinerary.card',
      scope: {
        kind: 'session',
        installationId: 'install-1',
        runtimeId: 'runtime-1',
        workspaceId: 'workspace-1',
        sessionId: SESSION,
      },
      source: { eventIds: [`event:${id}:${revision}`], projectionRevision: revision },
      phase: 'provisional',
      fallbackText: id,
      data: { summary: id },
      resources: [],
      actions: [],
      ...view,
    },
  }
}

/** Ids starting with `d` are domain cards, the rest user nodes. Proves the window is a valid wire value. */
function win(ids: string[], options: Options = {}, check = wire): Window {
  const revision = options.revision ?? 1
  const next = options.next ?? null
  const nodes = ids
    .filter((id) => !id.startsWith('d'))
    .map((id, index) => ({
      kind: 'user' as const,
      id,
      seq: index + 1,
      content: [{ type: 'text' as const, text: id }],
    }))
  const window: Window = {
    sessionId: SESSION,
    epoch: options.epoch ?? 'epoch-1',
    revision,
    native: {
      timeline: {
        sessionId: SESSION,
        upto: nodes.length,
        generation: options.generation ?? 1,
        opState: null,
        nodes,
        turns: options.turns ?? [],
      },
      history: { hasEarlier: false, startIndex: 0, totalNodes: nodes.length },
    },
    domains: ids.filter((id) => id.startsWith('d')).map((id) => domain(id, options.views?.[id])),
    order: ids.map((id) => ({ kind: id.startsWith('d') ? 'domain' : 'native', id })),
    orderCursor: `order-${revision}`,
    nextPageCursor: next,
    complete: next === null,
  }
  expect(check('RuntimeConversationWindow', window)).toBe(true)
  return window
}

/** Windows `n1`..`n<revision>` at that revision. */
const upto = (revision: number) =>
  win(
    Array.from({ length: revision }, (_, index) => `n${index + 1}`),
    { revision },
  )

function frame(
  value: ClientConversationSubscriptionFrame,
  check = wire,
): ClientConversationSubscriptionFrame {
  expect(check('ClientConversationSubscriptionFrame', value)).toBe(true)
  return value
}
const head = (subscriptionId: string) => ({
  subscriptionId,
  topic: 'conversation' as const,
  cursor: 'frame-1',
})
const snapshot = (page: Window, subscriptionId = SUB) =>
  frame({ ...head(subscriptionId), kind: 'snapshot', payload: { page, nextCursor: null, complete: true } })
const replace = (window: Window, baseOrderCursor: string, check = wire) =>
  frame({ ...head(SUB), kind: 'change', payload: { kind: 'replace', baseOrderCursor, window } }, check)
const resets = {
  change: (window: Window) =>
    frame({ ...head(SUB), kind: 'change', payload: { kind: 'reset', window, reason: 'rebuild' } }),
  frame: (page: Window) =>
    frame({
      ...head(SUB),
      kind: 'reset',
      payload: { snapshot: { page, nextCursor: null, complete: true }, reason: 'rebuild' },
    }),
  snapshot: (page: Window) => snapshot(page),
}
const end = (subscriptionId = SUB) =>
  frame({ ...head(subscriptionId), kind: 'end', payload: { reason: 'closed' } })
const failure = frame({
  ...head(SUB),
  kind: 'error',
  payload: {
    code: 'internal',
    detailCode: 'conversation.failed',
    message: 'failed',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'diagnostic-1',
  },
})

function liveOn(page: Window): ConversationWindowMerger {
  const merger = createConversationWindow(SESSION)
  merger.subscribed(SUB)
  expect(merger.frame(snapshot(page))).toEqual(APPLIED)
  return merger
}

/** The composed window's order ids, after proving it is a valid wire value and coherent. */
function ids(merger: ConversationWindowMerger, check = wire): string[] {
  const window = merger.window
  if (!window) throw new Error('no window')
  expect(check('RuntimeConversationWindow', window)).toBe(true)
  const order = window.order.map((entry) => entry.id)
  const of = (kind: string) => window.order.filter((entry) => entry.kind === kind).map((entry) => entry.id)
  expect(new Set(order).size).toBe(order.length)
  expect(window.native.timeline.nodes.map((node) => node.id)).toEqual(of('native'))
  expect(window.domains.map((entry) => entry.id)).toEqual(of('domain'))
  expect([window.sessionId, window.native.timeline.sessionId]).toEqual([SESSION, SESSION])
  expect(window.complete).toBe(window.nextPageCursor === null)
  return order
}

function tokenOf(step: WindowStep): number {
  if (step.result !== 'resync') throw new Error(`expected a resync, got ${step.result}`)
  return step.token
}

function request(merger: ConversationWindowMerger) {
  const next = merger.earlier()
  if (!next) throw new Error('no earlier page')
  return next
}

const view = (merger: ConversationWindowMerger, id: string) =>
  merger.window?.domains.find((entry) => entry.id === id)?.view

describe('conversation window subscription', () => {
  it('accepts frames only from the bound subscription and keeps the window across subscriptions', () => {
    const merger = createConversationWindow(SESSION)
    const page = win(['n1', 'd1'])
    expect(merger.frame(snapshot(page))).toEqual(IGNORED)
    merger.subscribed(SUB)
    expect(merger.frame(snapshot(page, 'sub-other'))).toEqual(IGNORED)
    expect([merger.status, merger.window, merger.writable]).toEqual(['empty', null, false])

    expect(merger.frame(snapshot(page))).toEqual(APPLIED)
    expect([merger.status, merger.writable, ids(merger)]).toEqual(['live', true, ['n1', 'd1']])
    expect(merger.frame(end('sub-other'))).toEqual(IGNORED)
    expect(merger.status).toBe('live')

    const window = merger.window
    merger.subscribed('sub-2')
    expect(merger.window).toBe(window)
    expect(merger.frame(replace(win(['n1', 'd1', 'n2'], { revision: 2 }), 'order-1'))).toEqual(IGNORED)
    expect(merger.window).toBe(window)
    expect(merger.frame(snapshot(win(['n1', 'd1', 'n2'], { revision: 2 }), 'sub-2'))).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['n1', 'd1', 'n2'])
  })

  it.each<[string, (merger: ConversationWindowMerger) => unknown]>([
    ['a disconnect', (merger) => merger.disconnected()],
    ['an end frame', (merger) => merger.frame(end())],
    ['an error frame', (merger) => merger.frame(failure)],
  ])('%s keeps the window offline and read-only until a new snapshot', (_, lose) => {
    const merger = liveOn(win(['n1']))
    const window = merger.window
    lose(merger)
    expect([merger.status, merger.writable]).toEqual(['offline', false])
    expect(merger.window).toBe(window)
    merger.subscribed('sub-2')
    expect(merger.frame(snapshot(win(['n1', 'n2'], { revision: 2 }), 'sub-2'))).toEqual(APPLIED)
    expect([merger.status, merger.writable, ids(merger)]).toEqual(['live', true, ['n1', 'n2']])
  })

  it('revoke drops the window and its subscription at once; only the open it asked for restores it', () => {
    const merger = liveOn(win(['n1', 'd1'], { next: 'page-1' }))
    const pending = request(merger)
    const token = merger.revoke()
    expect([merger.window, merger.status, merger.writable]).toEqual([null, 'resyncing', false])
    expect(merger.frame(replace(win(['n1', 'd1', 'n2'], { revision: 2 }), 'order-1'))).toEqual(IGNORED)
    expect(merger.frame(snapshot(win(['n1', 'd1'], { revision: 2 })))).toEqual(IGNORED)
    expect(merger.frame(resets.frame(win(['n1', 'd1'], { revision: 2 })))).toEqual(IGNORED)
    expect(merger.earlier()).toBeNull()
    expect(merger.window).toBeNull()
    expect(merger.opened(token, win(['n1'], { revision: 3 }))).toEqual(APPLIED)
    expect([merger.status, merger.writable, ids(merger)]).toEqual(['live', true, ['n1']])
    // The revoked card stays gone: neither a late frame of the old subscription nor the page asked for
    // before the revocation brings it back.
    expect(merger.frame(replace(win(['n1', 'd1'], { revision: 4 }), 'order-3'))).toEqual(IGNORED)
    expect(merger.loadedEarlier(pending.token, win(['d0', 'd1'], { revision: 3 }))).toEqual(IGNORED)
    expect(ids(merger)).toEqual(['n1'])
  })

  // The caller runs every query; merging frames, opens and pages sends no request of its own.
  it('sends no request while merging', () => {
    const fetch = vi.fn()
    const socket = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('WebSocket', socket)
    try {
      const merger = liveOn(win(['n2', 'd2'], { next: 'page-1' }))
      expect(
        merger.frame(replace(win(['n2', 'd2', 'n3'], { revision: 2, next: 'page-1' }), 'order-1')),
      ).toEqual(APPLIED)
      expect(merger.loadedEarlier(request(merger).token, win(['n1']))).toEqual(APPLIED)
      expect(merger.opened(merger.resync(), upto(3))).toEqual(APPLIED)
      merger.disconnected()
      merger.revoke()
      expect([fetch.mock.calls, socket.mock.calls]).toEqual([[], []])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('conversation window replace', () => {
  const next = win(['n1', 'd1', 'n2', 'n3'], { revision: 3 })
  const { timeline } = next.native
  it.each<[string, Window, string, WindowStep['result']]>([
    ['a newer revision on the live cursor', next, 'order-2', 'applied'],
    ['the same revision', win(['n1', 'd1', 'n2', 'n3'], { revision: 2 }), 'order-2', 'ignored'],
    ['an older revision', win(['n1'], { revision: 1 }), 'order-2', 'ignored'],
    ['another base cursor', next, 'order-1', 'resync'],
    ['another epoch', win(['n1', 'd1', 'n2', 'n3'], { revision: 3, epoch: 'epoch-2' }), 'order-2', 'resync'],
    ['a missing order entry', { ...next, order: next.order.slice(1) }, 'order-2', 'resync'],
    [
      'a duplicate order entry',
      { ...next, order: [...next.order.slice(0, -1), { kind: 'native', id: 'n1' }] },
      'order-2',
      'resync',
    ],
    [
      'a duplicate native node',
      {
        ...next,
        native: { ...next.native, timeline: { ...timeline, nodes: [...timeline.nodes, ...timeline.nodes] } },
      },
      'order-2',
      'resync',
    ],
    [
      'a native id reused by a domain',
      {
        ...next,
        domains: [...next.domains, domain('n1')],
        order: [...next.order, { kind: 'domain', id: 'n1' }],
      },
      'order-2',
      'resync',
    ],
    ['another session', { ...next, sessionId: 'session-2' }, 'order-2', 'resync'],
    [
      'a timeline of another session',
      { ...next, native: { ...next.native, timeline: { ...timeline, sessionId: 'session-2' } } },
      'order-2',
      'resync',
    ],
    [
      'complete with a page cursor',
      { ...next, complete: true, nextPageCursor: 'page-1' },
      'order-2',
      'resync',
    ],
  ])('%s', (_, window, baseOrderCursor, result) => {
    const merger = liveOn(win(['n1', 'd1', 'n2'], { revision: 2 }))
    const before = merger.window
    expect(merger.frame(replace(window, baseOrderCursor)).result).toBe(result)
    if (result === 'applied') {
      expect(ids(merger)).toEqual(['n1', 'd1', 'n2', 'n3'])
      expect(merger.window?.revision).toBe(3)
    } else expect(merger.window).toBe(before)
    expect([merger.status, merger.writable]).toEqual(
      result === 'resync' ? ['resyncing', false] : ['live', true],
    )
  })

  it('keeps two concurrent domain cards independent through a replace of one', () => {
    const views: Record<string, Partial<DomainView>> = {
      d1: { phase: 'provisional', fallbackText: 'Flight on hold' },
      d2: { phase: 'provisional', fallbackText: 'Hotel on hold' },
    }
    const merger = liveOn(win(['n1', 'd1', 'd2'], { views }))
    const cards = () =>
      merger.window?.domains.map(({ id, view }) => [id, view.revision, view.phase, view.fallbackText])
    const update = {
      ...views,
      d1: { revision: 2, phase: 'finalized' as const, fallbackText: 'Flight booked' },
    }
    expect(merger.frame(replace(win(['n1', 'd1', 'd2'], { revision: 2, views: update }), 'order-1'))).toEqual(
      APPLIED,
    )
    expect(ids(merger)).toEqual(['n1', 'd1', 'd2'])
    expect(cards()).toEqual([
      ['d1', 2, 'finalized', 'Flight booked'],
      ['d2', 1, 'provisional', 'Hotel on hold'],
    ])
    // The other card ends interrupted while the first stays finalized; the older revision arriving
    // late changes neither card nor their order.
    const interrupted = {
      ...update,
      d2: { revision: 2, phase: 'interrupted' as const, fallbackText: 'Hotel failed' },
    }
    expect(
      merger.frame(replace(win(['n1', 'd1', 'd2'], { revision: 3, views: interrupted }), 'order-2')),
    ).toEqual(APPLIED)
    const settled = merger.window
    expect(merger.frame(replace(win(['n1', 'd2', 'd1'], { revision: 2, views: update }), 'order-1'))).toEqual(
      IGNORED,
    )
    expect(merger.window).toBe(settled)
    expect(ids(merger)).toEqual(['n1', 'd1', 'd2'])
    expect(cards()).toEqual([
      ['d1', 2, 'finalized', 'Flight booked'],
      ['d2', 2, 'interrupted', 'Hotel failed'],
    ])
  })

  // Cards are keyed by entry id, which the server derives from the domain type, scope and view id, so
  // cards sharing only a view id never overwrite each other; a removed one stays gone.
  it('keeps cards sharing a view id apart by domain type and scope through replace, removal and reset', () => {
    const workspace: DomainView['scope'] = {
      kind: 'workspace',
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
    }
    const views: Record<string, Partial<DomainView>> = {
      dFlight: { viewId: 'shared', domainType: 'travel.flight', fallbackText: 'Flight' },
      dHotel: { viewId: 'shared', domainType: 'travel.hotel', fallbackText: 'Hotel' },
      dTeam: { viewId: 'shared', domainType: 'travel.flight', scope: workspace, fallbackText: 'Team flight' },
    }
    const merger = liveOn(win(['n1', 'dFlight', 'dHotel', 'dTeam'], { views }))
    const cards = () =>
      merger.window?.domains.map(({ id, view }) => [
        id,
        view.viewId,
        view.domainType,
        view.scope.kind,
        view.revision,
        view.fallbackText,
      ])
    const flight = ['dFlight', 'shared', 'travel.flight', 'session', 1, 'Flight']
    const hotel = ['dHotel', 'shared', 'travel.hotel', 'session', 1, 'Hotel']
    expect(cards()).toEqual([
      flight,
      hotel,
      ['dTeam', 'shared', 'travel.flight', 'workspace', 1, 'Team flight'],
    ])

    const upserted = { ...views, dTeam: { ...views.dTeam, revision: 2, fallbackText: 'Team flight booked' } }
    const team = ['dTeam', 'shared', 'travel.flight', 'workspace', 2, 'Team flight booked']
    const all = ['n1', 'dFlight', 'dHotel', 'dTeam']
    expect(merger.frame(replace(win(all, { revision: 2, views: upserted }), 'order-1'))).toEqual(APPLIED)
    expect(cards()).toEqual([flight, hotel, team])

    // A removal starts a new epoch without the card; a late frame of the old epoch asks for a resync
    // instead of bringing it back.
    const removal = win(['n1', 'dHotel', 'dTeam'], { epoch: 'epoch-2', revision: 3, views: upserted })
    expect(
      merger.frame(
        frame({
          ...head(SUB),
          kind: 'change',
          payload: { kind: 'reset', window: removal, reason: 'removal' },
        }),
      ),
    ).toEqual(APPLIED)
    const removed = merger.window
    expect(merger.frame(replace(win(all, { revision: 4, views: upserted }), 'order-3'))).toEqual(RESYNC)
    expect(merger.window).toBe(removed)
    expect(cards()).toEqual([hotel, team])

    // A rebuild installs exactly the order and identities it carries.
    const rebuilt = win(['dTeam', 'n1', 'dHotel'], { epoch: 'epoch-3', views: upserted })
    expect(merger.frame(resets.frame(rebuilt))).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['dTeam', 'n1', 'dHotel'])
    expect(cards()).toEqual([team, hotel])
  })

  it('returns the same composed window until something changes', () => {
    const merger = liveOn(win(['n2'], { next: 'page-1' }))
    const window = merger.window
    const stale = request(merger)
    merger.earlier()
    expect(merger.loadedEarlier(stale.token, win(['n1']))).toEqual(IGNORED)
    expect(merger.frame(snapshot(win(['n9']), 'sub-other'))).toEqual(IGNORED)
    expect(merger.frame(replace(win(['n2', 'n3']), 'order-1'))).toEqual(IGNORED)
    expect(merger.window).toBe(window)
    expect(merger.frame(replace(win(['n2', 'n3'], { revision: 2, next: 'page-1' }), 'order-1'))).toEqual(
      APPLIED,
    )
    expect(merger.window).not.toBe(window)
    expect(ids(merger)).toEqual(['n2', 'n3'])
  })
})

describe('conversation window resync', () => {
  it('installs only the latest open token', () => {
    const merger = liveOn(win(['n1']))
    const first = merger.resync()
    const latest = merger.resync()
    expect([merger.status, merger.writable, ids(merger)]).toEqual(['resyncing', false, ['n1']])
    expect(merger.opened(first, win(['n1', 'n2'], { revision: 2 }))).toEqual(IGNORED)
    expect(merger.status).toBe('resyncing')
    expect(merger.opened(latest, upto(3))).toEqual(APPLIED)
    expect([merger.status, merger.writable, ids(merger)]).toEqual(['live', true, ['n1', 'n2', 'n3']])
    expect(merger.opened(latest, upto(4))).toEqual(IGNORED)

    const again = merger.resync()
    const step = merger.opened(again, { ...win(['n1']), sessionId: 'session-2' })
    expect(step).toEqual(RESYNC)
    expect(merger.opened(again, win(['n1']))).toEqual(IGNORED)
    expect(merger.opened(tokenOf(step), upto(5))).toEqual(APPLIED)
    expect(merger.window?.revision).toBe(5)
  })

  it('replays replaces received while resyncing instead of resyncing on each', () => {
    const merger = liveOn(upto(1))
    const token = tokenOf(merger.frame(replace(upto(3), 'order-2')))
    for (const revision of [2, 3, 4, 5])
      expect(merger.frame(replace(upto(revision), `order-${revision - 1}`))).toEqual(IGNORED)
    expect(merger.status).toBe('resyncing')
    expect(merger.opened(token, upto(3))).toEqual(APPLIED)
    expect([merger.status, merger.writable, merger.window?.revision]).toEqual(['live', true, 5])
    expect(ids(merger)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
  })

  it('asks again when a replayed replace has a gap, and keeps the rest for the next open', () => {
    const merger = liveOn(upto(1))
    const token = merger.resync()
    expect(merger.frame(replace(upto(3), 'order-2'))).toEqual(IGNORED)
    expect(merger.frame(replace(upto(4), 'order-3'))).toEqual(IGNORED)
    const step = merger.opened(token, upto(1))
    expect(step).toEqual(RESYNC)
    expect(tokenOf(step)).not.toBe(token)
    expect([merger.status, merger.window?.revision]).toEqual(['resyncing', 1])
    expect(merger.opened(tokenOf(step), upto(3))).toEqual(APPLIED)
    expect(merger.window?.revision).toBe(4)
  })

  it('bounds the replay buffer', () => {
    const merger = liveOn(upto(1))
    const token = merger.resync()
    for (let revision = 2; revision <= 300; revision++)
      expect(merger.frame(replace(win(['n1'], { revision }), `order-${revision - 1}`))).toEqual(IGNORED)
    // The oldest replaces were dropped, so the held ones no longer follow this open.
    expect(merger.opened(token, upto(1))).toEqual(RESYNC)
  })

  it.each(Object.entries(resets))(
    'a %s reset switches epoch, drops history and outdates pending requests',
    (_, reset) => {
      const merger = liveOn(win(['n3', 'd3'], { next: 'page-1' }))
      expect(merger.loadedEarlier(request(merger).token, win(['n1', 'n2'], { next: 'page-0' }))).toEqual(
        APPLIED,
      )
      expect(ids(merger)).toEqual(['n1', 'n2', 'n3', 'd3'])
      const pendingPage = request(merger)
      const pendingOpen = merger.resync()

      expect(merger.frame(reset(win(['n9'], { epoch: 'epoch-2', revision: 7 })))).toEqual(APPLIED)
      expect([merger.status, merger.writable, ids(merger)]).toEqual(['live', true, ['n9']])
      expect(merger.window).toMatchObject({ epoch: 'epoch-2', revision: 7, nextPageCursor: null })
      expect(merger.opened(pendingOpen, win(['n1']))).toEqual(IGNORED)
      expect(merger.loadedEarlier(pendingPage.token, win(['n0'], { epoch: 'epoch-2' }))).toEqual(IGNORED)
      expect(ids(merger)).toEqual(['n9'])
    },
  )
})

describe('conversation window history', () => {
  it('prepends earlier pages in page order without overwriting what is already held', () => {
    const merger = liveOn(
      win(['n5', 'd5', 'n6'], {
        revision: 4,
        next: 'page-1',
        views: { d5: { revision: 3, fallbackText: 'live card' } },
      }),
    )
    const first = request(merger)
    expect(first.cursor).toBe('page-1')
    // Read at a newer cut, the page also holds the live n5 and d5: neither its copies, its revision
    // nor its order cursor replace the live ones.
    const older = win(['n3', 'd3', 'd4', 'n4', 'n5', 'd5'], {
      revision: 9,
      next: 'page-2',
      views: {
        d4: { revision: 2, fallbackText: 'held card' },
        d5: { revision: 2, fallbackText: 'old card' },
      },
    })
    expect(merger.loadedEarlier(first.token, older)).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['n3', 'd3', 'd4', 'n4', 'n5', 'd5', 'n6'])
    expect(merger.window).toMatchObject({
      epoch: 'epoch-1',
      revision: 4,
      orderCursor: 'order-4',
      nextPageCursor: 'page-2',
      complete: false,
    })
    expect(view(merger, 'd5')).toMatchObject({ revision: 3, fallbackText: 'live card' })
    expect(merger.window?.native.timeline.nodes.find((node) => node.id === 'n5')?.seq).toBe(1)
    expect(merger.window?.native.timeline.upto).toBe(2)

    const second = request(merger)
    expect(second.cursor).toBe('page-2')
    const oldest = win(['n1', 'd3', 'd4', 'n2', 'n3'], {
      views: {
        d3: { revision: 2, fallbackText: 'newer card' },
        d4: { revision: 1, fallbackText: 'older card' },
      },
    })
    expect(merger.loadedEarlier(second.token, oldest)).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['n1', 'n2', 'n3', 'd3', 'd4', 'n4', 'n5', 'd5', 'n6'])
    expect(view(merger, 'd3')).toMatchObject({ revision: 2, fallbackText: 'newer card' })
    expect(view(merger, 'd4')).toMatchObject({ revision: 2, fallbackText: 'held card' })
    expect(merger.window?.native.timeline.nodes.find((node) => node.id === 'n3')?.seq).toBe(1)
    expect(merger.window).toMatchObject({
      revision: 4,
      orderCursor: 'order-4',
      nextPageCursor: null,
      complete: true,
    })
    expect(merger.earlier()).toBeNull()
    // The live cursor did not move: the next replace on it applies after the loaded history.
    const live = win(['n5', 'd5', 'n6', 'n7'], {
      revision: 5,
      views: { d5: { revision: 3, fallbackText: 'live card' } },
    })
    expect(merger.frame(replace(live, 'order-4'))).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['n1', 'n2', 'n3', 'd3', 'd4', 'n4', 'n5', 'd5', 'n6', 'n7'])
  })

  it('merges turns by id with the live window winning, in start order', () => {
    const usage: UITurn['usage'] = {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    }
    const turn = (id: string, startSeq: number, status: UITurn['status']): UITurn => ({
      id,
      turn: startSeq,
      startSeq,
      startedAt: '2026-09-25T00:00:00.000Z',
      status,
      nodeIds: [],
      usage,
      inherited: false,
      forkable: true,
    })
    const merger = liveOn(
      win(['n3'], { next: 'page-1', turns: [turn('t2', 2, 'running'), turn('t3', 4, 'running')] }),
    )
    const page = win(['n1'], { turns: [turn('t1', 1, 'completed'), turn('t2', 2, 'completed')] })
    expect(merger.loadedEarlier(request(merger).token, page)).toEqual(APPLIED)
    expect(merger.window?.native.timeline.turns.map(({ id, status }) => [id, status])).toEqual([
      ['t1', 'completed'],
      ['t2', 'running'],
      ['t3', 'running'],
    ])
  })

  it.each<[string, (merger: ConversationWindowMerger) => WindowStep, unknown]>([
    [
      'a stale token',
      (merger) => {
        const stale = request(merger)
        request(merger)
        return merger.loadedEarlier(stale.token, win(['n1']))
      },
      IGNORED,
    ],
    [
      'another epoch',
      (merger) => merger.loadedEarlier(request(merger).token, win(['n1'], { epoch: 'epoch-2' })),
      IGNORED,
    ],
    [
      'another generation',
      (merger) => merger.loadedEarlier(request(merger).token, win(['n1'], { generation: 2 })),
      RESYNC,
    ],
    [
      'an incoherent page',
      (merger) =>
        merger.loadedEarlier(request(merger).token, {
          ...win(['n1', 'd1']),
          order: [{ kind: 'native', id: 'n1' }],
        }),
      RESYNC,
    ],
    [
      'a page colliding with held history',
      (merger) => {
        expect(merger.loadedEarlier(request(merger).token, win(['d1'], { next: 'page-2' }))).toEqual(APPLIED)
        const window = merger.window
        // Coherent on its own, but its native node reuses the held domain card's id.
        const page = win(['n1'])
        const { timeline } = page.native
        const step = merger.loadedEarlier(request(merger).token, {
          ...page,
          order: [{ kind: 'native', id: 'd1' }],
          native: {
            ...page.native,
            timeline: { ...timeline, nodes: timeline.nodes.map((n) => ({ ...n, id: 'd1' })) },
          },
        })
        expect(merger.window).toBe(window)
        return step
      },
      RESYNC,
    ],
  ])('refuses %s', (_, load, step) => {
    const merger = liveOn(win(['n2'], { generation: 1, next: 'page-1' }))
    const before = merger.window
    const result = load(merger)
    expect(result).toEqual(step)
    if (result.result === 'ignored') expect(merger.window).toBe(before)
    expect(merger.status).toBe(result.result === 'resync' ? 'resyncing' : 'live')
    expect(merger.window?.orderCursor).toBe('order-1')
  })

  it('keeps history contiguous across replaces and hides entries the live window holds again', () => {
    const merger = liveOn(win(['n3', 'n4'], { next: 'page-1' }))
    expect(merger.loadedEarlier(request(merger).token, win(['n1', 'n2']))).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(
      merger.frame(replace(win(['n2', 'n3', 'n4', 'n5'], { revision: 2, next: 'page-9' }), 'order-1')),
    ).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
    expect(merger.window).toMatchObject({ revision: 2, nextPageCursor: null, complete: true })
    // n2 and n3 scroll out of the live window; history keeps them in place, with no hole.
    expect(merger.frame(replace(win(['n4', 'n5'], { revision: 3 }), 'order-2'))).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
    expect(merger.window).toMatchObject({ nextPageCursor: null, orderCursor: 'order-3' })
  })

  // A late history page never leaves a hole: it lands only while it still ends where the window starts.
  it('installs a page asked for before a replace only while the window still starts where it did', () => {
    const merger = liveOn(win(['n3', 'n4'], { next: 'page-1' }))
    const appended = request(merger)
    expect(
      merger.frame(replace(win(['n3', 'n4', 'n5'], { revision: 2, next: 'page-1' }), 'order-1')),
    ).toEqual(APPLIED)
    expect(merger.loadedEarlier(appended.token, win(['n2'], { next: 'page-0' }))).toEqual(APPLIED)
    expect(ids(merger)).toEqual(['n2', 'n3', 'n4', 'n5'])

    // n3 scrolls out of a live window with no loaded history, so the page asked for before n3 would leave
    // a hole before n4 (and claim completeness); the next request asks from the new start.
    const fresh = liveOn(win(['n3', 'n4'], { next: 'page-1' }))
    const late = request(fresh)
    expect(fresh.frame(replace(win(['n4', 'n5'], { revision: 2, next: 'page-2' }), 'order-1'))).toEqual(
      APPLIED,
    )
    expect(fresh.loadedEarlier(late.token, win(['n1', 'n2']))).toEqual(IGNORED)
    expect(ids(fresh)).toEqual(['n4', 'n5'])
    const again = request(fresh)
    expect(again.cursor).toBe('page-2')
    expect(fresh.loadedEarlier(again.token, win(['n1', 'n2', 'n3']))).toEqual(APPLIED)
    expect(ids(fresh)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
  })

  it('holds the composed order to the protocol bound', () => {
    const many = Array.from({ length: 9999 }, (_, index) => `n${index + 10}`)
    const merger = createConversationWindow(SESSION)
    merger.subscribed(SUB)
    expect(merger.opened(merger.resync(), win(many, { next: 'page-1' }, schema))).toEqual(APPLIED)
    const before = merger.window
    expect(merger.loadedEarlier(request(merger).token, win(['n1', 'n2'], { next: 'page-0' }))).toEqual(
      IGNORED,
    )
    expect(merger.window).toBe(before)
    expect(merger.loadedEarlier(request(merger).token, win(['n1'], { next: 'page-0' }))).toEqual(APPLIED)
    expect(ids(merger, schema)).toHaveLength(10000)
    expect(merger.window?.nextPageCursor).toBe('page-0')
    expect(merger.earlier()).toBeNull()
    // A live window that fills the bound by itself drops the loaded history.
    const full = win([...many, 'n5'], { revision: 2, next: 'page-live' }, schema)
    expect(merger.frame(replace(full, 'order-1', schema))).toEqual(APPLIED)
    expect(ids(merger, schema)).toHaveLength(10000)
    expect(merger.window?.nextPageCursor).toBe('page-live')
  })
})

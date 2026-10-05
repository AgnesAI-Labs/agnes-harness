// Browser acceptance host: real client roster, fibers and assets; deterministic backend data.
import { Context } from '@agnes/cordis'
import {
  AgnesClientService,
  CommandService,
  LocaleService,
  SessionService,
  SlotRegistry,
  ThemeService,
  WorkbenchService,
} from '@agnes/web-client'
import { createReconciler } from '../../packages/web/src/client-modules/reconcile.js'

const descriptor = await fetch('/plugin/agnes.client.json').then((response) => response.json())
const archived = {
  id: 'browser-comparison',
  revision: 1,
  phase: 'completed',
  storageState: 'released',
  baselineId: 'baseline',
  baselineDigest: 'a'.repeat(64),
  policyHash: 'b'.repeat(64),
  rounds: [],
  lanes: ['left', 'right'].map((side) => ({
    side,
    sessionId: side,
    runtime: { id: side === 'left' ? 'native' : 'jevloop', version: '1' },
    workspaceLabel: side,
    phase: 'idle',
    lastSeq: 0,
  })),
}
let forbidden = 0
const listeners = new Set()
const client = {
  connectionState: 'connected',
  sessions: { get: () => undefined },
  on: (_event, listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  call: async () => ({ events: [], lastSeq: 0, nextAfterSeq: null }),
  comparison: {
    list: async () => ({ items: [], nextCursor: null }),
    get: async () => structuredClone(archived),
    journal: async ({ id }) => ({
      id,
      entries: [
        {
          seq: 1,
          cuts: { left: 0, right: 0 },
          fact: {
            kind: 'coordinator',
            revision: 1,
            creation: 'ready',
            lanes: {},
            roundCount: 0,
            latestRound: null,
            cancellation: {},
            cleanup: { exited: ['left', 'right'], released: true },
          },
        },
      ],
      afterSeq: 0,
      throughSeq: 1,
      nextAfterSeq: 1,
      complete: true,
    }),
    projectUI: async ({ id, side, atSeq }) => ({
      id,
      side,
      atSeq,
      sessionId: side,
      throughSeq: 0,
      timeline: { sessionId: side, upto: 0, opState: null, nodes: [], turns: [] },
    }),
    metrics: async ({ id, atSeq }) => ({ id, atSeq, cuts: { left: 0, right: 0 }, lanes: [] }),
    priceDetails: async () => {
      throw Error('Fixture has no provider call')
    },
    cancel: async () => {
      forbidden++
    },
    remove: async () => {
      forbidden++
    },
    release: async () => {
      forbidden++
    },
  },
}
const ctx = new Context()
await ctx.plugin(SlotRegistry)
new AgnesClientService(ctx, client)
new CommandService(ctx, async () => true)
new SessionService(ctx, undefined, client)
new LocaleService(ctx, 'zh-CN')
new ThemeService(ctx, 'dark')
const workbench = new WorkbenchService(ctx)
const ids = {
  root: 'session-workspace',
  chat: 'session-chat',
  aside: 'workspace-aside',
  divider: 'workspace-divider',
  footer: 'workspace-footer',
  toolbar: 'workspace-toolbar',
  overlay: 'workspace-overlay',
}
const surfaces = Object.fromEntries(
  Object.entries(ids).map(([name, id]) => [name, document.getElementById(id)]),
)
workbench.configure({
  surfaces,
  select: async (target, current) => {
    if (!current()) return
    history.replaceState(null, '', target ? `?comparison=${encodeURIComponent(target.id)}` : '/')
  },
  changed() {},
})
const publish = (patch) => workbench.publish({ ...workbench.snapshot, connected: true, ...patch })
publish({ session: { id: 'native-browser', runtime: { id: 'native', version: '1' }, head: 0 } })
let enabled = false
let revision = 0
const reconciler = createReconciler({
  ctx,
  source: {
    list: async () => ({
      revision: String(revision),
      statuses: [],
      modules: enabled
        ? [
            {
              packageId: '@agnes/jev-web',
              rowId: 'ext:jev-web/main',
              revision: String(revision),
              entryUrl: `/plugin/${descriptor.client.entry.replace('./', '')}`,
              styleUrls: descriptor.client.styles.map((name) => `/plugin/${name.replace('./', '')}`),
              slots: descriptor.client.slots,
              services: descriptor.client.services,
              extIds: [],
            },
          ]
        : [],
    }),
  },
  removeOwner: (owner) => ctx.get('slots').removeOwner(owner),
})
window.fixture = {
  async enable(value) {
    enabled = value
    revision++
    await reconciler.reconcileNow()
  },
  selectJev() {
    publish({ session: { id: 'jev-browser', runtime: { id: 'jevloop', version: '1' }, head: 0 } })
  },
  newDraft() {
    workbench.clear()
    publish({ session: undefined, loading: false })
  },
  selectNative() {
    workbench.clear()
    history.replaceState(null, '', '/')
    publish({ session: { id: 'native-browser', runtime: { id: 'native', version: '1' }, head: 0 } })
  },
  async openComparison() {
    await workbench.restore(new URL('/?comparison=browser-comparison', location.href))
  },
  async trySubmit() {
    try {
      await workbench.submit('request', 'do not dispatch')
      return 'accepted'
    } catch {
      return 'refused'
    }
  },
  state: () => ({ forbidden, listeners: listeners.size, target: workbench.target?.id }),
}
document.getElementById('conversation-shell').textContent = 'Native conversation — host-owned content'

/** @vitest-environment happy-dom */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  ConfigSnapshot,
  PageSessionMeta,
  SessionGroupsResult,
  SessionListParams,
  SessionRuntimeDescriptor,
  UIOpeningResult,
  UIProjectionUpdate,
  UITimeline,
} from '@agnes/protocol'
import { attachmentLink, FILE_UPLOAD_PATH, MAX_FRAME_BYTES } from '@agnes/protocol'
import type { InitializeInfo, LedgerEvent } from '@agnes/sdk/browser'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

let releaseRuntime: import('../src/client-modules/boot.js').ClientModulesRuntime | undefined
let mountRelease: () => Promise<void>
async function bootApp(): Promise<void> {
  await import('../src/app.js')
  if (!releaseRuntime) throw new Error('Client modules did not start')
  await mountRelease()
}

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(),
  memoryJournal: vi.fn(() => ({})),
}))
const initialized = async (): Promise<InitializeInfo> => ({
  agnesVersion: '0.1.0',
  capabilities: {},
  platform: 'linux',
})
const configurationCallback = vi.hoisted(() => ({
  saved: undefined as ((snapshot: ConfigSnapshot) => Promise<void>) | undefined,
}))
const traceBridge = vi.hoisted(() => ({
  options: undefined as unknown,
  transcriptOptions: undefined as unknown,
  claim: undefined as unknown,
  metas: [] as unknown[],
  // The session readiness at each full transcript render.
  paints: [] as (string | undefined)[],
}))
vi.mock('../src/client-modules/boot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client-modules/boot.js')>()
  // The mock survives resetModules; retain matching service classes and React slot contexts.
  const { mountReleasePresentations } = await import('./release-presentations-fixture.js')
  return {
    ...actual,
    startClientModules: async (options: Parameters<typeof actual.startClientModules>[0]) => {
      traceBridge.options = options.trace
      traceBridge.transcriptOptions = options.transcript
      traceBridge.claim = options.claim
      const runtime = await actual.startClientModules(options)
      releaseRuntime = runtime
      mountRelease = () => mountReleasePresentations(runtime)
      const dispose = runtime.dispose.bind(runtime)
      let disposing: Promise<void> | undefined
      runtime.dispose = () => (disposing ??= dispose())
      if (runtime.trace) {
        const render = runtime.trace.render.bind(runtime.trace)
        runtime.trace.render = (nodes, turns, meta) => {
          traceBridge.metas.push(meta)
          render(nodes, turns, meta)
        }
      }
      if (runtime.transcript) {
        const render = runtime.transcript.render.bind(runtime.transcript)
        runtime.transcript.render = (nodes, turns, meta) => {
          traceBridge.paints.push(runtime.session.readiness.getSnapshot()?.status)
          render(nodes, turns, meta)
        }
      }
      return runtime
    },
  }
})
vi.mock('@agnes/web-admin/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/web-admin/settings')>()
  return {
    ...actual,
    createSettingsController: (options: Parameters<typeof actual.createSettingsController>[0]) => {
      configurationCallback.saved = options.onSaved
      return actual.createSettingsController(options)
    },
  }
})

const selectionController = vi.hoisted(() => ({
  open: undefined as ((id: string) => Promise<void>) | undefined,
}))
vi.mock('../src/app/session-controller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/session-controller.js')>()
  return {
    ...actual,
    createSessionController: (...args: Parameters<typeof actual.createSessionController>) => {
      const controller = actual.createSessionController(...args)
      selectionController.open = controller.open
      return controller
    },
  }
})

const binding = vi.hoisted(() => ({
  bindWebSession: vi.fn(),
  loadWebSession: vi.fn(),
}))
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

// Existing app fixtures own their rows, failures and deferred responses. Add the current sidebar
// wire shape here; explicit pagination fixtures bypass this adapter and keep their refusal semantics.
function sidebarListingFixture(read: (input: SessionListParams) => Promise<PageSessionMeta>) {
  const active = (page: PageSessionMeta) => page.items.filter((row) => !row.archived)
  const revision = (rows: PageSessionMeta['items']) =>
    createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  return {
    activity: vi.fn(async () => ({ items: [] })),
    groups: vi.fn(async (): Promise<SessionGroupsResult> => {
      const rows = active(await read({ limit: 100 }))
      return {
        ready: true,
        items: [
          {
            groupId: 'unassigned',
            total: rows.length,
            lastMessageAt: null,
            revision: revision(rows),
            ready: true,
          },
        ],
      }
    }),
    list: vi.fn(async (input: SessionListParams = {}) => {
      const page = await read(input)
      if (!('sidebar' in input)) return page
      const rows = active(page)
      const version = revision(rows)
      const offset = input.cursor ? Number(input.cursor.split(':')[1]) : 0
      if (input.cursor && input.cursor.split(':')[0] !== version)
        throw Object.assign(new Error('Session group changed'), {
          data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' },
        })
      const limit = input.limit ?? 5
      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        revision: version,
        ...(offset + limit < rows.length ? { next: `${version}:${offset + limit}` } : {}),
      }
    }),
  }
}

vi.mock('@agnes/sdk/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/sdk/browser')>()),
  // The live projection reads the connection state and keeps the disposers `on` returns.
  createClient: (...args: unknown[]) => {
    const client = sdk.createClient(...args)
    if (client && !('connectionState' in client)) client.connectionState = 'connected'
    // Session binding is mocked below; these doubles have no cached SDK session handles.
    if (client && !('sessions' in client)) client.sessions = new Map()
    if (vi.isMockFunction(client?.on) && !client.on.getMockImplementation())
      client.on.mockImplementation(() => () => undefined)
    if (client?.session?.list && !client.session.groups)
      Object.assign(client.session, sidebarListingFixture(client.session.list))
    return client
  },
  memoryJournal: sdk.memoryJournal,
}))

// i18n: the workbench defaults to English; these tests assert the zh-CN catalog,
// so the locale preference is pinned before each app start.
beforeEach(() => {
  localStorage.setItem('agnes-locale', 'zh-CN')
})
vi.mock('../src/session-binding.js', () => ({
  bindWebSession: binding.bindWebSession,
  loadWebSession: binding.loadWebSession,
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

type SessionDouble = {
  id: string
  rememberWorkspace: ReturnType<typeof vi.fn>
  controls: ReturnType<typeof vi.fn>
  control: ReturnType<typeof vi.fn>
  editQueued: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  events: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  followUp: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  removeQueued: ReturnType<typeof vi.fn>
  promoteQueued: ReturnType<typeof vi.fn>
  pendingCommands: ReturnType<typeof vi.fn>
  checkCommand: ReturnType<typeof vi.fn>
  onPermissionRequest: ReturnType<typeof vi.fn>
  onPreview: ReturnType<typeof vi.fn>
  projectUI: ReturnType<typeof vi.fn>
  projectUIOpening: ReturnType<typeof vi.fn<() => Promise<UIOpeningResult>>>
  projectUIPatch: ReturnType<typeof vi.fn<(after: number) => Promise<UIProjectionUpdate>>>
  projectUIHistory: ReturnType<typeof vi.fn>
  readToolDetail: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  setModel: ReturnType<typeof vi.fn>
  setYolo: ReturnType<typeof vi.fn>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function idleTimeline(sessionId: string, model?: { route: string; id: string }): UITimeline {
  return {
    sessionId,
    upto: 0,
    generation: 1,
    opState: null,
    yolo: false,
    nodes: [],
    turns: [],
    ...(model
      ? {
          usage: {
            totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            reasoningComplete: false,
            billingComplete: false,
            context: { tokens: 0, window: 128_000, autoCompact: true, source: 'estimated' as const },
            model: { ...model, thinking: 'off' as const },
          },
        }
      : {}),
  }
}

function busyTimeline(sessionId: string, model?: { route: string; id: string }): UITimeline {
  return {
    ...idleTimeline(sessionId, model),
    sessionId,
    upto: 1,
    generation: 1,
    opState: { turn: 1, step: 1, phase: 'inference' },
    yolo: false,
    nodes: [],
    turns: [],
  }
}

/**
 * The Web reads a bounded opening and then patches. The doubles serve both from one full-timeline
 * function: a patch upserts every node and turn of the latest timeline, which the windowed merge
 * accepts whatever changed.
 */
function session(id: string, projectUI: () => Promise<UITimeline>): SessionDouble {
  const opening = vi.fn<() => Promise<UIOpeningResult>>(async () => {
    const timeline = await projectUI()
    return { timeline, history: { hasEarlier: false, startIndex: 0, totalNodes: timeline.nodes.length } }
  })
  const patch = vi.fn(async (after: number) => {
    const timeline = await projectUI()
    return {
      kind: 'patch' as const,
      patch: {
        sessionId: timeline.sessionId,
        generation: timeline.generation,
        from: after,
        upto: Math.max(after, timeline.upto),
        totalNodes: timeline.nodes.length,
        opState: timeline.opState,
        ...(timeline.yolo === undefined ? {} : { yolo: timeline.yolo }),
        ...(timeline.pendingInputs === undefined ? {} : { pendingInputs: timeline.pendingInputs }),
        changes: timeline.nodes.map((node, index) => ({ op: 'upsert' as const, index, node })),
        turnChanges: timeline.turns.map((turn, index) => ({ op: 'upsert' as const, index, turn })),
        ...(timeline.usage ? { usage: timeline.usage } : {}),
      },
    }
  })
  return {
    projectUIOpening: opening,
    projectUIPatch: patch,
    projectUIHistory: vi.fn(async () => {
      throw new Error('no history in this double')
    }),
    id,
    rememberWorkspace: vi.fn(),
    controls: vi.fn(async () => ({
      controls: { steer: true, interrupt: true, pause: true, cancel: true },
      paused: false,
      facts: [],
      pending: ((await projectUI()).pendingInputs ?? []).map((item) => ({
        itemId: item.itemId,
        target: 'next-step',
        kind: 'steer',
        content: [{ type: 'text', text: item.preview }],
      })),
    })),
    control: vi.fn(async () => 1),
    editQueued: vi.fn(async () => 1),
    cancel: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    events: vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
        return: async () => ({ done: true, value: undefined }),
      }),
    })),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => 1),
    removeQueued: vi.fn(async () => 1),
    promoteQueued: vi.fn(async () => 1),
    pendingCommands: vi.fn(async () => []),
    checkCommand: vi.fn(async () => 1),
    onPermissionRequest: vi.fn(() => vi.fn()),
    onPreview: vi.fn(() => vi.fn()),
    projectUI: vi.fn(projectUI),
    readToolDetail: vi.fn(async () => ({
      call: { toolUseId: 'tool-1', name: 'read', args: { path: 'a' }, ordinal: 0 },
    })),
    prompt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => ({ effectiveFromSeq: 1 })),
    setYolo: vi.fn(async () => ({ effectiveFromSeq: 1 })),
  }
}

const packageRoot = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')
const publicHtml = await readFile(resolve(packageRoot, 'public/index.html'), 'utf8')

function installPublicFixture(): void {
  // The entry point is imported directly below; removing only its production module tag keeps this
  // test rooted in the public DOM without attempting an HTTP fetch for /app.js.
  document.documentElement.innerHTML = publicHtml
    .replace(/<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g, '')
    .replace(/<script type="module" src="\/app\.js"><\/script>/, '')
  history.replaceState(null, '', '/?session=old#test-launcher-token')
  sessionStorage.clear()
  localStorage.clear()
  localStorage.setItem('agnes-locale', 'zh-CN')
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ available: false }), { status: 200 })),
  )
}

function editPrompt(text: string): void {
  const composer = document.getElementById('prompt') as HTMLTextAreaElement
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(composer, text)
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit(text: string): void {
  editPrompt(text)
  document.getElementById('composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

/** Leave the selected task before opening it again; selecting the current row now keeps its live view. */
async function leaveCurrentSession(): Promise<void> {
  document.getElementById('new')?.click()
  await vi.waitFor(() =>
    expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(true),
  )
  closeWorkspacePicker()
  await vi.waitFor(() =>
    expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false),
  )
  await vi.waitFor(() => expect((document.getElementById('new') as HTMLButtonElement).disabled).toBe(false))
}

/** The picker has no cancel button; its ✕ closes it. */
function closeWorkspacePicker(): void {
  document.querySelector<HTMLButtonElement>('#new-session .ant-modal-close')?.click()
}

/** The model trigger opens the complete model list; the popover mounts with the render after the click. */
async function openModelList(): Promise<void> {
  await vi.waitFor(() => {
    if (!document.querySelector('#model-listbox')) throw new Error('model picker did not open')
  })
}

/** The model list is rendered directly in the picker. */
function modelMenu(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-listbox')
  if (!found) throw new Error('model picker did not open')
  return found
}

afterEach(async () => {
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'))
  })
  await releaseRuntime?.dispose()
  releaseRuntime = undefined
  vi.resetModules()
  vi.clearAllMocks()
  binding.loadWebSession.mockReset()
  binding.bindWebSession.mockReset()
  traceBridge.options = undefined
  traceBridge.transcriptOptions = undefined
  traceBridge.claim = undefined
  traceBridge.metas.length = 0
  traceBridge.paints.length = 0
  vi.unstubAllGlobals()
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
  document.documentElement.replaceChildren()
  sessionStorage.clear()
  localStorage.clear()
})

describe.each(['win32', 'darwin'])('sidebar startup failure recovery (%s)', (platform) => {
  async function boot(
    accountsReady = true,
    state: 'failed-page' | 'empty' | 'initializing' | 'failed-summary' | 'loaded' = 'failed-page',
  ) {
    installPublicFixture()
    history.replaceState(null, '', '/#test-launcher-token')
    const rows = ['old', 'other'].map((sessionId) => ({
      sessionId,
      title: `${sessionId} task`,
      createdAt: '2026-10-16T00:00:00Z',
      lastSeq: 0,
      generation: 1,
      preset: 'standard',
    }))
    const page = { items: rows, total: rows.length, revision: 'v1' }
    const list = vi.fn(async (input?: { q?: { prefix?: string } }) =>
      input?.q ? { items: rows.filter((row) => row.sessionId === input.q?.prefix) } : page,
    )
    if (state === 'failed-page') list.mockRejectedValueOnce(new Error('first sidebar page unavailable'))
    const client = {
      initialize: vi.fn(async () => ({ platform })),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({
          configured: accountsReady,
          profile: 'local-dev',
          ...(accountsReady ? {} : { accounts: [] }),
        })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      clientModules: { list: vi.fn(async () => ({ revision: 'r1', modules: [], statuses: [], rows: [] })) },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        list,
        activity: vi.fn(async () => ({ items: [] })),
        groups: vi.fn(
          async (): Promise<SessionGroupsResult> => ({
            ready: state !== 'initializing',
            items:
              state === 'empty' || state === 'initializing'
                ? []
                : [{ groupId: 'unassigned', total: 2, lastMessageAt: null, revision: 'v1', ready: true }],
          }),
        ),
        load: vi.fn(),
      },
    }
    if (state === 'failed-summary')
      client.session.groups.mockRejectedValueOnce(new Error('sidebar summary unavailable'))
    sdk.createClient.mockReturnValue(client)
    binding.loadWebSession.mockImplementation(async (_load, id: string) => ({
      session: session(id, async () => idleTimeline(id)),
      offPermission: vi.fn(),
    }))
    await bootApp()
    // Diagnostics run at the end of startup, after the automatic navigation decision.
    await vi.waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/admin/api/doctor')).toBe(true),
    )
    await act(async () => {})
    const retry = () => {
      const button = document.querySelector<HTMLButtonElement>('#sessions [role="alert"] button')
      if (!button) throw new Error('missing sidebar retry button')
      button.click()
    }
    return { list, page, retry, groups: client.session.groups, roster: client.clientModules.list }
  }

  it.each([true, false])(
    'does not treat a failed first page as an empty account (configured=%s)',
    async (configured) => {
      await boot(configured)
      expect(document.querySelector('#sessions [role="alert"]')?.textContent).toContain(
        'first sidebar page unavailable',
      )
      expect(document.querySelector('[data-testid="first-run-guide"]')).toBeNull()
      expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
      expect(binding.loadWebSession).not.toHaveBeenCalled()
      expect(new URL(location.href).searchParams.has('session')).toBe(false)
    },
    // The first case cold-imports the full application; behavioral polling keeps its normal deadline.
    180_000,
  )

  it('restores the first page on retry and lets the user open its session', async () => {
    const { retry } = await boot()
    retry()
    const row = await vi.waitFor(() => {
      const row = document.querySelector<HTMLButtonElement>('#sessions button[data-session="old"]')
      if (!row) throw new Error('missing recovered session')
      return row
    })
    expect(document.querySelector('#sessions [role="alert"]')).toBeNull()
    expect(binding.loadWebSession).not.toHaveBeenCalled()
    row.click()
    await vi.waitFor(() => expect(new URL(location.href).searchParams.get('session')).toBe('old'))
    expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
  })

  it('keeps a manually selected session when the first-page retry arrives late', async () => {
    const { list, page, retry } = await boot()
    const pending = deferred<typeof page>()
    list.mockImplementationOnce(() => pending.promise)
    retry()
    await vi.waitFor(() => expect(document.querySelector('#sessions [aria-busy="true"]')).not.toBeNull())
    await selectionController.open?.('other')
    expect(new URL(location.href).searchParams.get('session')).toBe('other')
    await act(async () => pending.resolve(page))
    await vi.waitFor(() => expect(document.querySelector('#sessions [data-session="old"]')).not.toBeNull())
    expect(new URL(location.href).searchParams.get('session')).toBe('other')
    expect(document.getElementById('task-title')?.textContent).toBe('other task')
    expect(binding.loadWebSession.mock.calls.map(([, id]) => id)).toEqual(['other'])
    expect(document.querySelector('[data-testid="first-run-guide"]')).toBeNull()
    expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
  })

  it('reports a selected-session lookup failure during sidebar retry without losing the selection', async () => {
    const { list, page, retry, groups } = await boot()
    groups.mockRejectedValueOnce(new Error('summary unavailable after selection'))
    await selectionController.open?.('other')
    await vi.waitFor(() =>
      expect(document.querySelector('#sessions [role="alert"]')?.textContent).toContain(
        'summary unavailable after selection',
      ),
    )
    await act(async () => {})
    list.mockImplementation(async (input) => {
      if (input?.q) throw new Error('selected session lookup unavailable')
      return page
    })
    retry()
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-notifications')?.textContent).toContain(
        'selected session lookup unavailable',
      ),
    )
    expect(new URL(location.href).searchParams.get('session')).toBe('other')
    expect(document.getElementById('task-title')?.textContent).toBe('other task')
    expect(document.querySelector('#sessions [data-session="old"]')).not.toBeNull()
  })

  it.each(['initializing', 'failed-summary'] as const)(
    'does not offer first-run setup while the sidebar is %s',
    async (state) => {
      await boot(false, state)
      expect(document.querySelector('[data-testid="first-run-guide"]')).toBeNull()
      expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
      expect(binding.loadWebSession).not.toHaveBeenCalled()
      expect(document.querySelector('#sessions [role]')).not.toBeNull()
    },
  )

  it.each([true, false])('preserves empty-account startup (configured=%s)', async (configured) => {
    const { roster } = await boot(configured, 'empty')
    expect(Boolean(document.querySelector('[data-testid="first-run-guide"]'))).toBe(!configured)
    // The guide opens over the shell; the sidebar and composer still come from the profile roster.
    await vi.waitFor(() => expect(roster).toHaveBeenCalledWith('local-dev', undefined))
    expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(configured)
    expect(binding.loadWebSession).not.toHaveBeenCalled()
    if (!configured) {
      const readsCatalog = () => vi.mocked(fetch).mock.calls.some(([url]) => url === '/admin/api/loops')
      expect(readsCatalog()).toBe(false)
      document.querySelector<HTMLButtonElement>('[data-testid="first-run-skip"]')?.click()
      await vi.waitFor(() => expect(readsCatalog()).toBe(true))
    }
  })

  it('still opens a successfully loaded existing session without first-run setup', async () => {
    await boot(false, 'loaded')
    expect(new URL(location.href).searchParams.get('session')).toBe('old')
    expect(document.querySelector('[data-testid="first-run-guide"]')).toBeNull()
    expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
  })
})

describe('web permission synchronization', () => {
  const label = () => document.querySelector('[data-permission-label]')?.textContent
  const choose = async (name: string) => {
    const trigger = document.getElementById('composer-permission') as HTMLButtonElement
    // A previous choice closes the list and re-enables the trigger with the next render.
    await vi.waitFor(() => {
      expect(trigger.disabled).toBe(false)
      expect(document.getElementById('permission-listbox')).toBeNull()
    })
    trigger.click()
    const option = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('#permission-listbox [role="option"]')].find(
        (row) => row.querySelector('.permission-picker-label')?.textContent === name,
      )
      if (!found) throw new Error(`missing permission option: ${name}`)
      return found
    })
    option.click()
  }

  async function boot(yolo: boolean | undefined, row: { permission?: string } = {}) {
    installPublicFixture()
    const timeline = idleTimeline('old')
    timeline.upto = 10
    if (yolo === undefined) delete timeline.yolo
    else timeline.yolo = yolo
    const old = session('old', async () => ({ ...timeline }))
    let receive: ((value: IteratorResult<LedgerEvent>) => void) | undefined
    const queued: LedgerEvent[] = []
    old.events.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<LedgerEvent>>((resolve) => {
            const event = queued.shift()
            if (event) resolve({ done: false, value: event })
            else receive = resolve
          }),
        return: async () => {
          receive?.({ done: true, value: undefined })
          receive = undefined
          queued.length = 0
          return { done: true, value: undefined }
        },
      }),
    }))
    const publish = (enabled: boolean, type = 'x/core/yolo-switch', data = { to: enabled }) => {
      timeline.yolo = enabled
      timeline.upto++
      const next = receive
      receive = undefined
      const event: LedgerEvent = {
        seq: timeline.upto,
        ts: '2026-10-01T00:00:00.000Z',
        id: String(timeline.upto).padStart(26, '0'),
        type,
        data,
        actor: { id: 'test', org: '', role: 'user', deptPath: [], attrs: {} },
        origin: 'principal',
        trust: 'trusted',
        _meta: {
          promptTurnId: '',
          eventSequence: timeline.upto,
          generation: 1,
          lane: 'main',
          phase: 'event',
        },
      }
      if (next) next({ done: false, value: event })
      else queued.push(event)
      return timeline.upto
    }
    old.setYolo.mockImplementation(async (enabled: boolean) => ({
      effectiveFromSeq: publish(enabled || row.permission === 'full-access'),
    }))
    const listeners = new Map<string, Set<() => void>>()
    const client = {
      connectionState: 'connected',
      initialize: vi.fn(initialized),
      on: vi.fn((event: string, listener: () => void) => {
        const handlers = listeners.get(event) ?? new Set<() => void>()
        handlers.add(listener)
        listeners.set(event, handlers)
        return () => handlers.delete(listener)
      }),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        list: vi.fn(async () => ({ items: [{ sessionId: 'old', ...row }] })),
        load: vi.fn(async () => old),
      },
    }
    sdk.createClient.mockReturnValue(client)
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await bootApp()
    await vi.waitFor(() =>
      expect((document.getElementById('composer-permission') as HTMLButtonElement).disabled).toBe(false),
    )
    const connect = (event: 'reconnecting' | 'reconnected') => {
      client.connectionState = event === 'reconnected' ? 'connected' : 'reconnecting'
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    }
    return { old, publish, timeline, connect, client }
  }

  const startupRaces = ['ordinary', 'start link', 'settings close', 'settings cancel', 'settings backdrop']
  describe.each(startupRaces)('startup list race %s', (entry) => {
    let pending: ReturnType<typeof deferred<{ items: { sessionId: string }[] }>>
    beforeEach(async () => {
      // Load the full application as fixture preparation; this race does not measure cold imports.
      installPublicFixture()
      if (entry === 'start link') history.replaceState(null, '', '/?new=1#test-launcher-token')
      if (entry.startsWith('settings '))
        history.replaceState(null, '', '/?settings=security#test-launcher-token')
      pending = deferred<{ items: { sessionId: string }[] }>()
      const client = {
        connectionState: 'connected',
        initialize: vi.fn(initialized),
        on: vi.fn(() => () => undefined),
        close: vi.fn(async () => undefined),
        apis: vi.fn(async () => ({ profile: { models: [] } })),
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: { list: vi.fn(() => pending.promise), load: vi.fn() },
      }
      sdk.createClient.mockReturnValue(client)
      await bootApp()
      await vi.waitFor(() =>
        expect(sdk.createClient.mock.results.at(-1)?.value.session.groups).toHaveBeenCalled(),
      )
    })

    it('keeps the user choice when the startup session list arrives after navigation', async () => {
      if (entry.startsWith('settings ')) {
        document.getElementById('settings')?.click()
        const dialog = document.getElementById('config') as HTMLDialogElement
        await vi.waitFor(() => expect(dialog.open).toBe(true))
        if (entry === 'settings close') document.getElementById('config-close')?.click()
        else if (entry === 'settings cancel') dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
        else dialog.click()
        expect(dialog.open).toBe(false)
        await act(async () => {
          pending.resolve({ items: [] })
        })
        expect(dialog.open).toBe(false)
        return
      }
      const newButton = document.getElementById('new') as HTMLButtonElement
      expect(newButton.disabled).toBe(entry === 'start link')
      newButton.click()
      pending.resolve({ items: [{ sessionId: 'old' }] })
      // The old row proves the late response was rendered, rather than guessing at a 20ms delay.
      await vi.waitFor(() => expect(document.querySelector('[data-session="old"]')).not.toBeNull())
      expect(document.querySelector('[data-testid="goal-bar"]')).toBeNull()
      expect(binding.loadWebSession).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(newButton.disabled).toBe(false))
      expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(entry === 'ordinary')
    })
  })

  it.each([
    'slow-models',
    'slow-models-start-link',
    'slow-models-empty',
    'failed-models',
    'failed-workspaces',
  ])('keeps the session list usable during startup with %s', async (kind) => {
    installPublicFixture()
    if (kind === 'slow-models-start-link') history.replaceState(null, '', '/?new=1#test-launcher-token')
    if (kind === 'slow-models-empty') history.replaceState(null, '', '/#test-launcher-token')
    const models = deferred<void>()
    const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    const sessionList = vi.fn(async () => ({
      items: kind === 'slow-models-empty' ? [] : [{ sessionId: 'old' }],
    }))
    const client = {
      initialize: vi.fn(initialized),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => {
        await models.promise
        if (kind === 'failed-models') throw new Error('models unavailable')
        return { profile: { models: [{ route: 'local', id: 'model-a' }] } }
      }),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: {
        list: vi.fn(async () => {
          if (kind === 'failed-workspaces') throw new Error('workspaces unavailable')
          return { items: [] }
        }),
      },
      session: {
        list: sessionList,
        load: vi.fn(async () => old),
      },
    }
    sdk.createClient.mockReturnValue(client)
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await bootApp()
    if (kind === 'slow-models-empty') await vi.waitFor(() => expect(sessionList).toHaveBeenCalled())
    else await vi.waitFor(() => expect(document.querySelector('[data-session="old"]')).not.toBeNull())
    expect(client.workspace.list).toHaveBeenCalled()
    if (kind === 'slow-models-start-link' || kind === 'slow-models-empty') {
      await selectionController.open?.('old')
      await vi.waitFor(() => expect(new URL(location.href).searchParams.get('session')).toBe('old'))
      await act(async () => {
        models.resolve()
        await models.promise
      })
      expect(new URL(location.href).searchParams.get('session')).toBe('old')
      expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
      return
    }
    // Existing conversations open before the model catalog resolves.
    await vi.waitFor(() => expect(binding.loadWebSession).toHaveBeenCalled())
    if (kind === 'slow-models') {
      await vi.waitFor(() =>
        expect((document.getElementById('new') as HTMLButtonElement).disabled).toBe(false),
      )
      document.getElementById('new')?.click()
      await vi.waitFor(() =>
        expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(true),
      )
    }
    models.resolve()
    if (kind === 'slow-models') {
      await vi.waitFor(() =>
        expect((document.getElementById('model') as HTMLButtonElement).disabled).toBe(false),
      )
      expect(new URL(location.href).searchParams.get('session')).toBeNull()
      expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(true)
    } else {
      await vi.waitFor(() => expect(binding.loadWebSession).toHaveBeenCalled())
      expect(document.querySelector('[data-session="old"]')).not.toBeNull()
      await vi.waitFor(() =>
        expect(document.querySelector('.agh-notifications')?.textContent).toContain(
          kind === 'failed-models' ? 'models unavailable' : '工作区列表',
        ),
      )
    }
  })

  it('restores full access on reopening, applies workspace selections, and follows remote patches', async () => {
    const { old, publish } = await boot(false)
    const staleReady = deferred<void>()
    const freshReady = deferred<void>()
    const projectPatch = old.projectUIPatch.getMockImplementation()
    if (!projectPatch) throw new Error('missing projection fixture')
    old.projectUIPatch
      .mockImplementationOnce(async (...args) => {
        const stale = await projectPatch(...args)
        await staleReady.promise
        return stale
      })
      .mockImplementationOnce(async (...args) => {
        await freshReady.promise
        return projectPatch(...args)
      })
    publish(false)
    await vi.waitFor(() => expect(old.projectUIPatch).toHaveBeenCalledTimes(1))
    await choose('完全访问')
    await vi.waitFor(() => expect(label()).toBe('完全访问'))
    expect(old.setYolo).toHaveBeenLastCalledWith(true)
    staleReady.resolve()
    await vi.waitFor(() => expect(old.projectUIPatch).toHaveBeenCalledTimes(2))
    expect(label()).toBe('完全访问')
    freshReady.resolve()
    await leaveCurrentSession()
    const opened = old.projectUIOpening.mock.calls.length
    document.querySelector<HTMLButtonElement>('[data-session="old"]')?.click()
    await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(opened))
    await vi.waitFor(() => expect(label()).toBe('完全访问'))
    expect(old.setYolo.mock.calls.some(([enabled]) => enabled === false)).toBe(false)

    await choose('可修改工作区')
    await vi.waitFor(() => expect(old.setYolo).toHaveBeenLastCalledWith(false))
    await vi.waitFor(() => expect(label()).toBe('可修改工作区'))
    const applied = old.setYolo.mock.calls.length
    await choose('可修改工作区')
    await vi.waitFor(() => expect(old.setYolo.mock.calls.length).toBe(applied + 1))
    expect(old.setYolo).toHaveBeenLastCalledWith(false)

    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull())
    const calls = old.setYolo.mock.calls.length
    publish(true)
    await vi.waitFor(() => expect(label()).toBe('完全访问'))
    publish(false)
    await vi.waitFor(() => expect(label()).toBe('可修改工作区'))
    submit('use the remotely selected workspace permissions')
    await vi.waitFor(() => expect(old.prompt).toHaveBeenCalled())
    expect(old.setYolo).toHaveBeenCalledTimes(calls)
    expect(old.projectUIPatch).toHaveBeenCalled()
  }, 40_000)

  it.each([
    ['read-only', '完全访问', false, '只读'],
    ['workspace-write', '只读', false, '可修改工作区'],
    ['full-access', '可修改工作区', false, '完全访问'],
    ['workspace-write', '完全访问', true, '完全访问'],
  ] as const)(
    'uses the backend authority of a %s session after %s is chosen',
    async (level, choice, yolo, shown) => {
      const { old } = await boot(level === 'full-access', { permission: level })
      const setPreset = vi.fn()
      Object.assign(old, { setPreset })
      await vi.waitFor(() => expect(label()).toBe(level === 'workspace-write' ? '可修改工作区' : shown))
      await choose(choice)
      await vi.waitFor(() => expect(old.setYolo).toHaveBeenLastCalledWith(yolo))
      await vi.waitFor(() => expect(label()).toBe(shown))
      // The level part is never sent to an open session; a different level is for new sessions.
      expect(setPreset).not.toHaveBeenCalled()
      const notice = document.getElementById('notice')?.textContent ?? ''
      if (choice === shown) expect(notice).not.toContain('只对新会话生效')
      else expect(notice).toContain(`权限档只对新会话生效。本会话仍为「${shown}」`)
    },
    40_000,
  )

  it.each([true, false])(
    'refreshes an open child composer and runtime from Core after parent changes (full: %s)',
    async (before) => {
      const { old, publish, timeline, client } = await boot(before, {
        permission: before ? 'workspace-write' : 'full-access',
      })
      const runtime = vi.fn(
        async (): Promise<SessionRuntimeDescriptor> => ({
          sessionKey: 'old',
          loaded: true,
          generation: { current: false, state: 'historical' },
          providers: [],
          seams: [],
          restartRequired: [],
          policy: {
            approvalMode: 'manual',
            toolPolicy: 'default',
            toolRuntime: 'default',
            readOnly: false,
            sandbox: { provider: 'local', onUnavailable: 'deny' },
            permission: {
              policy: timeline.yolo ? 'full-access' : 'workspace-write',
              principal: 'core-parent',
            },
          },
        }),
      )
      Object.assign(client.session, { runtime })
      Object.assign(client, {
        approval: { sessionGrants: async () => ({ grants: [] }) },
        call: async () => ({ items: [], tools: [], resources: [] }),
      })
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-session-action-id="old"]')?.click(),
      )
      const runtimeAction = await vi.waitFor(() => {
        const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) =>
          button.textContent?.includes('运行信息'),
        )
        expect(item).toBeDefined()
        return item!
      })
      runtimeAction.click()
      const summary = () =>
        document.querySelector('[data-testid="session-runtime-summary"]')?.textContent ?? ''
      await vi.waitFor(() => expect(summary()).toContain('core-parent'))
      // The notification deliberately lies; both labels must use the backend reads instead.
      publish(!before, 'x/core/permission-projection-invalidated', { to: before })
      await vi.waitFor(() => expect(label()).toBe(before ? '可修改工作区' : '完全访问'))
      await vi.waitFor(() => expect(summary()).toContain(before ? '可修改工作区' : '完全访问'))
      expect(runtime).toHaveBeenLastCalledWith('old')
      expect(old.setYolo).not.toHaveBeenCalled()
    },
    40_000,
  )

  it.each([false, true])(
    'refreshes permission before sending after reconnect (previous full: %s)',
    async (before) => {
      const { old, timeline, connect } = await boot(before)
      const failed = deferred<void>()
      const ready = deferred<void>()
      const opening = old.projectUIOpening.getMockImplementation()
      if (!opening) throw new Error('missing opening fixture')
      old.projectUIOpening
        .mockImplementationOnce(async (...args) => {
          await failed.promise
          return opening(...args)
        })
        .mockImplementationOnce(async (...args) => {
          await ready.promise
          return opening(...args)
        })
      const opened = old.projectUIOpening.mock.calls.length
      connect('reconnecting')
      timeline.yolo = !before
      timeline.upto++
      connect('reconnected')
      await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(opened))

      const pendingLabel = label()
      // An unrelated approval render must not restore the cached pre-disconnect projection.
      const permission = binding.loadWebSession.mock.calls.at(-1)?.[2]
      const abort = new AbortController()
      const approval = permission(
        {
          sessionId: 'old',
          toolCall: { toolCallId: 'reconnect-check', title: 'Reconnect check' },
          options: [],
        },
        { signal: abort.signal },
      )
      abort.abort()
      await approval
      const renderedLabel = label()
      submit('wait for the current permission')
      const submittedWhilePending = old.prompt.mock.calls.length
      failed.reject(new Error('reconnect opening unavailable'))
      await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(opened + 1))
      const failedLabel = label()
      submit('wait after the opening failed')
      const submittedAfterFailure = old.prompt.mock.calls.length
      ready.resolve()
      await vi.waitFor(() => expect(label()).toBe(before ? '可修改工作区' : '完全访问'))
      old.prompt.mockClear()
      submit('use the current permission')
      await vi.waitFor(() =>
        expect(old.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'use the current permission' }], {
          titleLocale: 'zh-CN',
          references: [],
        }),
      )
      expect.soft(pendingLabel).toBe('请选择权限')
      expect.soft(renderedLabel).toBe('请选择权限')
      expect.soft(failedLabel).toBe('请选择权限')
      expect.soft(submittedWhilePending).toBe(0)
      expect.soft(submittedAfterFailure).toBe(0)
      expect(old.setYolo).not.toHaveBeenCalled()
    },
    40_000,
  )

  describe('live approval card', () => {
    const options = [
      { optionId: 'allow_once', name: 'allow_once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'allow_always', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'reject_once', kind: 'reject_once' },
    ]
    const card = (tool: string, kind: string, rawInput: unknown) => ({
      sessionId: 'old',
      toolCall: {
        toolCallId: `call-${tool}`,
        title: `${tool} summary`,
        kind,
        rawInput,
        _meta: { 'ai.agnes.harness': { tool } },
      },
      options,
    })
    const ask = async (request: ReturnType<typeof card>) => {
      await boot(false)
      const permission = binding.loadWebSession.mock.calls.at(-1)?.[2]
      const answer = permission(request, { signal: new AbortController().signal })
      const region = document.getElementById('approval') as HTMLElement
      await vi.waitFor(() => expect(region.querySelector('.approval-actions button')).toBeTruthy())
      const buttons = () => [...region.querySelectorAll<HTMLButtonElement>('.approval-actions button')]
      return { answer, region, buttons, preview: () => region.querySelector('pre')?.textContent ?? '' }
    }

    it('keeps the end of a long command on the card and says what the session choice covers', async () => {
      const command = `${'a'.repeat(2900)} && touch TAIL_UNSEEN`
      const { answer, region, buttons, preview } = await ask(card('shell', 'execute', { command }))
      expect(region.textContent).toContain('将在此任务的工作目录执行命令')
      expect(preview()).toContain('touch TAIL_UNSEEN')
      expect(region.querySelector('.approval-warning')).toBeNull()
      expect(buttons().map((b) => b.textContent)).toEqual([
        '仅允许这次',
        '本会话内允许此工具的所有调用',
        '拒绝',
      ])
      buttons()[0]?.click()
      await expect(answer).resolves.toEqual({ optionId: 'allow_once' })
    })

    it.each([
      ['write', 'edit', { content: 'body', path: 'src/a.ts' }, '将创建或覆盖文件 src/a.ts'],
      ['edit', 'edit', { edits: [], path: 'src/a.ts' }, '将修改文件 src/a.ts'],
      ['web_fetch', 'fetch', { url: 'https://example.com/x' }, '将访问网址 https://example.com/x'],
      ['read', 'read', { path: 'notes.md' }, '将读取 notes.md'],
      ['mcp__db__query', 'other', { sql: 'select 1' }, '请核对工具及参数后决定是否继续'],
    ])('%s says what it will do and puts its locating field first', async (tool, kind, input, text) => {
      const { region, preview } = await ask(card(tool, kind, input))
      expect(region.textContent).toContain(text)
      expect(region.textContent).not.toContain('执行命令')
      const first = Object.keys(JSON.parse(preview()))[0]
      expect(first).toBe(Object.keys(input).includes('path') ? 'path' : Object.keys(input)[0])
    })

    it('puts path before content in the preview although it arrived after it', async () => {
      const { preview } = await ask(card('write', 'edit', { content: 'body', path: 'src/a.ts' }))
      expect(preview().indexOf('"path"')).toBeGreaterThan(-1)
      expect(preview().indexOf('"path"')).toBeLessThan(preview().indexOf('"content"'))
    })

    it('does not offer the session grant when part of the call is not on the card, and says so', async () => {
      const command = `${'a'.repeat(40_000)}TAIL_UNSEEN`
      const { answer, region, buttons, preview } = await ask(card('shell', 'execute', { command }))
      const total = JSON.stringify({ command }, null, 2).length
      expect(preview()).toContain(`…[已显示 32768 / 共 ${total} 字符]`)
      expect(preview()).not.toContain('TAIL_UNSEEN')
      expect(region.querySelector('.approval-warning')?.textContent).toContain('内容未完整显示')
      expect(buttons().map((b) => b.textContent)).toEqual(['仅允许这次', '拒绝'])
      buttons()[1]?.click()
      await expect(answer).resolves.toEqual({ optionId: 'reject_once' })
    })
  })

  it('requires a confirmed selection when an older backend omits its permission state', async () => {
    const { old, timeline, connect } = await boot(undefined)
    expect(label()).toBe('请选择权限')
    submit('wait for permission')
    expect(old.prompt).not.toHaveBeenCalled()
    const applied = deferred<{ effectiveFromSeq: number }>()
    old.setYolo.mockImplementationOnce(() => applied.promise)
    await choose('可修改工作区')
    await vi.waitFor(() => expect(old.setYolo).toHaveBeenCalledWith(false))
    submit('still waiting')
    expect(old.prompt).not.toHaveBeenCalled()
    applied.resolve({ effectiveFromSeq: 11 })
    await vi.waitFor(() => expect(label()).toBe('可修改工作区'))
    submit('confirmed permission')
    await vi.waitFor(() =>
      expect(old.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'confirmed permission' }], {
        titleLocale: 'zh-CN',
        references: [],
      }),
    )

    const opened = old.projectUIOpening.mock.calls.length
    connect('reconnecting')
    timeline.upto = 12
    connect('reconnected')
    await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(opened))
    await vi.waitFor(() => expect(label()).toBe('请选择权限'))
    old.prompt.mockClear()
    submit('reconnect needs a new confirmation')
    expect(old.prompt).not.toHaveBeenCalled()
    expect(old.setYolo).toHaveBeenCalledTimes(1)
    old.setYolo.mockImplementationOnce(async () => ({ effectiveFromSeq: ++timeline.upto }))
    await choose('可修改工作区')
    await vi.waitFor(() => expect(label()).toBe('可修改工作区'))
    submit('confirmed after reconnect')
    await vi.waitFor(() =>
      expect(old.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'confirmed after reconnect' }], {
        titleLocale: 'zh-CN',
        references: [],
      }),
    )
    expect(old.setYolo).toHaveBeenCalledTimes(2)
  }, 20_000)
})

describe('web session selection', () => {
  it('reads trace tool details from the selected session and tags trace snapshots with that session', async () => {
    installPublicFixture()
    const old = session('old', async () => idleTimeline('old'))
    const next = session('next', async () => idleTimeline('next'))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(initialized),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        list: vi.fn(async () => ({ items: [{ sessionId: 'old' }, { sessionId: 'next' }] })),
        load: vi.fn(async (id: string) => (id === 'old' ? old : next)),
      },
    })
    binding.loadWebSession.mockImplementation(async (_load: unknown, id: string) => ({
      session: id === 'old' ? old : next,
      offPermission: vi.fn(),
    }))

    await bootApp()
    expect(traceBridge.transcriptOptions).toMatchObject({ onFork: expect.any(Function) })
    expect(traceBridge.claim).toEqual(expect.any(Function))
    await vi.waitFor(() => expect(traceBridge.metas.at(-1)).toMatchObject({ sessionId: 'old' }))
    const reportProblem = document.getElementById('report-problem') as HTMLButtonElement
    reportProblem.click()
    const diagnostics = document.querySelector('dialog.diagnostics-dialog') as HTMLDialogElement
    expect(diagnostics.open).toBe(true)
    expect(diagnostics.querySelector('section:not([hidden])')?.getAttribute('data-step')).toBe('menu')
    diagnostics.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click()
    expect(diagnostics.open).toBe(false)
    expect(document.activeElement).toBe(reportProblem)
    const trace = traceBridge.options as {
      readToolDetail: (sessionId: string, callSeq: number, resultSeq?: number) => Promise<unknown>
    }
    await trace.readToolDetail('old', 3, 7)
    expect(old.readToolDetail).toHaveBeenCalledWith(3, 7, undefined)

    document.querySelector<HTMLButtonElement>('[data-session="next"]')?.click()
    await vi.waitFor(() => expect(traceBridge.metas.at(-1)).toMatchObject({ sessionId: 'next' }))
    await expect(trace.readToolDetail('old', 3, 7)).rejects.toThrow('会话已切换')
    await trace.readToolDetail('next', 9)
    expect(next.readToolDetail).toHaveBeenCalledWith(9, undefined, undefined)
    expect(old.readToolDetail).toHaveBeenCalledTimes(1)

    document.getElementById('new')?.click()
    await vi.waitFor(() => expect(traceBridge.metas.at(-1)).toBeUndefined())
    await expect(trace.readToolDetail('next', 9)).rejects.toThrow('没有当前会话')
    expect(next.readToolDetail).toHaveBeenCalledTimes(1)
  }, 15_000)

  it.each(['none', 'model', 'permission'] as const)(
    'opens a new draft with the last model and permission (reconnect during %s)',
    async (reconnectDuring) => {
      installPublicFixture()
      // 记住的权限要经由部署的允许列表校验；不提供运行时目录就会退回默认级别。
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (url) => {
          if (url === '/admin/api/runtime')
            return Response.json({
              providers: [],
              bundles: [],
              presets: [{ id: 'standard', isDefault: true }],
              permissions: [
                { id: 'read-only', isDefault: false },
                { id: 'workspace-write', isDefault: false },
                { id: 'full-access', isDefault: false },
              ],
              localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/workspace/plugins' },
            })
          if (url === '/admin/api/bundles') return Response.json({ catalog: [] })
          // 草稿目录与运行时目录在同一次读取里解析：任一项失败，运行时快照会被一起丢弃。
          if (url === '/admin/api/loops') return Response.json({ revision: 0, defaults: {}, loops: [] })
          if (url === '/admin/api/model-adapters') return Response.json({ modelAdapters: [] })
          return Response.json({ available: false })
        }),
      )
      history.replaceState(null, '', '/#test-launcher-token')
      localStorage.setItem(
        'agnes-web-composer-selection',
        JSON.stringify({ model: { route: 'local', id: 'model-b' }, permission: 'full' }),
      )
      vi.mocked(fetch).mockImplementation(async (url) => {
        if (url === '/admin/api/loops') return Response.json({ revision: 0, defaults: {}, loops: [] })
        if (url === '/admin/api/model-adapters') return Response.json({ modelAdapters: [] })
        if (url === '/admin/api/bundles') return Response.json({ catalog: [] })
        if (url === '/admin/api/runtime')
          return Response.json({
            providers: [],
            presets: [{ id: 'standard', isDefault: true }],
            permissions: [
              { id: 'workspace-write', isDefault: true },
              { id: 'full-access', isDefault: false },
            ],
            localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/workspace/plugins' },
          })
        return Response.json({ available: false })
      })
      const timeline = idleTimeline('fresh')
      const fresh = session('fresh', async () => timeline)
      fresh.setYolo.mockImplementation(async (enabled: boolean) => {
        timeline.yolo = enabled
        return { effectiveFromSeq: ++timeline.upto }
      })
      const applied = deferred<{ effectiveFromSeq: number }>()
      if (reconnectDuring === 'model') fresh.setModel.mockImplementationOnce(() => applied.promise)
      if (reconnectDuring === 'permission') fresh.setYolo.mockImplementationOnce(() => applied.promise)
      const draftModel = {
        route: 'local',
        id: 'model-b',
        contextWindow: 128000,
        thinkingLevelMap: { low: 'low', high: 'high' },
        defaultSettings: { thinking: 'high', contextWindow: 64000 },
      }
      const listeners = new Map<string, Set<() => void>>()
      const client = {
        connectionState: 'connected',
        initialize: vi.fn(initialized),
        on: vi.fn((event: string, listener: () => void) => {
          const handlers = listeners.get(event) ?? new Set<() => void>()
          handlers.add(listener)
          listeners.set(event, handlers)
          return () => handlers.delete(listener)
        }),
        close: vi.fn(async () => undefined),
        apis: vi.fn(async () => ({
          profile: {
            models: [{ route: 'local', id: 'model-a' }, draftModel],
          },
        })),
        config: {
          get: vi.fn(async () => ({
            configured: true,
            profile: 'local',
            provider: { id: 'local', route: 'local', model: 'model-a' },
          })),
          providers: vi.fn(async () => ({ providers: [] })),
          save: vi.fn(async () => ({ configured: true })),
          test: vi.fn(async () => ({ verified: true, models: [] })),
        },
        approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
        workspace: {
          list: vi.fn(async () => ({ items: [] })),
          add: vi.fn(async (path: string) => ({
            workspace: { path, name: 'agnes', lastUsedAt: null, sessionCount: 0, available: true },
          })),
        },
        session: {
          list: vi.fn(async () => ({ items: [] })),
          load: vi.fn(async () => fresh),
          new: vi.fn(async () => fresh),
        },
      }
      sdk.createClient.mockReturnValue(client)
      const connect = (event: 'reconnecting' | 'reconnected') => {
        client.connectionState = event === 'reconnected' ? 'connected' : 'reconnecting'
        for (const listener of [...(listeners.get(event) ?? [])]) listener()
      }
      binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
        session: selected,
        offPermission: vi.fn(),
      }))
      await bootApp()
      const model = document.getElementById('model') as HTMLButtonElement
      const permission = document.getElementById('composer-permission') as HTMLButtonElement
      await vi.waitFor(() => {
        expect(model.disabled).toBe(false)
        expect(model.querySelector('[data-model-label]')?.textContent).toBe('model-b')
      })
      await vi.waitFor(
        () => expect(permission.querySelector('[data-permission-label]')?.textContent).toBe('完全访问'),
        { timeout: 5000 },
      )
      // Reuse the current model-picker contract: choices live in their named radio panels.
      const settingsPanel = () => document.querySelector<HTMLElement>('#model-settings-popover')
      const choice = (group: string, label: string) => {
        const selected = [...document.querySelectorAll<HTMLButtonElement>(`#${group} [role="radio"]`)].find(
          (option) => option.querySelector('span')?.childNodes[0]?.textContent === label,
        )
        if (!selected) throw new Error(`missing choice: ${label}`)
        return selected
      }
      const choose = (group: string, label: string) => {
        choice(group, label).click()
      }
      // 提交在飞行中时触发按钮与面板会一起禁用，每次开关前等它落定。
      const openPanel = async (panel: 'thinking' | 'context' = 'thinking') => {
        await vi.waitFor(() => expect(model.disabled).toBe(false))
        if (!document.getElementById('model-listbox')) model.click()
        await vi.waitFor(() => expect(settingsPanel()).not.toBeNull())
        document.querySelector<HTMLButtonElement>(`#model-picker-${panel}`)?.click()
        await vi.waitFor(() => expect(settingsPanel()?.hidden).toBe(false))
      }
      const closePanel = async () => {
        await vi.waitFor(() => expect(model.disabled).toBe(false))
        if (document.getElementById('model-listbox')) model.click()
        await vi.waitFor(() => expect(document.getElementById('model-listbox')).toBeNull())
      }
      await openPanel('context')
      expect(document.getElementById('model-picker-context')?.textContent).toContain('64K')
      expect(settingsPanel()?.textContent).toContain('128K')
      await closePanel()
      await openPanel()
      expect(choice('session-model-thinking', '高').getAttribute('aria-checked')).toBe('true')
      choose('session-model-thinking', '低')
      // 草稿里的模型/权限确认已改由 Toast 呈现，不再占用输入卡上方的提示条。
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="operation-toast"]')?.textContent).toContain(
          '新会话将使用',
        ),
      )
      // 选完一个参数面板收起，改下一个要重新展开。
      await vi.waitFor(() => expect(document.getElementById('model-listbox')).toBeNull())
      await openPanel('context')
      choose('session-model-budget', '较小')
      await vi.waitFor(() => expect(document.getElementById('model-listbox')).toBeNull())
      draftModel.defaultSettings.contextWindow = 96000
      await configurationCallback.saved?.({
        profile: 'local',
        revision: 1,
        configured: true,
        provider: null,
        effect: 'new-sessions',
      })
      await openPanel()
      expect(choice('session-model-thinking', '低').getAttribute('aria-checked')).toBe('true')
      await closePanel()
      await openPanel('context')
      expect(choice('session-model-budget', '较小').getAttribute('aria-checked')).toBe('true')
      await closePanel()
      const cwd = document.getElementById('new-session-cwd') as HTMLInputElement
      cwd.value = '/workspace/agnes'
      cwd.dispatchEvent(new Event('input', { bubbles: true }))
      document
        .getElementById('new-session-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() =>
        expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false),
      )
      const prompt = document.getElementById('prompt') as HTMLTextAreaElement
      editPrompt('use the remembered selection')
      document
        .getElementById('composer')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(fresh.setModel).toHaveBeenCalled())
      expect(fresh.setModel).toHaveBeenCalledWith({
        slot: 'primary',
        route: 'local',
        model: 'model-b',
        thinking: 'low',
        contextWindow: 32000,
      })
      if (reconnectDuring !== 'none') {
        if (reconnectDuring === 'permission')
          await vi.waitFor(() => expect(fresh.setYolo).toHaveBeenCalledWith(true))
        const ready = deferred<void>()
        const opening = fresh.projectUIOpening.getMockImplementation()
        if (!opening) throw new Error('missing opening fixture')
        fresh.projectUIOpening.mockImplementationOnce(async (...args) => {
          await ready.promise
          return opening(...args)
        })
        const opened = fresh.projectUIOpening.mock.calls.length
        connect('reconnecting')
        connect('reconnected')
        await vi.waitFor(() => expect(fresh.projectUIOpening.mock.calls.length).toBeGreaterThan(opened))
        applied.resolve({ effectiveFromSeq: 1 })
        // A settled first-turn RPC must not continue sending on a different connection.
        await vi.waitFor(() =>
          expect(fresh.prompt.mock.calls.length > 0 || prompt.value === 'use the remembered selection').toBe(
            true,
          ),
        )
        const submittedBeforeOpening = fresh.prompt.mock.calls.length
        const permissionCalls = fresh.setYolo.mock.calls.length
        ready.resolve()
        await vi.waitFor(() =>
          expect(permission.querySelector('[data-permission-label]')?.textContent).toBe('可修改工作区'),
        )
        expect.soft(submittedBeforeOpening).toBe(0)
        expect.soft(permissionCalls).toBe(reconnectDuring === 'model' ? 0 : 1)
        expect.soft(prompt.value).toBe('use the remembered selection')
        permission.click()
        const full = await vi.waitFor(() => {
          const found = [
            ...document.querySelectorAll<HTMLElement>('#permission-listbox [role="option"]'),
          ].find((row) => row.querySelector('.permission-picker-label')?.textContent === '完全访问')
          if (!found) throw new Error('missing permission option')
          return found
        })
        full.click()
        await vi.waitFor(() =>
          expect(permission.querySelector('[data-permission-label]')?.textContent).toBe('完全访问'),
        )
        submit('use the remembered selection')
      }
      expect(fresh.setYolo).toHaveBeenCalledWith(true)
      await vi.waitFor(() =>
        expect(fresh.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'use the remembered selection' }], {
          titleLocale: 'zh-CN',
          references: [],
        }),
      )
      expect(permission.querySelector('[data-permission-label]')?.textContent).toBe('完全访问')
    },
    20_000,
  )

  it('starts a draft in the workspace chosen from its sidebar action', async () => {
    installPublicFixture()
    const alpha = {
      workspaceId: 'a'.repeat(64),
      path: '/workspace/alpha',
      name: 'Alpha',
      lastUsedAt: null,
      sessionCount: 1,
      available: true,
    }
    const beta = {
      workspaceId: 'b'.repeat(64),
      path: '/workspace/beta',
      name: 'Beta',
      lastUsedAt: null,
      sessionCount: 0,
      available: true,
    }
    const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    const fresh = session('fresh', async () => idleTimeline('fresh', { route: 'local', id: 'model-a' }))
    const create = vi.fn(async () => fresh)
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(initialized),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      workspace: { list: vi.fn(async () => ({ items: [alpha, beta] })) },
      session: {
        activity: vi.fn(async () => ({ items: [] })),
        groups: vi.fn(
          async (): Promise<SessionGroupsResult> => ({
            ready: true,
            items: [alpha, beta].map((workspace) => ({
              groupId: workspace.workspaceId,
              workspaceId: workspace.workspaceId,
              total: workspace.sessionCount,
              lastMessageAt: null,
              revision: '1',
              ready: true,
            })),
          }),
        ),
        list: vi.fn(async (input: SessionListParams) => ({
          items:
            'sidebar' in input && input.sidebar.groupId === beta.workspaceId
              ? []
              : [{ sessionId: 'old', cwd: alpha.path, workspaceId: alpha.workspaceId }],
          ...('sidebar' in input
            ? { total: input.sidebar.groupId === beta.workspaceId ? 0 : 1, revision: '1' }
            : {}),
        })),
        load: vi.fn(async () => old),
        new: create,
      },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await bootApp()
    const createInBeta = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-workspace-new-session="/workspace/beta"]',
      )
      expect(button).toBeTruthy()
      expect(button?.disabled).toBe(false)
      return button as HTMLButtonElement
    })
    createInBeta.click()

    await vi.waitFor(() => expect(document.querySelector('[data-workspace-label]')?.textContent).toBe('Beta'))
    expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
    expect(create).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false),
    )

    editPrompt('create in beta')
    await vi.waitFor(() =>
      expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
    )
    submit('create in beta')
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledWith({
      cwd: beta.path,
      permission: 'default',
      sessionKey: expect.any(String),
    })
    await vi.waitFor(() =>
      expect(fresh.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'create in beta' }], {
        titleLocale: 'zh-CN',
        references: [],
      }),
    )
  })

  it('keeps controls usable after a pending model update and refreshes both old and new drafts', async () => {
    installPublicFixture()
    let models = [{ route: 'local', id: 'model-a' }]
    const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(initialized),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })), load: vi.fn(async () => old) },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await bootApp()
    const control = (id: string) => document.getElementById(id) as HTMLButtonElement
    await vi.waitFor(() => expect(control('model').disabled).toBe(false))
    const snapshot = {
      configured: true,
      effect: 'restart-required',
      provider: { id: 'new', route: 'new', model: 'model-b' },
    } as ConfigSnapshot
    const savedCallback = configurationCallback.saved
    if (!savedCallback) throw new Error('settings callback not bound')
    await savedCallback(snapshot)
    for (const id of ['model', 'composer-workspace', 'composer-permission', 'new', 'prompt'])
      expect(control(id).disabled).toBe(false)
    // The account settings owner reports the restart consequence, not this refresh callback.
    expect(document.getElementById('notice')?.textContent).toBe('')
    control('model').click()
    await openModelList()
    expect(modelMenu().textContent).toContain('model-a')
    expect(modelMenu().textContent).not.toContain('model-b')
    control('model').click()
    models = [...models, { route: 'new', id: 'model-b' }]
    await savedCallback({ ...snapshot, effect: 'new-sessions' })
    control('model').click()
    await openModelList()
    expect(modelMenu().textContent).toContain('model-b')
    control('model').click()
    control('new').click()
    await vi.waitFor(() => expect(control('model').disabled).toBe(false))
    for (const id of ['composer-workspace', 'composer-permission', 'prompt'])
      expect(control(id).disabled).toBe(false)
    models = []
    await savedCallback({ ...snapshot, configured: false })
    for (const id of ['composer-workspace', 'composer-permission', 'new', 'prompt'])
      expect(control(id).disabled).toBe(false)
    expect(control('send').disabled).toBe(true)
  })

  it('keeps the model picker flat and applies the selected model settings', async () => {
    installPublicFixture()
    const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(initialized),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      // Model capability metadata stays available to settings even though the picker is flat.
      apis: vi.fn(async () => ({
        profile: {
          models: [
            {
              route: 'local',
              id: 'model-a',
              reasoning: true,
              thinkingLevelMap: { low: 'low', high: 'high' },
            },
          ],
        },
      })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })), load: vi.fn(async () => old) },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await bootApp()
    const control = (id: string) => document.getElementById(id) as HTMLButtonElement
    await vi.waitFor(() => expect(control('model').disabled).toBe(false))

    const rows = () => Array.from(modelMenu().querySelectorAll<HTMLElement>('[role="option"]'))
    control('model').click()
    await openModelList()
    rows()[0]?.click()
    await vi.waitFor(() =>
      expect(old.setModel).toHaveBeenCalledWith({
        slot: 'primary',
        route: 'local',
        model: 'model-a',
        thinking: 'off',
        contextWindow: 128000,
      }),
    )

    // 模型列表仍是一段，按服务商账户分组；档位与预算是同面板的另外两段，没有二级菜单。
    await vi.waitFor(() => expect(control('model').disabled).toBe(false))
    control('model').click()
    await openModelList()
    expect(document.querySelector('.model-picker-entry, #model-submenu-listbox')).toBeNull()
    expect(rows().map((row) => row.textContent?.trim())).toContain('model-a')
    expect(modelMenu().querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('已配置账户')
    control('model').click()
  }, 20_000)

  it('scopes saved catalogs to drafts and rejects late catalogs from earlier drafts', async () => {
    installPublicFixture()
    const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    const apis = vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(initialized),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis,
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })), load: vi.fn(async () => old) },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await bootApp()
    await vi.waitFor(() =>
      expect((document.getElementById('model') as HTMLButtonElement).disabled).toBe(false),
    )
    const stale = deferred<Response>()
    const firstCatalog = deferred<Response>()
    let loopReads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        if (url === '/admin/api/loops') {
          if (++loopReads === 1) return firstCatalog.promise
          if (loopReads === 2) return stale.promise
          return Response.json({ revision: 2, defaults: { permission: 'full-access' }, loops: [] })
        }
        if (url === '/admin/api/model-adapters') return Response.json({ modelAdapters: [] })
        if (url === '/admin/api/composition') return Response.json({})
        if (url === '/admin/api/runtime')
          return Response.json({
            providers: [],
            bundles: [],
            presets: [{ id: 'standard', isDefault: true }],
            permissions: [
              { id: 'full-access', isDefault: true },
              { id: 'read-only', isDefault: false },
            ],
            localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/workspace/plugins' },
          })
        if (url === '/admin/api/bundles') return Response.json({ catalog: [] })
        return Response.json({ available: false })
      }),
    )
    const newButton = () => document.getElementById('new') as HTMLButtonElement
    window.dispatchEvent(new CustomEvent('agnes:session-configuration-changed'))
    await vi.waitFor(() => expect(apis).toHaveBeenCalledTimes(2))
    expect(loopReads).toBe(0)
    const detached = deferred<void>()
    old.detach.mockImplementationOnce(() => detached.promise)
    const rosterReady = deferred<void>()
    let rosterStarted = false
    if (!releaseRuntime) throw new Error('missing client runtime')
    vi.spyOn(releaseRuntime.reconciler, 'reconcileNow').mockImplementationOnce(() => {
      rosterStarted = true
      return rosterReady.promise
    })
    newButton().click()
    await vi.waitFor(() => expect(loopReads).toBe(1))
    // Detach the old view while catalogs are pending, without allowing an unready draft to send.
    await vi.waitFor(() => expect(old.detach).toHaveBeenCalled())
    // The new identity may prepare its roster without waiting for the old transport to detach.
    await vi.waitFor(() => expect(rosterStarted).toBe(true))
    expect(newButton().disabled).toBe(true)
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true)
    firstCatalog.resolve(Response.json({ revision: 2, defaults: { permission: 'full-access' }, loops: [] }))
    detached.resolve()
    await Promise.resolve()
    expect(newButton().disabled).toBe(true)
    rosterReady.resolve()
    await vi.waitFor(() => expect(newButton().disabled).toBe(false))
    const workspaceDialog = document.getElementById('new-session') as HTMLDialogElement
    workspaceDialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    window.dispatchEvent(new CustomEvent('agnes:session-configuration-changed'))
    await vi.waitFor(() => expect(loopReads).toBe(2))
    // Reading models is independent of the pending catalog; applying defaults still waits for it.
    await vi.waitFor(() => expect(apis).toHaveBeenCalledTimes(3))
    newButton().click()
    await vi.waitFor(() => expect(loopReads).toBe(3))
    await vi.waitFor(() => expect(newButton().disabled).toBe(false))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-permission-label]')?.textContent).toBe('完全访问'),
    )
    stale.resolve(Response.json({ revision: 1, defaults: { permission: 'read-only' }, loops: [] }))
    await vi.waitFor(() => expect(apis).toHaveBeenCalledTimes(3))
    expect(document.querySelector('[data-permission-label]')?.textContent).toBe('完全访问')
  })

  it.each(['idle-save', 'poll-save', 'failed-poll-save'])(
    'refreshes saved model choices after coordinated %s without duplicating account feedback',
    async (order) => {
      installPublicFixture()
      const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
      const apis = vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } }))
      sdk.createClient.mockReturnValue({
        initialize: vi.fn(initialized),
        on: vi.fn(),
        close: vi.fn(async () => undefined),
        apis,
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: {
          list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })),
          load: vi.fn(async () => old),
        },
      })
      binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
      await bootApp()
      const modelButton = document.getElementById('model') as HTMLButtonElement
      await vi.waitFor(() => expect(modelButton.disabled).toBe(false))
      const beforeSave = deferred<Awaited<ReturnType<typeof apis>>>()
      const afterSave = deferred<Awaited<ReturnType<typeof apis>>>()
      apis.mockImplementationOnce(() => beforeSave.promise).mockImplementationOnce(() => afterSave.promise)
      if (order !== 'idle-save') {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.waitFor(() => expect(apis).toHaveBeenCalledTimes(2))
      }
      const save = configurationCallback.saved
      if (!save) throw new Error('settings callback not bound')
      const saved = save({
        configured: true,
        effect: 'new-sessions',
        provider: { id: 'new', route: 'new', model: 'model-b' },
      } as ConfigSnapshot)
      await vi.waitFor(() => expect(apis).toHaveBeenCalledTimes(2))
      const result = { profile: { models: [{ route: 'new', id: 'model-b' }] } }
      if (order === 'failed-poll-save') beforeSave.reject(new Error('poll unavailable'))
      else beforeSave.resolve(order === 'idle-save' ? result : { profile: { models: [] } })
      if (order !== 'idle-save') {
        await vi.waitFor(() => expect(apis).toHaveBeenCalledTimes(3))
        afterSave.resolve(result)
      }
      await saved
      expect(document.getElementById('notice')?.textContent).toBe('')
      await vi.waitFor(() => expect(modelButton.disabled).toBe(false))
      modelButton.click()
      await openModelList()
      expect(modelMenu().textContent).toContain('model-b')
    },
  )

  it.each(['missing-profile', 'system-error', 'legacy-ledger'])(
    'keeps %s recovery visible and allows retry or a new task',
    async (kind) => {
      installPublicFixture()
      const old = session('old', async () => idleTimeline('old'))
      const error =
        kind === 'legacy-ledger'
          ? Object.assign(new Error('SEMANTIC_REJECTED (-32011)'), {
              data: {
                code: 'LEGACY_LEDGER_FORMAT',
                reason: 'legacy-ledger-format',
                diagnosticId: '00000000-0000-4000-8000-000000000001',
              },
            })
          : Object.assign(new Error('INTERNAL_ERROR (-32603)'), {
              data:
                kind === 'missing-profile'
                  ? { code: 'SESSION_PROFILE_MISSING' }
                  : { diagnosticId: '00000000-0000-4000-8000-000000000001' },
            })
      const create = vi.fn()
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
        close: vi.fn(async () => undefined),
        initialize: vi.fn(initialized),
        on: vi.fn(),
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old', title: 'Old' }] })), new: create },
      })
      binding.loadWebSession
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ session: old, offPermission: vi.fn() })
      await bootApp()
      const notice = document.getElementById('notice') as HTMLElement
      await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
      if (kind === 'legacy-ledger') {
        expect(notice.textContent).toContain('该会话由旧版本创建，当前版本无法打开，请新建会话。')
        expect(notice.textContent).not.toContain('诊断')
        expect(notice.textContent).not.toContain('00000000-0000-4000-8000-000000000001')
      } else
        expect(notice.textContent).toContain(
          kind === 'missing-profile' ? '旧配置文件已缺失' : '00000000-0000-4000-8000-000000000001',
        )
      // The session list renders whatever the failed open was.
      expect(document.querySelector('#sessions')?.textContent).toContain('Old')
      document.body.click()
      document.getElementById('settings')?.click()
      await vi.waitFor(() => expect((document.getElementById('config') as HTMLDialogElement).open).toBe(true))
      expect(notice.dataset.kind).toBe('session-recovery')
      document.getElementById('config-close')?.click()
      notice.querySelector('button')?.click()
      await vi.waitFor(() =>
        expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false),
      )
      await vi.waitFor(() => expect(notice.textContent).toBe(''))
      expect(create).not.toHaveBeenCalled()
      await leaveCurrentSession()
      binding.loadWebSession.mockRejectedValueOnce(error)
      // Reload the same historical task explicitly; preserve recovery rather than deleting its row.
      const row = [...document.querySelectorAll<HTMLButtonElement>('#sessions button')].find((button) =>
        button.textContent?.includes('Old'),
      )
      row?.click()
      await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
      const newTask = [...notice.querySelectorAll('button')].find(
        (button) => button.textContent === '新建任务',
      )
      newTask?.click()
      await vi.waitFor(() =>
        expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(true),
      )
      expect(notice.textContent).toBe('')
      expect(create).not.toHaveBeenCalled()
    },
  )

  it.each(['missing-profile', 'system-error'])(
    'preserves %s recovery through disconnects and unrelated refresh failures',
    async (kind) => {
      installPublicFixture()
      const old = session('old', async () => idleTimeline('old'))
      const error = Object.assign(new Error('INTERNAL_ERROR (-32603)'), {
        data:
          kind === 'missing-profile'
            ? { code: 'SESSION_PROFILE_MISSING' }
            : { diagnosticId: '00000000-0000-4000-8000-000000000001' },
      })
      const create = vi.fn()
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
        close: vi.fn(async () => undefined),
        initialize: vi.fn(initialized),
        on: vi.fn(),
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old', title: 'Old' }] })), new: create },
      })
      binding.loadWebSession
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ session: old, offPermission: vi.fn() })
      await bootApp()
      const notice = document.getElementById('notice') as HTMLElement
      await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
      expect(notice.textContent).toContain(
        kind === 'missing-profile' ? '旧配置文件已缺失' : '00000000-0000-4000-8000-000000000001',
      )

      const client = sdk.createClient.mock.results.at(-1)?.value
      const recoveryButtons = [...notice.querySelectorAll<HTMLButtonElement>('button')]
      const [retry, newTask] = recoveryButtons
      expect(retry).toBeDefined()
      expect(newTask).toBeDefined()
      if (!retry || !newTask) throw new Error('missing recovery controls')
      if (kind === 'missing-profile') {
        const pendingLoad = deferred<{ session: SessionDouble; offPermission: ReturnType<typeof vi.fn> }>()
        binding.loadWebSession.mockImplementationOnce(() => pendingLoad.promise)
        const event = (name: string) => client.on.mock.calls.find(([key]: [string]) => key === name)?.[1]()
        event('reconnecting')
        expect((document.getElementById('new') as HTMLButtonElement).disabled).toBe(true)
        for (const control of recoveryButtons) {
          expect(control.disabled).toBe(true)
          // Programmatic dispatch also exercises the handler guard.
          control.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        expect(binding.loadWebSession).toHaveBeenCalledTimes(1)
        expect(new URL(location.href).searchParams.get('session')).toBe('old')
        expect(notice.textContent).toContain('旧配置文件已缺失')
        event('reconnected')
        await vi.waitFor(() => expect(retry.disabled).toBe(false))
        expect(newTask.disabled).toBe(false)
        retry.click()
        await vi.waitFor(() => expect(binding.loadWebSession).toHaveBeenCalledTimes(2))
        for (const control of recoveryButtons) expect(control.disabled).toBe(true)
        newTask.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
        pendingLoad.resolve({ session: old, offPermission: vi.fn() })
        await vi.waitFor(() => expect(notice.textContent).toBe(''))
      } else {
        retry.focus()
        client.session.list.mockRejectedValueOnce(new Error('review-list-failure'))
        window.dispatchEvent(new Event('focus'))
        await vi.waitFor(() =>
          expect(document.getElementById('sessions')?.textContent).toContain('review-list-failure'),
        )
        expect(notice.textContent).toContain('00000000-0000-4000-8000-000000000001')
        expect(notice.querySelector('button')).toBe(retry)
        expect(document.activeElement).toBe(retry)
        window.dispatchEvent(new Event('focus'))
        await vi.waitFor(() =>
          expect(document.getElementById('sessions')?.textContent).not.toContain('review-list-failure'),
        )
        expect(notice.dataset.kind).toBe('session-recovery')
        expect(notice.textContent).toContain('历史任务打开失败')
        expect(notice.querySelector('button')).toBe(retry)
        retry.click()
        await vi.waitFor(() => expect(notice.textContent).toBe(''))
      }
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('creates only after confirming a directory and never sends to the old session during creation', async () => {
    installPublicFixture()
    const firstCreation = deferred<SessionDouble>()
    const create = vi.fn<() => Promise<SessionDouble>>(() => firstCreation.promise)
    const newProjection = deferred<UITimeline>()
    const old = session('old', async () => idleTimeline('old'))
    const fresh = session('fresh', () => newProjection.promise)
    let includeFresh = false

    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => {
          throw new Error('workspace list failed')
        }),
        add: vi.fn(async (path: string) => ({
          workspace: { path, name: 'agnes', lastUsedAt: null, sessionCount: 0, available: true },
        })),
      },
      session: {
        list: vi.fn(async () => ({
          items: [
            { sessionId: 'old', title: '现有任务' },
            ...(includeFresh ? [{ sessionId: 'fresh', title: '新任务' }] : []),
          ],
        })),
        load: vi.fn(async (id: string) => (id === 'old' ? old : fresh)),
        new: create,
      },
    })
    binding.loadWebSession.mockImplementation(async (_load: unknown, id: string) => ({
      session: id === 'old' ? old : fresh,
      offPermission: vi.fn(),
    }))
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await bootApp()
    const newButton = document.getElementById('new') as HTMLButtonElement
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement
    const send = document.getElementById('send') as HTMLButtonElement
    const model = document.getElementById('model') as HTMLButtonElement
    const newSession = document.getElementById('new-session') as HTMLDialogElement

    await vi.waitFor(() => expect(prompt.disabled).toBe(false))
    expect(document.querySelector('.agh-notifications')?.textContent).toContain('无法读取工作区列表')
    expect(send.disabled).toBe(true)
    await vi.waitFor(() => expect(send.dataset.mode).toBe('idle'))
    expect(send.getAttribute('aria-label')).toBe('发送')
    // The send button's tooltip carries the shortcut hint while the composer is idle.
    expect(send.title).toBe('Enter 发送，Shift+Enter 换行')
    expect(document.getElementById('composer-hint')?.dataset.kind).toBe('shortcut')
    expect(model.tagName).toBe('BUTTON')
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('选择模型')
    expect(model.getAttribute('aria-label')).toBe('选择当前会话模型')
    prompt.value = 'enable the send control'
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
    expect(send.disabled).toBe(false)
    prompt.value = ''
    prompt.dispatchEvent(new Event('input', { bubbles: true }))

    model.click()
    await openModelList()
    const option = modelMenu().querySelector<HTMLElement>('[role="option"]')
    option?.click()
    await vi.waitFor(() =>
      expect(old.setModel).toHaveBeenCalledWith({
        slot: 'primary',
        route: 'local',
        model: 'model-a',
        thinking: null,
        contextWindow: null,
      }),
    )
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('model-a')
    expect(model.title).toBe('当前会话模型：model-a')
    expect(model.getAttribute('aria-label')).toBe('当前会话模型：model-a')

    old.detach.mockRejectedValueOnce(new Error('detach cleanup failed'))
    newButton.click()
    expect(newSession.open).toBe(true)
    const newSessionCwd = document.getElementById('new-session-cwd') as HTMLInputElement
    expect(create).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-notifications')?.textContent).toContain('detach cleanup failed'),
    )
    expect(prompt.disabled).toBe(false)
    newSessionCwd.value = '/cancelled-directory'
    closeWorkspacePicker()
    expect(newSession.open).toBe(false)
    expect(create).not.toHaveBeenCalled()

    history.replaceState(
      null,
      '',
      '/?new=1&bundle=acme%23report&preset=workspace-write&loop=acme%401&prompt=launch&settings=examples#settings-subsection-examples',
    )
    newButton.click()
    expect(location.hash).toBe('#settings-subsection-examples')
    // The dialog can unmount its controls when closed; use the reopened form.
    const newSessionForm = await vi.waitFor(() => {
      const form = document.getElementById('new-session-form')
      expect(form).not.toBeNull()
      return form as HTMLFormElement
    })
    const confirmedCwd = document.getElementById('new-session-cwd') as HTMLInputElement
    const newSessionCreate = document.getElementById('new-session-create') as HTMLButtonElement
    confirmedCwd.value = ' /workspace/agnes '
    confirmedCwd.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(newSessionCreate.disabled).toBe(false))
    newSessionForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(newSession.open).toBe(false))
    submit('must not cross sessions')

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(prompt.disabled).toBe(true)
    expect(send.disabled).toBe(true)
    expect(model.disabled).toBe(true)
    expect(old.prompt).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith({
      cwd: '/workspace/agnes',
      permission: 'default',
      sessionKey: expect.any(String),
    })

    firstCreation.resolve(fresh)
    includeFresh = true
    newProjection.resolve(idleTimeline('fresh'))
    await vi.waitFor(() =>
      expect(fresh.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'must not cross sessions' }], {
        titleLocale: 'zh-CN',
        references: [],
      }),
    )
    expect(new URL(location.href).searchParams.get('session')).toBe('fresh')
    for (const key of ['new', 'bundle', 'preset', 'loop', 'prompt'])
      expect(new URL(location.href).searchParams.has(key)).toBe(false)
    expect(new URL(location.href).searchParams.get('settings')).toBe('examples')
    expect(location.hash).toBe('#settings-subsection-examples')
  })

  it.each([undefined, 'terminal', 'jobs'])(
    'validates directory confirmation and handles a terminal deep link without a session (%s)',
    async (terminalLink) => {
      installPublicFixture()
      history.replaceState(
        null,
        '',
        terminalLink ? `/?settings=${terminalLink}#test-launcher-token` : '/#test-launcher-token',
      )
      const create = vi.fn<() => Promise<SessionDouble>>()

      const add = vi.fn(async () => {
        throw Object.assign(new Error('SEMANTIC_REJECTED (-32011)'), {
          data: { code: 'WORKSPACE_INVALID', reason: 'not-found' },
        })
      })
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
        approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
        close: vi.fn(async () => undefined),
        config: {
          get: vi.fn(async () => ({ configured: true, accounts: [] })),
          providers: vi.fn(async () => ({ providers: [] })),
          save: vi.fn(async () => ({ configured: true })),
          test: vi.fn(async () => ({ verified: true, models: [] })),
        },
        initialize: vi.fn(initialized),
        on: vi.fn(),
        workspace: {
          list: vi.fn(async () => ({ items: [] })),
          add,
        },
        session: {
          list: vi.fn(async () => ({ items: [] })),
          load: vi.fn(),
          new: create,
        },
      })
      binding.loadWebSession.mockImplementation(async () => {
        throw new Error('no session should load before creation')
      })
      binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
        session: selected,
        offPermission: vi.fn(),
      }))

      await bootApp()
      if (terminalLink) {
        await vi.waitFor(() =>
          expect(document.querySelector('.agh-toast')?.textContent).toContain('打开会话后即可使用终端'),
        )
        expect((document.getElementById('config') as HTMLDialogElement).open).toBe(false)
        expect(document.querySelector('[data-testid="workbench-tab-terminal"]')).toBeNull()
        expect(new URL(location.href).searchParams.has('settings')).toBe(false)
      }
      const newSession = document.getElementById('new-session') as HTMLDialogElement

      if (terminalLink) document.getElementById('new')?.click()
      else {
        await vi.waitFor(() =>
          expect(document.querySelector('[data-testid="first-run-guide"]')).not.toBeNull(),
        )
        expect(newSession.open).toBe(false)
        expect(create).not.toHaveBeenCalled()
        document.querySelector<HTMLButtonElement>('[data-testid="first-run-skip"]')?.click()
      }
      await vi.waitFor(() => expect(newSession.open).toBe(true))
      const newSessionForm = document.getElementById('new-session-form') as HTMLFormElement
      const newSessionCwd = document.getElementById('new-session-cwd') as HTMLInputElement
      const newSessionCreate = document.getElementById('new-session-create') as HTMLButtonElement
      expect(create).not.toHaveBeenCalled()
      newSessionCwd.value = '/workspace/not-present'
      newSessionCwd.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.waitFor(() => expect(newSessionCreate.disabled).toBe(false))
      newSessionForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() =>
        expect(document.getElementById('new-session-error')?.textContent).toContain(
          '工作目录不存在，请检查路径后重试。',
        ),
      )
      expect(newSession.open).toBe(true)
      expect(add).toHaveBeenCalledWith('/workspace/not-present')
      closeWorkspacePicker()
      expect(newSession.open).toBe(false)
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('uses the system picker, treats cancel as a no-op, then validates the selected path through workspace.add', async () => {
    installPublicFixture()
    history.replaceState(null, '', '/#test-launcher-token')
    let pickerCalls = 0
    let releasePicker = () => {}
    const pickerReady = new Promise<void>((resolve) => {
      releasePicker = resolve
    })
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (_input === '/admin/api/doctor')
        return new Response(JSON.stringify({ checks: [], status: 'ok' }), { status: 200 })
      if ((init?.method ?? 'GET') === 'GET') {
        await pickerReady
        return new Response(JSON.stringify({ available: true }), { status: 200 })
      }
      pickerCalls++
      return new Response(
        JSON.stringify(
          pickerCalls === 1 ? { status: 'cancelled' } : { status: 'selected', path: '/workspace/系统选择' },
        ),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetcher)
    const add = vi.fn(async (path: string) => ({
      workspace: { path, name: '系统选择', lastUsedAt: null, sessionCount: 0, available: true },
    }))
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: { list: vi.fn(async () => ({ items: [] })), add },
      session: { list: vi.fn(async () => ({ items: [] })), load: vi.fn(), new: vi.fn() },
    })

    await bootApp()
    const dialog = document.getElementById('new-session') as HTMLDialogElement
    await vi.waitFor(() => expect(dialog.open).toBe(true))
    const picker = document.getElementById('workspace-pick') as HTMLButtonElement
    expect(picker.getAttribute('aria-busy')).toBe('true')
    releasePicker()
    await vi.waitFor(() => {
      expect(picker.disabled).toBe(false)
      expect(picker.getAttribute('aria-busy')).toBe('false')
      expect(document.getElementById('new-session-create')?.getAttribute('aria-busy')).toBe('false')
    })

    picker.click()
    await vi.waitFor(() => expect(picker.disabled).toBe(false))
    expect(dialog.open).toBe(true)
    expect(add).not.toHaveBeenCalled()

    picker.click()
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith('/workspace/系统选择')
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/workspace-picker',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })

  // A draft names its workspace in the address, so a refresh (which keeps `?new=1`) restores it
  // without asking again; without one it reuses the most recent available workspace.
  it.each([
    ['a forwarded resources link', `?workspaceId=${'b'.repeat(64)}`, true, 'linked'],
    ['a refreshed draft', `?new=1&workspaceId=${'b'.repeat(64)}`, true, 'linked'],
    ['a draft without a workspace', '?new=1', true, 'first'],
    ['a draft when no workspace is available', '?new=1', false, undefined],
    [
      'a refreshed draft whose workspace list fails',
      `?new=1&workspaceId=${'b'.repeat(64)}`,
      'unreadable',
      undefined,
    ],
  ] as const)('starts %s in the right workspace', async (_name, search, available, expected) => {
    installPublicFixture()
    const linked = 'b'.repeat(64)
    history.replaceState(null, '', `/${search}#test-launcher-token`)
    const row = (name: string, workspaceId: string) => ({
      path: `/workspace/${name}`,
      name,
      workspaceId,
      lastUsedAt: null,
      sessionCount: 0,
      available: available === true,
    })
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => {
          if (available === 'unreadable') throw new Error('workspace list offline')
          return {
            items: [
              { ...row('gone', 'c'.repeat(64)), available: false },
              { ...row('chats', 'd'.repeat(64)), kind: 'chats' as const },
              row('first', 'a'.repeat(64)),
              row('linked', linked),
            ],
          }
        }),
        add: vi.fn(),
      },
      session: { list: vi.fn(async () => ({ items: [] })), load: vi.fn(), new: vi.fn() },
    })

    await bootApp()
    const dialog = document.getElementById('new-session') as HTMLDialogElement
    if (!expected) {
      await vi.waitFor(() => expect(dialog.open).toBe(true))
      expect(new URL(location.href).searchParams.get('workspaceId')).toBe(
        search.includes('workspaceId') ? linked : null,
      )
      return
    }
    await vi.waitFor(() =>
      expect(document.querySelector('[data-workspace-label]')?.textContent).toBe(expected),
    )
    expect(dialog.open).toBe(false)
    if (!search.includes('new=1')) return
    expect(new URL(location.href).searchParams.get('workspaceId')).toBe(
      expected === 'linked' ? linked : 'a'.repeat(64),
    )
    // Choosing another workspace in the picker moves the address with it.
    const chip = document.getElementById('composer-workspace') as HTMLButtonElement
    expect(chip.textContent).toContain(`/workspace/${expected}`)
    await vi.waitFor(() => expect(chip.disabled).toBe(false))
    chip.click()
    await vi.waitFor(() => expect(document.querySelector('.workspace-picker-panel')).not.toBeNull())
    const other = expected === 'linked' ? 'first' : 'linked'
    // The managed chats workspace is never offered as a folder to choose.
    expect(
      [...document.querySelectorAll('.workspace-picker-panel .workspace-option-name')].map(
        (name) => name.textContent,
      ),
    ).toEqual(['gone', 'first', 'linked'])
    ;[...document.querySelectorAll<HTMLButtonElement>('.workspace-picker-panel .workspace-option')]
      .find((button) => button.textContent?.includes(other))
      ?.click()
    await vi.waitFor(() => expect(document.querySelector('[data-workspace-label]')?.textContent).toBe(other))
    expect(dialog.open).toBe(false)
    expect(new URL(location.href).searchParams.get('workspaceId')).toBe(
      other === 'linked' ? linked : 'a'.repeat(64),
    )
    // × leaves the workspace: the draft becomes a chat in the managed chats workspace.
    document.querySelector<HTMLButtonElement>('.composer-workspace-clear')?.click()
    await vi.waitFor(() => expect(chip.dataset.chats).toBe('true'))
    expect(document.querySelector('.composer-workspace-clear')).toBeNull()
    expect(new URL(location.href).searchParams.get('workspaceId')).toBe('d'.repeat(64))
  })

  it('keeps the native picker available when workspace.add rejects the selected directory', async () => {
    installPublicFixture()
    history.replaceState(null, '', '/#test-launcher-token')
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) =>
        init?.method === 'GET'
          ? new Response(JSON.stringify({ available: true }), { status: 200 })
          : new Response(JSON.stringify({ status: 'selected', path: '/workspace/removed' }), {
              status: 200,
            }),
      ),
    )
    const add = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { code: 'WORKSPACE_INVALID', data: { reason: 'not-found' } })
    })
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: { list: vi.fn(async () => ({ items: [] })), add },
      session: { list: vi.fn(async () => ({ items: [] })), load: vi.fn(), new: vi.fn() },
    })

    await bootApp()
    const picker = await vi.waitFor(() => {
      const button = document.getElementById('workspace-pick') as HTMLButtonElement
      expect(button).not.toBeNull()
      expect(button.disabled).toBe(false)
      return button
    })
    picker.click()
    await vi.waitFor(() =>
      expect(document.getElementById('new-session-error')?.textContent).toContain(
        '工作目录不存在，请检查路径后重试。',
      ),
    )
    expect(add).toHaveBeenCalledWith('/workspace/removed')
    expect(picker.hidden).toBe(false)
    expect(picker.disabled).toBe(false)
  })

  it.each(['slow', 'failed'] as const)(
    'sends the first prompt independently of a %s sidebar refresh',
    async (mode) => {
      installPublicFixture()
      history.replaceState(null, '', '/#test-launcher-token')
      const fresh = session('fresh', async () => idleTimeline('fresh'))
      const listing = deferred<{ items: Array<{ sessionId: string; title: string }> }>()
      let created = false
      const workspace = {
        path: '/workspace/agnes',
        name: 'agnes',
        lastUsedAt: null,
        sessionCount: 0,
        available: true,
      }
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
        approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
        close: vi.fn(async () => undefined),
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
          save: vi.fn(async () => ({ configured: true })),
          test: vi.fn(async () => ({ verified: true, models: [] })),
        },
        initialize: vi.fn(initialized),
        on: vi.fn(),
        workspace: {
          list: vi.fn(async () => ({ items: [] })),
          add: vi.fn(async () => ({ workspace })),
        },
        session: {
          list: vi.fn(async () => (created ? listing.promise : { items: [] })),
          load: vi.fn(async () => fresh),
          new: vi.fn(async () => {
            created = true
            return fresh
          }),
        },
      })
      binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
        session: selected,
        offPermission: vi.fn(),
      }))
      await bootApp()
      const dialog = document.getElementById('new-session') as HTMLDialogElement
      await vi.waitFor(() => expect(dialog.open).toBe(true))
      const path = document.getElementById('new-session-cwd') as HTMLInputElement
      path.value = workspace.path
      path.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.waitFor(() =>
        expect((document.getElementById('new-session-create') as HTMLButtonElement).disabled).toBe(false),
      )
      document
        .getElementById('new-session-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(dialog.open).toBe(false))
      document.getElementById('model')?.click()
      await openModelList()
      modelMenu().querySelector<HTMLElement>('[role="option"]')?.click()
      try {
        submit('first message')
        await vi.waitFor(() =>
          expect(fresh.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'first message' }], {
            titleLocale: 'zh-CN',
            references: [],
          }),
        )
        if (mode === 'failed') {
          listing.reject(new Error('sidebar list failed'))
          await vi.waitFor(() =>
            expect(document.querySelector('.agh-notifications')?.textContent).toContain(
              'sidebar list failed',
            ),
          )
        }
        expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('')
        expect(fresh.prompt).toHaveBeenCalledTimes(1)
      } finally {
        listing.resolve({ items: [{ sessionId: 'fresh', title: 'fresh' }] })
      }
    },
  )

  it('keeps the first draft and creation key through model and prompt failures', async () => {
    installPublicFixture()
    history.replaceState(null, '', '/#test-launcher-token')
    const fresh = session('fresh', async () => idleTimeline('fresh'))
    fresh.setModel
      .mockRejectedValueOnce(new Error('initial model failed'))
      .mockResolvedValue({ effectiveFromSeq: 1 })
    fresh.prompt
      .mockRejectedValueOnce(
        Object.assign(new Error('INTERNAL_ERROR (-32603)'), {
          data: { code: 'TURN_ERROR', error: { code: 'AUTH' } },
        }),
      )
      .mockResolvedValue(undefined)
    let includeFresh = false
    const create = vi.fn<(options: { cwd: string; sessionKey: string }) => Promise<SessionDouble>>(
      async () => {
        includeFresh = true
        return fresh
      },
    )
    const workspace = {
      path: '/workspace/agnes',
      name: 'agnes',
      lastUsedAt: null,
      sessionCount: 0,
      available: true,
    }

    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => ({ items: [] })),
        add: vi.fn(async () => ({ workspace })),
      },
      session: {
        list: vi.fn(async () => ({
          items: includeFresh ? [{ sessionId: 'fresh', title: '新任务' }] : [],
        })),
        load: vi.fn(async () => fresh),
        new: create,
      },
    })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await bootApp()
    const dialog = document.getElementById('new-session') as HTMLDialogElement
    await vi.waitFor(() => expect(dialog.open).toBe(true))
    const path = document.getElementById('new-session-cwd') as HTMLInputElement
    const form = document.getElementById('new-session-form') as HTMLFormElement
    const createButton = document.getElementById('new-session-create') as HTMLButtonElement
    const composer = document.getElementById('prompt') as HTMLTextAreaElement

    await vi.waitFor(() => expect(dialog.open).toBe(true))
    path.value = workspace.path
    path.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(createButton.disabled).toBe(false))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    document.getElementById('model')?.click()
    await openModelList()
    modelMenu().querySelector<HTMLElement>('[role="option"]')?.click()

    submit('保留这条首轮草稿')
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-notifications')?.textContent).toContain('initial model failed'),
    )
    expect(composer.value).toBe('保留这条首轮草稿')
    expect(fresh.prompt).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    const firstKey = create.mock.calls[0]?.[0]?.sessionKey
    expect(firstKey).toEqual(expect.any(String))

    submit('保留这条首轮草稿')
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-notifications')?.textContent).toContain(
        '提供方拒绝了所选模型或凭据。 请选择其他模型或重新登录。',
      ),
    )
    expect(fresh.setModel).toHaveBeenCalledTimes(2)
    expect(fresh.prompt).toHaveBeenCalledTimes(1)
    expect(composer.value).toBe('保留这条首轮草稿')
    expect(create).toHaveBeenCalledTimes(1)

    submit('保留这条首轮草稿')
    await vi.waitFor(() => expect(fresh.prompt).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(composer.disabled).toBe(false))
    expect(document.querySelector('[data-workspace-label]')?.textContent).toBe('agnes')
    expect(document.getElementById('composer-workspace')?.title).toBe(workspace.path)

    const locale = document.querySelector<HTMLSelectElement>('#locale-select')
    if (!locale) throw new Error('locale control missing')
    locale.value = 'en'
    locale.dispatchEvent(new Event('change', { bubbles: true }))
    editPrompt('成功后的第二条消息')
    await vi.waitFor(() =>
      expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
    )
    document
      .getElementById('composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(fresh.prompt).toHaveBeenLastCalledWith([{ type: 'text', text: '成功后的第二条消息' }], {
        titleLocale: 'en',
        references: [],
      }),
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]?.sessionKey).toBe(firstKey)
  })

  it('preserves the running action as a named busy mode with a separate stop control', async () => {
    installPublicFixture()
    let pendingInputs = [
      { itemId: 'B', preview: '第二条提示词' },
      { itemId: 'C', preview: '第三条提示词' },
    ]
    let sequence = 1
    const running = session('old', async () => ({ ...busyTimeline('old'), upto: sequence, pendingInputs }))
    const titleList = vi.fn(async () => ({ items: [{ sessionId: 'old' }] }))
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => ({ items: [] })),
        add: vi.fn(async (path: string) => ({
          workspace: { path, name: 'agnes', lastUsedAt: null, sessionCount: 0, available: true },
        })),
      },
      session: {
        list: titleList,
        load: vi.fn(async () => running),
        new: vi.fn(),
      },
    })
    binding.loadWebSession.mockImplementation(async () => ({ session: running, offPermission: vi.fn() }))
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await bootApp()
    const send = document.getElementById('send') as HTMLButtonElement
    const cancel = document.getElementById('cancel') as HTMLButtonElement
    const hint = document.getElementById('composer-hint') as HTMLParagraphElement

    await vi.waitFor(() => expect(send.dataset.mode).toBe('busy'))
    expect(send.getAttribute('aria-label')).toBe('排队消息')
    expect(send.title).toBe('排队消息（Enter）')
    expect(hint.dataset.kind).toBe('state')
    // When queued messages arrive is said by the queue tray, not by a line under the input.
    expect(hint.textContent).toBe('')
    expect(cancel.hidden).toBe(false)
    expect(cancel.textContent).toBe('取消当前轮')
    expect(document.querySelector('.composer-queue-total')?.textContent).toBe('待发送 2 条')
    expect(
      Array.from(document.querySelectorAll('.composer-queue-preview'), (node) => node.textContent),
    ).toEqual(['第二条提示词', '第三条提示词'])
    const sendNow = deferred<number>()
    running.interrupt.mockImplementationOnce(() => sendNow.promise)
    // Interrupting with a queued message is in the line's "more" menu.
    const queuedButton = document.querySelector<HTMLButtonElement>(
      '[data-queue-item="C"] [data-testid="queued-steer-more"]',
    )
    if (!queuedButton) throw new Error('missing queued input action')
    const interruptFromMenu = async () => {
      queuedButton.click()
      const item = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-testid="queued-steer-interrupt"]')
        expect(found).toBeTruthy()
        return found as HTMLElement
      })
      item.click()
    }
    await interruptFromMenu()
    await vi.waitFor(() => expect(running.interrupt).toHaveBeenCalledTimes(1))
    expect(running.interrupt).toHaveBeenCalledWith('C')
    await vi.waitFor(() => expect(queuedButton.disabled).toBe(true))
    expect(queuedButton.getAttribute('aria-busy')).toBe('true')
    expect(cancel.disabled).toBe(true)
    sendNow.reject(new Error('synthetic send-now refusal'))
    await vi.waitFor(() =>
      expect(document.querySelector('.composer-queue-error')?.textContent).toBe('synthetic send-now refusal'),
    )
    expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(2)
    running.interrupt.mockImplementationOnce(async () => {
      pendingInputs = [{ itemId: 'B', preview: '第二条提示词' }]
      sequence++
      return sequence
    })
    await interruptFromMenu()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(1))
    expect(document.querySelector('.composer-queue-total')?.textContent).toBe('待发送 1 条')
    expect(running.prompt).not.toHaveBeenCalled()
    const reads = titleList.mock.calls.length
    // Enter while the agent runs queues a follow-up.
    running.followUp.mockImplementation(async (input: { type: string; text?: string }[]) => {
      sequence++
      // 提交内容已是 ContentBlock[]，排队区的 preview 由 daemon 从文本块得出，这里照此模拟。
      const preview = input
        .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
        .join('')
      pendingInputs = [...pendingInputs, { itemId: `queued-${sequence}`, preview }]
      return sequence
    })
    const followUps = ['本轮还没结束，先补充下一轮', '再排一条', '第三条也应立即显示']
    for (const [index, input] of followUps.entries()) {
      submit(input)
      await vi.waitFor(() => expect(running.followUp).toHaveBeenCalledTimes(index + 1))
      await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(index + 2))
    }
    expect(
      Array.from(document.querySelectorAll('.composer-queue-preview'), (node) => node.textContent),
    ).toEqual(['第二条提示词', ...followUps])
    expect(titleList).toHaveBeenCalledTimes(reads)
    const composer = document.getElementById('prompt') as HTMLTextAreaElement
    composer.value = '尚未发送的草稿'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    const removeItemId = pendingInputs[1]?.itemId
    // Delete is the line's icon action: named for the message it removes, its tooltip says 删除.
    const remove = document
      .querySelectorAll<HTMLElement>('[data-testid="queued-steer"]')[1]
      ?.querySelector<HTMLButtonElement>('[data-testid="queued-steer-withdraw"]')
    if (!remove) throw new Error('missing queued input deletion')
    expect(remove.type).toBe('button')
    expect(remove.getAttribute('aria-label')).toBe('删除第 2 条消息')
    expect(cancel.disabled).toBe(false)
    expect(running.cancel).not.toHaveBeenCalled()
    const removing = deferred<number>()
    running.removeQueued.mockImplementationOnce(() => removing.promise)
    remove.click()
    remove.click()
    await vi.waitFor(() => expect(running.removeQueued).toHaveBeenCalledExactlyOnceWith(removeItemId))
    expect(remove.disabled).toBe(true)
    // In flight it spins in place of its icon; the state is aria-busy, not a changed label.
    expect(remove.getAttribute('aria-busy')).toBe('true')
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.composer-queue button')).every(
        (button) => button.disabled,
      ),
    ).toBe(true)
    expect(document.activeElement).toBe(composer)
    expect(cancel.disabled).toBe(false)
    const firstCancel = deferred<void>()
    running.cancel.mockImplementationOnce(() => firstCancel.promise)
    cancel.click()
    await vi.waitFor(() => expect(running.cancel).toHaveBeenCalledTimes(1))
    expect(cancel.disabled).toBe(true)
    cancel.click()
    expect(running.cancel).toHaveBeenCalledTimes(1)
    removing.reject(new Error('synthetic removal refusal'))
    await vi.waitFor(() =>
      expect(document.querySelector('.composer-queue-error')?.textContent).toBe('synthetic removal refusal'),
    )
    expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(4)
    // Deletion settling must not unlock the composer while stopping is still pending.
    expect(cancel.disabled).toBe(true)
    expect(remove.disabled).toBe(true)
    expect(composer.disabled).toBe(true)
    firstCancel.reject(new Error('cancel temporarily unavailable'))
    await vi.waitFor(() => expect(cancel.disabled).toBe(false))
    expect(remove.disabled).toBe(false)
    expect(composer.disabled).toBe(false)
    running.removeQueued.mockImplementationOnce(async (itemId: string) => {
      pendingInputs = pendingInputs.filter((item) => item.itemId !== itemId)
      return ++sequence
    })
    remove.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(3))
    expect(document.querySelector('.composer-queue-total')?.textContent).toBe('待发送 3 条')
    expect(
      Array.from(document.querySelectorAll('.composer-queue-preview'), (node) => node.textContent),
    ).toEqual(['第二条提示词', ...followUps.slice(1)])
    expect(composer.value).toBe('尚未发送的草稿')
    expect(running.cancel).toHaveBeenCalledTimes(1)
    expect(running.interrupt).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.composer-queue-error')).toBeNull()

    running.removeQueued.mockImplementationOnce(async (itemId: string) => {
      pendingInputs = pendingInputs.filter((item) => item.itemId !== itemId)
      sequence++
      throw { data: { code: 'QUEUED_INPUT_GONE' } }
    })
    document
      .querySelector<HTMLButtonElement>('.composer-queue li:nth-child(2) .composer-queue-remove')
      ?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(2))
    expect(document.querySelector('.composer-queue-error')?.textContent).toBe(
      '这条消息已开始执行或已不在队列中，列表会刷新。',
    )
    running.removeQueued.mockImplementation(async (itemId: string) => {
      pendingInputs = pendingInputs.filter((item) => item.itemId !== itemId)
      return ++sequence
    })
    for (const count of [1, 0]) {
      document.querySelector<HTMLButtonElement>('.composer-queue-remove')?.click()
      await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(count))
    }
    expect(document.querySelector('.composer-queue')).toBeNull()
    expect(composer.value).toBe('尚未发送的草稿')
    cancel.click()
    await vi.waitFor(() => expect(running.cancel).toHaveBeenCalledTimes(2))
    // A parked turn can acknowledge Stop without producing a newer turn/end. The receipt unlocks
    // the composer even if its last projection is still the busy frame seen when Stop was clicked.
    await vi.waitFor(() => expect(cancel.disabled).toBe(false))
    expect(composer.disabled).toBe(false)
    expect(running.prompt).not.toHaveBeenCalled()
  })
})

describe('queued input deletion', () => {
  it.each(['success', 'failure'] as const)(
    'allows deletion without a usable model and ignores a late old-session %s',
    async (outcome) => {
      installPublicFixture()
      const old = session('old', async () => ({
        ...idleTimeline('old', { route: 'removed', id: 'missing-model' }),
        pendingInputs: [{ itemId: 'shared-id', preview: 'old input' }],
      }))
      let nextQueue = [{ itemId: 'shared-id', preview: 'next input' }]
      let seq = 0
      const next = session('next', async () => ({
        ...idleTimeline('next'),
        upto: seq,
        pendingInputs: nextQueue,
      }))
      const oldRemoval = deferred<number>()
      const nextRemoval = deferred<number>()
      old.removeQueued.mockImplementation(() => oldRemoval.promise)
      next.removeQueued.mockImplementation(() => nextRemoval.promise)
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [] } })),
        approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
        close: vi.fn(async () => undefined),
        config: {
          get: vi.fn(async () => ({ configured: outcome === 'failure' })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        initialize: vi.fn(initialized),
        on: vi.fn(),
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: {
          list: vi.fn(async () => ({ items: [{ sessionId: 'old' }, { sessionId: 'next' }] })),
          load: vi.fn(async (id: string) => (id === 'old' ? old : next)),
        },
      })
      binding.loadWebSession.mockImplementation(async (_load: unknown, id: string) => ({
        session: id === 'old' ? old : next,
        offPermission: vi.fn(),
      }))
      binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
        session: selected,
        offPermission: vi.fn(),
      }))
      await bootApp()
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLButtonElement>('.composer-queue-remove')?.disabled).toBe(false),
      )
      // Interrupting needs a usable model; its menu stays shut while removing still works.
      expect(document.querySelector<HTMLButtonElement>('[data-testid="queued-steer-more"]')?.disabled).toBe(
        true,
      )
      document.querySelector<HTMLButtonElement>('.composer-queue-remove')?.click()
      await vi.waitFor(() => expect(old.removeQueued).toHaveBeenCalledExactlyOnceWith('shared-id'))
      document.querySelector<HTMLButtonElement>('[data-session="next"]')?.click()
      await vi.waitFor(() =>
        expect(document.querySelector('.composer-queue-preview')?.textContent).toBe('next input'),
      )
      document.querySelector<HTMLButtonElement>('.composer-queue-remove')?.click()
      await vi.waitFor(() => expect(next.removeQueued).toHaveBeenCalledExactlyOnceWith('shared-id'))
      if (outcome === 'success') oldRemoval.resolve(1)
      else oldRemoval.reject(new Error('late old-session refusal'))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const remove = document.querySelector<HTMLButtonElement>('.composer-queue-remove')
      expect(remove?.disabled).toBe(true)
      expect(remove?.getAttribute('aria-busy')).toBe('true')
      expect(document.querySelector('.composer-queue-preview')?.textContent).toBe('next input')
      expect(document.querySelector('.composer-queue-error')).toBeNull()
      nextQueue = []
      nextRemoval.resolve(++seq)
      await vi.waitFor(() => expect(document.querySelector('.composer-queue')).toBeNull())
      expect(old.cancel).not.toHaveBeenCalled()
      expect(next.cancel).not.toHaveBeenCalled()
    },
  )
})

describe('composer draft persistence', () => {
  it('keeps a draft after a failed send but never revives a sent prompt when the page unloads mid-run', async () => {
    installPublicFixture()
    const old = session('old', async () => idleTimeline('old'))
    const inFlight = deferred<undefined>()
    const unloading = deferred<undefined>()
    old.prompt
      .mockRejectedValueOnce(new Error('prompt rejected'))
      .mockImplementationOnce(() => inFlight.promise)
      .mockImplementationOnce(() => unloading.promise)
    const client = {
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })), load: vi.fn(async () => old) },
    }
    sdk.createClient.mockReturnValue(client)
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))
    await bootApp()
    const composer = document.getElementById('prompt') as HTMLTextAreaElement
    const type = (text: string) => {
      editPrompt(text)
    }
    await vi.waitFor(() => expect(composer.disabled).toBe(false))
    await vi.waitFor(() => expect(old.projectUIOpening).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect((document.getElementById('send') as HTMLButtonElement).dataset.mode).toBe('idle'),
    )

    // A rejected send is a failure the user can retry: the draft comes back and stays stored.
    type('一段较长的任务提示词')
    await vi.waitFor(() =>
      expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
    )
    document
      .getElementById('composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(old.prompt).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(composer.value).toBe('一段较长的任务提示词'))
    // Draft storage is scoped to the selected conversation; follow its persisted entry.
    const draftKey = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index),
    ).find((key) => key && sessionStorage.getItem(key) === '一段较长的任务提示词')
    if (!draftKey) throw new Error('Failed prompt draft was not persisted')
    expect(sessionStorage.getItem(draftKey)).toBe('一段较长的任务提示词')

    // Preserve a later draft if the in-flight message is rejected.
    document
      .getElementById('composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(old.prompt).toHaveBeenCalledTimes(2))
    expect(composer.value).toBe('')
    expect(sessionStorage.getItem(draftKey)).toBeFalsy()
    type('下一条草稿')
    inFlight.reject(new Error('provider rejected image input'))
    await vi.waitFor(() => expect(composer.value).toBe('一段较长的任务提示词\n下一条草稿'))
    expect(sessionStorage.getItem(draftKey)).toBe('一段较长的任务提示词\n下一条草稿')

    // The third prompt was accepted and is in flight. Unloading is not a failed send and must not
    // revive its contents.
    document
      .getElementById('composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(old.prompt).toHaveBeenCalledTimes(3))
    expect(composer.value).toBe('')
    expect(sessionStorage.getItem(draftKey)).toBeFalsy()
    window.dispatchEvent(new Event('pagehide'))
    unloading.reject(new Error('transport closed'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(composer.value).toBe('')
    expect(sessionStorage.getItem(draftKey)).toBeFalsy()
  })
})

describe('image composer submissions', () => {
  const imagePngData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const imagePngBytes = Uint8Array.from(atob(imagePngData), (character) => character.charCodeAt(0))

  const receiptId = '00000000-0000-0000-0000-000000000001'
  const imageReference = (bytes: Uint8Array, mime: string, name: string) =>
    attachmentLink(
      { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mime },
      name,
      {
        receiptId,
        image: { width: 1, height: 1 },
      },
    )

  function originalUploads(sessionId: string) {
    let metadata: { name: string; mimeType: string; size: number } | undefined
    let uploadId: string | undefined
    const chunks: Buffer[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input), 'http://localhost')
        expect(url.pathname).toBe(FILE_UPLOAD_PATH)
        const respond = (value: unknown) =>
          new Response(JSON.stringify(value), {
            headers: { 'Content-Type': 'application/json' },
          })
        if (!init?.method) {
          expect(Object.fromEntries(url.searchParams)).toEqual({
            sessionId,
            destination: 'original',
            laneId: 'main',
          })
          return respond({
            limits: { maxBytes: 100 * 1024 * 1024, chunkBytes: 1024 * 1024, allowedMimeTypes: [] },
          })
        }
        if (url.searchParams.get('operation') === 'chunk') {
          expect(url.searchParams.get('destination')).toBe('original')
          expect(url.searchParams.get('sessionId')).toBe(sessionId)
          expect(url.searchParams.get('laneId')).toBe('main')
          expect(url.searchParams.get('uploadId')).toBe(uploadId)
          expect(Number(url.searchParams.get('offset'))).toBe(
            chunks.reduce((size, bytes) => size + bytes.length, 0),
          )
          if (!(init.body instanceof Blob)) throw new Error('missing original upload chunk')
          const bytes = Buffer.from(await init.body.arrayBuffer())
          expect(bytes.length).toBeLessThanOrEqual(1024 * 1024)
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(url.searchParams.get('sha256'))
          chunks.push(bytes)
          return respond({ offset: chunks.reduce((size, chunk) => size + chunk.length, 0) })
        }
        const control = JSON.parse(String(init.body))
        expect(control).toMatchObject({ sessionId, laneId: 'main', destination: 'original' })
        if (control.operation === 'start') {
          uploadId = control.uploadId
          expect(uploadId).toBeTypeOf('string')
          metadata = control
          return respond({ offset: 0 })
        }
        expect(control.operation).toBe('finish')
        expect(control.uploadId).toBe(uploadId)
        if (!metadata) throw new Error('original upload was not started')
        const bytes = Buffer.concat(chunks)
        expect(bytes.length).toBe(metadata.size)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(control.sha256)
        return respond({ attachment: imageReference(bytes, metadata.mimeType, metadata.name) })
      }),
    )
  }

  async function start(
    sessionValue: SessionDouble,
    busy = false,
    inputModes: readonly ('text' | 'image')[] = ['text', 'image'],
  ): Promise<void> {
    installPublicFixture()
    originalUploads(sessionValue.id)
    const imageUrl = `blob:${sessionValue.id}-image`
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => imageUrl) })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({
        profile: { models: [{ route: 'local', id: 'model-a', input: inputModes }] },
      })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        list: vi.fn(async () => ({ items: [{ sessionId: sessionValue.id }] })),
        load: vi.fn(async () => sessionValue),
      },
    })
    binding.loadWebSession.mockResolvedValue({ session: sessionValue, offPermission: vi.fn() })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))
    await bootApp()
    const send = document.getElementById('send') as HTMLButtonElement
    await vi.waitFor(() =>
      expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false),
    )
    await vi.waitFor(() => expect(send.dataset.mode).toBe(busy ? 'busy' : 'idle'))
    await vi.waitFor(() => expect(sessionValue.projectUIOpening).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(document.querySelector('#model [data-model-label]')?.textContent).toBe('model-a'),
    )
  }

  async function attachPng(
    accepted = true,
    file = new File([imagePngBytes], 'one.png', { type: 'image/png' }),
  ): Promise<void> {
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')
    expect(prompt).not.toBeNull()
    if (!prompt) throw new Error('composer input is missing')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [file],
        items: [],
        getData: () => '',
      },
    })
    prompt.dispatchEvent(event)
    if (accepted) {
      await vi.waitFor(() =>
        expect(
          document.querySelector('.composer-file-preview'),
          document.querySelector('#composer')?.textContent ?? '',
        ).not.toBeNull(),
      )
      await vi.waitFor(() =>
        expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
      )
    }
  }

  it.each(['PNG', '10 MiB JPEG'])(
    'enables and sends a %s without text through session.prompt',
    async (format) => {
      const active = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
      await start(active)
      let bytes = imagePngBytes
      let mimeType = 'image/png'
      if (format === '10 MiB JPEG') {
        bytes = new Uint8Array(10 * 1024 * 1024)
        bytes.set([
          0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
        ])
        bytes.set([0xff, 0xd9], bytes.length - 2)
        mimeType = 'image/jpeg'
      }
      await attachPng(true, new File([bytes], 'image', { type: mimeType }))

      const send = document.getElementById('send') as HTMLButtonElement
      expect(send.disabled).toBe(false)
      submit('')

      await vi.waitFor(() => expect(active.prompt).toHaveBeenCalledTimes(1))
      expect(active.prompt).toHaveBeenCalledWith([imageReference(bytes, mimeType, 'image')], {
        titleLocale: 'zh-CN',
        references: [],
      })
    },
  )

  it('queues mixed text and images through session.followUp and restores both on failure', async () => {
    const active = session('old', async () => busyTimeline('old', { route: 'local', id: 'model-a' }))
    active.followUp.mockRejectedValueOnce(new Error('follow-up rejected'))
    await start(active, true)
    await attachPng()
    const draft = document.getElementById('prompt') as HTMLTextAreaElement
    draft.value = '请解释这张图'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    submit('请解释这张图')

    await vi.waitFor(() => expect(active.followUp).toHaveBeenCalledTimes(1))
    expect(active.followUp).toHaveBeenCalledWith(
      [{ type: 'text', text: '请解释这张图' }, imageReference(imagePngBytes, 'image/png', 'one.png')],
      { references: [] },
    )
    await vi.waitFor(() => expect(draft.value).toBe('请解释这张图'))
    expect(document.querySelector('.composer-file-preview')?.textContent).toContain('one.png')
    expect(document.querySelector('.agh-notifications')?.textContent).toContain('follow-up rejected')
  })

  it('accepts an image as a file attachment when the selected model has only text input', async () => {
    const active = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    await start(active, false, ['text'])
    const sha256 = createHash('sha256').update(imagePngBytes).digest('hex')
    const attachment = {
      type: 'resource_link',
      name: 'one.png',
      mimeType: 'image/png',
      uri: `agnes-upload://${'a'.repeat(64)}/${sha256}/${imagePngBytes.length}/00000000-0000-0000-0000-000000000001`,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const query = new URL(String(input), 'http://localhost').searchParams
        let value: unknown
        if (!init?.method) {
          value = { limits: { maxBytes: 1024 * 1024, chunkBytes: 1024, allowedMimeTypes: ['image/png'] } }
        } else if (query.get('operation') === 'chunk') {
          if (!(init.body instanceof Blob)) throw new Error('missing upload chunk')
          expect(new Uint8Array(await init.body.arrayBuffer())).toEqual(imagePngBytes)
          expect(query.get('sha256')).toBe(sha256)
          value = { offset: imagePngBytes.length }
        } else {
          const control = JSON.parse(String(init.body)) as { operation: string; sha256?: string }
          if (control.operation === 'finish') {
            expect(control.sha256).toBe(sha256)
            value = { attachment }
          } else value = { offset: 0 }
        }
        return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
      }),
    )
    await attachPng(false)
    await vi.waitFor(() => expect(document.querySelector('.composer-file-preview')).not.toBeNull())
    await vi.waitFor(() =>
      expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
    )
    expect(document.querySelector('.composer-image-preview img')).toBeNull()
    expect(document.getElementById('composer-attach')?.getAttribute('aria-disabled')).toBe('false')
    submit('')
    await vi.waitFor(() =>
      expect(active.prompt).toHaveBeenCalledWith([attachment], { titleLocale: 'zh-CN', references: [] }),
    )
  })

  it('keeps text and attachments when batch validation fails before sending', async () => {
    const active = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    await start(active)
    await attachPng()
    const protocol = await import('@agnes/protocol')
    const validation = vi.spyOn(protocol, 'validateUserAttachments').mockImplementationOnce(() => {
      throw new Error('attachments exceed aggregate byte limit')
    })
    submit('保留文字和图片')
    expect(active.prompt).not.toHaveBeenCalled()
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('保留文字和图片')
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-notifications')?.textContent).toContain('aggregate byte limit'),
    )
    // 支持图片的模型下，上传完成的图片按缩略图显示，文件名不再单独展示。
    await vi.waitFor(() => expect(document.querySelector('.composer-image-preview img')).not.toBeNull())
    validation.mockRestore()
    submit('保留文字和图片')
    await vi.waitFor(() => expect(active.prompt).toHaveBeenCalledTimes(1))
  })

  it('keeps an image draft and refuses a WebSocket frame that exceeds the transport limit', async () => {
    const active = session('old', async () => busyTimeline('old', { route: 'local', id: 'model-a' }))
    await start(active, true)
    await attachPng()
    const longText = 'x'.repeat(MAX_FRAME_BYTES)
    submit(longText)

    expect(active.followUp).not.toHaveBeenCalled()
    expect(active.steer).not.toHaveBeenCalled()
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe(longText)
    await vi.waitFor(() => expect(document.querySelector('.composer-image-preview img')).not.toBeNull())
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-notifications')?.textContent).toContain('144 MiB 限制'),
    )
  })
})

describe('web model confirmation', () => {
  it('preserves the confirmed model after a failed switch and ignores an old session response', async () => {
    installPublicFixture()
    const old = session('old', async () =>
      idleTimeline('old', { route: 'account-acct-private', id: 'model-a' }),
    )
    const next = session('next', async () => idleTimeline('next'))
    const oldResponse = deferred<{ effectiveFromSeq: number }>()
    old.setModel
      .mockImplementationOnce(async () => {
        throw new Error('model switch failed')
      })
      .mockImplementationOnce(() => oldResponse.promise)
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({
        profile: {
          models: [
            { route: 'local', id: 'model-a' },
            { route: 'local', id: 'model-b' },
          ],
        },
      })),
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(initialized),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => ({ items: [] })),
        add: vi.fn(async (path: string) => ({
          workspace: { path, name: 'agnes', lastUsedAt: null, sessionCount: 0, available: true },
        })),
      },
      session: {
        list: vi.fn(async () => ({
          items: [
            { sessionId: 'old', title: '现有任务' },
            { sessionId: 'next', title: '新任务' },
          ],
        })),
        load: vi.fn(async (id: string) => (id === 'old' ? old : next)),
        new: vi.fn(),
      },
    })
    binding.loadWebSession.mockImplementation(async (_load: unknown, id: string) => ({
      session: id === 'old' ? old : next,
      offPermission: vi.fn(),
    }))
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await bootApp()
    const model = document.getElementById('model') as HTMLButtonElement
    await vi.waitFor(() => expect(model.disabled).toBe(false))
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('model-a')
    expect(model.getAttribute('aria-label')).toBe('当前会话模型：model-a')

    model.click()
    await openModelList()
    modelMenu().querySelectorAll<HTMLElement>('[role="option"]')[1]?.click()
    await vi.waitFor(() => expect(old.setModel).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-notification-message[role="alert"]')?.textContent).toBe(
        'model switch failed',
      ),
    )
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('model-a')
    expect(model.getAttribute('aria-label')).not.toContain('account-acct-private')

    // The panel takes one request at a time: a choice made before the failed one has settled is
    // ignored, so choose again until the panel accepts it.
    await vi.waitFor(() => {
      modelMenu().querySelectorAll<HTMLElement>('[role="option"]')[1]?.click()
      expect(old.setModel).toHaveBeenCalledTimes(2)
    })
    expect(model.disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-session="next"]')?.click()
    await vi.waitFor(() => expect(next.projectUIOpening).toHaveBeenCalled())
    oldResponse.resolve({ effectiveFromSeq: 9 })

    await vi.waitFor(() => expect(model.disabled).toBe(false))
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('选择模型')
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull())
    expect(old.setModel).toHaveBeenCalledTimes(2)
  })
})

describe('session action review regressions', () => {
  /** 菜单项只在展开后存在（面板挂在 body 上），可访问名来自可见文字，所以按角色 + 文字定位。 */
  const menuItem = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === label,
    )

  async function boot(paged: { value: boolean }, narrow = false) {
    installPublicFixture()
    if (narrow)
      vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
          matches: query.includes('max-width'),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      )
    const on = vi.fn()
    let title = '改名前'
    const old = session('old', async () => idleTimeline('old'))
    const rename = vi.fn(async (_id: string, value: string) => {
      title = value
      paged.value = true
      return { title, archived: false }
    })
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(initialized),
      on,
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        rename,
        open: vi.fn(async () => old),
        load: vi.fn(async () => old),
        list: vi.fn(async (query: { q?: unknown }) =>
          paged.value && !query.q
            ? {
                items: Array.from({ length: 100 }, (_, i) => ({
                  sessionId: `recent-${i}`,
                  title: `近期 ${i}`,
                })),
                next: 'page2',
              }
            : { items: [{ sessionId: 'old', title }] },
        ),
      },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await bootApp()
    await vi.waitFor(() => expect(document.getElementById('task-title')?.textContent).toBe('改名前'))
    return { old, rename, on }
  }

  it('retains a renamed paged-out current session through the next transcript render', async () => {
    const { rename, old, on } = await boot({ value: false })
    await act(async () => document.querySelector<HTMLButtonElement>('#task-title')?.click())
    const titleInput = document.getElementById('task-title-input') as HTMLInputElement
    expect(titleInput).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(titleInput, '改名后')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="task-title-save"]')?.click(),
    )
    await vi.waitFor(() => expect(document.getElementById('task-title-input')).toBeNull())
    expect(rename).toHaveBeenCalledOnce()
    expect(document.getElementById('task-title')?.textContent).toBe('改名后')
    const prior = old.projectUIOpening.mock.calls.length
    on.mock.calls.find(([event]) => event === 'gap')?.[1]({ sessionId: 'old', earliestSeq: 1 })
    // A gap reopens the bounded window; it no longer reads the whole projection.
    await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(prior))
    await vi.waitFor(() => expect(document.getElementById('task-title')?.textContent).toBe('改名后'))
    await vi.waitFor(() => expect(document.querySelectorAll('#sessions [data-session]')).toHaveLength(5))
    expect(document.querySelector('[data-session="old"]')).toBeNull()
    expect(document.querySelector('#sessions [data-session]')?.getAttribute('data-session')).toBe('recent-0')
    expect(new URL(location.href).searchParams.get('session')).toBe('old')
  })

  it('reveals sidebar failures to narrow-screen users and restores keyboard focus', async () => {
    await boot({ value: false }, true)
    document.getElementById('sidebar-toggle')?.click()
    expect(document.querySelector('main')?.inert).toBe(true)
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-session-action-id="old"]')?.click()
    })
    const fork = menuItem('分叉会话')
    expect(fork).toBeDefined()
    fork?.click()
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-notifications')?.textContent).toContain('没有可分叉'),
    )
    expect(document.body.classList.contains('sidebar-open')).toBe(false)
    expect(document.querySelector('main')?.inert).toBe(false)
    expect(document.activeElement).toBe(document.getElementById('sidebar-toggle'))
  })
})

describe('sidebar recency', () => {
  it('re-lists after a user message so the chatted session moves up', async () => {
    installPublicFixture()
    const old = session('old', async () => idleTimeline('old'))
    const arrival = deferred<IteratorResult<unknown>>()
    let pulls = 0
    old.events.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => (pulls++ === 0 ? arrival.promise : new Promise(() => undefined)),
        return: async () => ({ done: true, value: undefined }),
      }),
    })
    let chatted = false
    const list = vi.fn(async () => ({
      items: chatted
        ? [
            { sessionId: 'old', title: '旧任务' },
            { sessionId: 'other', title: '别的任务' },
          ]
        : [
            { sessionId: 'other', title: '别的任务' },
            { sessionId: 'old', title: '旧任务' },
          ],
    }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(initialized),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list, load: vi.fn(async () => old) },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await bootApp()
    const order = () =>
      [...document.querySelectorAll<HTMLElement>('#sessions [data-session]')].map((b) => b.dataset.session)
    await vi.waitFor(() => expect(document.getElementById('task-title')?.textContent).toBe('旧任务'))
    expect(order()).toEqual(['other', 'old'])
    chatted = true
    arrival.resolve({ done: false, value: { type: 'user/message', seq: 9, data: {} } })
    await vi.waitFor(() => expect(order()).toEqual(['old', 'other']))
    expect(new URL(location.href).searchParams.get('session')).toBe('old')
    expect(document.getElementById('task-title')?.textContent).toBe('旧任务')
  })
})

describe('incremental opening', () => {
  async function bootWith(
    opening: () => Promise<UITimeline>,
    titled = true,
    configure?: (old: SessionDouble) => void,
    clientOverrides: Record<string, unknown> = {},
  ) {
    installPublicFixture()
    const on = vi.fn()
    const old = session('old', opening)
    configure?.(old)
    const list = vi.fn(async (_query?: { q?: { prefix?: string } }) => ({
      items: [{ sessionId: 'old', ...(titled ? { title: '旧任务' } : {}) }],
    }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(initialized),
      on,
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list, load: vi.fn(async () => old) },
      // Like every other client double here since approvals are looked up by decision: none pending.
      approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
      ...clientOverrides,
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await bootApp()
    const emit = (event: string, payload: unknown) =>
      on.mock.calls.find(([name]) => name === event)?.[1](payload)
    return { old, list, emit }
  }

  const finishedTurn: UITimeline['turns'][number] = {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    endSeq: 4,
    startedAt: '2026-09-24T00:00:00.000Z',
    status: 'completed',
    reason: 'completed',
    nodeIds: [],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: false,
      calls: [],
    },
    inherited: false,
    forkable: true,
  }

  it('opens with one bounded opening and no full projection, and seeds the run receipt from the last turn', async () => {
    const { old } = await bootWith(async () => ({ ...idleTimeline('old'), upto: 4, turns: [finishedTurn] }))
    await vi.waitFor(() =>
      expect(document.querySelector('#status [role="status"]')?.textContent).toBe('已完成'),
    )
    expect(
      document.querySelector('#status .run-status-phase > .run-status-word:last-child')?.textContent,
    ).toBe('已完成')
    expect(old.projectUIOpening).toHaveBeenCalledTimes(1)
    expect(old.projectUI).not.toHaveBeenCalled()
    expect(old.events).toHaveBeenCalledWith({ preview: true, cursor: { fromSeq: 4, generation: 1 } })
  })

  const controlState = (facts: unknown[] = []) => ({
    controls: { steer: true, interrupt: true, pause: true, cancel: true },
    paused: false,
    facts,
    pending: [],
  })

  it('reads session controls while the opening is out and applies them only after it', async () => {
    const opening = deferred<UITimeline>()
    const returned = {
      seq: 3,
      action: 'cancel',
      outcome: 'requested',
      details: { returned: [{ content: [{ type: 'text', text: 'Returned draft' }] }] },
    }
    const { old } = await bootWith(
      () => opening.promise,
      true,
      (old) => old.controls.mockImplementation(async () => controlState([returned])),
    )
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement
    await vi.waitFor(() => expect(old.projectUIOpening).toHaveBeenCalled())
    await vi.waitFor(() => expect(old.controls).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompt.value).not.toContain('Returned draft')
    expect(document.body.textContent).toContain('正在准备会话')
    opening.resolve({ ...idleTimeline('old'), upto: 4 })
    await vi.waitFor(() => expect(prompt.value).toContain('Returned draft'))
    await vi.waitFor(() =>
      expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it('keeps the composer preparing until the session controls arrive after the opening', async () => {
    const controls = deferred<ReturnType<typeof controlState>>()
    const { old } = await bootWith(
      async () => ({ ...idleTimeline('old'), upto: 4 }),
      true,
      (old) => old.controls.mockImplementation(() => controls.promise),
    )
    await vi.waitFor(() => expect(old.events).toHaveBeenCalled())
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement
    const send = document.getElementById('send') as HTMLButtonElement
    prompt.value = 'Next message'
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(send.disabled).toBe(true)
    expect(document.body.textContent).toContain('正在准备会话')
    controls.resolve(controlState())
    await vi.waitFor(() => expect(send.disabled).toBe(false))
  })

  it('renders an opened session once after its controls, together with its readiness', async () => {
    const controls = deferred<ReturnType<typeof controlState>>()
    const { old } = await bootWith(
      async () => ({ ...idleTimeline('old'), upto: 4 }),
      true,
      (old) => old.controls.mockImplementation(() => controls.promise),
    )
    await vi.waitFor(() => expect(old.events).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const opened = traceBridge.paints.length
    expect(opened).toBeGreaterThan(0)
    controls.resolve(controlState())
    await vi.waitFor(() => expect(releaseRuntime?.session.readiness.getSnapshot()?.status).toBe('ready'))
    await vi.waitFor(() => expect(traceBridge.paints.length).toBeGreaterThan(opened))
    expect(traceBridge.paints.slice(opened).filter((status) => status !== 'ready')).toEqual([])
  })

  it('still renders a later controls refresh by itself', async () => {
    const child = (status: string) => ({
      id: 'child-1',
      status,
      totalTokens: 10,
      durationMs: 1000,
      controls: { stop: true, continue: true },
    })
    const { old } = await bootWith(
      async () => ({ ...idleTimeline('old'), upto: 4 }),
      true,
      (old) =>
        old.controls
          .mockImplementationOnce(async () => ({ ...controlState(), children: [child('running')] }))
          .mockImplementation(async () => ({ ...controlState(), children: [child('completed')] })),
    )
    const status = () => document.querySelector('[data-testid="child-control-row"] [role="status"]')
    await vi.waitFor(() => expect(status()?.textContent).toBe('运行中'))
    // The periodic child refresh reads the controls again without any projection change.
    await vi.waitFor(() => expect(status()?.textContent).toBe('已完成'), { timeout: 4000 })
    expect(old.controls.mock.calls.length).toBeGreaterThan(1)
  })

  it.each(['persistent', 'transient'] as const)(
    'reads %s session control failures during the opening again after it, as before',
    async (failure) => {
      // The early read fails while nothing awaits it yet; that must not surface as unhandled.
      const unhandled: unknown[] = []
      const record = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', record)
      onTestFinished(() => {
        process.off('unhandledRejection', record)
      })
      const opening = deferred<UITimeline>()
      const { old } = await bootWith(
        () => opening.promise,
        true,
        (old) =>
          failure === 'persistent'
            ? old.controls.mockRejectedValue(new Error('controls unavailable'))
            : old.controls
                .mockRejectedValueOnce(new Error('connection lost'))
                .mockImplementation(async () => controlState()),
      )
      await vi.waitFor(() => expect(old.controls).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
      opening.resolve(idleTimeline('old'))
      const notice = document.getElementById('notice') as HTMLElement
      const prompt = document.getElementById('prompt') as HTMLTextAreaElement
      if (failure === 'persistent') {
        await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
        expect(old.detach).toHaveBeenCalled()
      } else {
        prompt.value = 'Next message'
        prompt.dispatchEvent(new Event('input', { bubbles: true }))
        await vi.waitFor(() =>
          expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
        )
        expect(notice.dataset.kind).not.toBe('session-recovery')
      }
      expect(old.controls).toHaveBeenCalledTimes(2)
    },
  )

  it('asks for a title once when the seeded last turn completed and the session has none', async () => {
    const { list } = await bootWith(
      async () => ({ ...idleTimeline('old'), upto: 4, turns: [finishedTurn] }),
      false,
    )
    await vi.waitFor(() => expect(list.mock.calls.some(([query]) => query?.q !== undefined)).toBe(true))
    const lookups = () => list.mock.calls.filter(([query]) => query?.q?.prefix === 'old').length
    const first = lookups()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lookups()).toBe(first)
  })

  it('drops the previous task recovery as soon as another task starts opening', async () => {
    await bootWith(async () => {
      throw new Error('previous task opening failed')
    })
    const notice = document.getElementById('notice') as HTMLElement
    await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
    const pending = deferred<{ session: SessionDouble; offPermission: ReturnType<typeof vi.fn> }>()
    binding.loadWebSession.mockReturnValueOnce(pending.promise)
    const next = session('next', async () => idleTimeline('next'))
    const work = selectionController.open?.('next')
    await vi.waitFor(() => expect(binding.loadWebSession).toHaveBeenCalledTimes(2))
    expect(notice.textContent).not.toContain('previous task opening failed')
    expect(notice.dataset.kind).not.toBe('session-recovery')
    pending.resolve({ session: next, offPermission: vi.fn() })
    await work
    expect(notice.textContent).toBe('')
  })

  it('shows session recovery when the first opening is refused', async () => {
    await bootWith(async () => {
      throw Object.assign(new Error('too large'), { data: { code: 'UI_PROJECTION_NODE_TOO_LARGE' } })
    })
    const notice = document.getElementById('notice') as HTMLElement
    await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
  })

  it('keeps the selected session when failed opening cleanup finishes late', async () => {
    const cleanup = deferred<void>()
    const next = session('next', async () => idleTimeline('next'))
    const { old } = await bootWith(
      async () => {
        throw new Error('old opening failed')
      },
      true,
      (old) => old.detach.mockImplementationOnce(() => cleanup.promise),
      {
        session: {
          list: vi.fn(async () => ({
            items: [
              { sessionId: 'old', title: 'Old' },
              { sessionId: 'next', title: 'Next' },
            ],
          })),
        },
      },
    )
    await vi.waitFor(() => expect(old.detach).toHaveBeenCalled())
    binding.loadWebSession.mockResolvedValue({ session: next, offPermission: vi.fn() })
    await vi.waitFor(() => expect(document.querySelector('[data-session="next"]')).not.toBeNull())
    const opening = selectionController.open?.('next')
    await opening
    await vi.waitFor(() => expect(next.projectUIOpening).toHaveBeenCalled())
    await vi.waitFor(() => expect(document.getElementById('task-title')?.textContent).toBe('Next'))
    cleanup.resolve()
    await act(async () => cleanup.promise)
    expect(document.getElementById('notice')?.dataset.kind).not.toBe('session-recovery')
    expect(document.getElementById('notice')?.textContent).not.toContain('old opening failed')
    expect(document.getElementById('task-title')?.textContent).toBe('Next')
    expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('restores the settings page and subpage named by the startup address', async () => {
    await bootWith(
      async () => idleTimeline('old'),
      true,
      () => {
        history.replaceState(null, '', '/?session=old&settings=model/add-account')
      },
    )
    await vi.waitFor(() => expect((document.getElementById('config') as HTMLDialogElement).open).toBe(true))
    await vi.waitFor(() => expect(document.querySelector('[data-testid="account-page-add"]')).not.toBeNull())
    expect(new URL(location.href).searchParams.get('settings')).toBe('model/add-account')
    expect(new URL(location.href).searchParams.get('session')).toBe('old')
  })

  it('points to a pending approval before the loaded window without offering a verdict', async () => {
    const decisions = vi.fn(async () => ({ decisions: [] }))
    await bootWith(
      async () => ({
        ...idleTimeline('old'),
        upto: 9,
        opState: {
          turn: 1,
          step: 1,
          phase: 'tools',
          parked: {
            decisionRef: { sessionId: 's', id: 't-1', revision: 1 },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      }),
      true,
      undefined,
      { approval: { list: decisions, decide: vi.fn(async () => undefined) } },
    )
    const approval = document.getElementById('approval') as HTMLElement
    // The automatic search of earlier pages ends without the decision: the card says where it is.
    await vi.waitFor(() => expect(approval.textContent).toContain('有一项审批等待处理'))
    expect(approval.textContent).not.toContain('已过期')
    const buttons = [...approval.querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons).toEqual(['定位审批'])
    // «定位审批» looks the decision up again, by its id, instead of giving up.
    const lookups = decisions.mock.calls.length
    approval.querySelector('button')?.click()
    await vi.waitFor(() => expect(decisions.mock.calls.length).toBeGreaterThan(lookups))
    expect(decisions).toHaveBeenLastCalledWith('s')
  })

  const parkedTimeline = (): UITimeline => ({
    ...idleTimeline('old'),
    upto: 9,
    opState: {
      turn: 1,
      step: 1,
      phase: 'tools',
      parked: {
        decisionRef: { sessionId: 's', id: 't-1', revision: 1 },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  })

  it('says it is looking while it loads earlier pages for a pending approval', async () => {
    await bootWith(
      async () => parkedTimeline(),
      true,
      (old) => {
        old.projectUIOpening.mockImplementation(async () => ({
          timeline: parkedTimeline(),
          history: { hasEarlier: true, startIndex: 3, totalNodes: 3, cursor: 'c' },
        }))
        old.projectUIHistory.mockImplementation(() => new Promise(() => undefined))
      },
    )
    const approval = document.getElementById('approval') as HTMLElement
    await vi.waitFor(() => expect(approval.textContent).toContain('正在查找'))
    expect(approval.querySelectorAll('button')).toHaveLength(0)
  })

  describe('recovery after the connection is gone', () => {
    // The fixture page carries the unreplaced marker as its daemon address.
    const page = (ws: string) => new Response(`<meta id="agnes-config" data-ws="${ws}" />`, { status: 200 })
    const samePage = () => page('__AGNES_WS_URL__')
    const newPage = () => page('ws://127.0.0.1:1/')
    const probes = (fetcher: { mock: { calls: unknown[][] } }) =>
      fetcher.mock.calls.filter(([input]) => input === '/').length
    let reload: { mockRestore(): void; mock: { calls: unknown[][] } }
    beforeEach(() => {
      reload = vi.spyOn(location, 'reload').mockImplementation(() => undefined)
    })
    afterEach(() => {
      vi.useRealTimers()
      reload.mockRestore()
    })

    it('reloads once the Web page serves a new daemon address, never into the old one', async () => {
      const { emit } = await bootWith(async () => idleTimeline('old'))
      const connection = document.getElementById('connection') as HTMLElement
      await vi.waitFor(() => expect(connection.dataset.state).toBe('connected'))
      const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 502 }))
      vi.stubGlobal('fetch', fetcher)
      emit('closed', { reason: 'closed' })
      // Two probes land at 0.5 s and 1.5 s; the server is still down, so the page must stay put.
      await new Promise((resolve) => setTimeout(resolve, 1700))
      expect(reload.mock.calls.length).toBe(0)
      expect(probes(fetcher)).toBe(2)
      const status = document.getElementById('reconnect-notice') as HTMLElement
      const notice = document.getElementById('notice') as HTMLElement
      expect(status.hidden).toBe(false)
      expect(connection.dataset.state).toBe('reconnecting')
      // The notice states the fact without contradicting the automatic recovery.
      expect(notice.textContent).not.toContain('重新运行')
      // A Web process that outlived the daemon still serves the old address: no reload into it.
      fetcher.mockImplementation(async () => samePage())
      await vi.waitFor(() => expect(probes(fetcher)).toBe(3), { timeout: 4000 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(reload.mock.calls.length).toBe(0)
      fetcher.mockImplementation(async () => newPage())
      await vi.waitFor(() => expect(reload.mock.calls.length).toBe(1), { timeout: 5000 })
      expect(status.textContent).toContain('正在重新载入')
    }, 20_000)

    it('starts recovering when the first connection fails', async () => {
      const fetcher = vi.fn<typeof fetch>(async () => newPage())
      await bootWith(async () => idleTimeline('old'), true, undefined, {
        initialize: vi.fn(async () => {
          throw new Error('connect failed')
        }),
      })
      vi.stubGlobal('fetch', fetcher)
      const status = document.getElementById('reconnect-notice') as HTMLElement
      await vi.waitFor(() => expect(status.hidden).toBe(false))
      await vi.waitFor(() => expect(reload.mock.calls.length).toBe(1), { timeout: 4000 })
    }, 15_000)

    it('keeps a retry control through later errors, retries by hand, and resumes when shown again', async () => {
      const { emit } = await bootWith(async () => idleTimeline('old'))
      const connection = document.getElementById('connection') as HTMLElement
      await vi.waitFor(() => expect(connection.dataset.state).toBe('connected'))
      const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 502 }))
      vi.stubGlobal('fetch', fetcher)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      emit('closed', { reason: 'closed' })
      await vi.advanceTimersByTimeAsync(65_000)
      const status = document.getElementById('reconnect-notice') as HTMLElement
      const retry = status.querySelector('button')
      expect(retry?.textContent).toBe('重试连接')
      expect(connection.dataset.state).toBe('closed')
      // A later message rewrites the notice, not the recovery status.
      emit('gap', { sessionId: 'old', earliestSeq: 1 })
      await vi.advanceTimersByTimeAsync(0)
      const notice = document.getElementById('notice') as HTMLElement
      expect(notice.textContent).toContain('部分历史事件')
      expect(status.querySelector('button')).toBe(retry)
      // Showing the tab again resumes automatic probing, which still refuses the old address.
      fetcher.mockImplementation(async () => samePage())
      const before = probes(fetcher)
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(probes(fetcher)).toBe(before + 1)
      expect(reload.mock.calls.length).toBe(0)
      await vi.advanceTimersByTimeAsync(65_000)
      // The retry button accepts any served page, for a restart that reused the same address.
      status.querySelector('button')?.click()
      await vi.advanceTimersByTimeAsync(0)
      expect(reload.mock.calls.length).toBe(1)
    }, 15_000)
  })

  it('looks for the approval again after a reopen, and ignores gaps of other sessions', async () => {
    const { old, emit } = await bootWith(async () => parkedTimeline())
    const approval = document.getElementById('approval') as HTMLElement
    await vi.waitFor(() => expect(approval.textContent).toContain('有一项审批等待处理'))
    const openings = old.projectUIOpening.mock.calls.length
    emit('gap', { sessionId: 'other', earliestSeq: 1 })
    emit('generationChanged', { sessionId: 'other', generation: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(old.projectUIOpening.mock.calls.length).toBe(openings)
    // The reopened window may reach further back, so the search starts over.
    old.projectUIOpening.mockImplementation(async () => ({
      timeline: parkedTimeline(),
      history: { hasEarlier: true, startIndex: 3, totalNodes: 3, cursor: 'c' },
    }))
    old.projectUIHistory.mockImplementation(() => new Promise(() => undefined))
    emit('gap', { sessionId: 'old', earliestSeq: 1 })
    await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBe(openings + 1))
    await vi.waitFor(() => expect(approval.textContent).toContain('正在查找'))
  })
})

it('reads the plugin roster, skins and models once per burst of package notices', async () => {
  installPublicFixture()
  const on = vi.fn()
  const old = session('old', async () => idleTimeline('old'))
  const request = vi.fn(async (_method: string) => undefined)
  const config = vi.fn(async () => ({ configured: true, profile: 'local-dev' }))
  const skins = vi.fn(async () => ({ revision: 'r1', skins: [] }))
  sdk.createClient.mockReturnValue({
    initialize: vi.fn(initialized),
    on,
    close: vi.fn(async () => undefined),
    request,
    apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
    config: { get: config, providers: vi.fn(async () => ({ providers: [] })) },
    clientModules: { list: vi.fn(async () => ({ revision: 'r1', modules: [], statuses: [], rows: [] })) },
    skins: { list: skins },
    workspace: { list: vi.fn(async () => ({ items: [] })) },
    session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old', title: 'Old' }] })) },
    approval: { list: vi.fn(async () => ({ decisions: [] })), decide: vi.fn(async () => undefined) },
  })
  binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
  await bootApp()
  await vi.waitFor(() => expect(old.controls).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 300))
  const rosters = () =>
    request.mock.calls.filter(([method]) => method === '_agnes/v1/applications.get').length
  const reads = { rosters: rosters(), configs: config.mock.calls.length, skins: skins.mock.calls.length }
  const notice = (kind: string) => {
    for (const [name, listener] of on.mock.calls)
      if (name === 'notice') listener({ kind, detail: { profile: 'local-dev' } })
  }
  for (const kind of ['tree_changed', 'tree_changed', 'packages_changed']) notice(kind)
  await vi.waitFor(() => expect(rosters()).toBeGreaterThan(reads.rosters))
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(rosters()).toBe(reads.rosters + 1)
  expect(config).toHaveBeenCalledTimes(reads.configs + 1)
  expect(skins).toHaveBeenCalledTimes(reads.skins + 1)
  notice('packages_changed')
  await vi.waitFor(() => expect(rosters()).toBe(reads.rosters + 2))
  await vi.waitFor(() => expect(config).toHaveBeenCalledTimes(reads.configs + 2))
  await vi.waitFor(() => expect(skins).toHaveBeenCalledTimes(reads.skins + 2))
})

it('renders Computer Use in the application and retires its late operation reply on pagehide', async () => {
  installPublicFixture()
  history.replaceState(null, '', '/?page=plugins&tab=plugins.computer-use#test-launcher-token')
  let finish!: (value: unknown) => void
  const pending = new Promise<unknown>((resolvePromise) => {
    finish = resolvePromise
  })
  const listSkins = vi.fn(async () => ({ revision: 'fixture', skins: [] }))
  const call = vi.fn(async (method: string) => {
    if (method.endsWith('operation.start')) return pending
    if (method.endsWith('operation.status')) return { status: 'not-found' }
    if (method.endsWith('permissions.status')) return { status: 'granted' }
    return {
      status: 'ready',
      driver: { platform: 'darwin', version: 'fixture' },
      runtime: { state: 'idle', startAttempted: false },
    }
  })
  sdk.createClient.mockReturnValue({
    call,
    skins: { list: listSkins },
    initialize: vi.fn(initialized),
    on: vi.fn(),
    close: vi.fn(async () => undefined),
    apis: vi.fn(async () => ({ profile: { models: [] } })),
    config: {
      get: vi.fn(async () => ({ configured: true, profile: 'local-dev' })),
      providers: vi.fn(async () => ({ providers: [] })),
    },
    workspace: { list: vi.fn(async () => ({ items: [] })) },
    session: { list: vi.fn(async () => ({ items: [] })) },
  })
  await bootApp()
  // This page is lazy-loaded; cold module loading can outlast waitFor's one-second default.
  await vi.waitFor(
    () =>
      expect(
        document.querySelector('[data-testid=computer-use-capability]'),
        `${location.href}\n${document.body.textContent?.slice(-3500)}`,
      ).not.toBeNull(),
    { timeout: 10_000 },
  )
  document.querySelector<HTMLButtonElement>('[data-testid=computer-use-more-toggle]')?.click()
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLButtonElement>('[data-testid=computer-use-update]')?.disabled).toBe(
      false,
    ),
  )
  document.querySelector<HTMLButtonElement>('[data-testid=computer-use-update]')?.click()
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.start', { kind: 'update' }),
  )
  window.dispatchEvent(new Event('pagehide'))
  const pane = document.querySelector('[data-testid=computer-use-capability]')
  const before = pane?.innerHTML
  const requests = call.mock.calls.length
  const skinReads = listSkins.mock.calls.length
  window.dispatchEvent(new CustomEvent('agnes:packages-changed'))
  finish({ status: 'found', operationId: 'retired', kind: 'update', state: 'running', phase: 'installing' })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  expect(pane?.innerHTML).toBe(before)
  expect(call.mock.calls).toHaveLength(requests)
  expect(listSkins.mock.calls).toHaveLength(skinReads)
  expect(call.mock.calls.some(([method]) => method.endsWith('operation.cancel'))).toBe(false)
})

// Opt-in synthetic sampling of the actual app entry; report files live outside the repository.
it.skipIf(!process.env.AGH_WEB_PERFORMANCE_OUTPUT).each([1, 2, 3])(
  'records visible idle requests and first-screen latency (sample %s)',
  async (sample) => {
    installPublicFixture()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const times: Record<string, number> = {}
    let requests = 0
    const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
    const counted = async <T>(value: T) => {
      requests++
      return value
    }
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        const path = String(url)
        if (path === '/admin/api/loops')
          return Response.json(
            await counted({
              revision: 1,
              defaults: {},
              loops: [],
            }),
          )
        if (path === '/admin/api/model-adapters') return Response.json(await counted({ modelAdapters: [] }))
        if (path === '/admin/api/composition') return Response.json(await counted({}))
        if (path === '/admin/api/runtime')
          return Response.json(
            await counted({
              providers: [],
              presets: [{ id: 'workspace-write', isDefault: true }],
              bundles: [],
              localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/workspace/plugins' },
            }),
          )
        if (path === '/admin/api/bundles') return Response.json(await counted({ catalog: [] }))
        return Response.json({ available: false })
      }),
    )
    const client = {
      initialize: vi.fn(initialized),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => {
          requests++
          times.config ??= performance.now()
          return { configured: true }
        }),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      apis: vi.fn(async () => {
        requests++
        times.modelsStart ??= performance.now()
        if (times.modelsEnd === undefined) await delay(250)
        times.modelsEnd ??= performance.now()
        return { profile: { models: [{ route: 'local', id: 'model-a' }] } }
      }),
      workspace: {
        list: vi.fn(async () => {
          times.workspacesStart ??= performance.now()
          await delay(40)
          times.workspacesEnd ??= performance.now()
          return { items: [] }
        }),
      },
      session: {
        list: vi.fn(async () => {
          times.sessionsStart ??= performance.now()
          await delay(20)
          times.sessionsEnd ??= performance.now()
          return { items: [{ sessionId: 'old' }] }
        }),
        load: vi.fn(),
      },
    }
    sdk.createClient.mockReturnValue(client)
    const old = session('old', async () => idleTimeline('old'))
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    try {
      await bootApp()
      await vi.waitFor(() => expect(binding.loadWebSession).toHaveBeenCalled())
      const idleStart = requests
      await vi.advanceTimersByTimeAsync(60_000)
      // These synthetic reads have real bounded waits; finish the last tick before counting.
      await delay(300)
      const visibleRequests = requests - idleStart
      const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      const hiddenStart = requests
      await vi.advanceTimersByTimeAsync(60_000)
      await delay(300)
      const hiddenRequests = requests - hiddenStart
      hidden.mockRestore()
      expect(hiddenRequests).toBe(0)
      const config = times.config ?? 0
      await writeFile(
        `${process.env.AGH_WEB_PERFORMANCE_OUTPUT}.${sample}.json`,
        JSON.stringify(
          {
            sample,
            modelDelayMs: 250,
            workspaceDelayMs: 40,
            sessionDelayMs: 20,
            visibleRequestsPerMinute: visibleRequests,
            hiddenRequestsPerMinute: hiddenRequests,
            firstSessionListMs: (times.sessionsEnd ?? 0) - config,
            requests: Object.fromEntries(Object.entries(times).map(([key, time]) => [key, time - config])),
          },
          null,
          2,
        ),
      )
    } finally {
      vi.useRealTimers()
    }
  },
)

describe('session that cannot continue on this build', () => {
  it('keeps a pending preview readable, clears it on admission, and dims only the previous selection', async () => {
    installPublicFixture()
    const opening = deferred<{ session: SessionDouble; offPermission: () => void }>()
    const nextView = deferred<ReturnType<typeof stored>>()
    const timeline = (id: string): UITimeline => ({
      ...idleTimeline(id, { route: 'local', id: 'model-a' }),
      nodes: [{ kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: `History of ${id}` }] }],
    })
    function stored(id: string) {
      return {
        sessionId: id,
        readOnly: true as const,
        lastSeq: 1,
        timeline: timeline(id),
        history: { hasEarlier: false, startIndex: 0, totalNodes: 1 },
      }
    }
    const old = session('old', async () => timeline('old'))
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      close: vi.fn(async () => undefined),
      initialize: vi.fn(initialized),
      on: vi.fn(),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        list: vi.fn(async () => ({ items: [{ sessionId: 'old', title: 'Old' }] })),
        view: vi.fn(async (id: string) => (id === 'old' ? stored(id) : nextView.promise)),
      },
    })
    binding.loadWebSession.mockReturnValue(opening.promise)
    await bootApp()
    await vi.waitFor(() =>
      expect(document.getElementById('transcript')?.textContent).toContain('History of old'),
    )
    expect(document.body.classList.contains('session-switching')).toBe(false)
    expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false)
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true)
    // The pending read-only preview states itself on the composer, which is what admission retires.
    expect((document.getElementById('prompt') as HTMLTextAreaElement).placeholder).toContain('只读')
    opening.resolve({ session: old, offPermission: vi.fn() })
    await vi.waitFor(() =>
      expect((document.getElementById('prompt') as HTMLTextAreaElement).placeholder).not.toContain('只读'),
    )
    expect(document.querySelector('[data-testid="session-read-only"]')).toBeNull()
    expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false)
    expect(document.body.classList.contains('session-switching')).toBe(false)

    const next = session('next', async () => timeline('next'))
    const nextOpening = deferred<{ session: SessionDouble; offPermission: () => void }>()
    binding.loadWebSession.mockReturnValue(nextOpening.promise)
    const switched = selectionController.open?.('next')
    expect(document.body.classList.contains('session-switching')).toBe(true)
    nextView.resolve(stored('next'))
    await vi.waitFor(() =>
      expect(document.getElementById('transcript')?.textContent).toContain('History of next'),
    )
    expect(document.body.classList.contains('session-switching')).toBe(false)
    expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false)
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true)
    nextOpening.resolve({ session: next, offPermission: vi.fn() })
    await switched
    expect((document.getElementById('prompt') as HTMLTextAreaElement).placeholder).not.toContain('只读')
    expect(document.body.classList.contains('session-switching')).toBe(false)
  })

  const refusals = [
    {
      issue: 'newer',
      code: 'E_SESSION_VERSION_NEWER',
      actions: ['upgrade'],
      text: '你的这个会话由更新版本的 AGH 写入，请升级。',
      buttons: ['升级后重新打开'],
    },
    {
      issue: 'older',
      code: 'E_SESSION_VERSION_OLDER',
      // The administrator switch is a per-kind CLI operation; the page never offers it.
      actions: ['new-session', 'repin'],
      text: '你的这个会话是用较旧版本创建的，已不可用。',
      buttons: ['新开会话'],
    },
    {
      issue: 'corrupt',
      code: 'E_SESSION_CORRUPT',
      actions: ['new-session'],
      text: '你的这个会话记录没有通过完整性检查。',
      buttons: ['新开会话'],
    },
  ] as const

  it.each(refusals.flatMap((entry) => [false, true].map((priorFailure) => ({ ...entry, priorFailure }))))(
    'keeps a $issue session readable after prior failure=$priorFailure',
    async ({ code, actions, text, buttons, issue, priorFailure }) => {
      installPublicFixture()
      const error = Object.assign(new Error('SEMANTIC_REJECTED (-32011)'), {
        data: { code, issue, actions, localized: { en: 'English text.', 'zh-CN': text } },
      })
      const view = vi.fn(async (id: string) => ({
        sessionId: id,
        readOnly: true as const,
        lastSeq: 2,
        timeline: {
          ...idleTimeline(id),
          upto: 2,
          nodes: [
            {
              kind: 'user' as const,
              id: 'u1',
              seq: 1,
              content: [{ type: 'text' as const, text: '历史问题' }],
            },
          ],
        },
        history: { hasEarlier: false, startIndex: 0, totalNodes: 1 },
      }))
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
        close: vi.fn(async () => undefined),
        initialize: vi.fn(initialized),
        on: vi.fn(),
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old', title: 'Old' }] })), view },
      })
      const opening = deferred<never>()
      if (priorFailure)
        binding.loadWebSession.mockRejectedValueOnce(
          Object.assign(new Error('worker open failed'), {
            data: { diagnosticId: '00000000-0000-4000-8000-000000000001' },
          }),
        )
      binding.loadWebSession.mockReturnValue(opening.promise)
      await bootApp()
      if (priorFailure) {
        await vi.waitFor(() =>
          expect(document.getElementById('notice')?.dataset.kind).toBe('session-recovery'),
        )
        document.querySelector<HTMLButtonElement>('[data-recovery-action="retry"]')?.click()
        await vi.waitFor(() => expect(binding.loadWebSession).toHaveBeenCalledTimes(2))
      }
      await vi.waitFor(() => expect(document.getElementById('transcript')?.textContent).toContain('历史问题'))
      expect(document.body.classList.contains('session-switching')).toBe(false)
      expect(document.querySelector('[data-testid="session-read-only"]')).toBeNull()
      expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false)
      expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true)
      expect(document.body.textContent).not.toContain('这个会话在这里只读')
      opening.reject(error)
      const banner = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-testid="session-read-only"]')
        expect(found).toBeTruthy()
        return found as HTMLElement
      })
      expect(view).toHaveBeenCalledWith(
        'old',
        expect.objectContaining({ maxNodes: expect.any(Number) }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      expect(banner.textContent).toContain('只读')
      expect(banner.textContent).toContain(text)
      expect([...banner.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
        '会话详情',
        ...buttons,
      ])
      // The conversation is rendered from the record, and nothing can be sent into it.
      expect(document.getElementById('transcript')?.textContent).toContain('历史问题')
      expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(true)
      expect(document.body.textContent).toContain('这个会话在这里只读')
      // The ordinary recovery card is not shown on top of the readable record.
      expect(document.getElementById('notice')?.dataset.kind).not.toBe('session-recovery')
    },
  )

  it('falls back to the ordinary recovery when the record itself cannot be read', async () => {
    installPublicFixture()
    const error = Object.assign(new Error('SEMANTIC_REJECTED (-32011)'), {
      data: { code: 'E_SESSION_CORRUPT', actions: ['new-session'] },
    })
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      close: vi.fn(async () => undefined),
      initialize: vi.fn(initialized),
      on: vi.fn(),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        list: vi.fn(async () => ({ items: [{ sessionId: 'old', title: 'Old' }] })),
        view: vi.fn(async () => {
          throw new Error('denied')
        }),
      },
    })
    binding.loadWebSession.mockRejectedValue(error)
    await bootApp()
    const notice = document.getElementById('notice') as HTMLElement
    await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
    expect(document.querySelector('[data-testid="session-read-only"]')).toBeNull()
  })
})

/** @vitest-environment happy-dom */

import type {
  JsonValue,
  Outcome,
  SchemaRef,
  ShellProvider,
  ShellServices,
  ShellSnapshot,
  ShellViewState,
} from '@agnes/extension-api/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShellSwitcher } from '../../src/runtime/shell-state.js'

const OK: Outcome<void> = { ok: true, value: undefined }
const refused = (message: string) =>
  ({
    ok: false,
    error: {
      code: 'conflict',
      detailCode: 'test',
      message,
      retryAdvice: { kind: 'never' },
      diagnosticId: 'test',
    },
  }) as const
const SCHEMA: SchemaRef = { typeId: 'example.shell/view-state@1', revision: 2, digest: 'a'.repeat(64) }
const DRAFT: JsonValue = { draft: 'half-written reply', focus: 'composer', layout: { sidebar: 'collapsed' } }
const SERVICES = {} as ShellServices
const snapshot = (cursor: string): ShellSnapshot => ({
  sessionId: 'session-1',
  catalogRevision: 1,
  conversation: null,
  views: [],
  pending: [],
  connection: 'connected',
  cursor,
})

type MountInput = Parameters<ShellProvider['mount']>[0]
type Hooks = {
  mount?(input: MountInput): Promise<Outcome<void>>
  exportState?(): Promise<Outcome<ShellViewState>>
  importState?(state: ShellViewState): Promise<Outcome<void>>
}

/** A shell that records each call and renders its id into its container. */
function fakeShell(id: string, options: { descriptor?: Record<string, unknown>; on?: Hooks } = {}) {
  const calls: string[] = []
  const seen: { mount?: MountInput; imported?: ShellViewState; updates: ShellSnapshot[] } = { updates: [] }
  const on = options.on ?? {}
  const shell: ShellProvider = {
    descriptor: {
      id,
      apiMajor: 1,
      stateSchema: SCHEMA,
      requiredRegions: ['conversation', 'composer', 'interactions'],
      ...options.descriptor,
    } as ShellProvider['descriptor'],
    async mount(input) {
      calls.push('mount')
      seen.mount = input
      input.container.textContent = id
      return on.mount ? on.mount(input) : OK
    },
    async update(next) {
      calls.push('update')
      seen.updates.push(next)
      return OK
    },
    async exportState() {
      calls.push('exportState')
      return on.exportState ? on.exportState() : { ok: true, value: { schema: SCHEMA, data: DRAFT } }
    },
    async importState(state) {
      calls.push('importState')
      seen.imported = state
      return on.importState ? on.importState(state) : OK
    },
    stopAdmission() {
      calls.push('stopAdmission')
    },
    async dispose(reason) {
      calls.push(`dispose:${reason}`)
      return OK
    },
  }
  return { shell, calls, seen }
}

/** A client instance with `old` mounted as its current shell. */
async function client(on?: Hooks) {
  const surface = document.createElement('main')
  document.body.append(surface)
  let latest = snapshot('c1')
  const switcher = createShellSwitcher({ surface, services: SERVICES, snapshot: () => latest })
  const old = fakeShell('old', on ? { on } : {})
  expect(await switcher.switchTo(() => old.shell)).toEqual(OK)
  const setSnapshot = (next: ShellSnapshot) => {
    latest = next
  }
  return { surface, switcher, old, setSnapshot }
}

type Client = Awaited<ReturnType<typeof client>>

/** The old shell is still current, shown, admitting input and neither stopped nor disposed. */
function expectOldShellKept({ surface, switcher, old }: Client) {
  expect(switcher.current()).toBe(old.shell)
  expect(old.calls).not.toContain('stopAdmission')
  expect(old.calls.some((call) => call.startsWith('dispose'))).toBe(false)
  expect(old.seen.mount?.signal.aborted).toBe(false)
  expect([...surface.children]).toEqual([old.seen.mount?.container])
  expect(old.seen.mount?.container).toMatchObject({ hidden: false, inert: false, textContent: 'old' })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('shell switch', () => {
  it('carries the view state to the new shell before stopping and disposing the old one', async () => {
    const current = await client()
    const { surface, switcher, old, setSnapshot } = current
    let duringMount: unknown
    const next = fakeShell('next', {
      // A later revision of the same state schema reads the old shell's state.
      descriptor: { stateSchema: { ...SCHEMA, revision: 3, digest: 'b'.repeat(64) } },
      on: {
        async mount() {
          duringMount = [...surface.querySelectorAll<HTMLElement>(':scope > *')].map((c) => ({
            text: c.textContent,
            hidden: c.hidden,
            inert: c.inert,
          }))
          setSnapshot(snapshot('c2'))
          return OK
        },
      },
    })

    expect(await switcher.switchTo(() => next.shell)).toEqual(OK)

    // The old shell stayed in view, without input, until the candidate was ready.
    expect(duringMount).toEqual([
      { text: 'old', hidden: false, inert: true },
      { text: 'next', hidden: true, inert: false },
    ])
    expect(next.seen.imported).toEqual({ schema: SCHEMA, data: DRAFT })
    expect(next.seen.mount).toMatchObject({ snapshot: snapshot('c1'), services: SERVICES })
    expect(next.seen.updates).toEqual([snapshot('c2')])
    expect(next.seen.mount?.ownerToken).not.toBe(old.seen.mount?.ownerToken)
    expect(next.seen.mount?.signal.aborted).toBe(false)
    expect(old.calls).toEqual(['mount', 'exportState', 'stopAdmission', 'dispose:switch'])
    expect(old.seen.mount?.signal.aborted).toBe(true)
    expect(switcher.current()).toBe(next.shell)
    expect([...surface.children]).toEqual([next.seen.mount?.container])
    expect(next.seen.mount?.container.hidden).toBe(false)
  })

  it('blocks the switch while the current shell holds an unsaved buffer it cannot export', async () => {
    const current = await client({ exportState: async () => refused('an attachment is still uploading') })
    const next = fakeShell('next')

    expect(await current.switcher.switchTo(() => next.shell)).toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        detailCode: 'shell_state_blocked',
        message: 'the current shell cannot hand over its state: an attachment is still uploading',
      },
    })
    expect(next.calls).toEqual([])
    expect(current.old.calls).toEqual(['mount', 'exportState'])
    expectOldShellKept(current)
  })

  it.each([
    ['an unsupported API major', { apiMajor: 2 }],
    ['an unknown region', { requiredRegions: ['conversation', 'sidebar'] }],
    ['another state schema', { stateSchema: { ...SCHEMA, typeId: 'example.shell/other-state@1' } }],
    ['a new state schema major', { stateSchema: { ...SCHEMA, typeId: 'example.shell/view-state@2' } }],
    ['an older state schema revision', { stateSchema: { ...SCHEMA, revision: 1 } }],
    ['the same revision under another digest', { stateSchema: { ...SCHEMA, digest: 'b'.repeat(64) } }],
  ])('refuses a shell with %s before calling either shell', async (_, descriptor) => {
    const current = await client()
    const next = fakeShell('next', { descriptor })

    expect(await current.switcher.switchTo(() => next.shell)).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'shell_incompatible' },
    })
    expect(next.calls).toEqual([])
    expect(current.old.calls).toEqual(['mount'])
    expectOldShellKept(current)
  })

  it.each<[string, Hooks, string]>([
    ['refuses to mount', { mount: async () => refused('no layout') }, 'mount: no layout'],
    ['throws while mounting', { mount: () => Promise.reject(new Error('boom')) }, 'mount: boom'],
    ['refuses the view state', { importState: async () => refused('bad draft') }, 'import: bad draft'],
    [
      'throws on the view state',
      {
        importState: () => {
          throw new Error('boom')
        },
      },
      'import: boom',
    ],
  ])('falls back to the current shell when the new one %s', async (_, on, message) => {
    const current = await client()
    const next = fakeShell('next', { on })

    expect(await current.switcher.switchTo(() => next.shell)).toMatchObject({
      ok: false,
      error: {
        code: 'internal',
        detailCode: 'shell_candidate_failed',
        message: `the new shell failed to ${message}`,
      },
    })
    expect(next.calls.slice(-2)).toEqual(['stopAdmission', 'dispose:fault'])
    expect(next.seen.mount?.signal.aborted).toBe(true)
    expect(current.old.calls).toEqual(['mount', 'exportState'])
    expectOldShellKept(current)

    // The kept shell still works: it hands its state to the next candidate.
    const later = fakeShell('later')
    expect(await current.switcher.switchTo(() => later.shell)).toEqual(OK)
    expect(later.seen.imported).toEqual({ schema: SCHEMA, data: DRAFT })
  })

  it('refuses a second switch while one is running, without holding up another client', async () => {
    const { switcher } = await client()
    const gate = deferred<Outcome<void>>()
    const slow = fakeShell('slow', { on: { mount: () => gate.promise } })
    const first = switcher.switchTo(() => slow.shell)
    const factory = vi.fn(() => fakeShell('second').shell)

    expect(await switcher.switchTo(factory)).toMatchObject({
      ok: false,
      error: { code: 'conflict', detailCode: 'shell_switch_in_progress' },
    })
    expect(factory).not.toHaveBeenCalled()
    // Another client instance switches while this one's switch is still in flight.
    const other = await client()
    expect(await other.switcher.switchTo(() => fakeShell('other-next').shell)).toEqual(OK)

    gate.resolve(OK)
    expect(await first).toEqual(OK)
    expect(switcher.current()).toBe(slow.shell)
  })

  it('disposes both the current shell and the candidate when the client closes mid-switch', async () => {
    const { surface, switcher, old } = await client()
    const next = fakeShell('next', {
      on: {
        mount: ({ signal }) =>
          new Promise((resolve) => signal.addEventListener('abort', () => resolve(refused('aborted')))),
      },
    })
    const switching = switcher.switchTo(() => next.shell)
    await vi.waitFor(() => expect(next.calls).toContain('mount'))

    await switcher.dispose()

    expect(await switching).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(next.calls).toEqual(['mount', 'stopAdmission', 'dispose:shutdown'])
    expect(old.calls).toEqual(['mount', 'exportState', 'stopAdmission', 'dispose:shutdown'])
    expect(old.seen.mount?.signal.aborted).toBe(true)
    expect(surface.children).toHaveLength(0)
    expect(switcher.current()).toBeUndefined()
    expect(await switcher.switchTo(() => fakeShell('late').shell)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})

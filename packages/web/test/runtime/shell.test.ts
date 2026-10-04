/** @vitest-environment happy-dom */

import type {
  CommandHandle,
  Outcome,
  RendererPresentation,
  ShellProvider,
  ShellServices,
  ShellSnapshot,
  ShellViewState,
} from '@agnes/extension-api/client'
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultShell, defaultShellLocale } from '../../src/runtime/providers/shell.js'
import { createShellSwitcher } from '../../src/runtime/shell-state.js'

const SESSION = 'session-1'
const AT = '2026-10-01T00:00:00.000Z'
const REGIONS = ['settings', 'conversation', 'interactions', 'composer', 'resources']
const OK: Outcome<void> = { ok: true, value: undefined }
const MARKUP = '<img src="x" onerror="alert(1)">'
const create = () => createDefaultShell(defaultShellLocale('en'))

const turn = (id: string, status: string, reason?: string) => ({
  id,
  turn: 1,
  startSeq: 1,
  startedAt: AT,
  status,
  ...(reason ? { reason } : {}),
  nodeIds: [`${id}-user`, `${id}-assistant`],
  usage: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
  inherited: false,
  forkable: false,
})

const view = (viewId: string, phase: string, fallbackText = `Card ${viewId}`) => ({
  kind: 'domain',
  viewId,
  revision: 1,
  domainType: 'acme.card',
  viewSchema: { typeId: 'acme.card/view@1', revision: 1, digest: 'c'.repeat(64) },
  renderKey: 'card',
  scope: { kind: 'session', installationId: 'i', runtimeId: 'r', workspaceId: 'w', sessionId: SESSION },
  source: { eventIds: [], projectionRevision: 1 },
  phase,
  fallbackText,
  data: {},
  resources: [],
  actions: [],
})

function snapshot(turns: ReturnType<typeof turn>[], pending = true): ShellSnapshot {
  const nodes = turns.flatMap(({ id }) => [
    { kind: 'user', id: `${id}-user`, seq: 1, content: [{ type: 'text', text: `asked in ${id}` }] },
    { kind: 'assistant', id: `${id}-assistant`, seq: 2, text: `${MARKUP} answered in ${id}` },
  ])
  return {
    sessionId: SESSION,
    catalogRevision: 1,
    conversation: {
      sessionId: SESSION,
      epoch: 'epoch-1',
      revision: 1,
      native: {
        timeline: { sessionId: SESSION, upto: 0, generation: 7, opState: null, nodes, turns },
        history: { hasEarlier: false, startIndex: 0, totalNodes: nodes.length },
      },
      domains: [],
      order: [],
      orderCursor: 'order-0',
      nextPageCursor: null,
      complete: true,
    },
    views: [view('view-1', 'finalized'), view('view-2', 'provisional', MARKUP)],
    pending: pending
      ? [
          {
            interactionId: 'approval-1',
            owner: { runId: 'run-1', actionId: 'action-1' },
            request: { kind: 'approval', title: 'Approve deleting the deck', body: MARKUP },
            version: 1,
            createdAt: AT,
            updatedAt: AT,
            status: 'pending',
            terminationReason: null,
            resolution: null,
          },
        ]
      : [],
    connection: 'reconnecting',
    cursor: null,
  } as unknown as ShellSnapshot
}

const SNAPSHOT = snapshot([turn('turn-running', 'running'), turn('turn-blocked', 'completed', 'blocked')])
const NEXT = snapshot(
  [turn('turn-failed', 'failed', 'error'), turn('turn-done', 'completed', 'completed')],
  false,
)

const refused = (code: 'denied' | 'internal' = 'denied') =>
  ({
    ok: false,
    error: {
      code,
      detailCode: 'test',
      message: 'refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'test',
    },
  }) as const

const handle = (input: { requestId: string }, status: CommandHandle['status']): Outcome<CommandHandle> =>
  ({
    ok: true,
    value: {
      commandId: `command-${input.requestId}`,
      requestId: input.requestId,
      revision: 1,
      completion: 'runtime-accepted',
      status,
      result: null,
      error: status === 'failed' ? refused('internal').error : null,
    },
  }) as Outcome<CommandHandle>

type Answers = {
  submit?: ((input: { requestId: string }) => Promise<Outcome<CommandHandle>>) | undefined
  present?: ((view: { viewId: string }) => Outcome<RendererPresentation>) | undefined
  navigate?: (() => Promise<Outcome<void>>) | undefined
}

/** Fake ShellServices: no client host serves a shell real ones yet. Every call is recorded. */
function fakeServices(answers: Answers = {}) {
  const calls: { method: string; input: unknown }[] = []
  const services = {
    conversation: {
      async submit(input: { requestId: string }) {
        calls.push({ method: 'conversation.submit', input })
        return answers.submit ? answers.submit(input) : handle(input, 'accepted')
      },
    },
    presentation: {
      domain(view: { viewId: string }) {
        calls.push({ method: 'presentation.domain', input: view.viewId })
        return answers.present ? answers.present(view) : refused()
      },
    },
    async navigate(target: unknown) {
      calls.push({ method: 'navigate', input: target })
      return answers.navigate ? answers.navigate() : OK
    },
  } as unknown as ShellServices
  return { services, calls, made: (method: string) => calls.filter((call) => call.method === method) }
}

type MountInput = Parameters<ShellProvider['mount']>[0]
const mountInput = (
  container: HTMLElement,
  services = fakeServices().services,
  signal = new AbortController().signal,
): MountInput => ({ container, snapshot: SNAPSHOT, services, ownerToken: 'owner-1', signal })

async function mount(answers: Answers = {}, signal?: AbortSignal) {
  const fake = fakeServices(answers)
  const container = document.body.appendChild(document.createElement('div'))
  const shell = create()
  expect(await shell.mount(mountInput(container, fake.services, signal))).toEqual(OK)
  return { shell, container, ...fake }
}

const region = (box: HTMLElement, name: string) =>
  box.querySelector<HTMLElement>(`[data-agnes-region="${name}"]`)
const item = (box: HTMLElement, id: string) =>
  box.querySelector<HTMLElement>(`[data-agnes-shell-item="${id}"]`)
const states = (box: HTMLElement) =>
  Object.fromEntries(
    [...box.querySelectorAll<HTMLElement>('[data-agnes-shell-item]')].map((found) => [
      found.dataset.agnesShellItem,
      found.dataset.agnesShellState,
    ]),
  )
const composer = (box: HTMLElement) => {
  const form = region(box, 'composer')?.querySelector('form')
  const draft = form?.querySelector('textarea')
  if (!form || !draft) throw new Error('no composer form')
  return { form, draft }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
async function send(box: HTMLElement, text: string) {
  const { form, draft } = composer(box)
  draft.value = text
  form.requestSubmit()
  await settle()
}
const code = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.code)
const exported = async (shell: ShellProvider) => {
  const outcome = await shell.exportState()
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('default chat shell', () => {
  it('lays out the five labelled regions and shows every item with its state, wire text as text', async () => {
    const { shell, container } = await mount()

    expect(shell.descriptor).toMatchObject({ apiMajor: 1, requiredRegions: REGIONS })
    expect(REGIONS.map((name) => Boolean(region(container, name)?.getAttribute('aria-label')))).toEqual(
      REGIONS.map(() => true),
    )
    expect(states(container)).toEqual({
      'turn-running': 'pending',
      'turn-blocked': 'blocked',
      'approval-1': 'pending',
      'view-1': 'done',
      'view-2': 'pending',
    })
    expect(item(container, 'turn-blocked')?.textContent).toContain(`asked in turn-blocked${MARKUP} answered`)
    expect(item(container, 'approval-1')?.textContent).toContain(MARKUP)
    expect(region(container, 'settings')?.textContent).toContain('reconnecting')
    expect(container.querySelector('img')).toBeNull()
  })

  it('shows its own text through the LocaleClient it is created with', async () => {
    const container = document.body.appendChild(document.createElement('div'))
    const shell = createDefaultShell(defaultShellLocale('zh-CN'))
    expect(await shell.mount(mountInput(container))).toEqual(OK)

    expect(region(container, 'settings')?.getAttribute('aria-label')).toBe('会话')
    expect(item(container, 'turn-running')?.firstElementChild?.textContent).toBe('第 1 轮：进行中')
    expect(item(container, 'approval-1')?.textContent).toContain('Approve deleting the deck：进行中')
    expect(region(container, 'settings')?.textContent).toContain('连接：重连中')
    expect(composer(container).form.querySelector('button')?.textContent).toBe('发送')
    // A locale the shell has no text for falls back to English; a placeholder without a value stays.
    expect(defaultShellLocale('fr').text('defaultShell.send')).toBe('Send')
    expect(defaultShellLocale('en').text('defaultShell.turn', { turn: 2 })).toBe('Turn 2: {state}')
  })

  it('applies a valid update and refuses a malformed one, keeping what it shows', async () => {
    const { shell, container } = await mount()
    expect(await shell.update(NEXT)).toEqual(OK)
    const shown = states(container)
    expect(shown).toEqual({
      'turn-failed': 'error',
      'turn-done': 'done',
      'view-1': 'done',
      'view-2': 'pending',
    })

    for (const malformed of [null, { ...NEXT, views: 'none' }, { ...NEXT, connection: 'sideways' }])
      expect(code(await shell.update(malformed as unknown as ShellSnapshot))).toBe('invalid_input')
    expect(states(container)).toEqual(shown)
  })

  it.each<[string, Partial<MountInput>, string]>([
    ['an empty owner token', { ownerToken: '' }, 'invalid_input'],
    ['a container that is not an element', { container: {} as HTMLElement }, 'invalid_input'],
    ['a malformed snapshot', { snapshot: { ...SNAPSHOT, pending: 'none' } as never }, 'invalid_input'],
    ['services without a conversation client', { services: {} as ShellServices }, 'invalid_input'],
    ['an aborted signal', { signal: AbortSignal.abort() }, 'cancelled'],
  ])('refuses a mount with %s and renders nothing', async (_, change, expected) => {
    const container = document.body.appendChild(document.createElement('div'))
    expect(code(await create().mount({ ...mountInput(container), ...change }))).toBe(expected)
    expect(container.childNodes.length).toBe(0)
  })

  it.each<[string, string, Answers['submit'], string]>([
    ['an accepted', 'pending', async (input) => handle(input, 'accepted'), ''],
    ['an unknown-effect', 'unknown', async (input) => handle(input, 'unknown_effect'), ''],
    ['a failed', 'error', async (input) => handle(input, 'failed'), 'Draft the deck'],
    ['a refused', 'error', async () => refused(), 'Draft the deck'],
    ['a thrown', 'error', async () => Promise.reject(new Error('offline')), 'Draft the deck'],
  ])(
    'sends the draft through the conversation client and shows %s prompt as %s',
    async (_, state, submit, draft) => {
      const { container, made } = await mount({ submit })
      await send(container, ' Draft the deck ')

      const sent = made('conversation.submit').map((call) => call.input as { requestId: string })
      expect(sent).toMatchObject([
        {
          sessionId: SESSION,
          kind: 'prompt',
          content: [{ type: 'text', text: 'Draft the deck' }],
          expectedGeneration: 7,
        },
      ])
      expect(states(region(container, 'composer') as HTMLElement)).toEqual({
        [`${sent[0]?.requestId}`]: state,
      })
      // A prompt that did not go through is back in the draft.
      expect(composer(container).draft.value).toBe(draft)
    },
  )

  it.each<[string, Answers['navigate'], boolean]>([
    ['accepted', undefined, true],
    ['refused', async () => refused(), false],
  ])('chooses a view only when navigation through the services is %s', async (_, navigate, chosen) => {
    const { container, made } = await mount({ navigate })
    item(container, 'view-2')?.click()
    await settle()
    expect(made('navigate').map((call) => call.input)).toEqual([{ sessionId: SESSION, viewId: 'view-2' }])
    expect(item(container, 'view-2')?.getAttribute('aria-current')).toBe(chosen ? 'true' : null)
  })

  it.each<[string, Answers['present']]>([
    ['refuses', () => refused()],
    [
      'throws',
      () => {
        throw new Error('no renderer')
      },
    ],
    [
      'answers for another target',
      () => ({ ok: true, value: { target: 'sdk', formatted: { parts: [] } } }) as never,
    ],
  ])('shows the fallback text as text when the presentation %s', async (_, present) => {
    const { container } = await mount({ present })
    const entry = item(container, 'view-2')?.parentElement
    expect(entry?.textContent).toContain(MARKUP)
    expect(entry?.querySelector('img')).toBeNull()
  })

  it('presents a Web view through services.presentation.domain and releases it on dispose', async () => {
    const lifecycle: string[] = []
    function Card({ id }: { id: string }) {
      useEffect(() => {
        lifecycle.push(`mounted ${id}`)
        return () => {
          lifecycle.push(`released ${id}`)
        }
      }, [id])
      return createElement('strong', { className: 'card' }, `Rendered ${id}`)
    }
    const present = (view: { viewId: string }): Outcome<RendererPresentation> =>
      view.viewId === 'view-1'
        ? { ok: true, value: { target: 'web', element: createElement(Card, { id: view.viewId }) } }
        : refused()
    const { shell, container, made } = await mount({ present })

    expect(made('presentation.domain').map((call) => call.input)).toEqual(['view-1', 'view-2'])
    expect(item(container, 'view-1')?.parentElement?.querySelector('strong.card')?.textContent).toBe(
      'Rendered view-1',
    )
    expect(await shell.update(NEXT)).toEqual(OK)
    // The view keeps its region across updates, so the renderer is not mounted again.
    expect(lifecycle).toEqual(['mounted view-1'])

    expect(await shell.dispose('shutdown')).toEqual(OK)
    expect(lifecycle).toEqual(['mounted view-1', 'released view-1'])
    expect(container.childNodes.length).toBe(0)
  })

  it.each(['stopAdmission', 'abort'] as const)(
    'after %s admits nothing new but still exports',
    async (stop) => {
      const controller = new AbortController()
      const { shell, container, made } = await mount({}, controller.signal)
      const saved = await exported(shell)
      if (stop === 'abort') controller.abort()
      else shell.stopAdmission()

      await send(container, 'late')
      item(container, 'view-2')?.click()
      await settle()
      expect(made('conversation.submit')).toEqual([])
      expect(made('navigate')).toEqual([])
      expect(code(await shell.update(NEXT))).toBe('conflict')
      expect(code(await shell.importState(saved))).toBe('conflict')
      expect(code(await shell.exportState())).toBe('ok')
    },
  )

  it.each(['switch', 'shutdown', 'fault'] as const)(
    'on %s releases the container and refuses later calls',
    async (reason) => {
      const { shell, container, calls } = await mount()
      const saved = await exported(shell)
      const { form } = composer(container)
      const entry = item(container, 'view-1')
      const before = calls.length

      expect(await Promise.all([shell.dispose(reason), shell.dispose(reason)])).toEqual([OK, OK])
      expect(container.childNodes.length).toBe(0)
      form.dispatchEvent(new Event('submit', { cancelable: true }))
      entry?.click()
      await settle()
      expect(calls.length).toBe(before)
      const later = [
        await shell.mount(mountInput(container)),
        await shell.update(NEXT),
        await shell.exportState(),
        await shell.importState(saved),
      ]
      expect(later.map(code)).toEqual(['conflict', 'conflict', 'conflict', 'conflict'])
      expect(container.childNodes.length).toBe(0)
    },
  )

  it('hands its draft, chosen view, focus and scroll to a fresh shell', async () => {
    const first = await mount()
    item(first.container, 'view-2')?.click()
    await settle()
    const { draft } = composer(first.container)
    draft.value = 'half a reply'
    draft.focus()
    ;(region(first.container, 'conversation') as HTMLElement).scrollTop = 40

    const saved = await exported(first.shell)
    expect(saved.data).toEqual({ draft: 'half a reply', viewId: 'view-2', focus: 'composer', scroll: 40 })
    expect(saved.schema).toEqual(first.shell.descriptor.stateSchema)

    const second = await mount()
    expect(await second.shell.importState(saved)).toEqual(OK)
    expect(composer(second.container).draft.value).toBe('half a reply')
    expect(item(second.container, 'view-2')?.getAttribute('aria-current')).toBe('true')
    expect(region(second.container, 'composer')?.contains(document.activeElement)).toBe(true)
    expect(await exported(second.shell)).toEqual(saved)
    // Importing view state reaches no service.
    expect(second.calls.filter((call) => call.method !== 'presentation.domain')).toEqual([])
  })

  it.each<[string, (state: ShellViewState) => unknown, string]>([
    [
      'another state type',
      (state) => ({ ...state, schema: { ...state.schema, typeId: 'other.shell/state@1' } }),
      'incompatible',
    ],
    ['a later revision', (state) => ({ ...state, schema: { ...state.schema, revision: 2 } }), 'incompatible'],
    [
      'another digest',
      (state) => ({ ...state, schema: { ...state.schema, digest: 'd'.repeat(64) } }),
      'incompatible',
    ],
    ['no schema', (state) => ({ data: state.data }), 'invalid_input'],
    [
      'a draft that is not text',
      (state) => ({ ...state, data: { ...(state.data as object), draft: 3 } }),
      'invalid_input',
    ],
    [
      'an unknown region',
      (state) => ({ ...state, data: { ...(state.data as object), focus: 'sidebar' } }),
      'invalid_input',
    ],
  ])('refuses view state with %s and changes nothing', async (_, change, expected) => {
    const { shell } = await mount()
    const before = await exported(shell)
    expect(code(await shell.importState(change(before) as ShellViewState))).toBe(expected)
    expect(await exported(shell)).toEqual(before)
  })

  it('refuses to hand over its state while a prompt waits for its outcome, blocking a switch', async () => {
    let answer: (outcome: Outcome<CommandHandle>) => void = () => undefined
    const fake = fakeServices({ submit: () => new Promise((resolve) => (answer = resolve)) })
    const surface = document.body.appendChild(document.createElement('main'))
    const switcher = createShellSwitcher({ surface, services: fake.services, snapshot: () => SNAPSHOT })
    expect(await switcher.switchTo(create)).toEqual(OK)
    const shell = switcher.current() as ShellProvider
    await send(surface, 'Draft the deck')

    expect(await shell.exportState()).toMatchObject({
      ok: false,
      error: { code: 'conflict', detailCode: 'shell_prompt_in_flight' },
    })
    expect(await switcher.switchTo(create)).toMatchObject({
      ok: false,
      error: { code: 'conflict', detailCode: 'shell_state_blocked' },
    })
    expect(switcher.current()).toBe(shell)

    const [sent] = fake.made('conversation.submit')
    answer(handle(sent?.input as { requestId: string }, 'accepted'))
    await settle()
    expect(await switcher.switchTo(create)).toEqual(OK)
    expect(switcher.current()).not.toBe(shell)
    await switcher.dispose()
    expect(surface.childNodes.length).toBe(0)
  })
})

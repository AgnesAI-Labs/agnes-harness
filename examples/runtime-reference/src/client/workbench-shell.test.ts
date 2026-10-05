/** @vitest-environment happy-dom */

import type { Outcome, ShellProvider, ShellServices, ShellSnapshot } from '@agnes/extension-api/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkbenchShell } from './workbench-shell.js'

const SESSION = 'session-1'
const OK: Outcome<void> = { ok: true, value: undefined }
// Only the fields the workbench shell reads; the shell conformance cases mount it with full snapshots.
const SNAPSHOT = {
  sessionId: SESSION,
  catalogRevision: 1,
  conversation: { native: { timeline: { generation: 7, turns: [{ id: 'turn-1', status: 'running' }] } } },
  views: [],
  pending: [],
  connection: 'connected',
  cursor: null,
} as unknown as ShellSnapshot

const refused = {
  ok: false,
  error: {
    code: 'denied',
    detailCode: 'test',
    message: 'refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'test',
  },
} as const
const accepted = (input: { requestId: string }) => ({
  ok: true,
  value: {
    commandId: `command-${input.requestId}`,
    requestId: input.requestId,
    revision: 1,
    completion: 'runtime-accepted',
    status: 'accepted',
    result: null,
    error: null,
  },
})

type Answer = (input: never) => Promise<unknown>

/** ShellServices that record each call and answer it; the session's active run is run-1 unless told. */
function fakeServices(answers: Record<string, Answer> = {}) {
  const calls: { method: string; input: unknown }[] = []
  const answer = (method: string, standard: Answer) => (input: never) => {
    calls.push({ method, input })
    return (answers[method] ?? standard)(input)
  }
  const services = {
    conversation: {
      submit: answer('conversation.submit', async (input: { requestId: string }) => accepted(input)),
      cancel: answer('conversation.cancel', async (input: { requestId: string }) => accepted(input)),
    },
    control: {
      read: answer('control.read', async (sessionId: string) => ({
        ok: true,
        value: { sessionId, activeRunId: 'run-1' },
      })),
    },
    navigate: answer('navigate', async () => OK),
  } as unknown as ShellServices
  return { services, made: (method: string) => calls.filter((call) => call.method === method) }
}

async function mount(answers?: Record<string, Answer>) {
  const fake = fakeServices(answers)
  const container = document.body.appendChild(document.createElement('div'))
  const shell: ShellProvider = createWorkbenchShell()
  const signal = new AbortController().signal
  expect(
    await shell.mount({
      container,
      snapshot: SNAPSHOT,
      services: fake.services,
      ownerToken: 'owner-1',
      signal,
    }),
  ).toEqual(OK)
  return { shell, container, ...fake }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const composer = (box: HTMLElement) => box.querySelector('[data-agnes-region="composer"]') as HTMLElement
const draft = (box: HTMLElement) => composer(box).querySelector('textarea') as HTMLTextAreaElement
const button = (box: HTMLElement, label: string) =>
  [...composer(box).querySelectorAll('button')].find(
    (found) => found.textContent === label,
  ) as HTMLButtonElement
/** The state of each request the composer shows, by request id. */
const shown = (box: HTMLElement) =>
  Object.fromEntries(
    [...composer(box).querySelectorAll<HTMLElement>('[data-agnes-shell-item]')].map((item) => [
      item.dataset.agnesShellItem,
      item.dataset.agnesShellState,
    ]),
  )

/** Sends the draft `text` as a prompt, through the form, or as a follow-up, through its own button. */
async function send(box: HTMLElement, text: string, kind: 'prompt' | 'follow-up' = 'prompt') {
  draft(box).value = text
  if (kind === 'prompt') composer(box).querySelector('form')?.requestSubmit()
  else button(box, 'Follow up').click()
  await settle()
}

async function stop(box: HTMLElement) {
  button(box, 'Stop').click()
  await settle()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('reference workbench shell', () => {
  it.each(['prompt', 'follow-up'] as const)(
    'sends the draft as a %s through the conversation client',
    async (kind) => {
      const { container, made } = await mount()
      await send(container, ' Draft the deck ', kind)

      const sent = made('conversation.submit').map((call) => call.input as { requestId: string })
      expect(sent).toMatchObject([
        {
          sessionId: SESSION,
          kind,
          content: [{ type: 'text', text: 'Draft the deck' }],
          expectedGeneration: 7,
        },
      ])
      expect(shown(container)).toEqual({ [`${sent[0]?.requestId}`]: 'pending' })
      expect(draft(container).value).toBe('')
    },
  )

  it.each<[string, Answer, string]>([
    ['refused', async () => refused, 'blocked'],
    [
      'thrown',
      async () => {
        throw new Error('offline')
      },
      'error',
    ],
  ])('keeps the draft when the send is %s', async (_, submit, state) => {
    const { container } = await mount({ 'conversation.submit': submit })
    await send(container, 'Draft the deck')

    expect(Object.values(shown(container))).toEqual([state])
    expect(draft(container).value).toBe('Draft the deck')
  })

  it.each<[string, Answer | undefined, string[]]>([
    ['the active run the session control names', undefined, ['run-1']],
    ['nothing when no run is active', async () => ({ ok: true, value: { activeRunId: null } }), []],
    ['nothing when the control read is refused', async () => refused, []],
  ])('stops %s, by its run id', async (_, read, runs) => {
    const { container, made } = await mount(read ? { 'control.read': read } : {})
    await stop(container)

    expect(made('control.read').map((call) => call.input)).toEqual([SESSION])
    const cancels = made('conversation.cancel').map((call) => call.input as { requestId: string })
    expect(cancels).toMatchObject(runs.map((runId) => ({ sessionId: SESSION, runId })))
    expect(shown(container)).toEqual(
      Object.fromEntries(cancels.map(({ requestId }) => [requestId, 'pending'])),
    )
  })

  it.each<[string, string, (box: HTMLElement) => Promise<void>]>([
    ['a prompt', 'conversation.submit', (box) => send(box, 'Draft the deck')],
    ['a stop', 'conversation.cancel', stop],
  ])('refuses to hand over its state while %s waits for its outcome', async (_, method, act) => {
    let answer: (outcome: unknown) => void = () => undefined
    const { shell, container, made } = await mount({
      [method]: () => new Promise((resolve) => (answer = resolve)),
    })
    await act(container)

    expect(await shell.exportState()).toMatchObject({ ok: false, error: { code: 'conflict' } })
    answer(accepted(made(method)[0]?.input as { requestId: string }))
    await settle()
    // Once the outcome is in, the state hands over, without the sent text as an unsent draft.
    expect(await shell.exportState()).toMatchObject({ ok: true, value: { data: { draft: '' } } })
  })

  it('sends no follow-up and no stop once admission stopped', async () => {
    const { shell, container, made } = await mount()
    shell.stopAdmission()
    await send(container, 'late', 'follow-up')
    await stop(container)
    expect([made('conversation.submit'), made('control.read'), made('conversation.cancel')]).toEqual([
      [],
      [],
      [],
    ])
  })
})

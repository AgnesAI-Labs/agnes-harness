import type { DomainView, NegotiatedClientCapabilities, RendererContext } from '@agnes/extension-api/client'
import { validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { createRendererContext, createViewIndex } from '../../src/runtime/renderer-context.js'

const schema = { typeId: 'acme.notes/rename@1', revision: 1, digest: 'a'.repeat(64) }
const scope = {
  kind: 'session' as const,
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
}
const action = { requiredFeatures: [], availability: 'enabled' as const, disabledReason: null }

function view(revision: number, rename = 'rename'): DomainView {
  const value: DomainView = {
    kind: 'domain',
    viewId: 'note-1',
    revision,
    domainType: 'acme.notes',
    viewSchema: { typeId: 'acme.notes/view@1', revision: 1, digest: 'b'.repeat(64) },
    renderKey: 'acme.notes/card',
    scope,
    source: { eventIds: ['event-1'], projectionRevision: 4 },
    phase: 'finalized',
    fallbackText: 'Note',
    data: {},
    resources: [
      { artifactId: 'file-1', version: 3, title: 'a.txt', mime: 'text/plain', size: 1, status: 'ready' },
    ],
    actions: [
      {
        ...action,
        kind: 'command',
        actionKey: rename,
        label: 'Rename',
        command: 'rename',
        inputSchema: schema,
      },
      { ...action, kind: 'download', actionKey: 'get', label: 'Get', artifactId: 'file-2', version: 1 },
      { ...action, kind: 'interaction', actionKey: 'ask', label: 'Ask', interactionId: 'ask-1', version: 2 },
      // Disabled actions are shown but not offered.
      {
        ...action,
        availability: 'disabled',
        disabledReason: 'Locked',
        kind: 'command',
        actionKey: 'lock',
        label: 'Lock',
        command: 'lock',
        inputSchema: schema,
      },
      {
        ...action,
        availability: 'disabled',
        disabledReason: 'Expired',
        kind: 'download',
        actionKey: 'old',
        label: 'Old',
        artifactId: 'file-3',
        version: 1,
      },
      // An enabled command needing a feature this client did not negotiate is shown but not offered.
      {
        ...action,
        kind: 'command',
        actionKey: 'batch',
        label: 'Batch',
        command: 'batch',
        inputSchema: schema,
        requiredFeatures: ['acme.batch'],
      },
    ],
  }
  expect(validateRuntime('DomainView', value).ok).toBe(true)
  // Unknown action (case 4): an enabled action of a kind this client does not know, forged past
  // validation as a newer or malicious server could send it, offers nothing it names.
  const forged = {
    ...action,
    kind: 'script',
    actionKey: 'run',
    label: 'Run',
    command: 'run',
    inputSchema: schema,
    interactionId: 'run-1',
    artifactId: 'file-4',
    version: 1,
  }
  return { ...value, actions: [...value.actions, forged as unknown as DomainView['actions'][number]] }
}

const capabilities = {
  clientInstanceId: 'client-1',
  target: 'web',
  features: [],
} as unknown as NegotiatedClientCapabilities

const submitted = (requestId: string, actionKey = 'rename', viewRevision = 7, viewId = 'note-1') => ({
  action: { viewId, actionKey, viewRevision },
  commandSchema: schema,
  input: { kind: 'inline' as const, schema, value: {}, digest: 'c'.repeat(64), bytes: 2 },
  requestId,
  expectedRevision: 4,
})

/** A context for `viewId` at revision 7; contexts given one `index` share what they sent per view. */
function mount({
  index = createViewIndex(),
  viewId = 'note-1',
  ownerToken = 'owner-1',
  drainMs = 5_000,
} = {}) {
  const ok = async (..._: unknown[]): Promise<unknown> => ({ ok: true as const, value: 'delegated' })
  const services = {
    commands: { submit: vi.fn(ok), commandStatus: vi.fn(ok) },
    interactions: {
      pending: vi.fn(ok),
      read: vi.fn(ok),
      respond: vi.fn(ok),
      formLink: vi.fn(ok),
      responseStatus: vi.fn(ok),
    },
    artifacts: {
      describe: vi.fn(ok),
      openDownload: vi.fn(ok),
      readRange: vi.fn(ok),
      openStream: vi.fn(ok),
      followDownload: vi.fn(() => ({ ok: true as const, value: undefined })),
    },
    locale: { locale: 'en', text: (key: string) => key, formatNumber: () => '', formatDate: () => '' },
  }
  const mounted = createRendererContext({
    clientInstanceId: 'client-1',
    ownerToken,
    capabilities,
    services: services as unknown as Pick<
      RendererContext,
      'commands' | 'interactions' | 'artifacts' | 'locale'
    >,
    view: { ...view(7), viewId },
    index,
    drainMs,
  })
  return { services, ...mounted }
}

const code = async (outcome: unknown) => {
  const settled = (await outcome) as { ok: boolean; error?: { code: string } }
  return settled.ok ? 'ok' : settled.error?.code
}
const detail = async (outcome: unknown) => {
  const settled = (await outcome) as { ok: boolean; error?: { code: string; detailCode: string } }
  return settled.ok ? 'ok' : `${settled.error?.code}/${settled.error?.detailCode}`
}

/** A command handle for `requestId` in `status`, as a submit or status read answers it. */
const handle = (requestId: string, status: string) => ({ ok: true as const, value: { requestId, status } })

/** Every client call a renderer can make, keyed by what it names. */
function calls(context: RendererContext, viewId = 'note-1') {
  const ticket = { url: 'u', expiresAt: 't', grantRevision: 1 }
  return {
    submit: (requestId: string, actionKey?: string, viewRevision?: number) =>
      context.commands.submit(submitted(requestId, actionKey, viewRevision, viewId)),
    status: (requestId: string) => context.commands.commandStatus(requestId),
    artifact: (artifactId: string, version: number) => [
      context.artifacts.describe(artifactId, version),
      context.artifacts.openDownload({ artifactId, version, disposition: 'attachment' }),
      context.artifacts.readRange({ artifactId, version, offset: 0, length: 1 }),
      context.artifacts.openStream({ artifactId, version }),
      context.artifacts.followDownload({ ...ticket, artifactId, version }),
    ],
    interaction: (interactionId: string, responseId = 'response-1') => [
      context.interactions.read(interactionId),
      context.interactions.formLink(interactionId, 2),
      context.interactions.respond({
        interactionId,
        responseId,
        expectedVersion: 2,
        answer: { kind: 'inline', schema, value: {}, digest: 'c'.repeat(64), bytes: 2 },
      }),
    ],
  }
}

const codes = (outcomes: unknown[]) => Promise.all(outcomes.map(code))

describe('renderer context restricted to the mounted view', () => {
  it('delegates what the view offers and refuses everything else before any service call', async () => {
    const { services, context } = mount()
    const call = calls(context)
    expect(
      await codes([call.status('request-1'), context.interactions.responseStatus('response-1')]),
    ).toEqual(['denied', 'denied'])
    expect(
      await codes([
        call.submit('r', 'missing'),
        call.submit('r', 'get'),
        call.submit('r', 'rename', 6),
        context.commands.submit({
          ...submitted('r'),
          action: { viewId: 'note-2', actionKey: 'rename', viewRevision: 7 },
        }),
        ...call.artifact('file-9', 3),
        ...call.artifact('file-1', 2),
        ...call.interaction('ask-9'),
        context.interactions.pending({ scope }),
        call.submit('r', 'lock'),
        ...call.artifact('file-3', 1),
        call.submit('r', 'run'),
        ...call.interaction('run-1'),
        ...call.artifact('file-4', 1),
        call.submit('r', 'batch'),
      ]),
    ).toEqual(Array(34).fill('denied'))
    for (const group of Object.values(services))
      for (const fn of Object.values(group)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled()

    expect(await code(call.submit('request-1'))).toBe('ok')
    expect(services.commands.submit).toHaveBeenCalledWith(submitted('request-1'))
    expect(
      await codes([call.status('request-1'), ...call.artifact('file-1', 3), ...call.artifact('file-2', 1)]),
    ).toEqual(Array(11).fill('ok'))
    expect(
      await codes([...call.interaction('ask-1'), context.interactions.responseStatus('response-1')]),
    ).toEqual(Array(4).fill('ok'))
    expect(services.commands.commandStatus).toHaveBeenCalledWith('request-1')
    expect(services.artifacts.describe).toHaveBeenCalledWith('file-1', 3)
    expect(services.interactions.responseStatus).toHaveBeenCalledWith('response-1')
  })

  it('checks a copy, so a request changed after the call cannot reach the service', async () => {
    const { services, context } = mount()
    const request = submitted('request-1')
    const pending = context.commands.submit(request)
    request.action.viewId = 'note-2'
    await pending
    expect(services.commands.submit).toHaveBeenCalledWith(submitted('request-1'))
    const tricky = { ...submitted('request-2'), toJSON: () => submitted('request-2') }
    expect(await code(context.commands.submit(tricky))).toBe('denied')
  })

  it('moves the allowed sets with a newer revision of the same view only', async () => {
    const { services, context, update } = mount()
    const call = calls(context)
    expect(update(view(8, 'retitle'))).toEqual({ ok: true, value: undefined })
    expect(await codes([call.submit('r', 'rename', 8), call.submit('r', 'retitle', 7)])).toEqual([
      'denied',
      'denied',
    ])
    expect(await code(call.submit('r', 'retitle', 8))).toBe('ok')
    expect(update({ ...view(9), viewId: 'note-2' }).ok).toBe(false)
    expect(update(view(7)).ok).toBe(false)
    expect(await code(call.submit('s', 'retitle', 8))).toBe('ok')
    expect(services.commands.submit).toHaveBeenCalledTimes(2)
  })

  it('refuses every call after dispose, aborts the signal and runs each cleanup once', async () => {
    const { services, context, update, dispose } = mount()
    const call = calls(context)
    const { submit, commandStatus } = context.commands
    expect(await code(submit(submitted('request-1')))).toBe('ok')
    const ran: string[] = []
    context.onDispose(() => {
      ran.push('first')
    })
    context.onDispose(() => {
      throw new Error('cleanup failed')
    })
    context.onDispose(async () => {
      ran.push('last')
    })
    expect(context.signal.aborted).toBe(false)
    await Promise.all([dispose(), dispose()])
    await dispose()
    expect(context.signal.aborted).toBe(true)
    expect(ran).toEqual(['last', 'first'])
    expect(
      await codes([
        submit(submitted('request-2')),
        commandStatus('request-1'),
        ...call.artifact('file-1', 3),
        ...call.interaction('ask-1'),
      ]),
    ).toEqual(Array(10).fill('denied'))
    expect(update(view(8)).ok).toBe(false)
    expect(services.commands.submit).toHaveBeenCalledTimes(1)
    expect(services.commands.commandStatus).not.toHaveBeenCalled()
    const late = vi.fn()
    context.onDispose(late)
    await Promise.resolve()
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('lets every context of one index read the status of what any of them sent for the view, and nothing else', async () => {
    const index = createViewIndex()
    const sender = mount({ index })
    const reader = mount({ index, ownerToken: 'owner-2' })
    const other = mount({ index, viewId: 'note-2', ownerToken: 'owner-3' })
    expect(
      await codes([
        calls(sender.context).submit('request-1'),
        ...calls(sender.context).interaction('ask-1', 'response-1'),
        calls(other.context, 'note-2').submit('request-2'),
      ]),
    ).toEqual(Array(5).fill('ok'))
    await sender.dispose()

    const { commands, interactions } = reader.context
    expect(
      await codes([commands.commandStatus('request-1'), interactions.responseStatus('response-1')]),
    ).toEqual(['ok', 'ok'])
    // Another view's request, a request never sent and a response id read as a request stay outside.
    expect(
      await Promise.all(
        ['request-2', 'request-9', 'response-1'].map((id) => detail(commands.commandStatus(id))),
      ),
    ).toEqual(Array(3).fill('denied/outside_view'))
    expect(reader.services.commands.commandStatus.mock.calls).toEqual([['request-1']])
    expect(reader.services.interactions.responseStatus.mock.calls).toEqual([['response-1']])
    expect(await detail(sender.context.commands.commandStatus('request-1'))).toBe('denied/renderer_disposed')
    expect(sender.services.commands.commandStatus).not.toHaveBeenCalled()
  })

  it('makes room in a full view by forgetting its oldest settled id', async () => {
    const { services, context } = mount()
    const call = calls(context)
    services.commands.submit.mockImplementation(async (request) =>
      handle((request as { requestId: string }).requestId, 'succeeded'),
    )
    const ids = Array.from({ length: 128 }, (_, n) => `request-${n}`)
    expect(await codes(ids.map((id) => call.submit(id)))).toEqual(Array(128).fill('ok'))
    expect(await code(call.submit('request-128'))).toBe('ok')
    expect(services.commands.submit).toHaveBeenCalledTimes(129)
    expect(
      await Promise.all(['request-0', 'request-1', 'request-128'].map((id) => detail(call.status(id)))),
    ).toEqual(['denied/outside_view', 'ok', 'ok'])
  })

  it('refuses a new id before any service call while the view holds no settled one to forget', async () => {
    const { services, context } = mount()
    const call = calls(context)
    const { submit, commandStatus } = services.commands
    submit.mockImplementation(async (request) =>
      handle((request as { requestId: string }).requestId, 'accepted'),
    )
    submit.mockResolvedValueOnce(handle('request-0', 'unknown_effect'))
    const ids = Array.from({ length: 128 }, (_, n) => `request-${n}`)
    expect(await codes(ids.map((id) => call.submit(id)))).toEqual(Array(128).fill('ok'))
    expect(await detail(call.submit('request-128'))).toBe('quota/command_ledger_full')
    expect(submit).toHaveBeenCalledTimes(128)
    // A retry of a sent id takes no new entry.
    expect(await code(call.submit('request-5'))).toBe('ok')

    // Running is not final, and a refused read leaves a final id final.
    commandStatus.mockResolvedValueOnce(handle('request-1', 'running'))
    commandStatus.mockResolvedValueOnce(handle('request-2', 'succeeded'))
    commandStatus.mockResolvedValueOnce({ ok: false, error: { code: 'timeout' } })
    expect(
      await codes([call.status('request-1'), call.status('request-2'), call.status('request-2')]),
    ).toEqual(['ok', 'ok', 'timeout'])
    // Only request-2 is settled, so it makes the room though request-0 and request-1 are older.
    expect(await code(call.submit('request-128'))).toBe('ok')
    expect(await detail(call.submit('request-129'))).toBe('quota/command_ledger_full')
    expect(submit).toHaveBeenCalledTimes(130)
    expect(
      await Promise.all(['request-0', 'request-1', 'request-2'].map((id) => detail(call.status(id)))),
    ).toEqual(['ok', 'ok', 'denied/outside_view'])
  })

  it('settles an id whose first send was refused outright, but not one refused on a resend', async () => {
    const { services, context } = mount()
    const call = calls(context)
    const { submit } = services.commands
    submit.mockImplementation(async (request) =>
      handle((request as { requestId: string }).requestId, 'accepted'),
    )
    submit.mockResolvedValueOnce({ ok: false, error: { code: 'denied' } })
    submit.mockResolvedValueOnce({ ok: false, error: { code: 'timeout' } })
    const ids = Array.from({ length: 128 }, (_, n) => `request-${n}`)
    expect(await codes(ids.map((id) => call.submit(id)))).toEqual([
      'denied',
      'timeout',
      ...Array(126).fill('ok'),
    ])
    // The refused request-0 makes the room; request-1 may have reached the server, so it stays.
    expect(await code(call.submit('request-128'))).toBe('ok')
    expect(await detail(call.submit('request-129'))).toBe('quota/command_ledger_full')
    // A resend refused outright leaves the id as it was, since its first send may still be live.
    submit.mockResolvedValueOnce({ ok: false, error: { code: 'conflict' } })
    expect(await code(call.submit('request-5'))).toBe('conflict')
    expect(await detail(call.submit('request-129'))).toBe('quota/command_ledger_full')
    expect(
      await Promise.all(['request-0', 'request-1', 'request-5'].map((id) => detail(call.status(id)))),
    ).toEqual(['denied/outside_view', 'ok', 'ok'])
  })

  it('holds all views of one index to 1024 ids together', async () => {
    const index = createViewIndex()
    const filled = async (viewId: string) => {
      const mounted = mount({ index, viewId })
      const call = calls(mounted.context, viewId)
      const ids = Array.from({ length: 128 }, (_, n) => `${viewId}-${n}`)
      expect(await codes(ids.map((id) => call.submit(id)))).toEqual(Array(128).fill('ok'))
      return { ...mounted, call }
    }
    const first = await filled('note-0')
    for (let n = 1; n < 8; n++) await filled(`note-${n}`)
    const last = mount({ index, viewId: 'note-8' })
    const next = calls(last.context, 'note-8')
    expect(await detail(next.submit('note-8-0'))).toBe('quota/command_ledger_full')
    expect(last.services.commands.submit).not.toHaveBeenCalled()

    // An id settled in another view makes the room.
    first.services.commands.commandStatus.mockResolvedValueOnce(handle('note-0-5', 'failed'))
    expect(await code(first.call.status('note-0-5'))).toBe('ok')
    expect(await code(next.submit('note-8-0'))).toBe('ok')
    expect(await detail(first.call.status('note-0-5'))).toBe('denied/outside_view')
  })

  it('waits for its calls in flight before the cleanups run, and leaves their results as they are', async () => {
    const { services, context, dispose, state } = mount()
    let answer: (outcome: unknown) => void = () => {}
    services.commands.submit.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    const pending = context.commands.submit(submitted('request-1'))
    const cleanup = vi.fn()
    context.onDispose(cleanup)
    expect(state()).toBe('open')
    const closing = dispose()
    expect([state(), context.signal.aborted]).toEqual(['draining', true])
    expect(await detail(context.commands.submit(submitted('request-2')))).toBe('denied/renderer_disposed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cleanup).not.toHaveBeenCalled()

    const accepted = handle('request-1', 'accepted')
    answer(accepted)
    expect(await pending).toBe(accepted)
    await closing
    expect([state(), cleanup.mock.calls.length]).toEqual(['disposed', 1])
    expect(services.commands.submit).toHaveBeenCalledTimes(1)
  })

  it('runs the cleanups once drainMs passes when a call in flight never settles', async () => {
    vi.useFakeTimers()
    try {
      const { services, context, dispose, state } = mount({ drainMs: 5_000 })
      services.commands.submit.mockReturnValueOnce(new Promise(() => {}))
      void context.commands.submit(submitted('request-1'))
      const cleanup = vi.fn()
      context.onDispose(cleanup)
      const closing = dispose()
      await vi.advanceTimersByTimeAsync(4_999)
      expect([state(), cleanup.mock.calls.length]).toEqual(['draining', 0])
      await vi.advanceTimersByTimeAsync(1)
      expect([state(), cleanup.mock.calls.length]).toEqual(['disposed', 1])
      await closing
    } finally {
      vi.useRealTimers()
    }
  })
})

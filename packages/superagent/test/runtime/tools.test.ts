import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserError } from '../../src/core/index.js'
import { SessionRegistry } from '../../src/runtime/sessions.js'
import { handleTool, registerTools, type ToolsHost } from '../../src/runtime/tools.js'
import { tempStore, ticket } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  agnes: { plugins: { capabilities: { tools: { names: string[] } } }[] }
}
const signal = new AbortController().signal

function setup(unavailable?: string) {
  const registry = new SessionRegistry(temp.store)
  registry.record({ kind: 'orchestrator' }, 'superagent:orchestrator')
  registry.record({ kind: 'worker', ticketId: 't1' }, 'superagent:worker:t1')
  registry.record({ kind: 'worker', ticketId: 't2' }, 'superagent:worker:t2')
  registry.record({ kind: 'worker', ticketId: 'gone' }, 'superagent:worker:gone')
  temp.store.tickets.save(ticket('t1'))
  temp.store.tickets.save(ticket('t2'))
  const reports: [string, unknown][] = []
  const resources = {
    store: temp.store,
    masterId: 'superagent:orchestrator',
    transcript: async () => [],
    sourceLink: async () => ({}),
  }
  const host = {
    registry,
    store: temp.store,
    unavailable: () => unavailable,
    main: {
      resources,
      engine: {
        requestStatus: (id: string) => {
          throw new UserError('unknownTicket', { id })
        },
      },
    },
    executor: {
      store: temp.store,
      resources,
      engine: {
        report: (id: string, report: unknown) => {
          reports.push([id, report])
          return temp.store.tickets.get(id)
        },
      },
      sessions: { relay: () => {}, notify: () => {} },
    },
  } as unknown as ToolsHost
  return { host, reports }
}
const call = (sessionId: string, toolName: string, input: unknown) => ({ sessionId, toolName, input, signal })
const text = (answer: { content: { type: string; text?: string }[] }) => answer.content[0]?.text ?? ''

describe('tool calls', () => {
  it("binds each call to the calling session's ticket", async () => {
    const { host, reports } = setup()
    const answer = await handleTool(
      host,
      call('superagent:worker:t1', 'orchestrator_report', { state: 'progress', summary: 'half' }),
    )
    expect(answer.isError).toBeUndefined()
    expect(JSON.parse(text(answer))).toMatchObject({ reported: true })
    expect(reports).toEqual([['t1', { state: 'progress', summary: 'half' }]])
    // A worker reads its own ticket and nothing of another one.
    const own = await handleTool(
      host,
      call('superagent:worker:t2', 'orchestrator_read', { resource: 'ticket/t2' }),
    )
    expect(own.isError).toBeUndefined()
    expect(JSON.parse(text(own))).toMatchObject({ ticket_id: 't2' })
    expect(
      await handleTool(host, call('superagent:worker:t2', 'orchestrator_read', { resource: 'ticket/t1' })),
    ).toEqual({
      content: [{ type: 'text', text: 'Ticket does not belong to this worker' }],
      isError: true,
    })
  })

  it('answers every refusal and invalid input with isError and the reason', async () => {
    const { host, reports } = setup()
    const refused = async (sessionId: string, toolName: string, input: unknown) => {
      const answer = await handleTool(host, call(sessionId, toolName, input))
      expect(answer.isError, text(answer)).toBe(true)
      return text(answer)
    }
    expect(
      await refused('superagent:worker:t1', 'orchestrator_report', { state: 'done', summary: 'x' }),
    ).toMatch(/^Invalid input: state: /)
    expect(await refused('superagent:worker:t1', 'orchestrator_route', { decisions: [] })).toBe(
      'orchestrator_route is not available to this session',
    )
    expect(
      await refused('superagent:orchestrator', 'orchestrator_report', { state: 'ready', summary: 'x' }),
    ).toBe('orchestrator_report is not available to this session')
    expect(
      await refused('superagent:orchestrator', 'orchestrator_ticket_request_status', { ticket_id: 'zz' }),
    ).toMatch(/ticket/i)
    expect(
      await refused('superagent:worker:t9', 'orchestrator_report', { state: 'ready', summary: 'x' }),
    ).toMatch(/not one of Superagent sessions/)
    expect(
      await refused('superagent:worker:t1/01HX', 'orchestrator_report', { state: 'ready', summary: 'x' }),
    ).toMatch(/not to their subagents/)
    expect(
      await refused('superagent:worker:gone', 'orchestrator_report', { state: 'ready', summary: 'x' }),
    ).toMatch(/no longer exists/)
    temp.store.tickets.save(ticket('t2', { state: 'ended' }))
    expect(
      await refused('superagent:worker:t2', 'orchestrator_report', { state: 'ready', summary: 'x' }),
    ).toBe('Ticket ended; new work needs a new authorized ticket')
    expect(reports).toEqual([])
    const { host: starting } = setup('Superagent is starting')
    expect(
      await handleTool(
        starting,
        call('superagent:worker:t1', 'orchestrator_report', { state: 'ready', summary: 'x' }),
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'Superagent is starting' }],
      isError: true,
    })
  })

  it('registers every declared tool and reaches the service only through its handle', async () => {
    const registered = new Map<
      string,
      { parameters: unknown; execute(args: unknown, ctx: unknown): Promise<unknown> }
    >()
    const plugin = {
      tools: {
        register: (def: never) => {
          const { name } = def as { name: string }
          registered.set(name, def)
          return () => registered.delete(name)
        },
      },
    }
    const calls: unknown[] = []
    let current: object | undefined
    const handle = {
      get: async () => {
        if (!current)
          throw Object.assign(new Error('The service is not current'), { code: 'CAPABILITY_DENIED' })
        return current as never
      },
    }
    const disposers = registerTools(plugin, handle)
    expect([...registered.keys()].sort()).toEqual(
      [...manifest.agnes.plugins[0]!.capabilities.tools.names].sort(),
    )
    const parameters = registered.get('orchestrator_report')!.parameters as Record<string | symbol, unknown>
    expect(parameters[Symbol.for('TypeBox.Kind')]).toBe('Object')
    expect(parameters).toMatchObject({
      type: 'object',
      required: ['state', 'summary'],
      additionalProperties: false,
    })
    const ctx = { session: { key: 'superagent:worker:t1' }, signal }
    // Every role's tool refuses deterministically before entering the service.
    for (const tool of registered.values())
      expect(await tool.execute({}, ctx)).toMatchObject({
        isError: true,
        details: { code: 'SUPERAGENT_UNAVAILABLE' },
      })
    expect(calls).toEqual([])
    // Run the refusal through Core too: a malformed "error" result would still become unknown.
    const { host } = await createTestHost({
      dataDir: join(temp.dir, 'host'),
      workspaceRoot: temp.dir,
      script: [
        [
          {
            type: 'toolcall_end',
            via: 'native',
            call: {
              toolUseId: '',
              name: 'orchestrator_report',
              args: { state: 'ready', summary: 'fixture' },
              ordinal: 0,
            },
          },
          { type: 'done', reason: 'toolUse' },
        ],
        [{ type: 'text_delta', delta: 'refused' }],
      ],
    })
    try {
      const session = await host.createSession({ key: 'refused', cwd: temp.dir })
      session
        .currentTools()
        .add(registered.get('orchestrator_report') as never, { source: 'fixture', trust: 'builtin' })
      await session.enqueue('next-turn', {
        actor: session.d.actor,
        content: [{ type: 'text', text: 'report' }],
      })
      await session.run({ until: 'turn-end', signal })
      const results = await session.scan({ type: 'tool/result', limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0]?.data).toMatchObject({ isError: true })
      expect(JSON.stringify(results)).toContain('the tool handler was not called')
      expect(JSON.stringify(results)).not.toContain('TOOL_OUTCOME_UNKNOWN')
    } finally {
      await host.close()
    }
    current = {
      handleTool: async (forwarded: unknown) => {
        calls.push(forwarded)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    }
    expect(await registered.get('orchestrator_report')!.execute({ state: 'ready' }, ctx)).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(calls).toEqual([
      {
        sessionId: 'superagent:worker:t1',
        toolName: 'orchestrator_report',
        input: { state: 'ready' },
        signal,
      },
    ])
    // A failure after entering the handler still propagates: its external outcome may be unknown.
    current = {
      handleTool: async () => {
        throw new Error('response lost after dispatch')
      },
    }
    await expect(registered.get('orchestrator_report')!.execute({}, ctx)).rejects.toThrow(
      'response lost after dispatch',
    )
    for (const dispose of disposers) dispose()
    expect(registered.size).toBe(0)
  })
})

import { fakeProvider, textTurn } from '@agnes/core/testkit'
import { describe, expect, it } from 'vitest'
import { pluginRowSource } from '../../src/ext-host/row-extension-host.js'
import {
  auditKinds,
  pluginHost,
  pluginRow,
  pluginSource,
  rowState,
  settle,
  targetOf,
  toolNames,
} from './plugin-extension-fixture.js'

const ROW = 'ext:acme/plugin-tools'
const SOURCE = pluginRowSource(ROW)
const probe = () => (globalThis as { __pluginProbe?: Record<string, unknown> }).__pluginProbe ?? {}
const resetProbe = () => {
  ;(globalThis as { __pluginProbe?: Record<string, unknown> }).__pluginProbe = {}
}

describe('a third-party row registers through ctx.extension()', () => {
  it('adds a tool and an observe hook owned by a Host-stamped source', async () => {
    const h = await pluginHost(
      pluginSource(`
  agnes.registerTool(tool('plugin_echo'))
  agnes.on('session_start', () => {})
`),
    )
    const report = await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
    await settle()

    expect(report.ok).toBe(true)
    expect(rowState(h, ROW)).toBe('active')
    expect(toolNames(h)).toContain('plugin_echo')
    const registered = h.host.kernel.tools.resolve('plugin_echo')
    expect(registered?.source).toEqual({ source: SOURCE, trust: 'trusted' })
    expect(registered?.packageIdentity).toBe('@acme/plugin-tools')
    expect(registered?.packageVersion).toBe('2.3.4')
    expect(registered?.executionDomain).toBe('workspace')
    expect(h.host.kernel.registrations(SOURCE)).toEqual(['tool:plugin_echo', 'hook:session_start'])

    const status = h.host.extensions().find((e) => e.id === SOURCE)
    expect(status).toMatchObject({
      package: '@acme/plugin-tools',
      version: '2.3.4',
      trust: 'trusted',
      loaded: true,
    })
    expect(auditKinds(h, 'extension.registered').map((e) => e.detail?.name)).toEqual([
      'plugin_echo',
      'session_start',
    ])
    expect(auditKinds(h, 'extension.loaded').some((e) => e.detail?.id === SOURCE)).toBe(true)
    await h.host.close()
  })

  it('runs the tool through its lease and drops it when the row goes', async () => {
    const h = await pluginHost(pluginSource(`  agnes.registerTool(tool('plugin_echo'))`))
    await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
    await settle()
    expect(h.host.extensions().find((e) => e.id === SOURCE)?.lease?.scope.toolPrefix).toBe('')

    await h.host.applyRuntimeTarget(targetOf([]))
    await settle()

    expect([...h.host.kernel.tools.snapshot(0).byName.keys()]).not.toContain('plugin_echo')
    expect(h.host.kernel.registrations(SOURCE)).toEqual([])
    expect(auditKinds(h, 'extension.revoked').filter((e) => e.detail?.id === SOURCE)).toHaveLength(1)
    expect(h.host.extensions().find((e) => e.id === SOURCE)?.loaded).toBe(false)
    await h.host.close()
  })

  it('refuses everything that is not a tool, any hook event (via registerHook) or a ledger event', async () => {
    resetProbe()
    const h = await pluginHost(
      pluginSource(`
  const refused = {}
  const attempt = (label, run) => { try { run(); refused[label] = 'allowed' } catch (e) { refused[label] = e.code } }
  attempt('rewriting hook', () => agnes.on('tool_call', () => {}))
  attempt('registerHook', () => agnes.registerHook('tool_call', () => {}))
  attempt('registerSlot', () => agnes.registerSlot('status.line', () => null))
  attempt('registerService', () => agnes.registerService({}))
  attempt('registerProjection', () => agnes.registerProjection({}))
  attempt('registerResource', () => agnes.registerResource({}))
  attempt('observe hook', () => agnes.on('shutdown', () => {}))
  globalThis.__pluginProbe = { refused }
`),
    )
    await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
    await settle()
    expect(probe().refused).toEqual({
      'rewriting hook': 'E_CAPABILITY_UNDECLARED',
      registerHook: 'allowed',
      registerSlot: 'E_CAPABILITY_UNDECLARED',
      registerService: 'E_CAPABILITY_UNDECLARED',
      registerProjection: 'E_CAPABILITY_UNDECLARED',
      registerResource: 'E_CAPABILITY_UNDECLARED',
      'observe hook': 'allowed',
    })
    await h.host.close()
  })

  it('cannot take a builtin tool name', async () => {
    const source = pluginSource(`  agnes.registerTool(tool('grep'))`)
    const h = await pluginHost(source)
    await expect(h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))).rejects.toThrow(/reserved/)
    await settle()
    expect(h.host.kernel.tools.resolve('grep')?.source.source).not.toBe(SOURCE)
    expect(auditKinds(h, 'extension.registered')).toEqual([])
    await h.host.close()
  })

  // agnes/mcp-search declares its two tool names (design §3.9, D123), so as a builtin row they are
  // reserved like any other builtin's. agnes/mcp-client declared none, so nothing was reserved before.
  it('cannot take tool_search, which agnes/mcp-search declares', async () => {
    const source = pluginSource(`  agnes.registerTool(tool('tool_search'))`)
    const h = await pluginHost(source)
    await expect(h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))).rejects.toThrow(/reserved/)
    await settle()
    expect(h.host.kernel.tools.resolve('tool_search')?.source.source).toBe('agnes/mcp-search')
    await h.host.close()
  })

  it('runs its observe hooks for sessions, and says shutdown to open ones when the row goes', async () => {
    resetProbe()
    const h = await pluginHost(
      pluginSource(`
  const events = (globalThis.__pluginProbe = { events: [] }).events
  agnes.on('session_start', () => { events.push('session_start') })
  agnes.on('shutdown', (payload) => { events.push('shutdown:' + payload.reason) })
`),
    )
    await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
    await settle()
    const session = await h.host.createSession({ cwd: h.dataDir })
    await settle()
    expect(probe().events).toEqual(['session_start'])

    await h.host.applyRuntimeTarget(targetOf([]))
    await settle()
    expect(probe().events).toEqual(['session_start', 'shutdown:revoke'])
    expect(h.host.kernel.registrations(SOURCE)).toEqual([])
    await session.close()
    await h.host.close()
  })

  it('refuses a replacement of a governance builtin that leaves its hooks out', async () => {
    const empty = await pluginHost(pluginSource('  void agnes'))
    await expect(empty.host.applyRuntimeTarget(targetOf([pluginRow('ext:agnes/privacy')]))).rejects.toThrow(
      /must register hooks: session_start, shutdown/,
    )
    expect(rowState(empty, 'ext:agnes/privacy')).toBe('active')
    expect(empty.host.ordinaryConvergence().rows.find((r) => r.id === 'ext:agnes/privacy')).toBeDefined()
    await empty.host.close()

    const complete = await pluginHost(
      pluginSource(`
  agnes.on('session_start', () => {})
  agnes.on('shutdown', () => {})
`),
    )
    const report = await complete.host.applyRuntimeTarget(targetOf([pluginRow('ext:agnes/privacy')]))
    expect(report.ok).toBe(true)
    await complete.host.close()
  })

  it('fails the target when two different rows register the same tool name', async () => {
    const h = await pluginHost(pluginSource(`  agnes.registerTool(tool('plugin_echo'))`))
    await expect(
      h.host.applyRuntimeTarget(targetOf([pluginRow('ext:acme/first'), pluginRow('ext:acme/second')])),
    ).rejects.toThrow(/E_REGISTRY_DUPLICATE/)
    await settle()
    expect(h.host.kernel.registrations(pluginRowSource('ext:acme/second'))).toEqual([])
    await h.host.close()
  })

  it('stays out of the way when the same row is applied again', async () => {
    const h = await pluginHost(
      pluginSource(`
  agnes.registerTool(tool('plugin_echo'))
  agnes.on('session_start', () => {})
`),
    )
    for (let round = 0; round < 3; round++) {
      const report = await h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))
      await settle()
      expect(report.ok).toBe(true)
    }
    expect(toolNames(h).filter((n) => n === 'plugin_echo')).toHaveLength(1)
    expect(h.host.kernel.registrations(SOURCE)).toEqual(['tool:plugin_echo', 'hook:session_start'])
    await h.host.close()
  })
})

describe('installing a third-party tool row', () => {
  // The system string is cached across turns, so it must not depend on which tools happen to be disclosed.
  const turnWith = async (source: ReturnType<typeof pluginSource> | undefined) => {
    const provider = fakeProvider([textTurn('done')], '2')
    const h = await pluginHost(source ? [source] : [], { provider })
    try {
      if (source) {
        await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
        await settle()
      }
      const session = await h.host.createSession({ cwd: h.dataDir, key: 'system-stable-fixture' })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'hello' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(out.reason).toBe('completed')
    } finally {
      await h.host.close()
    }
    const request = provider.requests[0]
    if (!request) throw new Error('provider received no request')
    return request
  }

  it('keeps the wire system string byte-identical while adding an eagerly disclosed tool', async () => {
    const bare = await turnWith(undefined)
    const installed = await turnWith(pluginSource(`  agnes.registerTool(tool('plugin_echo'))`))
    // Without differing tool lists the equality below would prove nothing about the tool axis.
    expect(installed.tools.map((t) => t.name)).toContain('plugin_echo')
    expect(bare.tools.map((t) => t.name)).not.toContain('plugin_echo')
    expect(bare.system.length).toBeGreaterThan(500)
    expect(installed.system).toBe(bare.system)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import fixture from '../examples/minimal/fixtures/basic.fixture.js'
import sample from '../examples/minimal/index.js'
import {
  checkManifest,
  checkToolDef,
  type ExtensionAPI,
  type HookContext,
  type HookHandler,
  type SlotContext,
  type SlotFill,
  type ToolContext,
  type ToolDef,
} from '../src/index.js'

const dir = new URL('../examples/minimal/', import.meta.url)

// This records author factory registrations, not a host or a hook engine.
function capture(failEvent = false, failRegistration = false) {
  const active = new Set<string>(),
    closed: string[] = [],
    events: string[] = []
  let tool: ToolDef | undefined
  let hook: HookHandler<'tool_result'> | undefined
  let slot: SlotFill<'status.line'> | undefined
  const register = (name: string) => {
    active.add(name)
    return () => {
      active.delete(name)
      closed.push(name)
    }
  }
  const api = {
    registerTool(def: ToolDef) {
      tool = def
      return register('tool')
    },
    registerHook: (_event: string, handler: HookHandler<'tool_result'>) => {
      if (failRegistration) throw new Error('registration refused')
      hook = handler
      return register('hook')
    },
    registerSlot: (_name: string, fill: SlotFill<'status.line'>) => {
      slot = fill
      return register('slot')
    },
    registerResource: () => register('resource'),
    events: {
      async append(name: string) {
        if (failEvent) throw new Error('event refused')
        events.push(name)
        return 1
      },
    },
    ctx: { version: '0.1.0' },
  } as unknown as ExtensionAPI
  return { api, active, closed, events, tool: () => tool, hook: () => hook, slot: () => slot }
}
describe('minimal author example', () => {
  it('uses a valid manifest and only author API/typebox imports', () => {
    const manifest = JSON.parse(readFileSync(new URL('agnes.extension.json', dir), 'utf8'))
    expect(checkManifest(manifest)).toEqual({ ok: true, value: manifest })
    const source = readFileSync(new URL('index.ts', dir), 'utf8')
    expect([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort()).toEqual([
      '@agnes/extension-api',
      '@sinclair/typebox',
    ])
    expect(fixture.cases.map((c) => c.kind)).toEqual(['tool', 'slot', 'negative'])
  })
  it('registers all four contracts and disposes them in reverse order exactly once', async () => {
    const recorded = capture(),
      dispose = await sample(recorded.api)
    expect([...recorded.active]).toEqual(['tool', 'hook', 'slot', 'resource'])
    expect(checkToolDef(recorded.tool(), { prefix: 'minimal_' })).toEqual({ ok: true })
    expect(recorded.events).toEqual(['loaded'])
    if (!dispose) throw new Error('missing disposer')
    dispose()
    dispose()
    expect(recorded.active.size).toBe(0)
    expect(recorded.closed).toEqual(['resource', 'slot', 'hook', 'tool'])
  })
  it('runs the example callbacks in isolation without claiming host dispatch', async () => {
    const recorded = capture(),
      dispose = await sample(recorded.api)
    const tool = recorded.tool(),
      hook = recorded.hook(),
      slot = recorded.slot()
    if (!tool || !hook || !slot || !dispose) throw new Error('missing registration')
    const notes: string[] = []
    const result = await tool.execute({ text: 'hi' }, {
      progress: (note: string) => {
        notes.push(note)
      },
    } as ToolContext)
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(notes).toEqual(['echoing'])
    const payload = {
      toolUseId: 't1',
      name: 'minimal_echo',
      args: { text: 'hi' },
      result,
      enforcement: { level: 'none' as const, scope: [] },
    }
    expect(await hook(payload, {} as HookContext)).toEqual({
      result: { ...result, details: { source: 'minimal' } },
    })
    expect(await hook({ ...payload, name: 'other' }, {} as HookContext)).toEqual({})
    expect(await slot({} as SlotContext)).toEqual({ text: 'minimal extension loaded', level: 'info' })
    dispose()
  })
  it('rolls back earlier registrations when a later registration fails', async () => {
    const recorded = capture(false, true)
    await expect(sample(recorded.api)).rejects.toThrow('registration refused')
    expect(recorded.active.size).toBe(0)
    expect(recorded.closed).toEqual(['tool'])
  })
  it('rejects a failed event write and rolls back all registrations', async () => {
    const recorded = capture(true)
    await expect(sample(recorded.api)).rejects.toThrow('event refused')
    expect(recorded.active.size).toBe(0)
    expect(recorded.closed).toEqual(['resource', 'slot', 'hook', 'tool'])
  })
})

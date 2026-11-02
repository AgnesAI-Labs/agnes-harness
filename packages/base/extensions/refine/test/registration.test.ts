import type { ToolDef } from '@agnes/extension-api'
import type { Context } from '@agnes/plugin-runtime'
import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import refineDefault, { createRefineExtension, type RefinementSwitch } from '../src/index.js'
import type { RefinementToolPort } from '../src/port.js'

type Registered = { tools: ToolDef[]; hooks: string[]; dispose(): void }

/** Applies the plugin to a context that records what it registers. */
function applyPlugin(plugin: ReturnType<typeof createRefineExtension>): Registered {
  const tools: ToolDef[] = []
  const hooks: string[] = []
  const ctx = {
    tools: {
      register: vi.fn((def: ToolDef) => {
        tools.push(def)
        return () => tools.splice(tools.indexOf(def), 1)
      }),
    },
    hooks: {
      register: vi.fn((name: string) => {
        hooks.push(name)
        return () => undefined
      }),
    },
    eventLog: { append: vi.fn() },
  } as unknown as Context
  const dispose = plugin.apply(ctx) as (() => void) | undefined
  return { tools, hooks, dispose: () => dispose?.() }
}

const settings = (enabled: boolean): RefinementSwitch => ({
  current: () => ({ settings: { enabled, mode: 'manual' }, revision: 'r' }),
})

const byName = (registered: Registered, name: string): ToolDef => {
  const def = registered.tools.find((tool) => tool.name === name)
  if (!def) throw new Error(`${name} was not registered`)
  return def
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((part) => part.text ?? '').join('')

const proposal = {
  proposalId: 'p1',
  trigger: 'manual' as const,
  rationale: 'r',
  evidenceSeqs: [3],
  edits: [{ op: 'upsert' as const, entry: { kind: 'memory' as const, id: 'm1', title: 't', content: 'c' } }],
}

describe('refine extension registration', () => {
  it('registers no tools and no hooks when refinement is off', () => {
    for (const plugin of [
      createRefineExtension({ settings: settings(false) }),
      // No switch handed in (the default export, or a host that grants none) reads as off.
      createRefineExtension(),
      refineDefault,
    ]) {
      const registered = applyPlugin(plugin)
      expect(registered.tools).toEqual([])
      expect(registered.hooks).toEqual([])
    }
  })

  it('registers harness_propose, harness_refine and harness_inspect as deferred tools when on', () => {
    const registered = applyPlugin(createRefineExtension({ settings: settings(true) }))
    expect(registered.tools.map((tool) => tool.name)).toEqual([
      'harness_propose',
      'harness_refine',
      'harness_inspect',
    ])
    for (const tool of registered.tools) expect(tool.meta.deferLoading, tool.name).toBe(true)
    expect(registered.hooks).toEqual([])
    registered.dispose()
    expect(registered.tools).toEqual([])
  })

  it('takes the switch from the view it is handed: a view pinned per assembly keeps every remount alike', () => {
    // The host hands over the value it read once when it assembled the container, so a later save
    // (here: `stored` flipping) must not change what a remount registers.
    let stored = true
    const read = () => ({ settings: { enabled: stored, mode: 'manual' as const }, revision: String(stored) })
    const atAssembly = read()
    const plugin = createRefineExtension({ settings: { current: () => atAssembly } })
    expect(applyPlugin(plugin).tools).toHaveLength(3)
    stored = false
    expect(applyPlugin(plugin).tools).toHaveLength(3)
    // A new assembly reads again and sees the change.
    const next = read()
    expect(applyPlugin(createRefineExtension({ settings: { current: () => next } })).tools).toEqual([])
  })

  it('mode does not stand in for the switch: auto with enabled false registers nothing', () => {
    const plugin = createRefineExtension({
      settings: { current: () => ({ settings: { enabled: false, mode: 'auto' }, revision: 'r' }) },
    })
    expect(applyPlugin(plugin).tools).toEqual([])
  })

  it('describes the tools without the retired review queue', () => {
    const registered = applyPlugin(createRefineExtension({ settings: settings(true) }))
    for (const tool of registered.tools) {
      expect(tool.description, tool.name).not.toMatch(/queue/i)
      expect(tool.description.length, tool.name).toBeGreaterThan(40)
    }
  })
})

describe('the default tool port', () => {
  const on = () => applyPlugin(createRefineExtension({ settings: settings(true) }))

  it('answers harness_propose and harness_refine with a typed unavailable error', async () => {
    const registered = on()
    for (const [name, args] of [
      ['harness_propose', proposal],
      ['harness_refine', { focus: 'tests' }],
    ] as const) {
      const result = await byName(registered, name).execute(args as never, fakeToolContext())
      expect(result.isError, name).toBe(true)
      expect(result.structured, name).toEqual({ code: 'REFINEMENT_UNAVAILABLE' })
      expect(text(result), name).toBe('REFINEMENT_UNAVAILABLE: refinement is not available yet')
    }
  })

  it('answers harness_inspect with a typed not-implemented error', async () => {
    const result = await byName(on(), 'harness_inspect').execute(
      { op: 'search', query: 'tests' } as never,
      fakeToolContext(),
    )
    expect(result.isError).toBe(true)
    expect(result.structured).toEqual({ code: 'REFINEMENT_NOT_IMPLEMENTED' })
    expect(text(result)).toBe('REFINEMENT_NOT_IMPLEMENTED: harness_inspect is not implemented yet')
  })
})

describe('tools forward to an injected port', () => {
  const ok = { content: [{ type: 'text' as const, text: 'ok' }] }
  const port = (): RefinementToolPort & { [K in keyof RefinementToolPort]: ReturnType<typeof vi.fn> } => ({
    propose: vi.fn(async () => ok),
    refine: vi.fn(async () => ok),
    inspect: vi.fn(async () => ok),
  })

  it('harness_refine hands the focus and the session target to the port', async () => {
    const p = port()
    const registered = applyPlugin(createRefineExtension({ settings: settings(true), port: p }))
    const ctx = fakeToolContext()
    expect(await byName(registered, 'harness_refine').execute({ focus: 'flaky tests' } as never, ctx)).toBe(
      ok,
    )
    expect(p.refine).toHaveBeenCalledWith({ focus: 'flaky tests', target: 'session' }, ctx)
    await byName(registered, 'harness_refine').execute({ target: 'session' } as never, ctx)
    expect(p.refine).toHaveBeenLastCalledWith({ target: 'session' }, ctx)
  })

  it('harness_inspect hands its query to the port unchanged', async () => {
    const p = port()
    const registered = applyPlugin(createRefineExtension({ settings: settings(true), port: p }))
    const ctx = fakeToolContext()
    const args = { op: 'list', kind: 'skill', cursor: 'c1' }
    expect(await byName(registered, 'harness_inspect').execute(args as never, ctx)).toBe(ok)
    expect(p.inspect).toHaveBeenCalledWith(args, ctx)
  })

  it('a workspace target is refused as a later-release feature and never reaches the port', async () => {
    const p = port()
    const registered = applyPlugin(createRefineExtension({ settings: settings(true), port: p }))
    for (const [name, args] of [
      ['harness_propose', { ...proposal, target: 'workspace' }],
      ['harness_refine', { focus: 'x', target: 'workspace' }],
    ] as const) {
      const result = await byName(registered, name).execute(args as never, fakeToolContext())
      expect(result.isError, name).toBe(true)
      expect(result.structured, name).toEqual({ code: 'REFINEMENT_TARGET_UNAVAILABLE' })
      expect(text(result), name).toBe(
        'REFINEMENT_TARGET_UNAVAILABLE: saving to the workspace is available in a later release; omit target to keep it in this session',
      )
    }
    expect(p.propose).not.toHaveBeenCalled()
    expect(p.refine).not.toHaveBeenCalled()
  })
})

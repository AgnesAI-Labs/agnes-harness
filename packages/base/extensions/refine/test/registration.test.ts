import type { ToolDef } from '@agnes/extension-api'
import type { Context } from '@agnes/plugin-runtime'
import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import refineDefault, { createRefineExtension, type RefinementSwitch } from '../src/index.js'
import {
  connectedToolPort,
  type RefinementOutcome,
  type RefinementRuns,
  type RefinementToolPort,
} from '../src/port.js'

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
  rationale: 'r',
  evidenceSeqs: [3],
  edits: [{ op: 'upsert' as const, kind: 'memory' as const, id: 'm1', title: 't', content: 'c' }],
}

/** Host runs that record what they were asked and answer with `answer`. */
function fakeRuns(answer: RefinementOutcome = { runId: 'run-1' }) {
  const calls: unknown[][] = []
  let planner: unknown
  const runs: RefinementRuns = {
    propose: async (...args) => {
      calls.push(['propose', ...args])
      return answer
    },
    request: async (...args) => {
      calls.push(['request', ...args])
      return answer
    },
  }
  return {
    calls,
    planner: () => planner,
    connect: (p: unknown) => {
      planner = p
      return runs
    },
  }
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

  it('registers no tools when on but the host runs no refinement: they could only fail', () => {
    expect(applyPlugin(createRefineExtension({ settings: settings(true) })).tools).toEqual([])
  })

  it('registers harness_propose and harness_refine as deferred tools when on, and not harness_inspect', () => {
    const registered = applyPlugin(
      createRefineExtension({ settings: settings(true), runs: fakeRuns().connect }),
    )
    // harness_inspect cannot read entries yet; a tool that only fails is not offered to the model.
    expect(registered.tools.map((tool) => tool.name)).toEqual(['harness_propose', 'harness_refine'])
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
    const runs = fakeRuns().connect
    const plugin = createRefineExtension({ settings: { current: () => atAssembly }, runs })
    expect(applyPlugin(plugin).tools).toHaveLength(2)
    stored = false
    expect(applyPlugin(plugin).tools).toHaveLength(2)
    // A new assembly reads again and sees the change.
    const next = read()
    expect(applyPlugin(createRefineExtension({ settings: { current: () => next }, runs })).tools).toEqual([])
  })

  it('mode does not stand in for the switch: auto with enabled false registers nothing', () => {
    const plugin = createRefineExtension({
      settings: { current: () => ({ settings: { enabled: false, mode: 'auto' }, revision: 'r' }) },
      runs: fakeRuns().connect,
    })
    expect(applyPlugin(plugin).tools).toEqual([])
  })

  it('describes the tools without the retired review queue', () => {
    const registered = applyPlugin(
      createRefineExtension({ settings: settings(true), runs: fakeRuns().connect }),
    )
    for (const tool of registered.tools) {
      expect(tool.description, tool.name).not.toMatch(/queue/i)
      expect(tool.description.length, tool.name).toBeGreaterThan(40)
    }
  })
})

describe('the tools backed by the host runs', () => {
  const on = (answer?: RefinementOutcome) => {
    const runs = fakeRuns(answer)
    return {
      runs,
      registered: applyPlugin(createRefineExtension({ settings: settings(true), runs: runs.connect })),
    }
  }

  it("hands the host this plugin's planner when it connects", () => {
    const { runs } = on()
    expect(runs.planner()).toMatchObject({
      buildPrompt: expect.any(Function),
      parseOutput: expect.any(Function),
    })
  })

  it('harness_propose hands the proposal to the session runs and says when it takes effect', async () => {
    const { runs, registered } = on()
    const ctx = fakeToolContext()
    const result = await byName(registered, 'harness_propose').execute(proposal as never, ctx)
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('run-1')
    expect(text(result)).toContain('later turn')
    expect(runs.calls).toEqual([['propose', { key: ctx.session.key, lane: ctx.session.lane }, proposal]])
  })

  it('harness_refine asks for a model-requested review and returns at once', async () => {
    const { runs, registered } = on()
    const ctx = fakeToolContext()
    const result = await byName(registered, 'harness_refine').execute({ focus: 'flaky tests' } as never, ctx)
    expect(text(result)).toContain('run-1')
    expect(runs.calls).toEqual([
      ['request', { key: ctx.session.key, lane: ctx.session.lane }, { focus: 'flaky tests' }],
    ])
  })

  it('a refusal is a typed tool error; with the switch now off the tools say refinement is off', async () => {
    for (const [refused, code] of [
      ['refinement-off', 'REFINEMENT_OFF'],
      ['manual-mode', 'REFINEMENT_MANUAL'],
      ['read-first', 'REFINEMENT_READ_FIRST'],
      ['invalid', 'REFINEMENT_INVALID'],
      ['cooldown', 'REFINEMENT_LIMIT'],
      ['child-session', 'REFINEMENT_UNAVAILABLE'],
    ] as const) {
      const { registered } = on({ refused })
      for (const [name, args] of [
        ['harness_propose', proposal],
        ['harness_refine', { focus: 'tests' }],
      ] as const) {
        const result = await byName(registered, name).execute(args as never, fakeToolContext())
        expect(result.isError, `${name} ${refused}`).toBe(true)
        expect(result.structured, `${name} ${refused}`).toEqual({ code })
      }
    }
    const { registered } = on({ refused: 'refinement-off' })
    const off = await byName(registered, 'harness_refine').execute({} as never, fakeToolContext())
    expect(text(off)).toBe('REFINEMENT_OFF: refinement is off for this profile')
  })

  it("the host port's inspect answers a typed not-implemented error", async () => {
    const result = await connectedToolPort(fakeRuns().connect(undefined)).inspect(
      { op: 'search', query: 'tests' },
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

  it('no harness_inspect tool exists to reach the port, even when the port could answer one', async () => {
    const p = port()
    const registered = applyPlugin(createRefineExtension({ settings: settings(true), port: p }))
    expect(registered.tools.map((tool) => tool.name)).toEqual(['harness_propose', 'harness_refine'])
    for (const tool of registered.tools) await tool.execute({ focus: 'x' } as never, fakeToolContext())
    expect(p.inspect).not.toHaveBeenCalled()
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

import type { ToolDef } from '@agnes/extension-api'
import type { Context } from '@agnes/plugin-runtime'
import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import refineDefault, { createRefineExtension, type RefinementSwitch } from '../src/index.js'
import type { RefinementOutcome, RefinementRuns, RefinementToolPort } from '../src/port.js'

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
    inspect: async (...args) => {
      calls.push(['inspect', ...args])
      return 'runId' in answer ? { op: 'search', entries: [], matched: 0 } : answer
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

  it('registers harness_propose, harness_refine and harness_inspect as deferred tools when on', () => {
    const registered = applyPlugin(
      createRefineExtension({ settings: settings(true), runs: fakeRuns().connect }),
    )
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
    const runs = fakeRuns().connect
    const plugin = createRefineExtension({ settings: { current: () => atAssembly }, runs })
    expect(applyPlugin(plugin).tools).toHaveLength(3)
    stored = false
    expect(applyPlugin(plugin).tools).toHaveLength(3)
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
        ['harness_inspect', { op: 'list', kind: 'memory' }],
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

  it('harness_inspect asks the runs of the session the tool ran in', async () => {
    const { runs, registered } = on()
    const ctx = fakeToolContext()
    const result = await byName(registered, 'harness_inspect').execute(
      { op: 'search', query: 'x' } as never,
      ctx,
    )
    expect(text(result)).toBe('No entry in this session matches.')
    expect(runs.calls).toEqual([
      ['inspect', { key: ctx.session.key, lane: ctx.session.lane }, { op: 'search', query: 'x' }],
    ])
  })

  it('an inspect refusal names what was wrong with the request', async () => {
    const missing = await byName(
      on({ refused: 'not-found', detail: 'memory/x' }).registered,
      'harness_inspect',
    ).execute({ op: 'get', id: 'memory/x' } as never, fakeToolContext())
    expect(missing.structured).toEqual({ code: 'REFINEMENT_NOT_FOUND' })
    expect(text(missing)).toBe('REFINEMENT_NOT_FOUND: no entry memory/x in this session')
    const invalid = await byName(
      on({ refused: 'invalid', detail: 'kind' }).registered,
      'harness_inspect',
    ).execute({ op: 'list' } as never, fakeToolContext())
    expect(text(invalid)).toBe('REFINEMENT_INVALID: the request is not valid (kind)')
  })
})

describe('saving to the workspace from the tools', () => {
  const on = (answer?: RefinementOutcome) => {
    const runs = fakeRuns(answer)
    return {
      runs,
      registered: applyPlugin(createRefineExtension({ settings: settings(true), runs: runs.connect })),
    }
  }

  it('harness_propose with target workspace applies to the session then saves as model', async () => {
    const { runs, registered } = on()
    const ctx = fakeToolContext()
    const result = await byName(registered, 'harness_propose').execute(
      { ...proposal, target: 'workspace' } as never,
      ctx,
    )
    expect(result.isError).toBeUndefined()
    // The host is asked to apply the proposal to this session and then save it; the model never says who it is.
    expect(runs.calls).toEqual([
      ['propose', { key: ctx.session.key, lane: ctx.session.lane }, proposal, { saveTo: 'workspace' }],
    ])
    expect(text(result)).toContain('run-1')
    expect(text(result)).toContain('saved to the workspace between later turns')
    expect(text(result)).toContain('timeline')
    expect(text(result)).toContain('user-revoked')
    expect(text(result)).toContain('do not try again')
  })

  it('harness_refine with target workspace runs the same flow as /refine --workspace', async () => {
    const { runs, registered } = on()
    const ctx = fakeToolContext()
    const result = await byName(registered, 'harness_refine').execute(
      { focus: 'build', target: 'workspace' } as never,
      ctx,
    )
    expect(runs.calls).toEqual([
      ['request', { key: ctx.session.key, lane: ctx.session.lane }, { focus: 'build', saveTo: 'workspace' }],
    ])
    expect(text(result)).toContain('saved to the workspace')
    expect(text(result)).toContain('timeline')
    // A session target asks for no save.
    await byName(registered, 'harness_refine').execute({ target: 'session' } as never, ctx)
    expect(runs.calls.at(-1)).toEqual(['request', { key: ctx.session.key, lane: ctx.session.lane }, {}])
  })

  it('a save the host cannot offer is a target error; in manual mode only the user can save', async () => {
    for (const name of ['harness_propose', 'harness_refine'] as const) {
      const args = name === 'harness_propose' ? { ...proposal, target: 'workspace' } : { target: 'workspace' }
      const none = await byName(on({ refused: 'unavailable', detail: 'workspace' }).registered, name).execute(
        args as never,
        fakeToolContext(),
      )
      expect(none.structured, name).toEqual({ code: 'REFINEMENT_TARGET_UNAVAILABLE' })
      expect(text(none), name).toBe(
        'REFINEMENT_TARGET_UNAVAILABLE: saving to the workspace is not available here; omit target to keep it in this session',
      )
      const manual = await byName(on({ refused: 'manual-mode' }).registered, name).execute(
        args as never,
        fakeToolContext(),
      )
      expect(manual.structured, name).toEqual({ code: 'REFINEMENT_MANUAL' })
      // Leaving out the target helps a proposal only: a review is the user's alone in manual mode.
      expect(text(manual), name).toBe(
        name === 'harness_propose'
          ? 'REFINEMENT_MANUAL: refinement is set to manual; only the user can save to the workspace. Omit target to keep it in this session'
          : 'REFINEMENT_MANUAL: refinement is set to manual; only the user can ask for a review or save to the workspace. The model can do either only when refinement is automatic',
      )
    }
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

  it('a workspace target reaches the port as the target, never as part of the proposal', async () => {
    const p = port()
    const registered = applyPlugin(createRefineExtension({ settings: settings(true), port: p }))
    const ctx = fakeToolContext()
    await byName(registered, 'harness_propose').execute({ ...proposal, target: 'workspace' } as never, ctx)
    expect(p.propose).toHaveBeenCalledWith(proposal, ctx, 'workspace')
    await byName(registered, 'harness_refine').execute({ focus: 'x', target: 'workspace' } as never, ctx)
    expect(p.refine).toHaveBeenCalledWith({ focus: 'x', target: 'workspace' }, ctx)
  })
})

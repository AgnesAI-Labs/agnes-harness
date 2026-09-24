import type { OpContext } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { createPromptOperation, operations, PROMPT_SECTIONS } from '../src/index.js'

const platform = {
  shell: () => 'posix',
  snapshot: () => ({ os: 'darwin', arch: 'arm64' }),
  capability: () => ({ level: 'unavailable' }),
}
const deps = { adapters: { platform } }

function ctxFor(over: {
  disclosure?: 'standard' | 'hybrid' | 'code'
  disclosed?: string[]
  cwd?: string
  now?: number
  model?: string
  route?: string
  presetName?: string
}): OpContext {
  return {
    session: {
      key: 'agnes:local:demo:cli:workspace:abcd',
      d: {
        cwd: over.cwd ?? '/w/repo',
        agnesVersion: '0.1.0',
        clock: () => over.now ?? Date.parse('2026-09-09T04:00:00.000Z'),
      },
    },
    preset: { name: over.presetName ?? 'standard', disclosure: over.disclosure ?? 'standard' },
    state: null,
    snapshot: { defs: [], byName: new Map() },
    signal: new AbortController().signal,
    disclosed: over.disclosed ?? ['read', 'shell'],
    model: { slot: 'primary', route: over.route ?? 'ds', model: over.model ?? 'deepseek-chat' },
  } as unknown as OpContext
}

const contribute = (ctx: OpContext) => {
  const op = createPromptOperation(deps)
  const c = op.contribute?.(ctx)
  if (!c?.promptSections) throw new Error('the operation contributed no prompt sections')
  return c.promptSections
}

describe('the prompt operation', () => {
  it('reports the actual Host-selected interpreter while preserving the dialect fallback', () => {
    const description = 'PowerShell 5.1.26100.9444 (Desktop); native argument mode: Legacy'
    const op = createPromptOperation({ adapters: { platform, shell: { description } } })
    const environment = op.contribute?.(ctxFor({}))?.promptSections?.find((s) => s.id === 'environment')
    expect(environment?.text).toContain(description)
    expect(contribute(ctxFor({})).find((s) => s.id === 'environment')?.text).toContain('posix')
  })
  it('is a before-inference operation that contributes prompt text and the tail runtime context, nothing else', () => {
    const op = createPromptOperation(deps)
    expect(op).toMatchObject({ name: 'code:prompts', slot: 'before-inference', replay: 'safe' })
    const c = op.contribute?.(ctxFor({}))
    expect(Object.keys(c ?? {})).toEqual(['promptSections', 'runtimeContext'])
  })

  it('is reachable as the package-level operations table the host reads', async () => {
    expect(Object.keys(operations)).toEqual(['prompts'])
    const op = operations.prompts(deps)
    expect(op.name).toBe('code:prompts')
    expect(await op.applicable(ctxFor({}))).toBe('applied')
    expect(await op.run(ctxFor({}))).toEqual({})
  })

  it('carries the frozen order of every section it contributes, in table order', () => {
    const sections = contribute(ctxFor({}))
    expect(sections.map((s) => s.id)).toEqual(['persona', 'environment', 'coding-doctrine'])
    const table = new Map(PROMPT_SECTIONS.map((s) => [s.id, s.order]))
    expect(sections.map((s) => s.order)).toEqual(sections.map((s) => table.get(s.id)))
    expect(sections.map((s) => s.order)).toEqual([...sections.map((s) => s.order)].sort((a, b) => a - b))
    for (const s of sections) expect(s.source).toBe('@agnes/code')
  })

  it('states the platform, the date and the transcript in prompt text; the model and cwd in the tail runtime context', () => {
    const c = createPromptOperation(deps).contribute?.(
      ctxFor({ cwd: '/other/place', model: 'some-model-9', now: Date.parse('2027-01-02T00:00:00Z') }),
    )
    const text = (c?.promptSections ?? []).map((s) => s.text).join('\n')
    expect(text).toContain('darwin-arm64')
    expect(text).toContain('2027-01-02')
    expect(text).toContain('agnes:local:demo:cli:workspace:abcd')
    expect(text).not.toContain('some-model-9')
    expect(text).not.toContain('/other/place')
    expect(text).not.toContain('{{')
    expect(c?.runtimeContext).toMatchObject({ environment: { model: 'some-model-9', cwd: '/other/place' } })
  })

  it('reads the clock on every call rather than capturing it once', () => {
    const op = createPromptOperation(deps)
    let now = Date.parse('2026-09-09T00:00:00Z')
    const ctx = ctxFor({})
    ;(ctx.session as unknown as { d: { clock: () => number } }).d.clock = () => now
    const first =
      op
        .contribute?.(ctx)
        ?.promptSections?.map((s) => s.text)
        .join('\n') ?? ''
    now = Date.parse('2026-12-25T00:00:00Z')
    const second =
      op
        .contribute?.(ctx)
        ?.promptSections?.map((s) => s.text)
        .join('\n') ?? ''
    expect(first).toContain('2026-09-09')
    expect(second).toContain('2026-12-25')
  })

  it('states that the offered tool list is complete in the tail runtime context, not as a prompt section', () => {
    const op = createPromptOperation(deps)
    const some = op.contribute?.(ctxFor({ disclosed: ['read', 'write', 'grep'] }))
    expect(some?.promptSections?.map((s) => s.id)).not.toContain('tools-available')
    expect(some?.runtimeContext).toMatchObject({
      tools: { complete: expect.stringContaining('complete set offered this turn') },
    })
    const none = op.contribute?.(ctxFor({ disclosed: [] }))
    expect(none?.runtimeContext).toMatchObject({
      tools: { complete: expect.stringContaining('You have no tools on this request') },
    })
  })

  // The two doctrine sections are the pair that can lie about what the model can do, so each is
  // pinned to the condition that makes it true rather than to the preset that usually implies it.
  it('teaches run_code only where run_code is actually offered', () => {
    const without = contribute(ctxFor({ disclosure: 'hybrid', disclosed: ['read'] }))
    expect(without.map((s) => s.id)).not.toContain('code-doctrine')
    const with_ = contribute(ctxFor({ disclosure: 'hybrid', disclosed: ['read', 'run_code'] }))
    expect(with_.map((s) => s.id)).toEqual([
      'persona',
      'environment',
      'coding-doctrine',
      'code-doctrine',
      'tools:sdk',
    ])
  })

  it('drops the direct-editing rules under the code preset', () => {
    const ids = contribute(ctxFor({ disclosure: 'code', disclosed: ['run_code'] })).map((s) => s.id)
    expect(ids).toEqual(['persona', 'environment', 'code-doctrine', 'tools:sdk'])
  })

  it('keeps the assembled system string byte-identical across a model switch, a preset-name switch, and a cwd change, holding disclosure fixed', () => {
    // Replicates the exact join packages/core/src/request/to-provider.ts uses to flatten sections
    // into the wire system string: req.sections.map((s) => s.text).join('\n\n').
    const flatten = (over: Parameters<typeof ctxFor>[0]) =>
      contribute(ctxFor(over))
        .map((s) => s.text)
        .join('\n\n')
    const base = flatten({})
    expect(base.length).toBeGreaterThan(500)
    expect(base).toContain('You are Agnes, a general-purpose AI agent powered by Agnes Harness.')
    expect(flatten({ model: 'a-totally-different-model', route: 'a-different-route' })).toBe(base)
    expect(flatten({ presetName: 'renamed-preset' })).toBe(base)
    expect(flatten({ cwd: '/a/totally/different/workspace' })).toBe(base)
    expect(flatten({ model: 'm2', route: 'r2', presetName: 'p2', cwd: '/x' })).toBe(base)
  })
})

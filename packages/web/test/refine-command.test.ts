import { webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'
import { describe, expect, it, vi } from 'vitest'
import { isRefineCommand, runRefineCommand } from '../src/app/refine-command.js'

const en = webLocaleCatalog.en as Record<string, string>
const zh = webLocaleCatalog['zh-CN'] as Record<string, string>

function setup(
  refine: (id: string, focus?: string) => Promise<{ runId: string }>,
  session = true,
  dict = en,
) {
  const lines: string[] = []
  const errors: unknown[] = []
  const context = {
    client: { session: { refine: vi.fn(refine) } },
    current: session ? { id: 'session-1' } : undefined,
    notice: { setText: (text: string) => lines.push(text), setKind: vi.fn() },
    t: (key: string, vars: Record<string, string | number> = {}) =>
      (dict[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? `{${name}}`)),
    showError: (error: unknown) => errors.push(error),
  }
  return {
    context: context as unknown as Parameters<typeof runRefineCommand>[0],
    lines,
    errors,
    refine: context.client.session.refine,
  }
}
const rejected = (reason: string) =>
  Object.assign(new Error('rejected'), { code: -32010, data: { code: 'SEMANTIC_REJECTED', reason } })

describe('the composer /refine command', () => {
  it('recognises the command and not a longer word', () => {
    expect(isRefineCommand('/refine')).toBe(true)
    expect(isRefineCommand('/refine the build')).toBe(true)
    expect(isRefineCommand('/refinement')).toBe(false)
    expect(isRefineCommand('please /refine')).toBe(false)
  })

  it('is refused with a hint when refinement is off', async () => {
    const { context, lines, refine } = setup(async () => {
      throw rejected('refinement-off')
    })
    await runRefineCommand(context, '/refine')
    expect(refine).toHaveBeenCalledWith('session-1', undefined)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(
      'Experience refinement (RSI) is not active in this session. Turn it on in Settings; it applies to sessions opened after that, so start a new session.',
    )
    const chinese = setup(
      async () => {
        throw rejected('refinement-off')
      },
      true,
      zh,
    )
    await runRefineCommand(chinese.context, '/refine')
    expect(chinese.lines[0]).toContain('请先在设置中开启')
  })

  it('uses the same hint when refinement is not connected to the session', async () => {
    const { context, lines } = setup(async () => {
      throw rejected('unavailable')
    })
    await runRefineCommand(context, '/refine')
    expect(lines[0]).toMatch(/not active.*new session/s)
  })

  it('queues a review with the focus', async () => {
    const { context, lines, refine } = setup(async () => ({ runId: 'run-3' }))
    await runRefineCommand(context, '/refine   the build setup ')
    expect(refine).toHaveBeenCalledWith('session-1', 'the build setup')
    expect(lines[0]).toContain('run-3')
  })

  it('asks for agreement to an unknown price, and --unpriced gives it', async () => {
    const refused = setup(async () => {
      throw rejected('unpriced')
    })
    await runRefineCommand(refused.context, '/refine the build')
    expect(refused.lines[0]).toMatch(/no known price/)
    expect(refused.lines[0]).toContain('/refine --unpriced')
    const { context, lines, refine } = setup(async () => ({ runId: 'run-6' }))
    await runRefineCommand(context, '/refine --unpriced the build')
    expect(refine).toHaveBeenLastCalledWith('session-1', 'the build', { allowUnpriced: true })
    expect(lines[0]).toContain('run-6')
    await runRefineCommand(context, '/refine --workspace --unpriced')
    expect(refine).toHaveBeenLastCalledWith('session-1', undefined, {
      saveTo: 'workspace',
      allowUnpriced: true,
    })
    const chinese = setup(
      async () => {
        throw rejected('unpriced')
      },
      true,
      zh,
    )
    await runRefineCommand(chinese.context, '/refine')
    expect(chinese.lines[0]).toContain('/refine --unpriced')
  })

  it('/refine --user queues a review saved to user memory', async () => {
    const { context, lines, refine } = setup(async () => ({ runId: 'run-7' }))
    await runRefineCommand(context, '/refine --user  my style ')
    expect(refine).toHaveBeenLastCalledWith('session-1', 'my style', { saveTo: 'user' })
    expect(lines[0]).toContain('run-7')
    expect(lines[0]).toMatch(/saved to user memory/i)
    await runRefineCommand(context, '/refine --unpriced --user')
    expect(refine).toHaveBeenLastCalledWith('session-1', undefined, { saveTo: 'user', allowUnpriced: true })
    // A word that only starts like the flag is focus text; both targets together are not taken.
    await runRefineCommand(context, '/refine --users')
    expect(refine).toHaveBeenLastCalledWith('session-1', '--users')
    const calls = refine.mock.calls.length
    await runRefineCommand(context, '/refine --user --workspace')
    expect(lines.at(-1)).toMatch(/either --workspace or --user/)
    expect(refine).toHaveBeenCalledTimes(calls)
    const chinese = setup(async () => ({ runId: 'run-8' }), true, zh)
    await runRefineCommand(chinese.context, '/refine --user')
    expect(chinese.lines[0]).toContain('用户记忆')
  })

  it('/refine --workspace queues a saving review', async () => {
    const { context, lines, refine } = setup(async () => ({ runId: 'run-4' }))
    await runRefineCommand(context, '/refine --workspace  the build ')
    expect(refine).toHaveBeenLastCalledWith('session-1', 'the build', { saveTo: 'workspace' })
    expect(lines[0]).toContain('run-4')
    expect(lines[0]).toMatch(/saved to this workspace/i)
    expect(lines[0]).not.toMatch(/not available/i)
    await runRefineCommand(context, '/refine --workspace')
    expect(refine).toHaveBeenLastCalledWith('session-1', undefined, { saveTo: 'workspace' })
    const chinese = setup(async () => ({ runId: 'run-5' }), true, zh)
    await runRefineCommand(chinese.context, '/refine --workspace')
    expect(chinese.lines[0]).toContain('工作区')
  })

  it('refuses a too-long focus without asking, and needs an open conversation', async () => {
    const { context, lines, refine } = setup(async () => ({ runId: 'x' }))
    await runRefineCommand(context, `/refine ${'x'.repeat(513)}`)
    expect(lines[0]).toMatch(/512/)
    // 300 emoji are 600 UTF-16 units, which the daemon counts.
    await runRefineCommand(context, `/refine ${'😀'.repeat(300)}`)
    expect(lines[1]).toMatch(/512/)
    await runRefineCommand(context, `/refine --workspace ${'x'.repeat(513)}`)
    expect(lines[2]).toMatch(/512/)
    expect(refine).not.toHaveBeenCalled()
    const none = setup(async () => ({ runId: 'x' }), false)
    await runRefineCommand(none.context, '/refine')
    expect(none.lines[0]).toMatch(/Open a conversation/)
    expect(none.refine).not.toHaveBeenCalled()
  })

  it('names other refusals and shows an unrelated failure as an error', async () => {
    const child = setup(async () => {
      throw rejected('child-session')
    })
    await runRefineCommand(child.context, '/refine')
    expect(child.lines[0]).toMatch(/forked or child session/)
    const other = setup(async () => {
      throw rejected('cooldown')
    })
    await runRefineCommand(other.context, '/refine')
    expect(other.lines[0]).toContain('cooldown')
    const down = setup(async () => {
      throw new Error('down')
    })
    await runRefineCommand(down.context, '/refine')
    expect(down.lines).toEqual([])
    expect(down.errors).toHaveLength(1)
  })
})

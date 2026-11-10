import { type Enforcement, type OpContext, readPreset } from '@agnes/core'
import { actor, fakeProvider, openSession, textTurn } from '@agnes/core/testkit'
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
  extraDirectories?: string[]
  now?: number
  promptSections?: string[]
  model?: string
  route?: string
  presetName?: string
  enforcement?: Enforcement
  toolPolicy?: string
}): OpContext {
  return {
    session: {
      key: 'agnes:local:demo:cli:workspace:abcd',
      d: {
        runtime: { enforcement: () => over.enforcement ?? { level: 'none', scope: [] } },
        cwd: over.cwd ?? '/w/repo',
        ...(over.extraDirectories ? { extraDirectories: over.extraDirectories } : {}),
        agnesVersion: '0.1.0',
        clock: () => over.now ?? Date.parse('2026-09-09T04:00:00.000Z'),
      },
    },
    preset: {
      name: over.presetName ?? 'standard',
      disclosure: over.disclosure ?? 'standard',
      approval: over.toolPolicy ? { policy: over.toolPolicy } : {},
      ...(over.promptSections ? { model: { promptSections: over.promptSections } } : {}),
    },
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
  it.each([false, true])('selects logical-change wording on the wire (%s)', async (enabled) => {
    const provider = fakeProvider([textTurn('answer')])
    const preset = readPreset({ tools: { logical_changes: enabled } }, 'trial')
    const h = await openSession({ provider, preset, operations: [createPromptOperation(deps)] })
    try {
      await h.session.enqueue('next-turn', {
        actor,
        content: [{ type: 'text', text: 'help with this file' }],
      })
      expect((await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      const line = provider.requests[0]?.system
        .split('\n')
        .find((line) => line.startsWith('- Make one logical') || line.startsWith('- Change one thing'))
      if (enabled)
        expect(line).toMatchInlineSnapshot(
          `"- Make one logical change at a time; it may span several edits or files. Verify the change as a unit before moving on. Prefer the smallest change that works. Independent reads, searches and checks can be issued together in one reply."`,
        )
      else {
        expect(line).toMatchInlineSnapshot(
          `"- Change one thing at a time and verify it before moving on. Prefer the smallest edit that works."`,
        )
        const implicit = readPreset({}, 'trial')
        const ctx = ctxFor({})
        expect(createPromptOperation(deps).contribute?.({ ...ctx, preset })?.promptSections).toEqual(
          createPromptOperation(deps).contribute?.({ ...ctx, preset: implicit })?.promptSections,
        )
      }
    } finally {
      await h.session.close()
    }
  })
  it('reports the actual Host-selected interpreter while preserving the dialect fallback', () => {
    const description = 'PowerShell 5.1.26100.9444 (Desktop); native argument mode: Legacy'
    const op = createPromptOperation({
      adapters: { platform: { ...platform, shell: () => 'powershell' }, shell: { description } },
    })
    const environment = op.contribute?.(ctxFor({}))?.promptSections?.find((s) => s.id === 'environment')
    expect(environment?.text).toContain(description)
    expect(environment?.text).toContain('curl.exe')
    expect(environment?.text).toContain('5.1 does not support && or ||')
    expect(contribute(ctxFor({})).find((s) => s.id === 'environment')?.text).not.toContain('curl.exe')
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
    expect(sections.map((s) => s.id)).toEqual([
      'persona',
      'environment',
      'tools-available',
      'coding-doctrine',
    ])
    const table = new Map(PROMPT_SECTIONS.map((s) => [s.id, s.order]))
    expect(sections.map((s) => s.order)).toEqual(sections.map((s) => table.get(s.id)))
    expect(sections.map((s) => s.order)).toEqual([...sections.map((s) => s.order)].sort((a, b) => a - b))
    expect(sections[0]?.id).toBe('persona')
    expect(sections[0]?.order).toBeLessThan(
      Math.min(...PROMPT_SECTIONS.filter((s) => s.owner === 'base').map((s) => s.order)),
    )
    for (const s of sections)
      expect(s.source).toBe(
        ['persona', 'coding-doctrine', 'code-doctrine', 'channel-style'].includes(s.id)
          ? `@agnes/code/prompts/${s.id}.md`
          : '@agnes/code',
      )
  })

  it('states stable platform and transcript guidance in prompt text; volatile facts in the tail runtime context', () => {
    const c = createPromptOperation(deps).contribute?.(
      ctxFor({ cwd: '/other/place', model: 'some-model-9', now: Date.parse('2027-01-02T00:00:00Z') }),
    )
    const text = (c?.promptSections ?? []).map((s) => s.text).join('\n')
    expect(text).toContain('darwin-arm64')
    expect(text).not.toContain('2027-01-02')
    expect(text).not.toContain('agnes:local:demo:cli:workspace:abcd')
    expect(text).not.toContain('some-model-9')
    expect(text).not.toContain('/other/place')
    expect(text).not.toContain('{{')
    expect(c?.runtimeContext).toMatchObject({
      environment: {
        model: 'some-model-9',
        cwd: '/other/place',
        date: '2027-01-02',
        sessionKey: 'agnes:local:demo:cli:workspace:abcd',
      },
    })
  })

  it('reads the clock on every call rather than capturing it once', () => {
    const op = createPromptOperation(deps)
    let now = Date.parse('2026-09-09T00:00:00Z')
    const ctx = ctxFor({})
    ;(ctx.session as unknown as { d: { clock: () => number } }).d.clock = () => now
    const first = op.contribute?.(ctx)
    now = Date.parse('2026-12-25T00:00:00Z')
    const second = op.contribute?.(ctx)
    expect(first?.promptSections).toEqual(second?.promptSections)
    expect(first?.runtimeContext).toMatchObject({ environment: { date: '2026-09-09' } })
    expect(second?.runtimeContext).toMatchObject({ environment: { date: '2026-12-25' } })
  })

  it("lists a session's extra directories sorted, and leaves the facts untouched without them", () => {
    const env = (extraDirectories?: string[]): Record<string, unknown> => {
      const ctx = ctxFor({ ...(extraDirectories ? { extraDirectories } : {}) })
      const c = createPromptOperation(deps).contribute?.(ctx)
      return (c?.runtimeContext?.environment ?? {}) as Record<string, unknown>
    }
    expect(env(['/z/lib', '/a/data']).extraDirectories).toEqual(['/a/data', '/z/lib'])
    expect('extraDirectories' in env([])).toBe(false)
    expect('extraDirectories' in env()).toBe(false)
  })

  it('renders tool guidance as prompt text, keeping runtime context limited to facts', () => {
    const op = createPromptOperation(deps)
    for (const disclosed of [['read', 'write', 'grep'], []]) {
      const c = op.contribute?.(
        ctxFor({
          disclosed,
          promptSections: ['persona', 'environment', 'tools-available', 'coding-doctrine'],
        }),
      )
      expect(c?.promptSections?.find((s) => s.id === 'tools-available')?.text).toContain(
        disclosed.length ? 'Use only tools offered in this request' : 'You have no tools on this request',
      )
      expect(c?.runtimeContext).not.toHaveProperty('tools')
      expect(JSON.stringify(c?.runtimeContext)).not.toContain('tool_search')
    }
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
      'tools-available',
      'coding-doctrine',
      'code-doctrine',
      'tools:sdk',
    ])
  })

  it('drops the direct-editing rules under the code preset', () => {
    const ids = contribute(ctxFor({ disclosure: 'code', disclosed: ['run_code'] })).map((s) => s.id)
    expect(ids).toEqual(['persona', 'environment', 'tools-available', 'code-doctrine', 'tools:sdk'])
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
    expect(base).toContain(
      'You are Agnes, a general-purpose AI agent developed by Agnes AI and powered by Agnes Harness.',
    )
    expect(flatten({ model: 'a-totally-different-model', route: 'a-different-route' })).toBe(base)
    expect(flatten({ presetName: 'renamed-preset' })).toBe(base)
    expect(flatten({ cwd: '/a/totally/different/workspace' })).toBe(base)
    expect(flatten({ model: 'm2', route: 'r2', presetName: 'p2', cwd: '/x' })).toBe(base)
  })
})

describe('the command isolation fact', () => {
  const boundary = {
    contract: 'windows-write-restricted-v1',
    fileWrite: 'acl-partial',
    fileRead: 'unrestricted',
    network: 'unrestricted',
    processTree: 'job-object',
  } as const
  const acl: Enforcement = { level: 'partial', scope: ['file'], boundary }
  const full: Enforcement = { level: 'full', scope: ['file', 'network', 'process'] }
  const none: Enforcement = { level: 'none', scope: [] }
  // What a Windows full-access session really reports: the local probe's unconfined file-only posture.
  const unconfined: Enforcement = { level: 'partial', scope: ['file'] }
  const host = (os: string) => ({
    adapters: {
      platform: {
        ...platform,
        shell: () => (os === 'win32' ? 'powershell' : 'posix'),
        snapshot: () => ({ os, arch: 'x64' }),
        // One platform value for the whole Host: it must not decide any session's fact.
        capability: () => ({ level: 'full' }),
      },
    },
  })
  const facts = (deps: ReturnType<typeof host>, over: Parameters<typeof ctxFor>[0]) => {
    const c = createPromptOperation(deps).contribute?.(ctxFor(over))
    return {
      env: (c?.runtimeContext?.environment ?? {}) as Record<string, unknown>,
      system: (c?.promptSections ?? []).map((section) => section.text).join('\n'),
    }
  }
  const WRITE =
    'Windows：工作区和本次临时目录使用 ACL 部分写限制，非严格路径隔离；读取与网络未隔离。受保护文件仍由文件工具检查，任意脚本不具备同等保护。'
  const READ = 'Windows：不授予工作区或临时目录写能力；读取与网络未隔离，工具仍按只读规则使用。'

  it('states the actual boundary of each permission as the last environment fact, never in the system text', () => {
    const windows = host('win32')
    const write = facts(windows, { enforcement: acl, toolPolicy: 'default' })
    expect(write.env.commandIsolation).toBe(
      `${WRITE}工作区内的硬链接若指向工作区外的文件（如 pnpm 存储），那些文件也可经此写入；会话的额外目录没有 ACL 写权限，命令写入那里会被拒绝访问。`,
    )
    expect(Object.keys(write.env).at(-1)).toBe('commandIsolation')
    expect(write.system).not.toContain('ACL')
    expect(facts(windows, { enforcement: acl, toolPolicy: 'read-only' }).env.commandIsolation).toBe(READ)
    expect(facts(windows, { enforcement: unconfined, toolPolicy: 'full-access' }).env.commandIsolation).toBe(
      'Windows：完全访问，命令未隔离',
    )
  })

  it('says a full-access session is not isolated whatever level its unconfined posture reports', () => {
    const windows = host('win32')
    for (const enforcement of [unconfined, none])
      expect(facts(windows, { enforcement, toolPolicy: 'full-access' }).env.commandIsolation).toBe(
        'Windows：完全访问，命令未隔离',
      )
    // A full boundary is isolation, not the unconfined local path.
    expect(facts(windows, { enforcement: full, toolPolicy: 'full-access' }).env).not.toHaveProperty(
      'commandIsolation',
    )
  })

  it('never names the Windows boundary off Windows, whoever reports it', () => {
    for (const toolPolicy of ['default', 'read-only', 'full-access'])
      expect(facts(host('linux'), { enforcement: acl, toolPolicy }).env).not.toHaveProperty(
        'commandIsolation',
      )
  })

  it('reads each session on one Host from its own enforcement, not the platform or its name', () => {
    const windows = host('win32')
    // The Host's platform claims full isolation; the sessions say otherwise and are believed.
    expect(facts(windows, { enforcement: acl, toolPolicy: 'default' }).env.commandIsolation).toContain(
      'ACL 部分写限制',
    )
    expect(facts(windows, { enforcement: none, toolPolicy: 'full-access' }).env.commandIsolation).toBe(
      'Windows：完全访问，命令未隔离',
    )
    // A partial level without the exact contract is not the Windows boundary.
    expect(
      facts(windows, { enforcement: { level: 'partial', scope: ['file'] }, toolPolicy: 'default' }).env,
    ).not.toHaveProperty('commandIsolation')
    // Another provider's full boundary, or a session that is not full access, gets no Windows line.
    expect(facts(windows, { enforcement: full, toolPolicy: 'default' }).env).not.toHaveProperty(
      'commandIsolation',
    )
    expect(facts(windows, { enforcement: none, toolPolicy: 'default' }).env).not.toHaveProperty(
      'commandIsolation',
    )
  })

  const POSIX_FULL =
    'Full access: the harness does not confine commands; installing software needs no approval.'

  it('says off Windows that a full-access session without a boundary runs commands unconfined', () => {
    // What such a session reports: no backend at all, or the unconfined file-only fallback.
    for (const os of ['linux', 'darwin'])
      for (const enforcement of [none, unconfined]) {
        const { env, system } = facts(host(os), { enforcement, toolPolicy: 'full-access' })
        expect(env.commandIsolation).toBe(POSIX_FULL)
        expect(Object.keys(env).at(-1)).toBe('commandIsolation')
        expect(system).not.toContain('Full access:')
      }
  })

  it('says nothing off Windows for any other permission, or where a boundary confines the commands', () => {
    for (const os of ['linux', 'darwin']) {
      for (const toolPolicy of ['default', 'read-only', undefined])
        for (const enforcement of [full, none, unconfined]) {
          const { env } = facts(host(os), { enforcement, ...(toolPolicy ? { toolPolicy } : {}) })
          expect(env).not.toHaveProperty('commandIsolation')
          expect(env.enforcement).toBe('full')
        }
      // Full access with a full boundary (a memory provider keeps the sandbox on) is not unconfined.
      expect(facts(host(os), { enforcement: full, toolPolicy: 'full-access' }).env).not.toHaveProperty(
        'commandIsolation',
      )
    }
  })
})

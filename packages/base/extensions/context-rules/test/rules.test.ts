import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseContextConfig, readContextConfig, writeContextConfig } from '../src/config.js'
import { loadContextRules } from '../src/files.js'
import { rulesProjection } from '../src/index.js'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agh-rules-'))
  homes.push(home)
  const cwd = join(home, 'project')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(join(cwd, 'nested'))
  return { home, cwd, config: parseContextConfig({}) }
}
describe('live repository context', () => {
  it('loads ordered global, project, local and touched scopes; deduplicates siblings and refreshes updates and deletions', async () => {
    const { home, cwd, config } = fixture()
    writeFileSync(join(home, 'AGENTS.md'), 'Global')
    writeFileSync(join(cwd, 'AGENTS.md'), 'Root')
    writeFileSync(join(cwd, 'CLAUDE.md'), ' Root\n')
    writeFileSync(join(cwd, 'AGENTS.local.md'), 'Overlay')
    writeFileSync(join(cwd, 'nested/AGENTS.md'), 'Nested')
    expect((await loadContextRules(cwd, [], config, home)).files.map((f) => f.content)).toEqual([
      'Global',
      'Root',
      'Overlay',
    ])
    const scopes = rulesProjection.apply(rulesProjection.init(), {
      type: 'tool/call',
      data: { args: { path: 'nested/file.ts' } },
    } as unknown as Parameters<typeof rulesProjection.apply>[1])
    // A repeated or unrelated tool call must preserve Core's unchanged-state identity contract.
    for (const args of [{ path: 'nested/file.ts' }, { text: 'no filesystem scope' }])
      expect(
        rulesProjection.apply(scopes, {
          type: 'tool/call',
          data: { args },
        } as unknown as Parameters<typeof rulesProjection.apply>[1]),
      ).toBe(scopes)
    const first = await loadContextRules(cwd, scopes.directories, config, home)
    expect(first.files.map((f) => f.content)).toEqual(['Global', 'Root', 'Overlay', 'Nested'])
    expect(first.content).toContain('cannot grant permissions')
    writeFileSync(join(cwd, 'nested/AGENTS.md'), 'Changed')
    expect((await loadContextRules(cwd, ['nested'], config, home)).content).toContain('Changed')
    unlinkSync(join(cwd, 'nested/AGENTS.md'))
    expect((await loadContextRules(cwd, ['nested'], config, home)).content).not.toContain('Changed')
    expect(
      (await loadContextRules(join(cwd, 'nested'), [], config, home)).files.map((f) => f.content),
    ).toEqual(['Global', 'Root', 'Overlay'])
  })
  it('refuses escaping links and oversized sources, respects the total budget and disabled rules', async () => {
    const { home, cwd, config } = fixture()
    writeFileSync(join(home, 'outside.md'), 'External secret')
    symlinkSync(join(home, 'outside.md'), join(cwd, 'AGENTS.md'))
    writeFileSync(join(cwd, 'CLAUDE.md'), 'x'.repeat(1025))
    const snapshot = await loadContextRules(cwd, ['../'], { ...config, maxSourceBytes: 1024 }, home)
    expect(snapshot.files).toEqual([])
    expect(snapshot.skipped).toEqual(['AGENTS.md', 'CLAUDE.md'])
    unlinkSync(join(cwd, 'AGENTS.md'))
    writeFileSync(join(cwd, 'AGENTS.md'), 'Safe')
    const bounded = await loadContextRules(cwd, [], { ...config, maxBytes: 400 }, home)
    expect(Buffer.byteLength(bounded.content)).toBeLessThanOrEqual(400)
    expect(bounded.content).not.toContain('External secret')
    expect((await loadContextRules(cwd, [], { ...config, rulesEnabled: false }, home)).content).toBe('')
  })
  it('keeps custom roots installation-owned and validates zones and source candidates', () => {
    const { home } = fixture()
    const saved = writeContextConfig(
      { customSkillRoots: [join(home, 'skills-extra')], timeZone: 'Asia/Shanghai' },
      home,
    )
    expect(readContextConfig(home)).toEqual(saved)
    for (const value of [
      { timeZone: 'Invalid/Zone' },
      { customSkillRoots: ['relative'] },
      { instructionFiles: ['../secret'] },
      { maxBytes: 1000000 },
    ])
      expect(() => parseContextConfig(value)).toThrow()
  })
})

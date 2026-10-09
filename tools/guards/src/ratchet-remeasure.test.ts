import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedRatchetKeys, parseRemeasureArgs, remeasure } from './ratchet-remeasure.js'

const scope = 'packages/example/src'
const component = `${scope}/component`
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(budget = 10, ceiling = budget) {
  const root = mkdtempSync(join(tmpdir(), 'agh-ratchet-'))
  roots.push(root)
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  write(`${scope}/main.ts`, '// ignored\n/* block\ncomment */\nconst main = 1\n')
  write(`${component}.ts`, 'const component = 1\n')
  write(`${component}/child.tsx`, 'const child = <div />\n')
  write(`${scope}/component-extra.ts`, 'const sibling = 1\n')
  write(`${scope}/fixtures/kept.mts`, 'const fixture = 1\n')
  write(`${scope}/test/kept.cts`, 'const sourceInTestDirectory = 1\n')
  write(`${scope}/main.test.tsx`, 'const test = 1\n')
  write(`${scope}/generated/ignored.ts`, 'const generated = 1\n')
  write(`${scope}/dist/ignored.ts`, 'const build = 1\n')
  write('tools/guards/ratchet.json', `{\n  "${scope}": ${budget},\n  "${component}": 8\n}\n`)
  write(
    'tools/guards/src/ratchet.test.ts',
    `// retain 123\nconst INITIAL_CEILING: Record<string, number> = {\n  '${component}': 8, // component history\n  /* scope history\n  '${scope}': 999,\n  */\n  '${scope}': ${ceiling},\n}\nconst unrelated = 77\n`,
  )
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const snapshot = (): [string, string] => [
    read('tools/guards/ratchet.json'),
    read('tools/guards/src/ratchet.test.ts'),
  ]
  return { root, write, read, snapshot }
}

describe('exact paired ratchet remeasurement', () => {
  it('counts the guard file forms and exclusions, rewrites both values and preserves comments/order', () => {
    const f = fixture()
    const before = f.snapshot()
    expect(remeasure(f.root, { keys: [scope, component] })).toEqual([
      { key: scope, actual: 6, budget: 10, ceiling: 10 },
      { key: component, actual: 2, budget: 8, ceiling: 8 },
    ])
    expect(f.snapshot()).toEqual([
      before[0].replace(`"${scope}": 10`, `"${scope}": 6`).replace(`"${component}": 8`, `"${component}": 2`),
      before[1].replace(`'${scope}': 10`, `'${scope}': 6`).replace(`'${component}': 8`, `'${component}': 2`),
    ])
    expect(remeasure(f.root, { keys: [scope, component], check: true })).toEqual([
      { key: scope, actual: 6, budget: 6, ceiling: 6 },
      { key: component, actual: 2, budget: 2, ceiling: 2 },
    ])
  })

  it('reports drift without writing, including an increase in either mirror', () => {
    const f = fixture(3, 10)
    const before = f.snapshot()
    expect(remeasure(f.root, { keys: [scope], check: true })).toEqual([
      { key: scope, actual: 6, budget: 3, ceiling: 10 },
    ])
    expect(f.snapshot()).toEqual(before)
  })

  it.each([
    [3, 10],
    [10, 3],
  ])('refuses all writes when either budget must increase (%i, %i)', (budget, ceiling) => {
    const f = fixture(budget, ceiling)
    const before = f.snapshot()
    expect(() => remeasure(f.root, { keys: [component, scope] })).toThrow('--allow-increase')
    expect(f.snapshot()).toEqual(before)
    remeasure(f.root, { keys: [scope], allowIncrease: true })
    expect(remeasure(f.root, { keys: [scope], check: true })).toEqual([
      { key: scope, actual: 6, budget: 6, ceiling: 6 },
    ])
    expect(f.read('tools/guards/ratchet.json')).toContain(`"${component}": 8`)
  })

  it('selects overlapping scopes for source changes and deletions without prefix collisions or test/build changes', () => {
    expect(
      changedRatchetKeys('/repo', [scope, component], [`${component}.ts`, `${component}/deleted.mts`]),
    ).toEqual([scope, component])
    expect(changedRatchetKeys('/repo', [scope, component], [`${scope}/component-extra.ts`])).toEqual([scope])
    expect(
      changedRatchetKeys(
        '/repo',
        [scope, component],
        [`${scope}/main.test.tsx`, `${scope}/generated/a.ts`, `${component}/image.png`],
      ),
    ).toEqual([])
  })

  it('defaults to branch/index/worktree changes and untracked source against the integration ref', () => {
    const f = fixture()
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(f.root, 'no-hooks')}`, ...args],
        { cwd: f.root, stdio: 'ignore' },
      )
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
    git('update-ref', 'refs/remotes/origin/feat/agh-plugin-core', 'HEAD')
    f.write(`${component}/child.tsx`, 'const child = <div />\nconst committed = 1\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'branch')
    f.write(`${scope}/main.ts`, 'const main = 1\nconst staged = 1\n')
    git('add', `${scope}/main.ts`)
    // A deletion can select a scope even though the deleted file no longer exists for counting.
    unlinkSync(join(f.root, `${component}.ts`))
    f.write(`${component}/new.mts`, 'const added = 1\n')
    expect(remeasure(f.root, { check: true }).map(({ key, actual }) => ({ key, actual }))).toEqual([
      { key: scope, actual: 8 },
      { key: component, actual: 3 },
    ])
  })

  it('refuses unknown, stale and mismatched keys before changing either file', () => {
    const f = fixture()
    const before = f.snapshot()
    expect(() => remeasure(f.root, { keys: [scope, 'missing'], allowIncrease: true })).toThrow('Unknown')
    rmSync(join(f.root, scope), { recursive: true })
    expect(() => remeasure(f.root, { keys: [scope] })).toThrow('no source files')
    expect(f.snapshot()).toEqual(before)
    f.write('tools/guards/ratchet.json', '{}\n')
    expect(() => remeasure(f.root, { keys: [] })).toThrow('same keys')
    expect(f.read('tools/guards/src/ratchet.test.ts')).toBe(before[1])
    f.write('tools/guards/ratchet.json', '[]\n')
    expect(() => remeasure(f.root, { keys: [] })).toThrow('budget object')
    expect(f.read('tools/guards/src/ratchet.test.ts')).toBe(before[1])
  })

  it('parses only explicit supported flags and refuses missing, empty or unknown keys syntax', () => {
    expect(parseRemeasureArgs(['--keys', `${scope},${component}`, '--check', '--allow-increase'])).toEqual({
      keys: [scope, component],
      check: true,
      allowIncrease: true,
    })
    for (const args of [['--keys'], ['--keys', '--check'], ['--keys', 'a,'], ['--unknown']])
      expect(() => parseRemeasureArgs(args)).toThrow()
  })
})

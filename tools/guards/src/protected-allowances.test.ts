import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import {
  assertBudgetNonIncrease,
  assertMaintainerBudgetChange,
  budgetGrowth,
  protectedAllowance,
  protectedBase,
} from './protected-allowances.js'

const root = mkdtempSync(join(tmpdir(), 'agh-protected-budget-'))
afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
git('init', '--initial-branch=fixture')
mkdirSync(join(root, 'tools/guards'), { recursive: true })
const path = 'tools/guards/file-size-allowlist.json'
const abs = join(root, path)
writeFileSync(abs, '{"old.ts": 801}')
git('add', '.')
git(
  '-c',
  'user.name=Guard fixture',
  '-c',
  'user.email=guard@example.invalid',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-m',
  'freeze fixture budget',
)
const base = git('rev-parse', 'HEAD')
git('update-ref', 'refs/remotes/origin/feat/agh-plugin-core', base)

it('uses real protected Git history: editing JSON or committing a raised budget cannot authorize growth', () => {
  vi.stubEnv('GITHUB_ACTIONS', 'false')
  expect(protectedBase(root)).toBe(base)
  writeFileSync(abs, '{"old.ts": 802, "new.ts": 900}')
  git('add', '.')
  git(
    '-c',
    'user.name=Guard fixture',
    '-c',
    'user.email=guard@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'attempt fixture growth',
  )
  expect(assertBudgetNonIncrease(root, path)).toHaveLength(2)
  writeFileSync(abs, '{"old.ts": 801}')
  expect(assertBudgetNonIncrease(root, path)).toEqual([])
  expect(budgetGrowth({ 'old.ts': 800 }, { 'old.ts': 801 })).toEqual([])
  expect(budgetGrowth({ 'old.ts': Number.NaN }, { 'old.ts': 801 })).toHaveLength(1)
  expect(() => protectedAllowance(root, 'tools/guards/function-size-allowlist.json', '{}')).toThrow(
    /Initial reviewed/,
  )
  expect(() => assertMaintainerBudgetChange(root)).not.toThrow()
  writeFileSync(join(root, 'product.ts'), 'export const behavior = true')
  expect(() => assertMaintainerBudgetChange(root)).toThrow(/separate maintainer/)
})
it('CI resolves the event base and missing/shallow protected history refuses', () => {
  const event = join(root, 'event.json')
  vi.stubEnv('GITHUB_ACTIONS', 'true')
  vi.stubEnv('GITHUB_EVENT_PATH', event)
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base } } }))
  expect(protectedBase(root)).toBe(base)
  writeFileSync(event, JSON.stringify({ before: base }))
  expect(protectedBase(root)).toBe(base)
  writeFileSync(event, JSON.stringify({ before: 'a'.repeat(40) }))
  expect(() => protectedBase(root)).toThrow(/protected base/)
  expect(readFileSync(abs, 'utf8')).toBe('{"old.ts": 801}')
  vi.unstubAllEnvs()
})

/** Compare with Git's protected merge-base, not a second PR-editable copy of the budget. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostAllowance } from './host-business.js'
import { hostKey } from './host-business.js'

export function protectedBase(root: string): string {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let ref = 'origin/feat/agh-plugin-core'
  if (process.env.GITHUB_ACTIONS !== 'true') {
    try {
      git('rev-parse', '--verify', ref)
    } catch {
      ref = 'origin/main'
    }
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH as string, 'utf8')) as {
      pull_request?: { base: { sha: string } }
      before?: string
    }
    ref =
      event.pull_request?.base.sha ??
      (event.before && !/^0+$/.test(event.before) ? event.before : git('rev-parse', 'HEAD^'))
  }
  try {
    return git('merge-base', 'HEAD', ref)
  } catch {
    throw new Error(
      `Cannot resolve protected base ${ref}; fetch full protected-branch history before running guards`,
    )
  }
}

// First introduction only: reviewed seed digests. Once present on the protected branch, Git owns
// the ceiling. These are not refreshed by remeasure. Changing a seed requires maintainer review.
const INITIAL_SEEDS: Record<string, string> = {
  'tools/guards/function-size-allowlist.json':
    '4ae0040035ce3202d71329668820850d2f0c1935b486190f11d4c91cfd8527e9',
  'tools/guards/host-business-allowlist.json':
    '88910148d87d3a24ac100cf4a963dce381f04b1076385293cb06ae92d16a92a2',
  'tools/guards/host-business-contracts.json':
    '60a6c8700914a41dda3a918d2a0b8ab39c1ce8f5816fc23ca991d211f6ac31c2',
}
export function protectedAllowance<T>(root: string, path: string, currentText: string): T {
  const base = protectedBase(root)
  const listed = execFileSync('git', ['ls-tree', '--name-only', base, '--', path], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  if (listed)
    return JSON.parse(execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' })) as T
  const digest = createHash('sha256').update(currentText).digest('hex')
  if (INITIAL_SEEDS[path] !== digest) throw new Error(`Initial reviewed allowance differs: ${path}`)
  return JSON.parse(currentText) as T
}
export function budgetGrowth(current: Record<string, number>, base: Record<string, number>): string[] {
  return Object.entries(current).flatMap(([key, ceiling]) =>
    !Object.hasOwn(base, key) || !Number.isInteger(ceiling) || ceiling <= 0 || ceiling > (base[key] ?? 0)
      ? [`${key}: ceiling ${ceiling} > protected ${base[key] ?? 0}`]
      : [],
  )
}
export function hostAllowanceGrowth(current: HostAllowance[], base: HostAllowance[]): string[] {
  const previous = new Map(base.map((entry) => [hostKey(entry), entry]))
  return current.flatMap((entry) => {
    const old = previous.get(hostKey(entry))
    return !old ||
      !Number.isInteger(entry.max) ||
      entry.max < 1 ||
      entry.max > old.max ||
      entry.removal !== old.removal
      ? [`Host allowance grew/changed: ${hostKey(entry)}`]
      : []
  })
}
export function assertBudgetNonIncrease(root: string, path: string): string[] {
  const text = readFileSync(join(root, path), 'utf8')
  return budgetGrowth(JSON.parse(text) as Record<string, number>, protectedAllowance(root, path, text))
}

/** Increases can only be prepared in a separate budget-only maintainer change. CI still compares
 * against the protected base; a reviewed policy change must explicitly authorize an increase. */
export function assertMaintainerBudgetChange(root: string): void {
  const base = protectedBase(root)
  const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, '--'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  paths.push(
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  )
  const allowed =
    /^(?:tools\/guards\/(?:file-size-allowlist|function-size-allowlist|scope-line-count)\.json|docs\/maintainers\/[^/]+\.md)$/
  if (paths.some((path) => !allowed.test(path)))
    throw new Error(
      '--allow-increase requires a separate maintainer budget change containing only budgets and maintainer documentation',
    )
}

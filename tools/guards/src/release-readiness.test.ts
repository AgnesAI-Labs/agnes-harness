import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listPackages, repoRoot } from './repo.js'

type ReadinessProblem = {
  id: string
  affectedPackages?: string[]
}

type HeldItem = ReadinessProblem & {
  owner: string
  reason: string
  exitCriteria: string
}

type HeldFile = {
  scope: string
  held: HeldItem[]
}

const HOLDABLE = new Set(['license.root-file', 'license.manifests', 'packages.private'])
const INTERNAL_CODENAMES = ['B-plan', 'fadeaway', 'OpenClaw', 'agnes-harness-a', 'agnes-harness-b']
const APACHE_LICENSE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
const LICENSE_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  '@agnes/cordis': 'MIT',
  '@agnes/cosmokit': 'MIT',
  '@agnes/base': 'Apache-2.0 AND MIT',
  '@agnes/host': 'Apache-2.0 AND MIT',
  '@agnes/package-manager': 'Apache-2.0 AND MIT',
})

function sorted(values: string[]): string[] {
  return [...values].sort()
}

function productPackages(root: string) {
  return listPackages(root).filter(({ dir }) => dir.startsWith(join(root, 'packages')))
}

function checkReleaseReadiness(root: string): ReadinessProblem[] {
  const problems: ReadinessProblem[] = []
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  const packages = productPackages(root)

  const licenseFile = join(root, 'LICENSE')
  if (
    !existsSync(licenseFile) ||
    createHash('sha256').update(readFileSync(licenseFile)).digest('hex') !== APACHE_LICENSE_SHA256
  )
    problems.push({ id: 'license.root-file' })
  if (!existsSync(join(root, 'NOTICE'))) problems.push({ id: 'license.notice-missing' })
  if (!existsSync(join(root, 'SECURITY.md'))) problems.push({ id: 'security.policy-missing' })
  if (!existsSync(join(root, 'CONTRIBUTING.md'))) problems.push({ id: 'contributing.root-file-missing' })

  const manifestsWithWrongLicense = [
    rootManifest.license === 'Apache-2.0' ? undefined : String(rootManifest.name),
    ...packages.map(({ name, json }) =>
      json.license === (LICENSE_EXCEPTIONS[name] ?? 'Apache-2.0') ? undefined : name,
    ),
  ].filter((name): name is string => name !== undefined)
  if (manifestsWithWrongLicense.length > 0) {
    problems.push({ id: 'license.manifests', affectedPackages: sorted(manifestsWithWrongLicense) })
  }

  const privatePackages = packages.filter(({ json }) => json.private === true).map(({ name }) => name)
  if (privatePackages.length > 0) {
    problems.push({ id: 'packages.private', affectedPackages: sorted(privatePackages) })
  }

  const readme = readFileSync(join(root, 'README.md'), 'utf8').toLowerCase()
  for (const codename of INTERNAL_CODENAMES) {
    if (readme.includes(codename.toLowerCase())) {
      problems.push({ id: `readme.internal-codename:${codename}` })
    }
  }

  const versioningPath = join(root, 'docs/maintainers/versioning.md')
  if (!existsSync(versioningPath)) {
    problems.push({ id: 'version.strategy-missing' })
  } else {
    const versioning = readFileSync(versioningPath, 'utf8')
    if (!versioning.includes('Semantic Versioning') || !versioning.includes('0.0.0')) {
      problems.push({ id: 'version.strategy-incomplete' })
    }
  }
  return problems
}

function auditHeldItems(problems: ReadinessProblem[], heldFile: HeldFile): string[] {
  const errors: string[] = []
  if (!heldFile.scope.trim()) errors.push('release readiness todo-list must explain its scope')
  const held = new Map<string, HeldItem>()

  for (const item of heldFile.held) {
    if (held.has(item.id)) errors.push(`duplicate HELD item: ${item.id}`)
    if (!HOLDABLE.has(item.id)) errors.push(`item cannot be HELD: ${item.id}`)
    for (const field of ['owner', 'reason', 'exitCriteria'] as const) {
      if (!item[field].trim()) errors.push(`${item.id}: missing ${field}`)
    }
    held.set(item.id, item)
  }

  const actual = new Map(problems.map((problem) => [problem.id, problem]))
  for (const problem of problems) {
    const item = held.get(problem.id)
    if (!item) {
      errors.push(`unregistered release blocker: ${problem.id}`)
      continue
    }
    if (
      JSON.stringify(sorted(problem.affectedPackages ?? [])) !==
      JSON.stringify(sorted(item.affectedPackages ?? []))
    ) {
      errors.push(`${problem.id}: affected package list changed`)
    }
  }
  for (const id of held.keys()) {
    if (!actual.has(id)) errors.push(`stale HELD item: ${id}`)
  }
  return errors.sort()
}

const root = repoRoot()
const problems = checkReleaseReadiness(root)
const heldFile = JSON.parse(
  readFileSync(join(root, 'tools/guards/release-readiness-todos.json'), 'utf8'),
) as HeldFile

describe('release readiness', () => {
  it('has no unknown, stale or under-specified release blocker', () => {
    expect(auditHeldItems(problems, heldFile)).toEqual([])
  })

  it('publishes every HELD item in the human-readable todo-list', () => {
    const document = readFileSync(join(root, 'docs/maintainers/release.md'), 'utf8')
    for (const item of heldFile.held) expect(document).toContain(`- [ ] \`${item.id}\``)
  })

  it('does not allow code-name or version-strategy failures to be held', () => {
    expect([...HOLDABLE].every((id) => !id.startsWith('readme.') && !id.startsWith('version.'))).toBe(true)
  })
})

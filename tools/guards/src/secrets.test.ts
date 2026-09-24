import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './repo.js'

type SecretFinding = {
  path: string
  line: number
  rule: string
}

type Rule = {
  name: string
  pattern: RegExp
}

type Allowance = {
  path: string
  rule: string
  lines: number[]
  reason: string
}

type Allowlist = {
  scope: string
  allow: Allowance[]
}

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  // Git-ignored local daemon/Web acceptance state. Like dist, it is not repository content and
  // legitimately records the current machine's workspace path and owner identity.
  '.agnes-tmp',
  '.pnpm-store',
  '.superpowers',
  '.worktrees',
  'coverage',
  'dist',
  'node_modules',
])

const SCANNED_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.env',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.mts',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
])

// Escaped control characters are removed before matching so tests proving that secrets are redacted
// do not accidentally become long credential-shaped literals. This is the only content exemption;
// documentation examples and test fixtures must use the explicit, consumed allowlist.
const BENIGN_ESCAPES = [
  /\\u\{[0-9a-fA-F]{1,6}\}/g,
  /\\u[0-9a-fA-F]{4}/g,
  /\\x[0-9a-fA-F]{2}/g,
  /\\[nrtbf0'"`\\]/g,
]

const RULES: readonly Rule[] = [
  { name: 'private-key-block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'bearer-literal', pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'private-key-pem-body', pattern: /\bMII[A-Za-z0-9+/]{40,}={0,2}/ },
  {
    name: 'env-assignment',
    pattern: /^[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s'"`]{16,}$/,
  },
  {
    name: 'assigned-credential',
    pattern:
      /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"`][^'"`\n]{16,}['"`]/i,
  },
  {
    name: 'posix-user-home',
    pattern: /(?:^|[\s'"`(=:])\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s'"`)]*)?/,
  },
  {
    name: 'windows-user-home',
    pattern: /(?:^|[\s'"`(=:])[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s'"`)]+(?:\\{1,2}[^\s'"`)]*)?/i,
  },
]

function scanText(text: string, path: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    let line = raw
    for (const pattern of BENIGN_ESCAPES) line = line.replace(pattern, ' ')
    for (const rule of RULES) {
      if (rule.pattern.test(line)) findings.push({ path, line: index + 1, rule: rule.name })
    }
  }
  return findings
}

function isEnvResidue(name: string): boolean {
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example')
}

function scanRepository(root: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry)) walk(full)
        continue
      }
      const path = relative(root, full).split(sep).join('/')
      if (isEnvResidue(entry)) findings.push({ path, line: 1, rule: 'env-file' })
      if (!SCANNED_EXTENSIONS.has(extname(entry)) && !entry.startsWith('.env')) continue
      findings.push(...scanText(readFileSync(full, 'utf8'), path))
    }
  }
  walk(root)
  return findings
}

function allowanceKey(finding: SecretFinding): string {
  return `${finding.path}:${finding.line} ${finding.rule}`
}

function isUntrackedScratchMachinePath(finding: SecretFinding, tracked: ReadonlySet<string>): boolean {
  return (
    finding.rule === 'posix-user-home' &&
    finding.path.startsWith('.agnes-scratch/') &&
    !tracked.has(finding.path)
  )
}

function isFixtureOrDocumentation(path: string): boolean {
  return (
    path.startsWith('docs/') ||
    path.includes('/fixtures/') ||
    path.includes('/test/') ||
    path.includes('/testkit/') ||
    /(?:^|\/)testkit\.[cm]?[jt]sx?$/.test(path) ||
    /\.test\.[cm]?[jt]sx?$/.test(path)
  )
}

function auditFindings(findings: SecretFinding[], allowlist: Allowlist): string[] {
  const errors: string[] = []
  if (!allowlist.scope.trim()) errors.push('secrets allowlist must explain its scope')

  const allowances = new Map<string, Allowance>()
  for (const allowance of allowlist.allow) {
    const label = `${allowance.path} ${allowance.rule}`
    if (!allowance.reason.trim()) errors.push(`${label}: allowance has no reason`)
    if (!isFixtureOrDocumentation(allowance.path)) {
      errors.push(`${label}: production files cannot be allowlisted`)
    }
    if (!Array.isArray(allowance.lines) || allowance.lines.length === 0) {
      errors.push(`${label}: allowance has no lines`)
      continue
    }
    for (const line of allowance.lines) {
      const key = allowanceKey({ path: allowance.path, line, rule: allowance.rule })
      if (!Number.isInteger(line) || line < 1) errors.push(`${key}: invalid allowance line`)
      if (allowances.has(key)) errors.push(`${key}: duplicate allowance`)
      allowances.set(key, allowance)
    }
  }

  const actual = new Set(findings.map(allowanceKey))
  for (const key of actual) {
    if (!allowances.has(key)) errors.push(`credential-shaped literal: ${key}`)
  }
  for (const key of allowances.keys()) {
    if (!actual.has(key)) errors.push(`stale secrets allowance: ${key}`)
  }
  return errors.sort()
}

const root = repoRoot()
const allowlistPath = join(root, 'tools/guards/secrets-allowlist.json')
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as Allowlist
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path.length > 0),
)
// Operator scratch remains scanned for credentials and private keys. Only a machine-specific home
// path in an untracked root scratch file is local state rather than repository evidence. If such a
// file is ever force-added, `tracked` makes the same finding blocking again.
const findings = scanRepository(root).filter((finding) => !isUntrackedScratchMachinePath(finding, tracked))

describe('repository secrets scan', () => {
  it('has no unregistered credential, private key, env file or machine home path', () => {
    const errors = auditFindings(findings, allowlist)
    expect(errors, errors.join('\n')).toEqual([])
  })

  it('detects representative fake secrets without storing them literally in this file', () => {
    const fakeGithubToken = ['ghp', '_', 'a'.repeat(36)].join('')
    const fakePrivateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
    const fakePosixHome = ['/', 'Users', '/', 'example-user', '/', 'project'].join('')
    const fakeWindowsHome = ['C:', '\\', 'Users', '\\', 'example-user', '\\', 'project'].join('')
    const detected = scanText(
      [fakeGithubToken, fakePrivateKey, fakePosixHome, fakeWindowsHome].join('\n'),
      'synthetic.txt',
    ).map(({ rule }) => rule)
    expect(detected).toEqual(['github-token', 'private-key-block', 'posix-user-home', 'windows-user-home'])
  })

  it('detects env residue names and permits only the public example form', () => {
    expect(isEnvResidue('.env')).toBe(true)
    expect(isEnvResidue('.env.local')).toBe(true)
    expect(isEnvResidue('.env.production')).toBe(true)
    expect(isEnvResidue('.env.example')).toBe(false)
  })

  it.each(['\n', '\r\n'])('detects and audits assignments with %j line endings', (newline) => {
    const path = 'docs/synthetic.md'
    const assignment = ['EXAMPLE_VALUE', '=', 'a'.repeat(24)].join('')
    const text = ['# Example', assignment, '', assignment, ''].join(newline)
    const detected = scanText(text, path)
    expect(detected).toEqual([
      { path, line: 2, rule: 'env-assignment' },
      { path, line: 4, rule: 'env-assignment' },
    ])
    expect(auditFindings(detected, { scope: 'test', allow: [] })).toEqual([
      `credential-shaped literal: ${path}:2 env-assignment`,
      `credential-shaped literal: ${path}:4 env-assignment`,
    ])
    expect(
      auditFindings(detected, {
        scope: 'test',
        allow: [{ path, rule: 'env-assignment', lines: [2, 4], reason: 'Synthetic example' }],
      }),
    ).toEqual([])
  })

  it.each(['github-token', 'posix-user-home'])('cannot allowlist a production source %s finding', (rule) => {
    const synthetic: SecretFinding = {
      path: 'packages/core/src/leak.ts',
      line: 1,
      rule,
    }
    expect(
      auditFindings([synthetic], {
        scope: 'test',
        allow: [
          {
            path: synthetic.path,
            rule: synthetic.rule,
            lines: [synthetic.line],
            reason: 'must not be accepted',
          },
        ],
      }),
    ).toContain(`packages/core/src/leak.ts ${rule}: production files cannot be allowlisted`)
  })

  it('exempts only untracked root scratch home paths, not credentials, nested names or tracked files', () => {
    const home: SecretFinding = {
      path: '.agnes-scratch/mcp-demo/server.mjs',
      line: 4,
      rule: 'posix-user-home',
    }
    expect(isUntrackedScratchMachinePath(home, new Set())).toBe(true)
    expect(isUntrackedScratchMachinePath({ ...home, rule: 'github-token' }, new Set())).toBe(false)
    expect(
      isUntrackedScratchMachinePath({ ...home, path: 'packages/core/.agnes-scratch/leak.ts' }, new Set()),
    ).toBe(false)
    expect(isUntrackedScratchMachinePath(home, new Set([home.path]))).toBe(false)
  })
})

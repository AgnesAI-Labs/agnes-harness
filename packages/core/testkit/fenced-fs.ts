import { win32 } from 'node:path'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import { decideFsPath, FS_DENIED, type FsPolicy, type FsRule } from '../src/effects/fs-guard.js'
import type { FsOps } from '../src/effects/tool-context.js'

/**
 * A policy fence around an in-memory FsOps, so a test double is not laxer than the file system it
 * stands in for. A double that enforced nothing would pass every case core writes about paths and
 * fail the moment it was assembled against a real host, which is the failure the fence exists to
 * keep out of the test suite.
 *
 * Lexical and nothing more. There are no symlinks and no case-insensitive volume behind a fake, so
 * this says nothing about either - the host adapter is where those are resolved and where they are
 * tested. The precedence rule is the shared one: decideFsPath, the same function the host's real
 * file system runs, so a test cannot certify a reading the deployment would not make.
 */
export function fencedFs(inner: FsOps, policy: FsPolicy): FsOps {
  const root = normalize(policy.workspaceRoot)
  const check = (path: string): string => {
    // Drive-relative paths depend on process state, which an in-memory fake cannot model.
    if (windowsAbsolute(root) && /^[A-Za-z]:(?![\\/])/.test(path))
      throw new Error(`${FS_DENIED}: drive-relative path`)
    const real = windowsAbsolute(root)
      ? normalize(win32.resolve(root, path))
      : normalize(path.startsWith('/') ? path : `${root}/${path}`)
    const decision = decideFsPath(policy, real, { caseSensitive: true })
    if (decision.effect !== 'allow') {
      const why = decision.reason === 'no-match' ? 'outside every allow rule' : 'denied by policy'
      throw new Error(`${FS_DENIED}: ${path} is ${why}`)
    }
    return real
  }
  // Every method is async, so a refusal arrives as a rejected promise exactly as it does from a
  // real file system. A synchronous throw would be a difference the doubles could hide behind.
  return {
    read: async (path, opts) => inner.read(check(path), opts),
    write: async (path, data) => inner.write(check(path), data),
    list: async (path) => inner.list(check(path)),
    stat: async (path) => inner.stat(check(path)),
  }
}

function windowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path)
}

function normalize(path: string): string {
  if (windowsAbsolute(path)) return win32.normalize(path).replaceAll('\\', '/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * Builds a valid FsPolicy for tests: the workspace allow, the host-integrity floor every real
 * binding is required to carry, and the caller's extra rules. `deny` entries are relative to the
 * root, `denyAbsolute` / `extraAllowAbsolute` are already absolute. The digest is a deterministic
 * 64-hex stand-in computed without crypto - a test policy's digest only has to be stable and
 * sensitive to rule changes, which FNV over the canonical rule list is.
 */
export function testFsPolicy(
  workspaceRoot: string,
  opts: {
    deny?: readonly string[]
    denyAbsolute?: readonly string[]
    extraAllowAbsolute?: readonly string[]
    rules?: readonly FsRule[]
    floor?: boolean
  } = {},
): FsPolicy {
  const root = normalize(workspaceRoot)
  const rules: FsRule[] = [{ effect: 'allow', path: root, source: 'workspace', hard: false }]
  const floorPaths = new Set([`${root}/.git`, ...WORKSPACE_SECRET_DIRS.map((dir) => `${root}/${dir}`)])
  for (const rel of opts.deny ?? []) {
    // A deny entry the floor already carries is not restated: two rules disagreeing about `hard`
    // at one canonical path is an invalid policy, and the floor's hard deny is the stronger one.
    if (floorPaths.has(`${root}/${rel}`)) continue
    rules.push({ effect: 'deny', path: `${root}/${rel}`, source: 'preset', hard: false })
  }
  for (const abs of opts.denyAbsolute ?? [])
    rules.push({ effect: 'deny', path: normalize(abs), source: 'preset', hard: false })
  for (const abs of opts.extraAllowAbsolute ?? [])
    rules.push({ effect: 'allow', path: normalize(abs), source: 'extra', hard: false })
  if (opts.floor !== false) {
    rules.push({ effect: 'deny', path: `${root}/.git`, source: 'host-integrity', hard: true })
    for (const dir of WORKSPACE_SECRET_DIRS)
      rules.push({ effect: 'deny', path: `${root}/${dir}`, source: 'host-integrity', hard: true })
  }
  rules.push(...(opts.rules ?? []))
  const digest = testDigest(rules)
  return { workspaceRoot: root, rules, networkAllow: [], digest }
}

function testDigest(rules: readonly FsRule[]): string {
  const canonical = rules
    .map((r) => [r.path.toLowerCase(), r.effect, r.hard, r.source].join(''))
    .sort()
    .join('\n')
  // FNV-1a, four offset bases, hex-joined: 64 hex chars, stable, and changes with any rule change.
  const hexes = [0x811c9dc5, 0x01000193, 0x811c9dc5 ^ 0x9e3779b9, 0x01000193 ^ 0x85ebca6b].map((basis) => {
    let h = basis >>> 0
    for (let i = 0; i < canonical.length; i++) {
      h ^= canonical.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0').repeat(2)
  })
  return hexes.join('')
}

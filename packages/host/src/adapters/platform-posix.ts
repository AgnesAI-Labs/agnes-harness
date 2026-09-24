import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Enforcement, PlatformSeam } from '@agnes/core'
import type { PlatformSnapshot } from '../profile/types.js'

export const CAPABILITY_IDS = [
  'sandbox.l1',
  'sandbox.network',
  'exec.kill-tree',
  'fs.symlink',
  'terminal.truecolor',
  'terminal.kitty-keys',
  'ipc',
] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]
export type CapabilityLevel = {
  level: 'full' | 'partial' | 'unavailable'
  scope: string[]
  reason?: string
  value?: string
}
export type SandboxBackendReport = Readonly<{
  name: 'none' | 'bwrap' | 'seatbelt' | 'remote'
  enforcement: Enforcement
}>
// `capability` is restated rather than inherited. An intersection with PlatformSeam keeps that
// method's own return type, which has no `value`, so the socket shape `ipc` reports would be
// invisible to every caller holding a PlatformBackend. CapabilityLevel only adds an optional field,
// so a backend is still a PlatformSeam — the assertion below is what keeps that true.
export type PlatformBackend = Omit<PlatformSeam, 'capability'> & {
  readonly os: 'darwin' | 'linux' | 'win32'
  capability(id: string): CapabilityLevel
  snapshot(): PlatformSnapshot
  probe(opts?: { root?: string }): Promise<void>
  /** Records the sandbox seam's actual full-boundary probe, never an executable-presence guess. */
  recordSandboxBackend(report: SandboxBackendReport): void
  killTree(pid: number): void
  matches(): boolean
}
// A backend is fitted into the platform seam at assembly, so it has to remain assignable to it.
type BackendIsASeam = PlatformBackend extends PlatformSeam ? true : never
export type PlatformBackendSatisfiesSeam = BackendIsASeam

/** One fresh table per backend. Nothing is claimed before it has been measured. */
export function unprobed(): Record<CapabilityId, CapabilityLevel> {
  const out = {} as Record<CapabilityId, CapabilityLevel>
  for (const id of CAPABILITY_IDS) out[id] = { level: 'unavailable', scope: [], reason: 'not probed' }
  return out
}
export function assertCapabilityId(id: string): asserts id is CapabilityId {
  if (!(CAPABILITY_IDS as readonly string[]).includes(id)) throw new Error(`unknown capability ${id}`)
}

// Case sensitivity is a property of a volume, not of a machine, so it is measured on the path the
// answer will be applied to. The measurement is read-only: entries inside the resolved root are
// respelled in the opposite case and stat-ed, which writes nothing into the caller's workspace and,
// unlike respelling a mount point, actually asks the mounted volume. A volume that resolves every
// respelling is treated as case-insensitive. No root, an empty root, an inaccessible root, or a
// directory whose entries are all case-paired gives no reliable signal and fails closed to false.
export function probeCaseSensitive(root?: string): boolean {
  if (root === undefined) return false
  let resolved: string
  let entries: string[]
  try {
    resolved = realpathSync(root)
    entries = readdirSync(resolved)
  } catch {
    return false
  }
  for (const name of entries) {
    const flipped = [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('')
    if (flipped === name) continue
    try {
      lstatSync(join(resolved, flipped))
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return true
      return false
    }
  }
  return false
}

export function createPosixPlatform(): PlatformBackend {
  // guards-allow-platform: this file is the one place a platform check belongs
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const caps = unprobed()
  // False, not true, and the difference is a leak. `fs.ts` folds when it is told the filesystem is
  // case-insensitive, so `true` is the answer that turns folding off — it is the fail-open value,
  // and it was being asserted before anything had been measured. `openAdapters` awaits `probe()`
  // first, so the assembled path was right, but `createPlatform()` hands back an unprobed backend
  // to anyone else, and `.GIT/config` reads straight through it. An unmeasured backend now claims
  // the safe answer instead of the convenient one.
  let caseSensitive = false
  return {
    os,
    // guards-allow-platform: the backend has to be able to say whether it is the right one
    matches: () => process.platform === 'darwin' || process.platform === 'linux',
    shell: () => 'posix',
    fs: () => ({ caseSensitive, pathSep: '/' }),
    terminal: () => ({
      color: process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY),
      ...(process.stdout.columns ? { width: process.stdout.columns } : {}),
    }),
    capability(id) {
      assertCapabilityId(id)
      return caps[id]
    },
    // guards-allow-platform: process.arch is the architecture half of the same snapshot
    snapshot: () => ({
      os,
      arch: process.arch,
      capabilities: Object.fromEntries(CAPABILITY_IDS.map((id) => [id, caps[id].level])),
    }),
    recordSandboxBackend(report) {
      // A remote backend is not a weaker local sandbox - it is another machine. This harness ships
      // commands there; it cannot attest to whatever isolation does or does not exist inside. Saying
      // 'full' would assert something unverified, so l1 is reported unavailable with the reason
      // spelled out, and callers decide what that is worth to them.
      if (report.name === 'remote') {
        caps['sandbox.l1'] = {
          level: 'unavailable',
          scope: [],
          reason: 'remote host boundary: isolation inside the remote host is not attested by this harness',
        }
        return
      }
      const scope = new Set(report.enforcement.scope)
      const processBoundary = scope.has('file') && scope.has('process')
      caps['sandbox.l1'] =
        report.name !== 'none' && report.enforcement.level !== 'none' && processBoundary
          ? {
              level: report.enforcement.level,
              scope: ['file', 'process'],
              value: report.name,
              ...(report.enforcement.level === 'partial'
                ? { reason: 'runtime probe proved only partial file/process confinement' }
                : {}),
            }
          : {
              level: 'unavailable',
              scope: [],
              reason: 'no runnable OS sandbox backend passed its full-boundary probe',
            }
      caps['sandbox.network'] =
        report.name !== 'none' && report.enforcement.level !== 'none' && scope.has('network')
          ? {
              level: report.enforcement.level,
              scope: ['network'],
              value: report.name,
              ...(report.enforcement.level === 'partial'
                ? { reason: 'runtime probe proved only partial network confinement' }
                : {}),
            }
          : {
              level: 'unavailable',
              scope: [],
              reason: 'the selected sandbox backend did not prove a network boundary',
            }
    },
    killTree(pid) {
      // `process.kill(0, ...)` targets the caller's whole process group. This method is exported as
      // part of PlatformBackend, so do not rely on createExec being the only caller that always
      // supplies a positive ChildProcess.pid.
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    },
    async probe(opts) {
      caseSensitive = probeCaseSensitive(opts?.root)
      caps['fs.symlink'] = { level: 'full', scope: ['file'] }
      caps['exec.kill-tree'] = { level: 'full', scope: ['process'] }
      // The sandbox seam owns the revocable raw-exec probe because it also owns the exact compiler
      // argv. Until that complete boundary runs, executable presence proves nothing: bwrap may be
      // blocked by user-namespace policy and sandbox-exec may reject the generated profile.
      caps['sandbox.l1'] = {
        level: 'unavailable',
        scope: [],
        reason: 'awaiting sandbox backend full-boundary probe',
      }
      caps['sandbox.network'] = {
        level: 'unavailable',
        scope: [],
        reason: 'awaiting sandbox backend full-boundary probe',
      }
      caps['terminal.truecolor'] =
        process.env.COLORTERM === 'truecolor'
          ? { level: 'full', scope: [] }
          : { level: 'partial', scope: [], reason: '16-color fallback' }
      caps['terminal.kitty-keys'] = {
        level: 'unavailable',
        scope: [],
        reason: 'negotiated at TUI start',
      }
      // The daemon picks its socket shape from here rather than from a platform check of its own.
      caps.ipc = { level: 'full', scope: ['socket'], value: 'unix' }
    },
  }
}

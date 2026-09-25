import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { decideFsPath, FS_DENIED, type FsPolicy } from '@agnes/core'
import type { FsEntry, FsStat } from '@agnes/extension-api'
import type { FsIo } from './fs-io.js'
import { localFsIo } from './fs-io-local.js'

/** The consumption contract the seam packages are written against. */
export type HostFs = {
  realpath(p: string): Promise<string>
  read(p: string, opts?: { offset?: number; limit?: number }): Promise<Uint8Array>
  write(p: string, data: Uint8Array): Promise<void>
  stat(p: string): Promise<FsStat>
  list(p: string): Promise<FsEntry[]>
  mkdir(p: string): Promise<void>
  rm(p: string, opts?: { recursive?: boolean }): Promise<void>
}

/**
 * What the fence is enforcing right now: the full sandbox policy - allow roots beyond the
 * workspace, the data directory's narrow exceptions, the hard denies - and the case semantics of
 * the volume it runs on. Re-read on every call; nothing here is cached. The digest on the policy
 * is the identity the host pinned when it bound the seam's policy; it is how a caller verifies
 * the fence is still the policy the seam declared.
 */
export type FsBinding = { policy: FsPolicy; caseSensitive: boolean }

/** The fenced handle: HostFs plus what session assembly and the sandbox seam ask the fence directly. */
export type FencedFs = HostFs & {
  resolveInside(path: string): Promise<string>
  /** Symlink resolution only - no policy decision. What the sandbox seam's compiler and session open ask for. */
  canonicalize(path: string, opts?: { base?: string }): Promise<string>
  fence(): FsPolicy
}

const refuse = (requested: string, why: string): never => {
  throw Object.assign(new Error(`${FS_DENIED}: ${requested} ${why}`), { code: FS_DENIED })
}

const usable = (p: unknown): void => {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) refuse(String(p), 'is not a usable path')
}

// `Buffer.toString('utf8')` - what the windowed read used before the io split - keeps a leading
// BOM. The default `TextDecoder` strips it, which would silently change the bytes a windowed read
// returns; `ignoreBOM: true` keeps the old behaviour instead of stripping it.
const windowDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * Resolves every symlink component, including a final dangling symlink.
 *
 * A stat that follows links reports a dangling link as absent. Treating that spelling as an
 * ordinary missing leaf authorises the lexical path inside an allow root, after which the write
 * follows the link and creates its target outside. Walking with lstat keeps the link itself
 * observable; its target is then resolved even when the target does not exist yet.
 *
 * This is called at operation time, never cached: a directory traded for a symlink after the
 * policy was compiled resolves to where it points now, not where it pointed then. L0 makes no
 * RESOLVE_BENEATH promise about a hostile process racing the check - that is what the L1 OS
 * backend is for.
 *
 * Where the io reports final paths, the link-free prefix the walk reached is respelled by it, so a
 * short-name alias of a directory decides exactly as its long name does, and a root pinned in one
 * spelling still contains a path asked for in the other.
 */
async function canonicalize(io: FsIo, abs: string, requested: string = abs): Promise<string> {
  const seen = new Set<string>()
  const settle = async (prefix: string, rest: readonly string[]): Promise<string> => {
    const real = io.finalPath ? await io.finalPath(prefix) : prefix
    return rest.length === 0 ? real : resolve(real, ...rest)
  }
  const walk = async (candidate: string): Promise<string> => {
    const normalized = resolve(candidate)
    const volumeRoot = parse(normalized).root
    const parts = normalized.slice(volumeRoot.length).split(sep).filter(Boolean)
    let current = volumeRoot
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index] as string
      const next = join(current, part)
      // The io answers undefined for both ENOENT and ENOTDIR: the policy then decides on the
      // deepest real prefix plus the unresolved remainder.
      const stat = await io.lstat(next)
      if (stat === undefined) return settle(current, parts.slice(index))
      if (stat.kind !== 'symlink') {
        current = next
        continue
      }
      if (seen.has(next)) refuse(requested, 'contains a symlink cycle')
      seen.add(next)
      const target = await io.readlink(next)
      const targetPath = isAbsolute(target) ? target : resolve(dirname(next), target)
      return walk(resolve(targetPath, ...parts.slice(index + 1)))
    }
    return settle(current, [])
  }
  return walk(abs)
}

/** A one-rule policy, so segment matching and case folding stay the one rule decideFsPath states. */
const overlay = (root: string): FsPolicy => ({
  workspaceRoot: root,
  rules: [{ effect: 'allow', path: root, source: 'extra', hard: false }],
  networkAllow: [],
  digest: '',
})

const missing = (requested: string): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory, lstat '${requested}'`), { code: 'ENOENT' })

/**
 * `readRoots` names directories outside the policy that read, list and stat may still reach - the
 * real directories of the Skills a session can use. It never widens a write, never overrides a
 * rule that matched (a deny, hard or not, still refuses), and is asked on every call so a Skill
 * that stops being usable closes at once. The policy and its digest are untouched.
 */
export function createFs(
  binding: () => FsBinding,
  io: FsIo = localFsIo,
  readRoots?: () => readonly string[],
): FencedFs {
  /**
   * The one choke point every method goes through: resolve the caller's spelling against the
   * workspace root, canonicalize it against the live filesystem, and apply the bound policy to the
   * canonical name. The decision is segment-wise, not a string prefix - `/work/a` does not contain
   * `/work/ab` - and case folds only where the volume does. Nothing is authorised at init; this
   * runs again on every operation.
   */
  async function authorize(p: string): Promise<{ real: string; abs: string }> {
    const { policy, caseSensitive } = binding()
    usable(p)
    const abs = isAbsolute(p) ? p : resolve(policy.workspaceRoot, p)
    const real = await canonicalize(io, abs, p)
    const decision = decideFsPath(policy, real, { caseSensitive })
    if (decision.effect !== 'allow')
      refuse(p, decision.reason === 'no-match' ? 'is outside every allow rule' : 'is denied by policy')
    return { real, abs }
  }

  // A read that matched no rule may still land inside a Skill directory. A root that is the
  // workspace or above it is ignored: it would turn the overlay into a way around the policy.
  async function authorizeRead(p: string): Promise<{ real: string; abs: string }> {
    if (!readRoots) return authorize(p)
    usable(p)
    try {
      return await authorize(p)
    } catch (err) {
      const { policy, caseSensitive } = binding()
      const abs = isAbsolute(p) ? p : resolve(policy.workspaceRoot, p)
      const real = await canonicalize(io, abs, p)
      if (decideFsPath(policy, real, { caseSensitive }).reason !== 'no-match') throw err
      const inside = (outer: string, inner: string): boolean =>
        decideFsPath(overlay(outer), inner, { caseSensitive }).effect === 'allow'
      // Each root is canonicalized the way the path was, so both are compared in one spelling; a
      // root that cannot be canonicalized opens nothing.
      const roots = await Promise.all(
        readRoots().map((root) => canonicalize(io, resolve(root)).catch(() => undefined)),
      )
      const open = roots.some(
        (root) => root !== undefined && !inside(root, policy.workspaceRoot) && inside(root, real),
      )
      if (!open) throw err
      return { real, abs }
    }
  }

  // Kept under the old name: it is how session assembly asks "is this cwd inside the fence".
  async function resolveInside(p: string): Promise<string> {
    return (await authorize(p)).real
  }

  return {
    resolveInside,
    async canonicalize(p, opts) {
      usable(p)
      const abs = isAbsolute(p) ? p : resolve(opts?.base ?? binding().policy.workspaceRoot, p)
      return canonicalize(io, abs, p)
    },
    // The policy this handle is enforcing right now, readable from outside - including its digest,
    // which is what a session re-checks the sandbox seam's answer against. A floor that cannot be
    // read is a floor nothing can be held to.
    fence: () => binding().policy,
    async realpath(p) {
      return resolveInside(p)
    },
    async read(p, opts = {}) {
      const buf = await io.readFile((await authorizeRead(p)).real)
      if (opts.offset === undefined && opts.limit === undefined) return new Uint8Array(buf)
      const lines = windowDecoder.decode(buf).split(/(?<=\n)/)
      const start = Math.max((opts.offset ?? 1) - 1, 0)
      return new TextEncoder().encode(
        lines.slice(start, opts.limit === undefined ? undefined : start + opts.limit).join(''),
      )
    },
    async write(p, data) {
      const { real } = await authorize(p)
      await io.mkdir(dirname(real))
      await io.writeFile(real, data)
    },
    async list(p) {
      const ents = await io.readdir((await authorizeRead(p)).real)
      return ents.map((e) => ({ name: e.name, kind: e.kind }))
    },
    // Describes the name that was asked about, not what it points at. list() reports a symlink as a
    // symlink, and a caller that lists a directory and stats each entry has to get the same answer
    // from both - statting the resolved target can only ever say `file` or `dir`, so the two never
    // agreed. The fence still runs on the whole path first, so a name resolving outside every allow
    // root is refused here exactly as it is on the read path; only the final component is then
    // stat'ed unresolved.
    async stat(p) {
      const { abs } = await authorizeRead(p)
      const named = join(await canonicalize(io, dirname(abs), p), basename(abs))
      const st = await io.lstat(named)
      if (st === undefined) throw missing(p)
      return { kind: st.kind, size: st.size, mtimeMs: st.mtimeMs }
    },
    async mkdir(p) {
      const { real } = await authorize(p)
      await io.mkdir(real)
    },
    async rm(p, opts = {}) {
      // Removing is answered twice: the target, and the resolved parent it is removed from. A
      // policy that allows a leaf but not its directory is not a licence to unlink there.
      const { real } = await authorize(p)
      const { policy, caseSensitive } = binding()
      if (decideFsPath(policy, dirname(real), { caseSensitive }).effect !== 'allow')
        refuse(p, 'is denied by policy at its parent')
      await io.rm(real, { recursive: opts.recursive ?? false })
    },
  }
}

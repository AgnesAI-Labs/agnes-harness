import type { ApprovalAnswer, ApprovalRequest, PlatformSeam, Verdict } from '@agnes/core'
import type { PersistenceMetadataNamespace } from '@agnes/extension-api'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import type {
  HostExecResult,
  HostFs,
  Prompter,
  SandboxBackendReport,
  SandboxGateState,
  SeamInitContext,
  TableHandle,
} from '../src/seam-init.js'
import { MemTable } from './mem-table.js'

/**
 * The assembly context a seam is handed, built in memory. What it is for is letting a seam be
 * tested without a host; what it has to avoid is being *easier* than the host, because a seam that
 * only works against a lenient fake is a seam that throws the first time it is assembled.
 *
 * The two places that matters here:
 *   - `fs` and `dataFs` are fenced, at workspaceRoot and dataDir respectively, and refuse a path
 *     outside their root with the same `E_FS_DENIED` prefix the host adapter uses. A seam that
 *     reaches for dataDir through `fs` fails here as it would there.
 *   - the storage handles for one context share one table registry, as one owner's handles share
 *     one SQLite connection, so a statement naming a table another handle created works here too.
 *
 * The fences are lexical and nothing more. There are no symlinks in a Map of paths, so nothing
 * here says anything about whether the host's fence survives one - it does not, and closing that
 * needs realpath in the fs seam.
 */

type MemTables = ConstructorParameters<typeof MemTable>[1]

export type FakeSeamInit = SeamInitContext & {
  /** One entry per name asked of `storage.table`, all sharing one registry. */
  tables: Map<string, MemTable>
  /** One entry per name asked of `storage.namespace`; the same name returns the same namespace. */
  namespaces: Map<string, MemNamespace>
  /** Every argv passed to `adapters.exec`, in order. */
  execCalls: string[][]
  /** The opts each exec call carried, parallel to execCalls. */
  execOpts: Array<Record<string, unknown>>
  /** The workspace file contents, keyed by absolute path. */
  mem: Map<string, Uint8Array>
  /** The dataDir file contents, keyed by absolute path. */
  data: Map<string, Uint8Array>
}

export type FakeSeamInitOpts = {
  files?: Record<string, string | Uint8Array>
  prompter?: (req: ApprovalRequest, opts: { signal: AbortSignal }) => Promise<Verdict | ApprovalAnswer>
  platform?: Partial<PlatformSeam>
  preset?: Record<string, unknown>
  limits?: Record<string, number>
  workspaceRoot?: string
  dataDir?: string
  homeDir?: string
  profileName?: string
  resolvedProfileHash?: string | null
  secrets?: Record<string, string>
  exec?: (cmd: string[]) => Partial<HostExecResult>
}

const enc = new TextEncoder()
const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'

/**
 * A file system over a Map, fenced at `root`. Containment is decided on the normalized path and
 * nothing else: `..` segments are resolved first so `root/../etc/passwd` is refused rather than
 * stored under a key that merely looks contained.
 */
function memFs(root: string, files: Map<string, Uint8Array>, denyPaths: string[]): HostFs {
  const dirs = new Set<string>([root])
  const resolveInside = (p: string): string => {
    const abs = p.startsWith('/') ? p : `${root}/${p}`
    const parts: string[] = []
    for (const seg of abs.split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    const real = `/${parts.join('/')}`
    if (real !== root && !real.startsWith(`${root}/`)) throw new Error(`E_FS_DENIED: ${p} is outside ${root}`)
    const rel = real.slice(root.length + 1)
    for (const d of denyPaths)
      if (rel === d || rel.startsWith(`${d}/`)) throw new Error(`E_FS_DENIED: ${p} matches deny path ${d}`)
    return real
  }
  return {
    async realpath(p) {
      return resolveInside(p)
    },
    async read(p, opts) {
      const real = resolveInside(p)
      const b = files.get(real)
      if (!b) throw enoent(p)
      if (!opts || (opts.offset === undefined && opts.limit === undefined)) return b
      const lines = new TextDecoder().decode(b).split(/(?<=\n)/)
      const start = Math.max((opts.offset ?? 1) - 1, 0)
      return enc.encode(
        lines.slice(start, opts.limit === undefined ? undefined : start + opts.limit).join(''),
      )
    },
    async write(p, data) {
      const real = resolveInside(p)
      files.set(real, data)
      for (let d = parentOf(real); d.startsWith(root); d = parentOf(d)) dirs.add(d)
    },
    async stat(p) {
      const real = resolveInside(p)
      const b = files.get(real)
      if (b) return { kind: 'file', size: b.byteLength, mtimeMs: 0 }
      if (dirs.has(real) || [...files.keys()].some((k) => k.startsWith(`${real}/`)))
        return { kind: 'dir', size: 0, mtimeMs: 0 }
      throw enoent(p)
    },
    async list(p) {
      const real = resolveInside(p)
      const names = new Map<string, 'file' | 'dir'>()
      for (const k of files.keys()) {
        if (!k.startsWith(`${real}/`)) continue
        const rest = k.slice(real.length + 1)
        const head = rest.split('/')[0] as string
        names.set(head, rest.includes('/') ? 'dir' : 'file')
      }
      return [...names].map(([name, kind]) => ({ name, kind }))
    },
    async mkdir(p) {
      const real = resolveInside(p)
      for (let d = real; d.startsWith(root); d = parentOf(d)) dirs.add(d)
    },
    async rm(p, opts) {
      const real = resolveInside(p)
      if (files.delete(real)) return
      if (opts?.recursive !== true) {
        if (dirs.has(real) || [...files.keys()].some((k) => k.startsWith(`${real}/`)))
          throw Object.assign(new Error(`EISDIR: ${p}`), { code: 'EISDIR' })
        throw enoent(p)
      }
      for (const k of [...files.keys()]) if (k.startsWith(`${real}/`)) files.delete(k)
      for (const d of [...dirs]) if (d === real || d.startsWith(`${real}/`)) dirs.delete(d)
    },
  }
}

export function fakeSeamInit(opts: FakeSeamInitOpts = {}): FakeSeamInit {
  const workspaceRoot = opts.workspaceRoot ?? '/work/proj'
  const dataDir = opts.dataDir ?? '/home/u/.agh'
  const mem = new Map<string, Uint8Array>(
    Object.entries(opts.files ?? {}).map(([k, v]) => [
      k.startsWith('/') ? k : `${workspaceRoot}/${k}`,
      typeof v === 'string' ? enc.encode(v) : v,
    ]),
  )
  const data = new Map<string, Uint8Array>()
  // The same two deny lists the host installs: the workspace hides the git directory and the
  // secret store, and the data directory hides the host's own files from the seams that live in it.
  const fs = memFs(workspaceRoot, mem, ['.git', ...WORKSPACE_SECRET_DIRS])
  const dataFs = memFs(dataDir, data, ['secrets', 'tables', 'audit', 'sessions.db'])

  const registry: MemTables = new Map()
  const tables = new Map<string, MemTable>()
  const namespaces = new Map<string, MemNamespace>()
  const execCalls: string[][] = []
  const execOpts: Array<Record<string, unknown>> = []
  const platform: PlatformSeam = {
    shell: () => 'posix',
    fs: () => ({ caseSensitive: true, pathSep: '/' }),
    terminal: () => ({ color: false }),
    capability: () => ({ level: 'unavailable', scope: [], reason: 'fakeSeamInit probes nothing' }),
    ...opts.platform,
  }
  const prompter: Prompter | undefined = opts.prompter ? { ask: opts.prompter } : undefined
  const secrets = (ref: string): string => {
    const v = opts.secrets?.[ref]
    if (v === undefined) throw new Error(`no secret ${ref} in fakeSeamInit`)
    return v
  }
  return {
    secrets,
    adapters: {
      fs,
      dataFs,
      platform,
      async exec(argv, execOptions) {
        execCalls.push(argv)
        execOpts.push({ ...execOptions })
        return { code: 0, stdout: '', stderr: '', truncated: false, timedOut: false, ...opts.exec?.(argv) }
      },
      storage: {
        table(name: string): TableHandle {
          let t = tables.get(name)
          if (!t) {
            t = new MemTable(name, registry)
            tables.set(name, t)
          }
          return t
        },
        namespace(name: string): MemNamespace {
          let ns = namespaces.get(name)
          if (!ns) {
            ns = new MemNamespace()
            namespaces.set(name, ns)
          }
          return ns
        },
      },
      ...(prompter ? { prompter } : {}),
    },
    profile: {
      name: opts.profileName ?? 'local-dev',
      resolvedProfileHash: opts.resolvedProfileHash ?? null,
      dataDir,
      workspaceRoot,
      homeDir: opts.homeDir ?? '/home/u',
      limits: opts.limits ?? {},
      preset: opts.preset ?? {},
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    tables,
    namespaces,
    execCalls,
    execOpts,
    mem,
    data,
  }
}

/**
 * Owner-scoped metadata in memory. It keeps the host's JSON round trip, so a value that would not
 * survive the SQLite metadata store does not survive here either, and reads are detached copies.
 */
export class MemNamespace implements PersistenceMetadataNamespace {
  /** JSON text by key. */
  readonly data = new Map<string, string>()

  get(key: string): unknown | undefined {
    const json = this.data.get(key)
    return json === undefined ? undefined : JSON.parse(json)
  }

  set(key: string, value: unknown): void {
    const json = JSON.stringify(value)
    if (json === undefined) throw new TypeError('metadata value must be JSON serializable')
    this.data.set(key, json)
  }

  delete(key: string): void {
    this.data.delete(key)
  }

  entries(): readonly Readonly<{ key: string; value: unknown }>[] {
    return [...this.data.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => ({ key, value: this.get(key) }))
  }

  transaction<T>(fn: () => T): T {
    const snapshot = new Map(this.data)
    try {
      const result = fn()
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new TypeError('metadata transaction callback must be synchronous')
      return result
    } catch (error) {
      this.data.clear()
      for (const [key, value] of snapshot) this.data.set(key, value)
      throw error
    }
  }
}

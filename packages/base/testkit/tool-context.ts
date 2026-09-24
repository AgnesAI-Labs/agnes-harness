import { createHash } from 'node:crypto'
import type {
  ArtifactRef,
  ExecResult,
  FsEntry,
  PlanItem,
  ToolContext,
  ToolResult,
} from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'

// An in-memory stand-in for the context the kernel hands a tool. Everything a tool is allowed to
// touch either goes into `mem` (the file system) or is recorded in `calls` (every outward effect),
// so a test asserts on what the tool *did*, not only on what it returned. Methods no tool under
// test should reach for reject with a named error instead of quietly returning a plausible value —
// a tool that starts using one fails loudly rather than silently passing.

export type MemFs = { files: Map<string, Uint8Array> }

export type ExecOpts = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
export type ExecFn = (
  cmd: string[],
  opts: ExecOpts,
) => { code: number; stdout: string; stderr: string; truncated?: boolean }

export type FakeCalls = {
  exec: string[][]
  read: { path: string; opts: { offset?: number; limit?: number } | undefined }[]
  execOpts: ExecOpts[]
  artifacts: { bytes: Uint8Array; mime: string | undefined; name: string | undefined }[]
  jobs: JsonValue[]
  plan: PlanItem[][]
  invoke: { name: string; args: JsonValue }[]
  confine: string[][]
}

export type FakeToolContext = ToolContext & { mem: MemFs; calls: FakeCalls }

export type FakeToolContextOpts = {
  cwd?: string
  files?: Record<string, string | Uint8Array>
  exec?: ExecFn
  invoke?: (name: string, args: JsonValue) => Promise<ToolResult>
  timeoutMs?: number
  /** Makes `artifacts.put` fail, which is how a tool's behaviour with no artifact store is tested. */
  artifactsFail?: string
  /**
   * Failures `fs.read` raises for a given path, keyed the same way `files` is. A memory filesystem
   * can only ever produce ENOENT, so without this the branches a tool takes for a permission error,
   * a directory, or a sandbox refusal are unreachable from a test - and those are branches only a
   * real user walks.
   */
  readErrors?: Record<string, { code?: string; message?: string }>
  /** The same, for `fs.list`: a directory a listing tool is refused rather than handed. */
  listErrors?: Record<string, { code?: string; message?: string }>
  /**
   * Directory entries `fs.list` reports in addition to the ones derived from `files`, keyed by
   * directory path. The derived ones can only be files and directories, so a symlink or a socket -
   * the kinds a listing tool has to be able to show - has no other way into a test.
   */
  entries?: Record<string, FsEntry[]>
}

const enc = new TextEncoder()

function notSupported(what: string): () => Promise<never> {
  return () => Promise.reject(new Error(`not supported in fakeToolContext: ${what}`))
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
}

export function fakeToolContext(opts: FakeToolContextOpts = {}): FakeToolContext {
  const cwd = opts.cwd ?? '/work/proj'
  const abs = (p: string): string => (p.startsWith('/') ? p : `${cwd}/${p}`)
  const mem: MemFs = {
    files: new Map(
      Object.entries(opts.files ?? {}).map(([k, v]) => [abs(k), typeof v === 'string' ? enc.encode(v) : v]),
    ),
  }
  const calls: FakeCalls = {
    exec: [],
    read: [],
    execOpts: [],
    artifacts: [],
    jobs: [],
    plan: [],
    invoke: [],
    confine: [],
  }
  const runExec: ExecFn = opts.exec ?? (() => ({ code: 0, stdout: '', stderr: '' }))
  const readErrors = new Map(Object.entries(opts.readErrors ?? {}).map(([k, v]) => [abs(k), v]))
  const listErrors = new Map(Object.entries(opts.listErrors ?? {}).map(([k, v]) => [abs(k), v]))
  const extraEntries = new Map(Object.entries(opts.entries ?? {}).map(([k, v]) => [abs(k), v]))

  const ctx: ToolContext = {
    projections: unavailableProjections,
    session: {
      key: 'agnes:t:a:cli:dm:x',
      lane: 'main',
      workspaceRoot: cwd,
      turn: 1,
      step: 1,
      toolUseId: 'tu-1',
      depth: 0,
      generationDepth: 0,
    },
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    cwd,
    async exec(cmd: string[], o: ExecOpts = {}): Promise<ExecResult> {
      calls.exec.push(cmd)
      calls.execOpts.push(o)
      return { truncated: false, ...runExec(cmd, o) }
    },
    fs: {
      async read(p: string, o?: { offset?: number; limit?: number }): Promise<Uint8Array> {
        calls.read.push({ path: p, opts: o })
        const fail = readErrors.get(abs(p))
        if (fail) throw Object.assign(new Error(fail.message ?? 'read failed'), { code: fail.code })
        const b = mem.files.get(abs(p))
        if (!b) throw enoent(p)
        if (!o) return b
        const from = o.offset ?? 0
        return b.subarray(from, o.limit === undefined ? undefined : from + o.limit)
      },
      async write(p: string, data: Uint8Array | string): Promise<void> {
        mem.files.set(abs(p), typeof data === 'string' ? enc.encode(data) : data)
      },
      async list(p: string) {
        const dir = abs(p).replace(/\/$/, '')
        const listFail = listErrors.get(dir)
        if (listFail)
          throw Object.assign(new Error(listFail.message ?? 'list failed'), { code: listFail.code })
        const names = new Map<string, 'file' | 'dir'>()
        for (const k of mem.files.keys()) {
          if (!k.startsWith(`${dir}/`)) continue
          const rest = k.slice(dir.length + 1)
          const head = rest.split('/')[0] as string
          names.set(head, rest.includes('/') ? 'dir' : 'file')
        }
        const out: FsEntry[] = [...names].map(([name, kind]) => ({ name, kind }))
        return [...out, ...(extraEntries.get(dir) ?? [])]
      },
      async stat(p: string) {
        const b = mem.files.get(abs(p))
        if (b) return { kind: 'file' as const, size: b.byteLength, mtimeMs: 0 }
        const prefix = `${abs(p).replace(/\/$/, '')}/`
        if ([...mem.files.keys()].some((k) => k.startsWith(prefix)))
          return { kind: 'dir' as const, size: 0, mtimeMs: 0 }
        throw enoent(p)
      },
    },
    net: { fetch: notSupported('net.fetch') },
    sandbox: {
      async confine(argv: string[]): Promise<string[]> {
        calls.confine.push(argv)
        return argv
      },
      // The fake is unconfined and says so; a tool asserting on this value is asserting on the fake.
      enforcement: () => ({ level: 'none', scope: [] }),
    },
    // Fixed facts: base extension tests are never about the platform, and a tool that branches on
    // it should say so by overriding here rather than reading the host's real backend.
    platform: {
      shell: 'posix',
      fs: { caseSensitive: true, pathSep: '/' },
      terminal: { color: false },
      capability: () => ({ level: 'full', scope: [] }),
    },
    async authorize(): Promise<import('@agnes/protocol').Decision> {
      return { decisionId: 'fake', effect: 'allow', reason: 'fakeToolContext allows everything' }
    },
    tools: {
      async invoke(name: string, args: JsonValue): Promise<ToolResult> {
        calls.invoke.push({ name, args })
        if (!opts.invoke) throw new Error('not supported in fakeToolContext: tools.invoke')
        return opts.invoke(name, args)
      },
      list: () => [],
    },
    artifacts: {
      async put(bytes: Uint8Array, meta?: { mime?: string; name?: string }): Promise<ArtifactRef> {
        if (opts.artifactsFail !== undefined) throw new Error(opts.artifactsFail)
        calls.artifacts.push({ bytes, mime: meta?.mime, name: meta?.name })
        return {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
          mime: meta?.mime ?? 'application/octet-stream',
        }
      },
      get: notSupported('artifacts.get'),
      async submitJob(spec: JsonValue): Promise<string> {
        calls.jobs.push(spec)
        return `job-${calls.jobs.length}`
      },
      poll: notSupported('artifacts.poll'),
      cancel: notSupported('artifacts.cancel'),
    },
    subagent: {
      fork: notSupported('subagent.fork'),
      spawn: notSupported('subagent.spawn'),
      collect: notSupported('subagent.collect'),
      cancel: notSupported('subagent.cancel'),
      resume: notSupported('subagent.resume'),
    },
    plan: {
      async set(items: PlanItem[]): Promise<number> {
        calls.plan.push(items)
        return calls.plan.length
      },
    },
    requestCompaction: () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    timeoutMs: opts.timeoutMs ?? 120000,
    lease: { expiresAt: '2999-01-01T00:00:00Z', scope: {}, budget: { remaining: 1e9 } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return Object.assign(ctx, { mem, calls })
}

import { delimiter, relative, resolve } from 'node:path'
import type { ToolContext } from '@agnes/extension-api'
import { normalizeWorkspacePath } from '../../tools-core/src/paths.js'
import { LspClient } from './client.js'
import { DEFAULTS, type LspConfig } from './config.js'
import { serverEnv } from './env.js'
import { type FileReport, formatAuto } from './format.js'
import { launchArgv, resolveBinary, safeEntries } from './resolve.js'
import { findRoot, type ServerDef, serverFor } from './servers.js'

/** What the registry reads from a tool context. It is used inside the call and never kept. */
type Ctx = Pick<ToolContext, 'sandbox' | 'fs' | 'session' | 'cwd' | 'signal' | 'outputMaxBytes'>

type Entry = {
  key: string
  owner: string
  def: ServerDef
  root: string
  client?: LspClient
  starting?: Promise<void>
  busy: number
  last: number
  idle?: ReturnType<typeof setTimeout>
  closing: boolean
}

const ownerOf = (ctx: Pick<Ctx, 'session'>) => `${ctx.session.key}\0${ctx.session.lane}`
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Language servers for every session of one worker. Each server runs in the session's sandbox (the
 * Host's policy differs per session, so none is shared) and is owned by the session, not by the call
 * that started it. Inactive until the lsp extension applies, so a preset without it starts nothing.
 */
export class LspSessions {
  private cfg: LspConfig = { ...DEFAULTS }
  private active = false
  private readonly entries = new Map<string, Entry>()
  private readonly failed = new Map<string, { until: number; reason: string }>()
  // Next command to try per server, kept when a start is cut short by the end of the call that began it.
  private readonly nextCommand = new Map<string, number>()

  get isActive(): boolean {
    return this.active
  }

  configure(config: Partial<LspConfig> = {}): void {
    this.cfg = { ...DEFAULTS, ...config }
    this.active = this.cfg.enabled
    if (!this.active) void this.dispose()
  }

  /** Text for a write/edit result, or undefined: inactive, cold server, timeout, no errors, anything wrong. */
  async diagnosticsFor(ctx: Ctx, abs: string, text: string): Promise<string | undefined> {
    if (!this.active || !this.cfg.autoAttach) return undefined
    if (ctx.session.generationDepth > 0 && !this.cfg.autoAttachInChildren) return undefined
    try {
      const target = serverFor(abs)
      const got = target && (await this.acquire(ctx, abs, target.def))
      // A server still starting is not waited for: the next edit finds it ready.
      if (!got || 'reason' in got || !got.entry.client) return undefined
      const diags = await this.run(got.entry, (client) =>
        client.diagnostics(abs, target.languageId, text, this.cfg.autoWaitMs),
      )
      return diags && formatAuto(this.display(ctx, abs), diags, ctx.outputMaxBytes)
    } catch {
      return undefined
    }
  }

  /** The `lsp_diagnostics` path: reads each file through the context's fence and waits longer. */
  async check(ctx: Ctx, paths: readonly string[]): Promise<FileReport[]> {
    return Promise.all(paths.map((path) => this.checkOne(ctx, path)))
  }

  async closeSession(key: string, lane: string): Promise<void> {
    const owner = `${key}\0${lane}`
    await Promise.all([...this.entries.values()].filter((e) => e.owner === owner).map((e) => this.close(e)))
  }

  async dispose(): Promise<void> {
    this.active = false
    await Promise.all([...this.entries.values()].map((e) => this.close(e)))
  }

  private display(ctx: Ctx, abs: string): string {
    const rel = relative(ctx.session.workspaceRoot, abs)
    return rel.startsWith('..') ? abs : rel
  }

  private async checkOne(ctx: Ctx, input: string): Promise<FileReport> {
    const abs = normalizeWorkspacePath(input, ctx.cwd).abs
    const path = this.display(ctx, abs)
    const target = serverFor(abs)
    if (!target) return { path, note: 'no language server is built in for this file type' }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await ctx.fs.read(abs, { limit: 4 * 1024 * 1024 }),
      )
    } catch (e) {
      return { path, note: `cannot read the file: ${errorText(e)}` }
    }
    const got = await this.acquire(ctx, abs, target.def)
    if ('reason' in got) return { path, note: got.reason }
    const { entry } = got
    if (!entry.client && entry.starting)
      await Promise.race([
        entry.starting,
        new Promise((done) => setTimeout(done, this.cfg.toolStartMs).unref?.()),
      ])
    if (!entry.client) {
      const bad = this.failed.get(entry.key)
      return {
        path,
        note:
          bad && bad.until > Date.now()
            ? bad.reason
            : 'the language server is still starting; try again shortly',
      }
    }
    try {
      const diags = await this.run(entry, (client) =>
        client.diagnostics(abs, target.languageId, text, this.cfg.toolWaitMs),
      )
      return diags ? { path, diags } : { path, note: 'the language server did not answer in time; try again' }
    } catch (e) {
      return { path, note: `language server error: ${errorText(e)}` }
    }
  }

  private async acquire(
    ctx: Ctx,
    abs: string,
    def: ServerDef,
  ): Promise<{ entry: Entry } | { reason: string }> {
    if (!ctx.sandbox.openProcess)
      return { reason: 'language servers need a local sandbox, and this session has none' }
    const root = await findRoot(
      (p) =>
        ctx.fs.stat(p).then(
          () => true,
          () => false,
        ),
      abs,
      resolve(ctx.session.workspaceRoot),
      def,
    )
    if (!root)
      return { reason: `the ${def.id} server does not apply here (an excluding project marker was found)` }
    const owner = ownerOf(ctx)
    const key = `${owner}\0${def.id}\0${root}`
    const bad = this.failed.get(key)
    if (bad && bad.until > Date.now()) return { reason: bad.reason }
    let entry = this.entries.get(key)
    if (!entry) {
      if (!this.makeRoom(owner)) return { reason: 'too many language servers are running; try again later' }
      entry = { key, owner, def, root, busy: 0, last: Date.now(), closing: false }
      this.entries.set(key, entry)
      entry.starting = this.launch(ctx, entry)
    }
    return { entry }
  }

  // Closes the least recently used idle server of a full scope; false when all are busy or starting.
  private makeRoom(owner: string): boolean {
    for (const [scope, cap] of [
      [owner, this.cfg.maxPerSession],
      [undefined, this.cfg.maxServers],
    ] as const) {
      const pool = [...this.entries.values()].filter((e) => scope === undefined || e.owner === scope)
      if (pool.length < cap) continue
      const victim = pool.filter((e) => e.client && e.busy === 0).sort((a, b) => a.last - b.last)[0]
      if (!victim) return false
      void this.close(victim)
    }
    return true
  }

  private async launch(ctx: Ctx, entry: Entry): Promise<void> {
    const workspaceRoot = resolve(ctx.session.workspaceRoot)
    if (entry.def.needsTrust && !this.cfg.trusted) return this.fail(entry, entry.def.needsTrust)
    // One filtered PATH for resolving and for the process, so what is checked is what runs.
    const roots = [workspaceRoot, ctx.cwd, entry.root]
    const entries = safeEntries(this.cfg.searchPath, roots)
    const base = { ...serverEnv(), PATH: entries.join(delimiter) }
    const first = this.nextCommand.get(entry.key) ?? 0
    let reason = 'not found on PATH'
    for (let i = first; i < entry.def.commands.length; i++) {
      // A fallback command would need the context, which ended with the call: resume there next call.
      if (i > first && ctx.signal.aborted) {
        this.nextCommand.set(entry.key, i)
        this.entries.delete(entry.key)
        return
      }
      const [name = '', ...rest] = entry.def.commands[i] as readonly string[]
      // The executable is resolved once, here, and launched by absolute path.
      const bin = resolveBinary(name, entries, roots)
      if (!bin || 'refused' in bin) {
        reason = bin?.refused ?? `${name} not found on PATH`
        continue
      }
      const run = launchArgv(bin.path, rest, entries, roots)
      if ('unavailable' in run) {
        reason = run.unavailable
        continue
      }
      // Static analysis only: what each server may run from the workspace is switched off, because
      // starting a server must not be a way around command approval. See servers.ts.
      const settings = entry.def.settings?.({ workspaceRoot, binary: bin.path })
      if (settings && 'unavailable' in settings) return this.fail(entry, settings.unavailable)
      let client: LspClient | undefined
      try {
        // No `signal`: the handle belongs to the session and outlives this call.
        const proc = await ctx.sandbox.openProcess?.({
          argv: run.argv,
          cwd: entry.root,
          env: { ...base, ...settings?.env },
        })
        if (!proc) throw new Error('no process port')
        client = new LspClient(proc, entry.root, this.cfg.stableMs)
        await client.start(this.cfg.initMs, settings?.initializationOptions)
      } catch (e) {
        reason = errorText(e)
        await client?.close()
        client = undefined
        continue
      }
      if (entry.closing) {
        await client.close()
        return
      }
      entry.client = client
      this.touch(entry)
      void client.exited.then(
        () => entry.closing || this.fail(entry, `the ${entry.def.id} language server exited unexpectedly`),
      )
      return
    }
    this.nextCommand.delete(entry.key)
    this.fail(
      entry,
      `could not start ${entry.def.commands.map((c) => c[0]).join(' or ')} (${reason}); install it so it is on PATH`,
    )
  }

  private fail(entry: Entry, reason: string): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    clearTimeout(entry.idle)
    this.failed.set(entry.key, { until: Date.now() + this.cfg.failMs, reason })
  }

  private touch(entry: Entry): void {
    if (entry.closing) return
    entry.last = Date.now()
    clearTimeout(entry.idle)
    entry.idle = setTimeout(() => {
      if (entry.busy > 0) this.touch(entry)
      else void this.close(entry)
    }, this.cfg.idleMs)
    entry.idle.unref?.()
  }

  private async run<T>(entry: Entry, fn: (client: LspClient) => Promise<T>): Promise<T | undefined> {
    const client = entry.client
    if (!client) return undefined
    entry.busy++
    try {
      return await fn(client)
    } finally {
      entry.busy--
      this.touch(entry)
    }
  }

  private async close(entry: Entry): Promise<void> {
    entry.closing = true
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    clearTimeout(entry.idle)
    await entry.starting?.catch(() => undefined)
    await entry.client?.close()
  }
}

export const standaloneLsp = new LspSessions()
const registries = new WeakMap<AbortSignal, LspSessions>()
/** One registry per assembly, closed when it ends, like the shell jobs registry. */
export function lspFor(signal: AbortSignal): LspSessions {
  let lsp = registries.get(signal)
  if (!lsp) {
    lsp = new LspSessions()
    registries.set(signal, lsp)
    const registry = lsp
    signal.addEventListener('abort', () => void registry.dispose().catch(() => undefined), { once: true })
  }
  return lsp
}

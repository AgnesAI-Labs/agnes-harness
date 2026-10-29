import { pathToFileURL } from 'node:url'
import type { SandboxProcess } from '@agnes/extension-api'
import { encodeFrame, FrameDecoder } from './framing.js'

export type Diagnostic = Readonly<{
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  /** 1 error, 2 warning, 3 information, 4 hint; absent means the client decides (we treat it as error). */
  severity?: number
  message: string
  source?: string
  code?: string | number
}>

type Doc = { version: number; text: string; diags: readonly Diagnostic[] | undefined }
type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
type Message = {
  id?: number | string
  method?: string
  params?: any
  result?: unknown
  error?: { message?: string }
}

const MAX_OPEN_DOCUMENTS = 50

/** One language server over one sandboxed process. It holds a process handle, never a tool context. */
export class LspClient {
  readonly exited: Promise<void>
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<number, Pending>()
  private readonly docs = new Map<string, Doc>()
  private readonly waiters = new Set<() => void>()
  private nextId = 0
  private pull = false
  private dead = false
  private readonly rootUri: string

  constructor(
    private readonly proc: SandboxProcess,
    root: string,
    private readonly stableMs = 200,
  ) {
    this.rootUri = pathToFileURL(root).href
    proc.onOutput((chunk) => {
      if (chunk.stream !== 'stdout') return
      try {
        for (const message of this.decoder.push(chunk.text)) this.handle(message as Message)
      } catch {
        void this.close()
      }
    })
    this.exited = proc.exited.then(
      () => this.die(),
      () => this.die(),
    )
  }

  get alive(): boolean {
    return !this.dead
  }

  async start(timeoutMs: number, initializationOptions?: unknown): Promise<void> {
    const result = (await this.request(
      'initialize',
      {
        processId: null,
        rootUri: this.rootUri,
        ...(initializationOptions === undefined ? {} : { initializationOptions }),
        workspaceFolders: [{ uri: this.rootUri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
      },
      timeoutMs,
    )) as { capabilities?: { diagnosticProvider?: unknown } } | null
    this.pull = Boolean(result?.capabilities?.diagnosticProvider)
    this.notify('initialized', {})
  }

  /**
   * Sends the full text and resolves with the diagnostics of exactly that version once they have been
   * stable for `stableMs`; undefined when `waitMs` passes first or the server dies.
   */
  async diagnostics(
    path: string,
    languageId: string,
    text: string,
    waitMs: number,
  ): Promise<readonly Diagnostic[] | undefined> {
    if (this.dead) return undefined
    const uri = pathToFileURL(path).href
    const previous = this.docs.get(uri)
    // Same text as the last send and its diagnostics are in: a repeat change would not be answered.
    if (previous?.text === text && previous.diags) return previous.diags
    const doc: Doc = { version: (previous?.version ?? 0) + 1, text, diags: undefined }
    this.docs.delete(uri)
    this.docs.set(uri, doc)
    if (previous) {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }],
      })
    } else {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: doc.version, text } })
    }
    for (const [old] of this.docs) {
      if (this.docs.size <= MAX_OPEN_DOCUMENTS) break
      this.docs.delete(old)
      this.notify('textDocument/didClose', { textDocument: { uri: old } })
    }
    if (this.pull) {
      void this.request('textDocument/diagnostic', { textDocument: { uri } }, waitMs)
        .then((report) => {
          const items = (report as { kind?: string; items?: Diagnostic[] } | null)?.items
          if (this.docs.get(uri) === doc && Array.isArray(items)) this.publish(doc, items)
        })
        .catch(() => undefined)
    }
    return this.settle(doc, waitMs)
  }

  async close(): Promise<void> {
    if (!this.dead) {
      try {
        await this.request('shutdown', null, 1000)
        this.notify('exit', undefined)
      } catch {
        // A server that will not shut down politely is killed below.
      }
    }
    await this.proc.close().catch(() => undefined)
    this.die()
  }

  private publish(doc: Doc, diags: readonly Diagnostic[]): void {
    doc.diags = diags
    for (const wake of [...this.waiters]) wake()
  }

  private settle(doc: Doc, waitMs: number): Promise<readonly Diagnostic[] | undefined> {
    return new Promise((resolve) => {
      let stable: ReturnType<typeof setTimeout> | undefined
      const finish = (value: readonly Diagnostic[] | undefined) => {
        clearTimeout(deadline)
        clearTimeout(stable)
        this.waiters.delete(check)
        resolve(value)
      }
      // Every publish restarts the quiet period: servers often send syntax errors first and the
      // semantic ones moments later.
      const check = () => {
        if (this.dead) return finish(undefined)
        if (!doc.diags) return
        clearTimeout(stable)
        stable = setTimeout(() => finish(doc.diags), this.stableMs)
      }
      const deadline = setTimeout(() => finish(undefined), waitMs)
      this.waiters.add(check)
      check()
    })
  }

  private die(): void {
    if (this.dead) return
    this.dead = true
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('language server exited'))
      this.pending.delete(id)
    }
    for (const wake of [...this.waiters]) wake()
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('language server exited'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.notify('$/cancelRequest', { id })
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(message: unknown): void {
    try {
      void this.proc.write(encodeFrame(message)).catch(() => undefined)
    } catch {
      // The process is gone; exit handling rejects whatever was waiting.
    }
  }

  private handle(message: Message): void {
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        // Requests from the server (configuration, progress, capability registration): answer with
        // nothing so it never blocks waiting for a client that is not a full editor.
        const items = message.params?.items
        const result =
          message.method === 'workspace/configuration' && Array.isArray(items) ? items.map(() => null) : null
        this.send({ jsonrpc: '2.0', id: message.id, result })
      } else if (message.method === 'textDocument/publishDiagnostics') {
        const doc = this.docs.get(String(message.params?.uri))
        const version = message.params?.version
        // A publish for an older version of the document is stale; one without a version is taken
        // as an answer to the latest text, which servers that omit versions only give for it.
        if (
          doc &&
          (version === undefined || version === doc.version) &&
          Array.isArray(message.params?.diagnostics)
        )
          this.publish(doc, message.params.diagnostics)
      }
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message ?? 'language server error'))
    else entry.resolve(message.result)
  }
}

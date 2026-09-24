import type { BridgeHandler, CodeRunResult, CodeRuntime } from './index.js'

type Script = (program: string, call: BridgeHandler, signal: AbortSignal) => Promise<Partial<CodeRunResult>>
const cancelled = (): CodeRunResult => ({
  status: 'aborted',
  stdout: '',
  stderr: '',
  durationMs: 0,
  subcalls: 0,
})

/** Scripted test double. It does not parse Python, spawn a process, or certify sandbox isolation. */
export class FakeRuntime implements CodeRuntime {
  get language() {
    return 'python' as const
  }
  get state() {
    return 'persistent' as const
  }
  get isolation() {
    return 'process' as const
  }
  private started = false
  private starting = false
  private generation = 0
  private active: AbortController | undefined
  private vars = new Map<string, string>()
  constructor(private readonly opts: { script?: Script } = {}) {}
  async probe() {
    return { ok: true as const, version: 'scripted-test-double' }
  }
  async start(opts: Parameters<CodeRuntime['start']>[0]) {
    if (this.started || this.starting) throw new Error('runtime already started or starting')
    opts.signal?.throwIfAborted()
    this.starting = true
    const generation = this.generation
    try {
      await opts.confine(['scripted-runtime-test-double'])
      opts.signal?.throwIfAborted()
      if (generation !== this.generation) throw new Error('runtime start cancelled')
      this.started = true
    } finally {
      this.starting = false
    }
  }
  async run(req: Parameters<CodeRuntime['run']>[0]): Promise<CodeRunResult> {
    if (!this.started) throw new Error('run before start')
    if (this.active) throw new Error('runtime busy')
    if (req.signal?.aborted) return cancelled()
    const controller = new AbortController()
    this.active = controller
    const abort = () => controller.abort()
    req.signal?.addEventListener('abort', abort, { once: true })
    let onAbort: () => void = () => {}
    const stopped = new Promise<CodeRunResult>((resolve) => {
      onAbort = () => resolve(cancelled())
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    let subcalls = 0
    const call: BridgeHandler = async (frame) => {
      controller.signal.throwIfAborted()
      subcalls++
      const result = await req.bindings(frame)
      controller.signal.throwIfAborted()
      return result
    }
    try {
      const execution = Promise.resolve().then(async (): Promise<CodeRunResult> => {
        controller.signal.throwIfAborted()
        const patch = this.opts.script
          ? await this.opts.script(req.program, call, controller.signal)
          : await this.execute(req.program, call)
        return { status: 'ok', stdout: '', stderr: '', durationMs: 0, ...patch, subcalls }
      })
      return await Promise.race([execution, stopped])
    } finally {
      controller.abort()
      controller.signal.removeEventListener('abort', onAbort)
      req.signal?.removeEventListener('abort', abort)
      if (this.active === controller) this.active = undefined
    }
  }
  private async execute(program: string, call: BridgeHandler): Promise<Partial<CodeRunResult>> {
    if (program === 'echo') return { stdout: 'runtime-contract-ok' }
    if (program === 'define') {
      this.vars.set('answer', '42')
      return {}
    }
    if (program === 'read') return { stdout: this.vars.get('answer') ?? 'missing' }
    if (program === 'call' || program === 'wait') {
      const result = await call({ jsonrpc: '2.0', id: 1, method: 'bridge.test', params: { marker: 42 } })
      return { stdout: JSON.stringify(result) }
    }
    throw new Error('unknown scripted test program')
  }
  async interrupt() {
    this.active?.abort()
  }
  async snapshot() {
    if (!this.started || this.active) throw new Error('snapshot requires idle started runtime')
    return {
      payload: new TextEncoder().encode(JSON.stringify([...this.vars])),
      saved: [...this.vars.keys()],
      skipped: [],
    }
  }
  async restore(payload: Uint8Array) {
    if (!this.started || this.active) throw new Error('restore requires idle started runtime')
    const data: unknown = JSON.parse(new TextDecoder().decode(payload))
    if (
      !Array.isArray(data) ||
      !data.every((v) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string'))
    )
      throw new Error('invalid scripted snapshot')
    this.vars = new Map(data as [string, string][])
    return { restored: [...this.vars.keys()], skipped: [] }
  }
  async listNames() {
    return [...this.vars].map(([name, value]) => ({ name, type: 'str', bytes: value.length }))
  }
  async shutdown() {
    await this.kill()
  }
  async kill() {
    this.generation++
    this.active?.abort()
    this.started = false
    this.vars.clear()
  }
}

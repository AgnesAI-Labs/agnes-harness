import type { CodeRuntime, ToolContext } from '@agnes/extension-api'
import { NODE_GUEST, PYTHON_GUEST } from './guest.js'

/** Every cell uses the invocation's policy-bound executor and a fresh provider-owned process. */
export function processRuntime(
  initial: Pick<ToolContext, 'exec' | 'cwd' | 'signal' | 'tools'> | undefined,
  language: CodeRuntime['language'],
  options: { rawIo?: boolean } = {},
): CodeRuntime {
  let rawIo = options.rawIo ?? false
  let ctx: Pick<ToolContext, 'exec' | 'cwd' | 'signal'> | undefined = initial
  let names = () =>
    initial?.tools
      .list()
      .filter((t) => t.name !== 'run_code')
      .map((t) => t.name) ?? []
  let stopped = false
  const controller = new AbortController()
  const runtime: CodeRuntime = {
    language,
    state: 'stateless',
    isolation: 'process',
    async probe() {
      if (!ctx) return { ok: false, reason: 'Managed executor is not bound' }
      const result = await ctx.exec(
        language === 'typescript' ? ['node', '--version'] : ['python3', '--version'],
      )
      return result.code === 0
        ? { ok: true, version: result.stdout.trim() }
        : { ok: false, reason: result.stderr }
    },
    async start(opts) {
      opts.signal?.throwIfAborted()
      if (!opts.exec) throw new Error('Managed sandbox executor is required')
      rawIo = opts.rawIo ?? rawIo
      ctx = {
        exec: opts.exec,
        cwd: opts.cwd,
        signal: opts.signal ?? new AbortController().signal,
      }
      names = () => [...(opts.toolNames ?? [])].filter((name) => name !== 'run_code')
    },
    async run(req) {
      if (!ctx) throw new Error('Code runtime is not started')
      if (language === 'python' && !rawIo)
        throw new Error('E_PRESET_UNSUPPORTED: Python raw_io:false is not implemented')
      if (stopped) throw new Error('code runtime is closed')
      const started = Date.now()
      const signal = AbortSignal.any([req.signal ?? ctx.signal, ctx.signal, controller.signal])
      if (signal.aborted) return { status: 'aborted', stdout: '', stderr: '', durationMs: 0, subcalls: 0 }
      let subcalls = 0
      const output = await ctx.exec(
        language === 'typescript'
          ? ['node', ...(rawIo ? [] : ['--permission']), '-e', NODE_GUEST]
          : ['python3', '-I', '-u', '-c', PYTHON_GUEST],
        {
          cwd: ctx.cwd,
          signal,
          maxOutputBytes: req.limits.maxOutputChars,
          stdin: JSON.stringify({
            program: req.program,
            names: names(),
          }),
          timeoutMs: req.limits.wallMs,
          bridge: async (frame) => {
            subcalls++
            return req.bindings(frame)
          },
        },
      )
      const status = signal.aborted
        ? 'aborted'
        : output.code === 0 && !output.timedOut && !output.truncated
          ? 'ok'
          : 'error'
      return {
        status,
        stdout: output.stdout.slice(0, req.limits.maxOutputChars),
        stderr: output.stderr.slice(0, req.limits.maxOutputChars),
        durationMs: Date.now() - started,
        subcalls,
        ...(status === 'error'
          ? {
              error: {
                name: output.timedOut ? 'TimeoutError' : output.truncated ? 'OutputLimitError' : 'CodeError',
                message: output.timedOut
                  ? 'Cell time budget exceeded'
                  : output.truncated
                    ? 'Process output budget exceeded'
                    : 'Code process failed',
                traceback: [],
              },
            }
          : {}),
      }
    },
    async interrupt() {
      controller.abort()
    },
    async kill() {
      stopped = true
      controller.abort()
    },
    async shutdown() {
      stopped = true
      controller.abort()
    },
  }
  return runtime
}

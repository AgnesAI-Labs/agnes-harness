import type { ChildProcess } from 'node:child_process'
import { tracingChannel } from 'node:diagnostics_channel'

type Stage = 'runtime-inspection' | 'sandbox'
type Observation = {
  stage: Stage
  attempt: number
  event: 'start' | 'spawn' | 'spawn-error' | 'exit' | 'close'
  elapsedMs: number
  pid?: number
  code?: number | string | null
  signal?: string | null
  killed?: boolean
  stdoutBytes?: number | null
  stderrBytes?: number | null
}

/** Observe actual Node spawn calls without changing their promises, streams or error listeners. */
export function observeMcpProcesses(
  executables: ReadonlyMap<string, Stage> = new Map([
    ['/usr/bin/otool', 'runtime-inspection'],
    ['/usr/bin/sandbox-exec', 'sandbox'],
  ]),
) {
  const events: Observation[] = []
  let attempts = 0
  let dropped = 0
  const active = new Map<ChildProcess, { error(code: unknown): void; detach(): void }>()
  const { start, error } = tracingChannel('child_process.spawn')
  const record = (event: Observation) => {
    if (events.length < 64) events.push(event)
    else dropped++
  }
  const onStart = (message: unknown) => {
    const { process: child, options } = message as { process: ChildProcess; options: { file: string } }
    const stage = executables.get(options.file)
    if (!stage) return
    const attempt = ++attempts
    const started = performance.now()
    const facts = () => ({ stage, attempt, elapsedMs: Math.round(performance.now() - started) })
    const pid = () =>
      typeof child.pid === 'number' && Number.isSafeInteger(child.pid) && child.pid > 0
        ? { pid: child.pid }
        : {}
    const bytesRead = (stream: ChildProcess['stdout']) =>
      stream && 'bytesRead' in stream && typeof stream.bytesRead === 'number' ? stream.bytesRead : null
    const output = () => ({ stdoutBytes: bytesRead(child.stdout), stderrBytes: bytesRead(child.stderr) })
    const detach = () => {
      child.removeListener('spawn', spawned)
      child.removeListener('exit', exited)
      child.removeListener('close', closed)
      active.delete(child)
    }
    const spawned = () => record({ ...facts(), event: 'spawn', ...pid() })
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      record({ ...facts(), event: 'exit', ...pid(), code, signal, killed: child.killed, ...output() })
    }
    const closed = (code: number | null, signal: NodeJS.Signals | null) => {
      record({ ...facts(), event: 'close', ...pid(), code, signal, killed: child.killed, ...output() })
      detach()
    }
    active.set(child, {
      detach,
      error(code) {
        record({
          ...facts(),
          event: 'spawn-error',
          code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null,
        })
        detach()
      },
    })
    child.once('spawn', spawned)
    child.once('exit', exited)
    child.once('close', closed)
    record({ stage, attempt, event: 'start', elapsedMs: 0 })
  }
  const onError = (message: unknown) => {
    const { process: child, error: failure } = message as {
      process: ChildProcess
      error: NodeJS.ErrnoException
    }
    active.get(child)?.error(failure.code)
  }
  start.subscribe(onStart)
  error.subscribe(onError)
  return {
    events,
    get dropped() {
      return dropped
    },
    dispose() {
      start.unsubscribe(onStart)
      error.unsubscribe(onError)
      for (const entry of active.values()) entry.detach()
    },
  }
}

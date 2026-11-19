/** Bounded, abortable bot-event consumer. It owns only its child process tree, never the CLI's shared event daemon. */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { HOST_PLATFORM, isWindows } from '../infra/platform.js'
import { childEnvironment, killTree, type Processes, signalGroup } from './subprocess.js'
import { windowsLaunch } from './windows-launch.js'

export const STREAM_LIMITS = { lineBytes: 1_048_576, queueBytes: 4_194_304, queueLines: 128, readyMs: 45_000 }
export interface StreamOptions {
  cli: string
  signal: AbortSignal
  receive(value: unknown): Promise<void>
  ready(signal: AbortSignal): void
  warning(): void
  /** Tests shorten readiness and termination deadlines without changing the production lifecycle. */
  readyMs?: number
  graceMs?: number
}
export async function consumeFeishu(options: StreamOptions): Promise<void> {
  options.signal.throwIfAborted()
  const env = childEnvironment({
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  })
  const args = ['event', 'consume', 'im.message.receive_v1', '--as', 'bot']
  const windows = isWindows(HOST_PLATFORM)
  const launch = windows
    ? windowsLaunch(options.cli, args, env)
    : { program: options.cli, args, verbatim: false }
  const stopping = new AbortController()
  const child = spawn(launch.program, launch.args, {
    env,
    detached: !windows,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
  })
  const processes: Processes = { spawn, kill: (pid, signal) => process.kill(pid, signal) }
  let error: Error | undefined
  let ready = false,
    stopped = false,
    queuedBytes = 0
  let killer: ReturnType<typeof setTimeout> | undefined
  let drain: ReturnType<typeof setTimeout> | undefined
  const queue: string[] = []
  let processing: Promise<void> | undefined
  const stop = () => {
    if (stopped) return
    stopped = true
    stopping.abort()
    queue.length = 0
    queuedBytes = 0
    child.stdin?.end()
    if (windows) killTree(child, processes)
    else signalGroup(child, 'SIGTERM', processes)
    // Keep this escalation even if the wrapper exits first: descendants may still hold the pipes.
    killer = setTimeout(() => {
      if (windows) child.kill('SIGKILL')
      else signalGroup(child, 'SIGKILL', processes)
    }, options.graceMs ?? 2000)
  }
  const fail = (message: string) => {
    error ??= new Error(message)
    stop()
  }
  const deadline = setTimeout(
    () => fail('Feishu event consumer did not become ready within its deadline'),
    options.readyMs ?? STREAM_LIMITS.readyMs,
  )
  const pump = () => {
    if (processing || stopped || !ready) return
    processing = (async () => {
      while (queue.length && !stopped) {
        const line = queue.shift()!
        queuedBytes -= Buffer.byteLength(line)
        try {
          await options.receive(JSON.parse(line))
        } catch {
          fail('Feishu event could not be processed; history recovery will retry it')
        }
      }
    })().finally(() => {
      processing = undefined
    })
  }
  const output = (line: string) => {
    if (stopped || !line.trim()) return
    queuedBytes += Buffer.byteLength(line)
    if (queue.length >= STREAM_LIMITS.queueLines || queuedBytes > STREAM_LIMITS.queueBytes) {
      fail('Feishu event queue exceeded its bound; reconnecting for history recovery')
      return
    }
    queue.push(line)
    pump()
  }
  const diagnostic = (line: string) => {
    if (line.startsWith('[event] ready')) {
      if (!ready && !stopped) {
        ready = true
        clearTimeout(deadline)
        options.ready(AbortSignal.any([options.signal, stopping.signal]))
        pump()
      }
    } else if (/WARN|drop|error/i.test(line)) options.warning()
    // Never log raw CLI diagnostics or event contents: wrappers may print credentials there.
  }
  const lines = (limit: number, emit: (line: string) => void) => {
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    return (chunk: Buffer) => {
      if (stopped) return
      buffer += decoder.write(chunk)
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n')
        const line = buffer.slice(0, at).replace(/\r$/, '')
        buffer = buffer.slice(at + 1)
        if (Buffer.byteLength(line) > limit) {
          fail('Feishu event stream line exceeds its byte limit')
          return
        }
        emit(line)
        if (stopped) return
      }
      if (Buffer.byteLength(buffer) > limit) fail('Feishu event stream line exceeds its byte limit')
    }
  }
  child.stdin?.on('error', () => {})
  child.stdout.on('data', lines(STREAM_LIMITS.lineBytes, output))
  child.stderr.on('data', lines(4096, diagnostic))
  options.signal.addEventListener('abort', stop, { once: true })
  if (options.signal.aborted) stop()
  try {
    await new Promise<void>((resolve) => {
      child.once('error', () => {
        error ??= new Error('Feishu event consumer could not start')
        stop()
        resolve()
      })
      child.once('exit', () => {
        if (!stopped) {
          error ??= new Error('Feishu event consumer exited; reconnecting')
          stop()
        }
        drain = setTimeout(resolve, (options.graceMs ?? 2000) + 50)
      })
      child.once('close', () => {
        if (!stopped) {
          error ??= new Error('Feishu event consumer closed; reconnecting')
          stop()
        }
        // Let the group escalation run even when the wrapper closed all pipes before its descendants exited.
        drain ??= setTimeout(resolve, (options.graceMs ?? 2000) + 50)
      })
    })
    await processing
  } finally {
    stop()
    clearTimeout(deadline)
    clearTimeout(drain)
    clearTimeout(killer)
    options.signal.removeEventListener('abort', stop)
    child.stdout.destroy()
    child.stderr.destroy()
    child.stdin?.destroy()
  }
  if (!options.signal.aborted) throw error ?? new Error('Feishu event consumer stopped')
}

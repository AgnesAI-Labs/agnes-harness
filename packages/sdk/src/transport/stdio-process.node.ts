import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { isSea } from 'node:sea'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { mergeWindowsEnvironment, startWindowsJobProcess } from '@agnes/system-node/process-spawn'

/** A stdio server belongs to its transport, including every descendant it starts. */
type StdioProcess = EventEmitter & {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(signal?: NodeJS.Signals): boolean
}
export async function startStdioProcess(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string>,
  options: { nodeExecutable?: string; windowsBatch?: 'script' | 'argv-proxy' } = {},
): Promise<StdioProcess> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  if (!options.nodeExecutable && isSea())
    throw new Error('Windows stdio in a SEA executable requires nodeExecutable pointing to Node.js')
  const processJob = await startWindowsJobProcess(cmd, {
    cwd: resolve(cwd ?? process.cwd()),
    env: mergeWindowsEnvironment(inherited, env),
    nodeExecutable: options.nodeExecutable ?? process.execPath,
    windowsBatch: options.windowsBatch ?? 'script',
  }).catch((error: Error) => {
    // Preserve ChildProcess's asynchronous spawn-error contract for transport consumers.
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        return false
      },
    })
    setImmediate(() => {
      child.emit('error', error)
      child.emit('close', null, null)
    })
    return child
  })
  if (!('completion' in processJob)) return processJob
  let requestedSignal: string | null = null
  const child = Object.assign(new EventEmitter(), {
    stdin: processJob.stdin,
    stdout: processJob.stdout,
    stderr: processJob.stderr,
    kill(signal = 'SIGTERM') {
      requestedSignal ??= signal
      processJob.terminate()
      return true
    },
  })
  // Install transport listeners before delivering completion, even for an immediate process exit.
  void processJob.completion.then((status) => {
    setImmediate(() => {
      if (status.error) child.emit('error', status.error)
      const signal = status.cancelled ? requestedSignal : status.signal
      child.emit('exit', signal ? null : status.code, signal)
      child.emit('close', signal ? null : status.code, signal)
    })
  })
  return child
}

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type { ProcessOutput, SandboxProcess, SandboxProcessRequest } from '@agnes/extension-api'
import { sandboxUnavailable } from '@agnes/extension-api'
import { baseEnvironment } from './exec.js'

declare const AGNES_PACKAGED_BUILTINS: boolean | undefined
export function ptyRelayBinary(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return typeof AGNES_PACKAGED_BUILTINS !== 'undefined' && AGNES_PACKAGED_BUILTINS
    ? join(here, 'native', 'pty-relay')
    : join(here, '../../dist/native/pty-relay')
}
const dimensions = (columns: number, rows: number) => {
  if (![columns, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 1000))
    throw new Error('terminal dimensions must be integers between 1 and 1000')
}
/** Raw Host spawner. Only the policy-bound sandbox provider may call it. */
export async function openLocalProcess(request: SandboxProcessRequest): Promise<SandboxProcess> {
  request.signal?.throwIfAborted()
  if (!request.argv.length) throw new Error('process argv is empty')
  const windows = process.platform === 'win32' // guards-allow-platform: process-tree/PTY backend selection
  if (request.pty && windows) throw sandboxUnavailable('local Windows PTY needs a ConPTY provider')
  if (request.pty) dimensions(request.pty.columns, request.pty.rows)
  const argv = request.pty
    ? [ptyRelayBinary(), String(request.pty.columns), String(request.pty.rows), ...request.argv]
    : [...request.argv]
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: request.cwd,
    env: { ...baseEnvironment(), TERM: 'xterm-256color', ...request.env },
    detached: !windows,
    windowsHide: true,
    stdio: request.pty ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  })
  const listeners = new Set<(chunk: ProcessOutput) => void>()
  const pending: ProcessOutput[] = []
  let pendingBytes = 0
  const emit = (chunk: ProcessOutput) => {
    if (!listeners.size) {
      pendingBytes += Buffer.byteLength(chunk.text)
      pending.push(chunk)
      while (pendingBytes > 65536 && pending.length > 1)
        pendingBytes -= Buffer.byteLength(pending.shift()!.text)
    } else for (const listener of listeners) listener(chunk)
  }
  const stdout = new StringDecoder('utf8'),
    stderr = new StringDecoder('utf8')
  child.stdout!.on('data', (bytes: Buffer) => emit({ stream: 'stdout', text: stdout.write(bytes) }))
  child.stderr!.on('data', (bytes: Buffer) => emit({ stream: 'stderr', text: stderr.write(bytes) }))
  let ended = false
  const exited = new Promise<{ code: number | null; signal?: string }>((resolve) => {
    child.once('close', (code, signal) => {
      ended = true
      emit({ stream: 'stdout', text: stdout.end() })
      emit({ stream: 'stderr', text: stderr.end() })
      resolve({ code, ...(signal ? { signal } : {}) })
    })
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  const write = (stream: NodeJS.WritableStream, text: string) =>
    new Promise<void>((resolve, reject) => {
      if (ended) {
        reject(new Error('process has exited'))
        return
      }
      stream.write(text, (error?: Error | null) => (error ? reject(error) : resolve()))
    })
  // Consume late stream errors after exit; writes still reject through their callbacks.
  child.stdin!.on('error', () => undefined)
  const control = child.stdio[3] as NodeJS.WritableStream | undefined
  control?.on('error', () => undefined)
  const signal = async (name: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGKILL') => {
    if (ended) return
    if (request.pty) return write(control!, `${name === 'SIGKILL' ? 'close' : name}\n`)
    if (windows && name === 'SIGKILL') {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        killer.once('error', reject)
        killer.once('close', () => resolve())
      })
    } else {
      try {
        windows ? child.kill(name) : process.kill(-child.pid!, name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  let closing: Promise<void> | undefined
  const handle: SandboxProcess = {
    enforcement: request.enforcement ?? { level: 'none', scope: [] },
    exited,
    onOutput(listener) {
      listeners.add(listener)
      for (const chunk of pending.splice(0)) listener(chunk)
      pendingBytes = 0
      return () => listeners.delete(listener)
    },
    write: (text) => write(child.stdin!, text),
    resize: async (columns, rows) => {
      dimensions(columns, rows)
      if (!request.pty) throw new Error('process is not a PTY')
      await write(control!, `resize ${columns} ${rows}\n`)
    },
    signal,
    close() {
      closing ??= (async () => {
        await signal('SIGKILL')
        await exited
      })()
      return closing
    },
  }
  if (request.signal?.aborted) {
    await handle.close()
    request.signal.throwIfAborted()
  }
  return handle
}

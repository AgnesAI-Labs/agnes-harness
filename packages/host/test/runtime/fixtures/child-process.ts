import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateRuntime } from '@agnes/protocol/runtime'

/** Waits for the next IPC message the caller accepts; an error message or an exit rejects. */
export function message(
  child: ChildProcess,
  accept: (value: Record<string, unknown>) => boolean,
  ms = 60_000,
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let stderr = ''
    const err = (chunk: Buffer) => {
      stderr += chunk.toString()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(Error(`Process IPC deadline: ${stderr}`))
    }, ms)
    const receive = (value: unknown) => {
      if (value === null || typeof value !== 'object') return
      const wire = validateRuntime('JsonValue', value)
      if (!wire.ok || Array.isArray(wire.value) || typeof wire.value !== 'object' || wire.value === null)
        return
      const object = wire.value
      if (object.phase === 'error') {
        cleanup()
        reject(Error(String(object.message)))
        return
      }
      if (accept(object)) {
        cleanup()
        resolve(object)
      }
    }
    const exit = () => {
      cleanup()
      reject(Error(`Process exited: ${stderr}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', receive)
      child.off('exit', exit)
      child.stderr?.off('data', err)
    }
    child.on('message', receive)
    child.once('exit', exit)
    child.stderr?.on('data', err)
  })
}

export async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await stopped
}

/** Starts a Node child at the repository root with an IPC channel and a minimal environment. */
export function run(children: ChildProcess[], args: string[]) {
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, LANG: 'C' },
  })
  children.push(child)
  return child
}

import { spawn } from 'node:child_process'
import { fault } from './private-files.mjs'
export function command(
  executable,
  args,
  { env, cwd, signal, timeout = 10000, maxBytes = 4 * 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '',
      bytes = 0,
      timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) child.kill('SIGKILL')
      else output += chunk.toString()
    })
    child.stderr.resume() // Never reflect provider diagnostics or credentials to callers.
    child.once('error', () => {
      clearTimeout(timer)
      reject(Object.assign(fault('SYNC_COMMAND_FAILED'), { stage: args[0] }))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut || signal?.aborted) reject(fault('SYNC_TIMEOUT'))
      else if (code !== 0 || bytes > maxBytes)
        reject(Object.assign(fault('SYNC_COMMAND_FAILED'), { stage: args[0] }))
      else resolve(output)
    })
  })
}
export function start(executable, args, options = {}) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'ignore', 'ignore'] })
  const closed = new Promise((resolve) => {
    child.once('error', () => resolve(-1))
    child.once('exit', (code) => resolve(code ?? -1))
  })
  return { child, closed }
}
export async function terminate(process, { timeout = 3000 } = {}) {
  if (!process || process.child.exitCode !== null || process.child.signalCode !== null || !process.child.pid)
    return
  process.child.kill('SIGTERM')
  const timer = setTimeout(() => process.child.kill('SIGKILL'), timeout)
  try {
    await process.closed
  } finally {
    clearTimeout(timer)
  }
}

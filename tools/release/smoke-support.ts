import { type ChildProcess, execFile } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export async function command(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  acceptedExitCodes: readonly number[] = [0],
): Promise<string> {
  const { stdout, stderr } = await execute(bin, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((error: unknown) => {
    const result = error as { code?: number | string; stdout?: string; stderr?: string }
    if (
      typeof result.code !== 'number' ||
      !acceptedExitCodes.includes(result.code) ||
      typeof result.stdout !== 'string'
    )
      throw error
    return { stdout: result.stdout, stderr: result.stderr ?? '' }
  })
  if (stderr) process.stderr.write(stderr)
  return stdout
}

export async function freePort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((done, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', done)
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('No TCP port')
  await new Promise<void>((done) => listener.close(() => done()))
  return address.port
}

export async function treeBytes(root: string): Promise<number> {
  let bytes = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) bytes += await treeBytes(path)
    else if (!entry.isSymbolicLink()) bytes += (await lstat(path)).size
  }
  return bytes
}

export async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  child?: ChildProcess,
  log = () => '',
): Promise<void> {
  const deadline = performance.now() + 90_000
  while (performance.now() < deadline) {
    if (child && (!child.pid || child.exitCode !== null || child.signalCode !== null))
      throw new Error(`${label}: process exited\n${log()}`)
    if (await probe().catch(() => false)) return
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`${label}: timed out\n${log()}`)
}

/** Signal only the process group created by this smoke, including npm's launcher children. */
export async function stopWeb(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  signal('SIGTERM')
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      signal('SIGKILL')
      reject(new Error('Web failed to shut down gracefully'))
    }, 10_000)
    child.once('exit', (code, sig) => {
      clearTimeout(timer)
      if (code !== 0 && code !== 143 && sig !== 'SIGTERM')
        reject(new Error(`Web shutdown: exit ${code}, signal ${sig}`))
      else done()
    })
  })
}

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { SandboxProcess, ToolContext } from '@agnes/extension-api'

/** Compatibility for older Hosts: still goes through the public confine port. No PTY fallback. */
export async function legacyProcess(
  ctx: Pick<ToolContext, 'signal' | 'sandbox'>,
  raw: string[],
  cwd: string,
): Promise<SandboxProcess> {
  const windows = process.platform === 'win32' // guards-allow-platform: process group backend
  if (windows) throw new Error('SANDBOX_UNAVAILABLE: Windows requires the Host process port')
  const argv = await ctx.sandbox.confine(raw)
  ctx.signal.throwIfAborted()
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP'])
    if (process.env[key] !== undefined) env[key] = process.env[key]!
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<{ code: number | null }>((resolve) =>
    child.once('close', (code) => resolve({ code })),
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.stdin.on('error', () => undefined)
  return {
    enforcement: ctx.sandbox.enforcement(),
    exited,
    onOutput(listener) {
      const out = new StringDecoder('utf8'),
        err = new StringDecoder('utf8')
      const stdout = (bytes: Buffer) => listener({ stream: 'stdout', text: out.write(bytes) })
      const stderr = (bytes: Buffer) => listener({ stream: 'stderr', text: err.write(bytes) })
      child.stdout.on('data', stdout)
      child.stderr.on('data', stderr)
      return () => {
        child.stdout.off('data', stdout)
        child.stderr.off('data', stderr)
      }
    },
    write: (text) =>
      new Promise((resolve, reject) =>
        child.stdin.write(text, (error) => (error ? reject(error) : resolve())),
      ),
    resize: async () => {
      throw new Error('legacy process is not a PTY')
    },
    signal: async (signal) => {
      if (child.pid) process.kill(-child.pid, signal)
    },
    close: async () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await exited
    },
  }
}

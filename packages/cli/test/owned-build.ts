import { startWindowsJobProcess } from '@agnes/system-node/process-spawn'

/** Finite build only: cancellation must also stop native compiler descendants. */
export async function ownedWindowsBuild(
  node: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 90_000,
) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const env = Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    const child = await startWindowsJobProcess([node, ...args], {
      cwd,
      env,
      nodeExecutable: node,
      signal: abort.signal,
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stdin.end()
    const result = await child.completion
    if (result.error) throw result.error
    return {
      code: result.cancelled ? 124 : (result.code ?? 1),
      output: Buffer.concat(chunks).toString('utf8'),
    }
  } finally {
    clearTimeout(timer)
  }
}

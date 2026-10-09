import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const canonicalBase64 =
  'eyJyZXNvdXJjZSI6eyJyZXNvdXJjZXMiOnsibWNwIjpbXSwic2tpbGxzIjp7fX0sInJvd3MiOnsiZXh0OmFnbmVzL21jcC1jbGllbnQiOm51bGwsImV4dDphZ25lcy9za2lsbHMiOm51bGx9LCJ0YXJnZXQiOnsiY29tcG9zaXRlUmV2aXNpb24iOiJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjIiwicmVzb3VyY2VSZXZpc2lvbiI6ImJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIiLCJ0cmVlSGFzaCI6IjE2MzM5MDJjNmNiYmE1ZTc3NzBkYmVkMTcyZGY3NTRhMjUwNzhiYjc2ZWZlMWYyMzQ3NGVkYzg3ZjFhNDc2NTUifX0sInRyZWUiOnsiaGFzaCI6IjE2MzM5MDJjNmNiYmE1ZTc3NzBkYmVkMTcyZGY3NTRhMjUwNzhiYjc2ZWZlMWYyMzQ3NGVkYzg3ZjFhNDc2NTUiLCJyb3dzIjpbXX19'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function digest(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`
}

async function runProbe(
  bytes: Uint8Array,
  workerDigest: string,
): Promise<{ code: number | null; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agnes-worker-entry-probe-'))
  roots.push(root)
  const targetFile = join(root, 'runtime-target.json')
  await writeFile(targetFile, bytes)
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('AGNES_')),
  )
  const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))
  const entry = fileURLToPath(new URL('./worker-entry.ts', import.meta.url))

  return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, entry], {
      cwd: root,
      env: {
        ...inherited,
        AGNES_RUNTIME_TARGET_FILE: targetFile,
        AGNES_WORKER_KEY: `@probe:${workerDigest}`,
        AGNES_WORKER_KIND: 'probe',
        AGNES_WORKER_ROOT: root,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('worker-entry probe subprocess timed out'))
    }, 15_000)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

it('executes the real worker entry in probe mode without starting a business Host', async () => {
  const canonical = Buffer.from(canonicalBase64, 'base64')
  const success = await runProbe(canonical, digest(canonical))
  expect(success, success.stderr).toMatchObject({ code: 0 })
  expect((await runProbe(canonical, `sha256-${'0'.repeat(64)}`)).code).not.toBe(0)

  const noncanonical = Buffer.from(JSON.stringify(JSON.parse(canonical.toString('utf8')), null, 2))
  expect((await runProbe(noncanonical, digest(noncanonical))).code).not.toBe(0)
}, 30_000)

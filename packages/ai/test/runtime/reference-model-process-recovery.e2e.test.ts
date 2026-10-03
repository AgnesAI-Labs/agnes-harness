import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalJsonDigest,
  type EffectResult,
  type ReconcileResult,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'

function wait(child: ChildProcess, accept: (message: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Fixture IPC deadline'))
    }, 10000)
    const receive = (value: Record<string, unknown>) => {
      if (accept(value)) {
        cleanup()
        resolve(value)
      }
    }
    const exited = () => {
      cleanup()
      reject(new Error('Fixture process exited'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', receive)
      child.off('exit', exited)
    }
    child.on('message', receive)
    child.once('exit', exited)
  })
}
async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}
it('reopens an independent model owner in a different process and reads the original durable receipt without resend', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-cold-')),
    requests = join(directory, 'requests.jsonl'),
    receipt = join(directory, 'receipt.json')
  const children: ChildProcess[] = []
  const run = (args: string[]) => {
    const child = spawn(process.execPath, args, {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, LANG: 'C' },
    })
    children.push(child)
    return child
  }
  try {
    const http = run([fileURLToPath(new URL('./fixtures/model-http.mjs', import.meta.url)), requests])
    const address = await wait(http, (message) => typeof message.port === 'number')
    const endpoint = `http://127.0.0.1:${address.port}/v1`
    const start = async () => {
      const child = run([
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/reference-model-worker.ts', import.meta.url)),
        endpoint,
        receipt,
      ])
      const ready = await wait(child, (message) => message.ready === true)
      return { child, pid: ready.pid }
    }
    const first = await start()
    const executed = wait(first.child, (message) => message.id === 1)
    first.child.send({ id: 1, op: 'execute' })
    const sent = await executed,
      result = sent.result as EffectResult
    expect(validateRuntime('EffectResult', result).ok).toBe(true)
    expect(result.outcome).toBe('succeeded')
    expect(readFileSync(receipt, 'utf8')).toContain('fixture-response')
    await terminate(first.child)
    const second = await start()
    expect(second.pid).not.toBe(first.pid)
    const reconciled = wait(second.child, (message) => message.id === 2)
    second.child.send({
      id: 2,
      op: 'reconcile',
      context: { authorizationRef: 'caller-cannot-issue-capability' },
    })
    const received = await reconciled,
      recovered = received.result as ReconcileResult
    expect(recovered.kind).toBe('resolved')
    if (recovered.kind !== 'resolved') throw new Error('Original receipt missing')
    expect(canonicalJsonDigest(recovered.result)).toBe(canonicalJsonDigest(result))
    expect(readFileSync(requests, 'utf8').trim().split('\n')).toHaveLength(1)
    const duplicate = wait(second.child, (message) => message.id === 3)
    second.child.send({ id: 3, op: 'execute' })
    expect((await duplicate).error).toBe('Fixture operation refused')
    expect(readFileSync(requests, 'utf8').trim().split('\n')).toHaveLength(1)
  } finally {
    await Promise.all(children.map(terminate))
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)

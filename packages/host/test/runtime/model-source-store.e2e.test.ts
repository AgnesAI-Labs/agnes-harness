import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  canonicalJsonDigest,
  type EffectResult,
  type ReconcileResult,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'

type Api = 'openai-completions' | 'anthropic-messages'
type Cut = 'none' | 'before-save' | 'in-transaction' | 'after-save' | 'save-fails'
// A cold TypeScript worker compiles the adapter and its fixtures on first start, which is slow on a busy machine.
const STARTUP = 90000
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const worker = fileURLToPath(new URL('./fixtures/model-source-store-worker.ts', import.meta.url))
const fenceChild = fileURLToPath(new URL('./fixtures/model-source-store-fence-child.ts', import.meta.url))
const peer = fileURLToPath(new URL('../../../ai/test/runtime/fixtures/model-http.mjs', import.meta.url))

function message(child: ChildProcess, accept: (value: Record<string, unknown>) => boolean, deadline = 15000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let stderr = ''
    const err = (chunk: Buffer) => {
      stderr += chunk.toString()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(Error(`Worker IPC deadline: ${stderr}`))
    }, deadline)
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
      reject(Error(`Worker exited: ${stderr}`))
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
async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await stopped
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 15000
  while (!condition()) {
    if (Date.now() > deadline) throw Error('Condition deadline')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const children: ChildProcess[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(children.splice(0).map(terminate))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function world(api: Api, soleSendFence: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'model-source-e2e-'))
  directories.push(directory)
  const files = {
    journal: join(directory, 'receipt.json'),
    operation: join(directory, 'operation.json'),
    store: join(directory, 'model-source.sqlite'),
    wire: join(directory, 'wire.jsonl'),
    flag: join(directory, 'in-transaction.flag'),
  }
  const run = (args: string[]) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, LANG: 'C' },
    })
    children.push(child)
    return child
  }
  const server = run([peer, files.wire])
  const listening = await message(server, (value) => typeof value.port === 'number', STARTUP)
  const endpoint = `http://127.0.0.1:${listening.port}/v1`
  const start = async (mode: 'execute' | 'recover', cut: Cut) => {
    const child = run([
      '--import',
      'tsx',
      worker,
      api,
      endpoint,
      files.journal,
      files.operation,
      files.store,
      files.flag,
      mode,
      cut,
      String(soleSendFence),
    ])
    const ready = await message(child, (value) => value.phase === 'ready', STARTUP)
    return { child, pid: ready.pid }
  }
  const wire = () =>
    existsSync(files.wire) ? readFileSync(files.wire, 'utf8').trim().split('\n').filter(Boolean) : []
  /** Runs the original call in a first worker until it reaches `cut`, then SIGKILLs it. */
  async function original(cut: Exclude<Cut, 'none'>) {
    const first = await start('execute', cut)
    const reached =
      cut === 'in-transaction'
        ? until(() => existsSync(files.flag)).then(() => ({}) as Record<string, unknown>)
        : message(
            first.child,
            (value) =>
              value.phase ===
              (cut === 'after-save' ? 'durable' : cut === 'before-save' ? 'in-flight' : 'executed'),
          )
    first.child.send({ op: 'execute' })
    const seen = await reached
    expect(first.child.exitCode).toBeNull()
    await terminate(first.child)
    expect(first.child.signalCode).toBe('SIGKILL')
    return { first, seen }
  }
  /** A fresh process asks the original attempt's question in both ways the adapter exposes. */
  async function recover(extra: 'none' | 'resend-first' = 'none') {
    const second = await start('recover', 'none')
    let resent: Record<string, unknown> | undefined
    if (extra === 'resend-first') {
      const sent = message(second.child, (value) => value.phase === 'resent')
      second.child.send({ op: 'resend' })
      resent = await sent
    }
    const answered = message(second.child, (value) => value.phase === 'recovered')
    second.child.send({ op: 'recover' })
    const answer = await answered
    return {
      second,
      resent,
      sends: answer.sends,
      pending: answer.pending,
      leaf: reconcile(answer.leaf),
      targeted: reconcile(answer.targeted),
    }
  }
  return { files, wire, original, recover }
}
function reconcile(value: unknown): ReconcileResult {
  const checked = validateRuntime('ReconcileResult', value)
  if (!checked.ok) throw Error('Invalid ReconcileResult from the worker')
  return checked.value
}
function effect(value: unknown): EffectResult {
  const checked = validateRuntime('EffectResult', value)
  if (!checked.ok) throw Error('Invalid EffectResult from the worker')
  return checked.value
}

describe('model source store across process death', () => {
  it.each(['openai-completions', 'anthropic-messages'] as const)(
    'returns the original %s result in a fresh PID after SIGKILL following the durable save, without a resend',
    async (api) => {
      const w = await world(api, true)
      const { first, seen } = await w.original('after-save')
      const original = effect(seen.result)
      expect(original.outcome).toBe('succeeded')
      expect(original.usage).toHaveLength(1)
      expect(w.wire()).toHaveLength(1)
      const answer = await w.recover()
      expect(answer.second.pid).not.toBe(first.pid)
      for (const reply of [answer.leaf, answer.targeted]) {
        if (reply.kind !== 'resolved') throw Error(`expected resolved, got ${reply.kind}`)
        expect(canonicalJsonDigest(reply.result as never)).toBe(seen.resultDigest)
        expect(reply.result.usage).toEqual(original.usage)
        expect(reply.result.externalRequests).toEqual(original.externalRequests)
      }
      expect(answer.sends).toBe(0)
      expect(answer.pending).toEqual([])
      expect(w.wire()).toHaveLength(1)
    },
    120000,
  )

  it.each(['openai-completions', 'anthropic-messages'] as const)(
    'answers unknown, not not_found, for %s when the worker dies after the request left but before the save',
    async (api) => {
      const w = await world(api, true)
      await w.original('before-save')
      expect(w.wire()).toHaveLength(1)
      const answer = await w.recover()
      for (const reply of [answer.leaf, answer.targeted])
        expect(reply).toMatchObject({ kind: 'unknown', reason: 'model_sent_unsaved' })
      expect(answer.pending).toEqual(['sent_unsaved'])
      expect(answer.sends).toBe(0)
      expect(w.wire()).toHaveLength(1)
    },
    120000,
  )

  it('rolls back a save that is killed between the row write and the commit', async () => {
    const w = await world('openai-completions', true)
    await w.original('in-transaction')
    expect(w.wire()).toHaveLength(1)
    const answer = await w.recover()
    for (const reply of [answer.leaf, answer.targeted])
      expect(reply).toMatchObject({ kind: 'unknown', reason: 'model_sent_unsaved' })
    expect(answer.sends).toBe(0)
    expect(w.wire()).toHaveLength(1)
  }, 120000)

  it('reports a failed save as unconfirmed and a fresh process as sent but unsaved', async () => {
    const w = await world('openai-completions', true)
    const { seen } = await w.original('save-fails')
    expect(effect(seen.result)).toMatchObject({
      outcome: 'unknown_effect',
      error: { detailCode: 'model_receipt_unconfirmed' },
    })
    const answer = await w.recover()
    for (const reply of [answer.leaf, answer.targeted])
      expect(reply).toMatchObject({ kind: 'unknown', reason: 'model_sent_unsaved' })
    expect(answer.sends).toBe(0)
    expect(w.wire()).toHaveLength(1)
  }, 120000)

  it('answers not_found only when nothing ever left and the store declared its send fence', async () => {
    const fenced = await world('openai-completions', true)
    const answer = await fenced.recover()
    for (const reply of [answer.leaf, answer.targeted])
      expect(reply).toMatchObject({ kind: 'not_found', safeToRetry: false })
    expect(fenced.wire()).toHaveLength(0)
    const plain = await world('openai-completions', false)
    const unfenced = await plain.recover()
    for (const reply of [unfenced.leaf, unfenced.targeted])
      expect(reply).toMatchObject({ kind: 'unknown', reason: 'model_not_recorded' })
    expect(plain.wire()).toHaveLength(0)
  }, 120000)

  it('refuses a second execute of the same attempt in a fresh process and sends nothing', async () => {
    const w = await world('openai-completions', true)
    const { seen } = await w.original('after-save')
    const answer = await w.recover('resend-first')
    expect(effect(answer.resent?.result)).toMatchObject({
      outcome: 'failed',
      error: { detailCode: 'model_not_sent' },
    })
    expect(answer.resent?.sends).toBe(0)
    if (answer.leaf.kind !== 'resolved') throw Error('the original result must survive the refused resend')
    expect(canonicalJsonDigest(answer.leaf.result as never)).toBe(seen.resultDigest)
    expect(answer.sends).toBe(0)
    expect(w.wire()).toHaveLength(1)
  }, 120000)

  it('never returns a result whose stored bytes were altered', async () => {
    const w = await world('openai-completions', true)
    await w.original('after-save')
    const db = new DatabaseSync(w.files.store)
    try {
      db.exec(`UPDATE model_attempts SET result=replace(result,'"value":"7"','"value":"8"')`)
      expect(
        db.prepare(`SELECT count(*) AS n FROM model_attempts WHERE result LIKE '%"value":"8"%'`).get()?.n,
      ).toBe(1)
    } finally {
      db.close()
    }
    const answer = await w.recover()
    for (const reply of [answer.leaf, answer.targeted])
      expect(reply).toMatchObject({ kind: 'unknown', reason: 'model_store_corrupt' })
    expect(answer.sends).toBe(0)
    expect(w.wire()).toHaveLength(1)
  }, 120000)

  it('lets exactly one of many processes fence the same attempt, even when they create the file together', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'model-source-fence-'))
    directories.push(directory)
    const path = join(directory, 'model-source.sqlite')
    const runs = Array.from(
      { length: 16 },
      () =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, ['--import', 'tsx', fenceChild, path], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (bytes) => {
            stdout += String(bytes)
          })
          child.stderr.on('data', (bytes) => {
            stderr += String(bytes)
          })
          child.on('error', reject)
          child.on('close', (code) => resolve({ code, stdout, stderr }))
        }),
    )
    const results = await Promise.all(runs)
    expect(
      results.map((result) => result.code),
      results.map((result) => result.stderr).join('\n'),
    ).toEqual(Array(16).fill(0))
    expect(results.filter((result) => JSON.parse(result.stdout).fenced === true)).toHaveLength(1)
  }, 60000)
})

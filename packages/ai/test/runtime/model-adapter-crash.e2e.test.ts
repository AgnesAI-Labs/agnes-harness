import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonDigest, type EffectResult, validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'

function message(child: ChildProcess, accept: (value: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let stderr = ''
    const err = (chunk: Buffer) => {
      stderr += chunk.toString()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(Error(`Provider IPC deadline: ${stderr}`))
    }, 15000)
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
      reject(Error(`Provider process exited: ${stderr}`))
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
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await stopped
}
it.each(['openai-completions', 'anthropic-messages'] as const)(
  'recovers the default %s adapter receipt in a fresh PID after SIGKILL inside its durable save boundary without resend',
  async (api) => {
    const directory = mkdtempSync(join(tmpdir(), 'default-model-crash-')),
      receipt = join(directory, 'receipt.json'),
      operation = join(directory, 'operation.json'),
      requests = join(directory, 'wire.jsonl')
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
      const server = run([fileURLToPath(new URL('./fixtures/model-http.mjs', import.meta.url)), requests])
      const listening = await message(server, (value) => typeof value.port === 'number'),
        endpoint = `http://127.0.0.1:${listening.port}/v1`
      const worker = async (mode: 'execute' | 'recover') => {
        const child = run([
          '--import',
          'tsx',
          fileURLToPath(new URL('./fixtures/model-crash-worker.ts', import.meta.url)),
          api,
          endpoint,
          receipt,
          operation,
          mode,
        ])
        const ready = await message(child, (value) => value.phase === 'ready')
        return { child, pid: ready.pid }
      }
      const first = await worker('execute'),
        durable = message(first.child, (value) => value.phase === 'durable')
      first.child.send({ op: 'execute' })
      const issued = await durable,
        checked = validateRuntime('EffectResult', issued.result)
      if (!checked.ok) throw Error('Actual original adapter result invalid')
      const original: EffectResult = checked.value
      expect(original.outcome).toBe('succeeded')
      expect(original.externalRequests).toHaveLength(1)
      expect(original.usage).toHaveLength(1)
      expect(original.usage[0]?.actionId).toBe('action')
      expect(original.usage[0]?.attemptId).toBe('attempt')
      const dimensions = original.usage[0]?.dimensions
      expect(dimensions?.kind).toBe('inline')
      if (dimensions?.kind !== 'inline') throw Error('Original measured usage missing')
      const measured = validateRuntime('UsageMeasurement', dimensions.value)
      if (!measured.ok) throw Error('Original measured usage is not official')
      expect(measured.value.kind).toBe('reported')
      expect(measured.value.actualModel).toBe('fixture-model')
      expect(
        measured.value.quantities.find((quantity) => quantity.unit === 'fixture.input-token')?.value,
      ).toBe('7')
      expect(
        measured.value.quantities.find((quantity) => quantity.unit === 'fixture.output-token')?.value,
      ).toBe('3')
      const receiptBytes = readFileSync(receipt, 'utf8'),
        operationBytes = readFileSync(operation, 'utf8')
      const originalOperation = JSON.parse(operationBytes)
      expect(validateRuntime('ActionFrame', originalOperation.frame).ok).toBe(true)
      expect(validateRuntime('PreparedModelRequest', originalOperation.source.prepared).ok).toBe(true)
      expect(originalOperation.source.prepared.target.priceVersion).toBe('fixture-price-1')
      expect(originalOperation.frame.requestIdentity.aghRequestId).toBe('fixture-request')
      expect(originalOperation.frame.requestIdentity.idempotencyKey).toBe('fixed-external-key')
      const originalReceipt = JSON.parse(receiptBytes)
      expect(validateRuntime('Digest', originalReceipt.bodyDigest).ok).toBe(true)
      expect(originalReceipt.requestIdentity).toEqual(originalOperation.frame.requestIdentity)
      expect(originalReceipt.preparedPriceVersion).toBe(originalOperation.source.prepared.target.priceVersion)
      expect(originalReceipt.usage).toEqual(original.usage)
      expect(first.child.pid).toBe(first.pid)
      expect(server.pid).not.toBe(first.pid)
      expect(first.child.exitCode).toBeNull()
      await kill(first.child)
      expect(first.child.signalCode).toBe('SIGKILL')
      const second = await worker('recover')
      expect(second.pid).not.toBe(first.pid)
      expect(second.child.pid).toBe(second.pid)
      const recovering = message(second.child, (value) => value.phase === 'recovered')
      second.child.send({ op: 'recover' })
      const answer = await recovering,
        reconciled = validateRuntime('ReconcileResult', answer.result)
      if (!reconciled.ok || reconciled.value.kind !== 'resolved')
        throw Error('Default adapter original receipt recovery missing')
      expect(canonicalJsonDigest(reconciled.value.result)).toBe(canonicalJsonDigest(original))
      expect(reconciled.value.result.usage).toEqual(original.usage)
      expect(reconciled.value.result.externalRequests).toEqual(original.externalRequests)
      expect(answer.sends).toBe(0)
      expect(canonicalJsonDigest(answer.frame as never)).toBe(originalOperation.frameDigest)
      expect(canonicalJsonDigest(answer.source as never)).toBe(originalOperation.sourceDigest)
      expect(readFileSync(receipt, 'utf8')).toBe(receiptBytes)
      expect(readFileSync(operation, 'utf8')).toBe(operationBytes)
      const physical = readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(physical).toHaveLength(1)
      expect(physical[0].input.model).toBe('fixture-model')
      expect(physical[0].credentialMatched).toBe(true)
      expect(server.exitCode).toBeNull()
    } finally {
      await Promise.all(children.map(kill))
      rmSync(directory, { recursive: true, force: true })
    }
  },
  45000,
)

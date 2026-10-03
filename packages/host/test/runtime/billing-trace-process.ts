import { type ChildProcess, fork } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderDescriptor, TelemetryConsent } from '@agnes/protocol/runtime'
import {
  billingInput,
  billingTraceProviderDigest,
  exportInput,
  refundInput,
  traceInput,
} from './billing-trace-fixture.js'

const fixtureRoot = fileURLToPath(new URL('../../../../tools/acceptance/runtime/fixtures/', import.meta.url))
export function startFixture(file: string, args: string[]) {
  const child = fork(join(fixtureRoot, file), args, {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.stdout?.resume()
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture start timed out: ${stderr}`)), 30000)
    child.once('message', (value) => {
      clearTimeout(timer)
      resolve(value as Record<string, unknown>)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`fixture exited: ${stderr}`))
    })
  })
  return { child, ready }
}
export async function killFixture(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await done
}
export function billingTraceProcessDriver(
  service: 'billing' | 'trace',
  kind: 'default' | 'reference',
  options: {
    path?: string
    level?: TelemetryConsent['level']
    crashAfterSend?: boolean
    accountingChain?: boolean
    crashBoundary?: 'usage' | 'budget' | 'intent' | 'callback'
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'billing-trace-')),
    log = join(directory, 'peer.jsonl')
  writeFileSync(log, '', { mode: 0o600 })
  let peer: ChildProcess | undefined,
    actor: ChildProcess | undefined,
    port = 0,
    descriptor: ProviderDescriptor,
    serial = 0,
    closed = false
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  async function launch() {
    const proc = startFixture('billing-trace-provider.ts', [
      JSON.stringify({ directory, service, kind, port, ...options }),
    ])
    actor = proc.child
    const info = await proc.ready
    descriptor = info.descriptor as ProviderDescriptor
    actor.on('message', (message: { id?: number; result?: unknown; error?: string }) => {
      if (typeof message.id !== 'number') return
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id)
      if (message.error) task.reject(new Error(message.error))
      else task.resolve(message.result)
    })
    actor.on('exit', () => {
      for (const task of pending.values()) task.reject(new Error('provider process exited'))
      pending.clear()
    })
    return Number(info.pid)
  }
  function invoke(method: string, input: unknown = null, mode?: string): Promise<unknown> {
    const id = ++serial
    return new Promise((resolve, reject) => {
      if (!actor?.connected) {
        reject(new Error('fixture not connected'))
        return
      }
      pending.set(id, { resolve, reject })
      actor.send({ id, method, input, mode })
    })
  }
  const records = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { path: string; body: unknown })
  const driver = {
    directory,
    log,
    expectedProviderId: `agh.${kind}/${service}`,
    expectedPackageDigest: billingTraceProviderDigest(kind, service),
    input: structuredClone(service === 'trace' ? traceInput : billingInput),
    exportInput: exportInput(options.level),
    refundInput,
    async start() {
      if (!peer) {
        const proc = startFixture(service === 'trace' ? 'otlp-receiver.ts' : 'billing-receipt-server.ts', [
          log,
        ])
        peer = proc.child
        port = Number((await proc.ready).port)
        await launch()
        if (options.accountingChain && !options.crashBoundary)
          Object.assign(driver.input, await invoke('prepare-accounting'))
      }
      return descriptor
    },
    record: (input: unknown, mode?: string) => invoke('record', input, mode),
    export: (input: unknown, mode?: string) => invoke('export', input, mode),
    post: (input: unknown, mode?: string) => invoke('post', input, mode),
    refund: (input: unknown) => invoke('refund', input),
    invoke,
    async cancel() {
      await invoke('cancel')
    },
    async stop() {
      await invoke('stop')
    },
    async restart() {
      const previousPid = actor?.pid ?? 0
      await killFixture(actor)
      const pid = await launch()
      return { previousPid, pid }
    },
    async restartPeer() {
      await killFixture(actor)
      await killFixture(peer)
      const proc = startFixture('billing-receipt-server.ts', [log])
      peer = proc.child
      port = Number((await proc.ready).port)
      await launch()
    },
    async deliveries() {
      return records().length
    },
    records,
    retirePrice: () => invoke('retire-price') as Promise<void>,
    accountingStats: () =>
      invoke('accounting-stats') as Promise<{ usageFacts: number; origins: number; settled: string }>,
    async waitReceived() {
      const end = Date.now() + 10000
      while (Date.now() < end) {
        if (records().length) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('peer did not receive request')
    },
    async close() {
      if (closed) return
      closed = true
      await killFixture(actor)
      await killFixture(peer)
      rmSync(directory, { recursive: true, force: true })
    },
  }
  return driver
}
export function traceContractDriver(kind: 'default' | 'reference', scenario: string) {
  return {
    ...billingTraceProcessDriver('trace', kind, {
      path: ['cancel', 'dispose'].includes(scenario) ? '/hang' : '/v1/traces',
    }),
    input: traceInput,
  }
}
export function billingContractDriver(kind: 'default' | 'reference', scenario: string) {
  const driver = billingTraceProcessDriver('billing', kind, {
    accountingChain: true,
    path: ['cancel', 'dispose'].includes(scenario) ? '/hang' : '/billing',
  })
  return { ...driver, input: driver.input as typeof billingInput }
}

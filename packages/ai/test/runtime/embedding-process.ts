import { type ChildProcess, fork } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as W from '@agnes/protocol/runtime'
import { type EmbeddingFixtureOptions, embeddingInput, embeddingProviderDigest } from './embedding-fixture.js'
import { embeddingUsageCount } from './embedding-usage.js'

export function embeddingProcessDriver(
  kind: 'default' | 'reference',
  scenario: string,
  options: Partial<EmbeddingFixtureOptions> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'embedding-cold-'))
  let actor: ChildProcess | undefined,
    descriptor: W.ProviderDescriptor,
    sequence = 0,
    crashAfterUsage = options.crashAfterUsage ?? false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const counts = async () => {
    const count = (name: string) => {
      try {
        return readFileSync(join(directory, `${name}.jsonl`), 'utf8')
          .split('\n')
          .filter(Boolean).length
      } catch {
        return 0
      }
    }
    return { deliveries: count('deliveries'), usages: embeddingUsageCount(directory) }
  }
  async function launch(): Promise<number> {
    const next = fork(
      new URL('./fixtures/embedding-process.ts', import.meta.url),
      [
        JSON.stringify({
          ...options,
          kind,
          directory,
          hang: scenario === 'cancel' || scenario === 'dispose',
          crashAfterUsage,
        }),
      ],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    )
    actor = next
    let stderr = ''
    next.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    next.stdout?.resume()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Embedding process startup timeout: ${stderr}`)), 30000)
      next.on(
        'message',
        (message: {
          ready?: boolean
          pid?: number
          descriptor?: W.ProviderDescriptor
          id?: number
          result?: unknown
          error?: string
        }) => {
          if (message.ready && message.descriptor) {
            clearTimeout(timer)
            descriptor = message.descriptor
            resolve(message.pid ?? 0)
            return
          }
          if (typeof message.id !== 'number') return
          const task = pending.get(message.id)
          if (task) {
            pending.delete(message.id)
            message.error ? task.reject(Error(message.error)) : task.resolve(message.result)
          }
        },
      )
      next.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      next.once('exit', () => {
        clearTimeout(timer)
        reject(Error(`Embedding process exited: ${stderr}`))
        for (const task of pending.values()) task.reject(Error('Embedding process exited'))
        pending.clear()
      })
    })
  }
  function invoke(method: string, input: unknown = null, mode?: string): Promise<unknown> {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      if (!actor?.connected) {
        reject(Error('Embedding process unavailable'))
        return
      }
      pending.set(id, { resolve, reject })
      actor.send({ id, method, input, mode })
    })
  }
  async function kill() {
    if (!actor || actor.exitCode !== null || actor.signalCode !== null) return
    const end = new Promise<void>((resolve) => actor?.once('exit', () => resolve()))
    actor.kill('SIGKILL')
    await end
  }
  return {
    directory,
    input: options.input ?? embeddingInput,
    expectedProviderId: `agh.${kind}/embedding`,
    expectedPackageDigest: embeddingProviderDigest(kind),
    async start() {
      if (!actor) await launch()
      return descriptor
    },
    encode: (input: W.EmbeddingEncodeRequest, mode?: string) =>
      invoke('encode', input, mode) as Promise<W.EffectResult>,
    reconcile: (input: W.EmbeddingEncodeRequest) => invoke('reconcile', input) as Promise<W.ReconcileResult>,
    counts,
    async readVectorsBlob(ref: W.BytesRef) {
      if (!/^[a-f0-9]{64}$/.test(ref.blobId)) throw Error('Restricted blob identity')
      return new Uint8Array(readFileSync(join(directory, 'content', ref.blobId)))
    },
    cancel: async () => {
      await invoke('cancel')
    },
    stop: async () => {
      await invoke('stop')
    },
    async restart() {
      const previousPid = actor?.pid ?? 0
      await kill()
      crashAfterUsage = false
      return { previousPid, pid: await launch() }
    },
    async waitReceived() {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if ((await counts()).deliveries) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw Error('Embedding fixture delivery absent')
    },
    async close() {
      await kill()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, stampFor } from '@agnes/ai/testkit'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import * as dagModule from '../../../examples/loops/dag-loop/index.mjs'
import * as reactModule from '../../../examples/loops/react-loop/index.mjs'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const reply = 'Refund window is 30 days.'
const answer: InferenceEvent[] = [
  { type: 'text_delta', delta: reply },
  { type: 'done', reason: 'stop' },
]
const plan: InferenceEvent[] = [
  { type: 'text_delta', delta: '[]' },
  { type: 'done', reason: 'stop' },
]

const cases = {
  react: {
    selection: { id: 'example.react', version: '1.0.0' },
    packageId: '@agnes-example/react-loop',
    source: new URL('../../../examples/loops/react-loop', import.meta.url),
    module: reactModule,
    scripts: [answer],
  },
  dag: {
    selection: { id: 'example.dag', version: '1.0.0' },
    packageId: '@agnes-example/dag-loop',
    source: new URL('../../../examples/loops/dag-loop', import.meta.url),
    module: dagModule,
    scripts: [plan, answer],
  },
} as const

async function runExampleTurn(kind: keyof typeof cases) {
  const spec = cases[kind]
  const dataDir = mkdtempSync(join(tmpdir(), `agnes-${kind}-loop-`))
  dirs.push(dataDir)
  const directory = join(dataDir, 'snapshot')
  cpSync(fileURLToPath(spec.source), directory, {
    recursive: true,
    filter: (path) => !path.includes('/node_modules'),
  })
  const source: RuntimePluginSnapshot = {
    snapshot: {
      packageId: spec.packageId,
      version: spec.selection.version,
      snapshotId: `sha256-${'1'.repeat(64)}`,
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'fixture',
      directory,
      profile: 'local-dev',
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { [spec.packageId]: directory },
    script: [...spec.scripts],
    disableSessionTitle: true,
    lock: {
      packages: Object.fromEntries(
        ['@agnes/ai', '@agnes/base', '@agnes/code', spec.packageId].map((id) => [
          id,
          {
            version: '1.0.0',
            integrity: source.snapshot.integrity,
            trust: id === spec.packageId ? 'trusted' : 'builtin',
            enabled: true,
          },
        ]),
      ),
    },
    profileInputs: {
      user: {
        name: 'local-dev',
        packages: [{ id: spec.packageId, source: `file:${directory}` }],
        loop: spec.selection,
      },
    },
    runtimePluginSnapshots: [source],
    runtimePluginCatalogue: [source],
    runtimePluginSources: async () => [source],
    extensionLoader: {
      import: async (file) => {
        expect(file.endsWith('/snapshot/index.mjs')).toBe(true)
        return spec.module
      },
    },
  })
  try {
    const session = await host.createSession({
      key: `${kind}-turn`,
      cwd: dataDir,
      loop: spec.selection,
    })
    expect(session.loop).toEqual(spec.selection)
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Read report.md and summarize the refund window.' }],
      actor: session.d.actor,
    })
    const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const ended = await session.scan({ type: 'turn/end', limit: 5 })
    expect(result.reason, JSON.stringify({ result, ended })).toBe('completed')
    const messages = await session.scan({ type: 'assistant/message', limit: 5 })
    expect(messages.some((row) => JSON.stringify(row.data).includes(reply))).toBe(true)
  } finally {
    await host.close()
  }
}

it('completes a scripted ReAct example turn through Host loop assembly', async () => {
  await runExampleTurn('react')
}, 30_000)

it('completes a scripted dynamic DAG example turn through Host loop assembly', async () => {
  await runExampleTurn('dag')
}, 30_000)

/** Pauses inside the first infer so a test can retire the tree or abort the run underneath it. */
class GatedProvider implements Provider {
  readonly calls: RequestBody[] = []
  readonly signals: AbortSignal[] = []
  private release: (() => void) | undefined
  private entered: (() => void) | undefined
  readonly opened = new Promise<void>((resolve) => {
    this.entered = resolve
  })
  readonly blocked = new Promise<void>((resolve) => {
    this.release = resolve
  })

  constructor(private readonly scripts: InferenceEvent[][]) {}

  models() {
    return [fakeModel({ id: 'faux-1', route: 'faux' })]
  }

  unblock(): void {
    this.release?.()
  }

  async *infer(
    req: RequestBody,
    opts: { signal: AbortSignal; toolNames: string[] },
  ): AsyncIterable<InferenceEvent> {
    const n = this.calls.length
    this.calls.push(req)
    this.signals.push(opts.signal)
    if (n === 0) {
      this.entered?.()
      await this.blocked
    }
    const events = this.scripts[n] ?? this.scripts.at(-1) ?? []
    if (opts.signal.aborted) {
      yield { type: 'sent', stamp: stampFor(req) }
      yield { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false }
      return
    }
    if (events[0]?.type !== 'sent') yield { type: 'sent', stamp: stampFor(req) }
    for (const event of events) {
      if (opts.signal.aborted) {
        yield { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false }
        return
      }
      yield event
      if (event.type === 'done' || event.type === 'error') return
    }
  }
}

async function openExample(kind: keyof typeof cases, provider: Provider) {
  const spec = cases[kind]
  const dataDir = mkdtempSync(join(tmpdir(), `agnes-${kind}-probe-`))
  dirs.push(dataDir)
  const directory = join(dataDir, 'snapshot')
  cpSync(fileURLToPath(spec.source), directory, {
    recursive: true,
    filter: (path) => !path.includes('/node_modules'),
  })
  const source: RuntimePluginSnapshot = {
    snapshot: {
      packageId: spec.packageId,
      version: spec.selection.version,
      snapshotId: `sha256-${'1'.repeat(64)}`,
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'fixture',
      directory,
      profile: 'local-dev',
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { [spec.packageId]: directory },
    provider,
    disableSessionTitle: true,
    lock: {
      packages: Object.fromEntries(
        ['@agnes/ai', '@agnes/base', '@agnes/code', spec.packageId].map((id) => [
          id,
          {
            version: '1.0.0',
            integrity: source.snapshot.integrity,
            trust: id === spec.packageId ? 'trusted' : 'builtin',
            enabled: true,
          },
        ]),
      ),
    },
    profileInputs: {
      user: {
        name: 'local-dev',
        packages: [{ id: spec.packageId, source: `file:${directory}` }],
        loop: spec.selection,
      },
    },
    runtimePluginSnapshots: [source],
    runtimePluginCatalogue: [source],
    runtimePluginSources: async () => [source],
    extensionLoader: {
      import: async (file) => {
        expect(file.endsWith('/index.mjs')).toBe(true)
        return spec.module
      },
    },
  })
  return { host, dataDir, spec }
}

async function probeTurn(
  kind: keyof typeof cases,
  disturb: 'retire' | 'run-abort',
): Promise<Record<string, unknown>> {
  const provider = new GatedProvider([...cases[kind].scripts])
  const { host, dataDir, spec } = await openExample(kind, provider)
  const runSignal = new AbortController()
  try {
    const session = await host.createSession({
      key: `${kind}-${disturb}`,
      cwd: dataDir,
      loop: spec.selection,
    })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Read report.md and summarize the refund window.' }],
      actor: session.d.actor,
    })
    const running = session.run({ until: 'turn-end', signal: runSignal.signal })
    const started = await Promise.race([
      provider.opened.then(() => 'infer' as const),
      running.then(() => 'ended' as const),
    ])
    let disturbance: string = 'skipped'
    if (started === 'infer') {
      const action =
        disturb === 'retire'
          ? host.extensionRows
              .apply([
                host.extensionRows.prepare({
                  extensionId: 'agnes/tools-core',
                  config: { note: 'retire-during-infer' },
                }),
              ])
              .then(() => 'applied')
          : Promise.resolve().then(() => {
              runSignal.abort()
              return 'aborted-run'
            })
      disturbance = await Promise.race([
        action,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 8_000)),
      ])
      provider.unblock()
    }
    const result = await running
    const ended = await session.scan({ type: 'turn/end', limit: 5 })
    return {
      kind,
      disturb,
      started,
      disturbance,
      runReason: result.reason,
      turnEnd: ended.map((row) => (row.data as { reason?: string }).reason),
      inferAborted: provider.signals[0]?.aborted ?? null,
      runAborted: runSignal.signal.aborted,
    }
  } finally {
    provider.unblock()
    await host.close()
  }
}

it('cancels an example turn only when the session run signal aborts', async () => {
  const report = []
  for (const disturb of ['retire', 'run-abort'] as const)
    for (const kind of ['react', 'dag'] as const) report.push(await probeTurn(kind, disturb))
  const completed = {
    started: 'infer',
    disturbance: 'applied',
    runReason: 'completed',
    turnEnd: ['completed'],
    inferAborted: false,
    runAborted: false,
  }
  const aborted = {
    started: 'infer',
    disturbance: 'aborted-run',
    runReason: 'aborted',
    turnEnd: ['aborted'],
    inferAborted: true,
    runAborted: true,
  }
  expect(report).toEqual([
    { kind: 'react', disturb: 'retire', ...completed },
    { kind: 'dag', disturb: 'retire', ...completed },
    { kind: 'react', disturb: 'run-abort', ...aborted },
    { kind: 'dag', disturb: 'run-abort', ...aborted },
  ])
}, 120_000)

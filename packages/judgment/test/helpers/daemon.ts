import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { answersFor, type FakeSystemOneBehaviour, startFakeSystemOne } from '@agnes/ai/testkit'
import { redactSecrets } from '@agnes/extension-api'
import { createCredentialStore, initializeHome } from '@agnes/host'
import type { EventEnvelope, PackageOperationReceipt } from '@agnes/protocol'
import { createClient, memoryJournal, unixTransport } from '@agnes/sdk'

export const PROFILE = 'local-dev'
export const PACKAGE = '@agnes/judgment'
export const CALLER = 'ext:agnes.judgment/main'
export const MODEL = 'typesafe/jev-1.13-20260917'
export const PROMISE_REPLY = 'I will inspect the synthetic sample file now.'
export const DONE_REPLY = 'The synthetic inspection is complete.'
const sourceDaemon = fileURLToPath(
  new URL('../../../daemon/test/fixtures/source-loop-daemon.ts', import.meta.url),
)

export async function bounded<T>(promise: Promise<T>, label: string, ms = 120_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type Sdk = ReturnType<typeof createClient>
type Session = Awaited<ReturnType<Sdk['session']['new']>>
export type TurnCapture = {
  events: EventEnvelope[]
  elapsed: number
  stoppingMs: number
  ui: Awaited<ReturnType<Session['projectUI']>>
  result: Awaited<ReturnType<Session['prompt']>>
}

/** A real daemon/SDK fixture. Only synthetic text and a loopback credential enter its home. */
export async function judgmentDaemon(options: { scriptedTool?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-judgment-e2e-')))
  let daemon: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  let sdk: Sdk | undefined
  let socketDirectory: string | undefined
  let installed = false
  let configKey: string | undefined
  let stderr = ''
  let delayedUntil = 0
  let behaviour: FakeSystemOneBehaviour = {}
  let probability = 0.1
  let closing: Promise<void> | undefined
  const fake = await startFakeSystemOne((_n, seen) => {
    if (behaviour.delayMs) delayedUntil = Math.max(delayedUntil, Date.now() + behaviour.delayMs)
    const questions = (seen.body as { questions?: Record<string, unknown> })?.questions ?? {}
    const answers = answersFor(questions)
    for (const [id, value] of Object.entries(questions)) {
      if ((value as { type?: string }).type === 'noul') answers[id] = { type: 'noul', noul: probability }
    }
    return { answers, ...behaviour }
  })
  const shutdown = async () => {
    try {
      await sdk?.close()
    } finally {
      try {
        if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
          daemon.kill('SIGTERM')
          const kill = setTimeout(() => daemon?.kill('SIGKILL'), 20_000)
          try {
            await bounded(exited!, 'owned daemon shutdown', 25_000)
          } finally {
            clearTimeout(kill)
          }
        }
      } finally {
        try {
          await fake.close()
          // The shared fake owns delayed response timers even after its client disconnects.
          const remaining = delayedUntil - Date.now()
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining + 25))
        } finally {
          if (socketDirectory) rmSync(socketDirectory, { recursive: true, force: true })
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
  }
  const close = () => (closing ??= shutdown())
  try {
    initializeHome(root, PROFILE)
    await createCredentialStore({ root }).putApiKey('secret://jev/key', 'TEST-KEY-0123456789')
    const model = (over: Record<string, unknown>) => ({
      name: over.id,
      reasoning: false,
      input: ['text'],
      contextWindow: 65536,
      maxTokens: 8192,
      toolCallFormats: [],
      thinkingReplay: 'drop',
      contract_id: null,
      cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...over,
    })
    const reply = (text: string) => [
      { type: 'text_delta', delta: text },
      {
        type: 'usage',
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ]
    const toolReply = (toolUseId: string) => [
      {
        type: 'toolcall_end',
        call: { toolUseId, name: 'read', args: { path: 'synthetic-rule.txt' }, ordinal: 0 },
      },
      ...reply('').filter((event) => event.type === 'usage'),
      { type: 'done', reason: 'toolUse' },
    ]
    if (options.scriptedTool)
      writeFileSync(join(root, 'synthetic-rule.txt'), 'Synthetic record: pending review. No private data.\n')
    writeFileSync(
      join(root, 'profiles', PROFILE, 'profile.yaml'),
      JSON.stringify({
        name: PROFILE,
        computerUse: { enabled: false },
        limits: { 'worker.startup_ms': 120_000 },
        adapters: { secrets: { kind: 'file', path: join(root, 'secrets') } },
        provider: {
          package: '@agnes/ai',
          catalog: { include: [] },
          routes: [
            ...['jev-a', 'jev-b'].map((route) => ({
              route,
              api: 'typesafe-systemone',
              baseUrl: fake.url,
              credentialRef: 'secret://jev/key',
              models: [model({ id: MODEL, route, api: 'typesafe-systemone', baseUrl: fake.url })],
            })),
            {
              route: 'main',
              api: 'scripted',
              baseUrl: 'https://scripted.invalid',
              compat: {
                replies: options.scriptedTool
                  ? [toolReply('read-one'), reply(DONE_REPLY), toolReply('read-two'), reply(DONE_REPLY)]
                  : [reply(PROMISE_REPLY), reply(DONE_REPLY)],
                repeatLast: true,
              },
              models: [
                model({
                  id: 'main-1',
                  route: 'main',
                  api: 'scripted',
                  baseUrl: 'https://scripted.invalid',
                  toolCallFormats: ['native'],
                  contextWindow: 200000,
                }),
              ],
            },
          ],
        },
      }),
    )
    daemon = spawn(process.execPath, ['--import', 'tsx', sourceDaemon, root, root], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: root, NO_PROXY: '127.0.0.1,localhost' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    exited = new Promise((resolve) => daemon!.once('exit', resolve))
    await bounded(
      new Promise<void>((resolve, reject) => {
        daemon!.once('error', reject)
        daemon!.stderr?.on('data', (data) => {
          stderr = (stderr + String(data)).slice(-64 * 1024)
          if (stderr.includes('agnesd listening on ')) resolve()
        })
        daemon!.once('exit', (code) => reject(new Error(`owned daemon exited ${code}: ${redactSecrets(stderr).replaceAll(root, '[owned-home]').slice(-8000)}`)))
      }),
      'daemon boot',
    )
    const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
    const pipe = owner.socketPath.startsWith('\\\\.\\pipe\\')
    socketDirectory = pipe ? undefined : dirname(owner.socketPath)
    sdk = createClient({
      journal: memoryJournal(),
      timeouts: { request: 120_000 },
      transport: {
        kind: 'unix',
        path: owner.socketPath,
        ...(pipe ? { serverIdentity: { pid: owner.pid, processStartId: owner.processStartId } } : {}),
      },
      transportFactories: {
        unix: (option) => {
          if (option.kind !== 'unix') throw new Error('expected owned daemon transport')
          return unixTransport(option)
        },
      },
    })
    const client = sdk
    await bounded(client.initialize(), 'SDK initialize')
    async function operation(receipt: PackageOperationReceipt, stage = 'package-operation') {
      const deadline = Date.now() + (options.scriptedTool ? 45_000 : 120_000)
      let last: Awaited<ReturnType<Sdk['packages']['operation']['get']>> | undefined
      let previous = ''
      const stages: { stage: string; operation: string; state: string; progress: number }[] = []
      const diagnostic = async () => {
        const packages = await bounded(
          client.packages.list({ profile: PROFILE }),
          'package diagnostic',
          3000,
        ).catch(() => null)
        return JSON.stringify({
          stage,
          stages,
          operation: last?.operation,
          state: last?.state,
          progress: last?.progress,
          error: last?.error,
          packages: packages?.packages
            .filter((pkg) => pkg.id === PACKAGE)
            .map((pkg) => ({
              id: pkg.id,
              actual: pkg.actual,
              primaryStatus: pkg.primaryStatus,
              reason: pkg.actualReason,
            })),
          stderr: redactSecrets(stderr).replaceAll(root, '[owned-home]').slice(-8000),
        })
      }
      while (Date.now() < deadline) {
        last = await client.packages.operation.get(receipt)
        if (options.scriptedTool && previous !== last.state) {
          previous = last.state
          stages.push({ stage, operation: last.operation, state: last.state, progress: last.progress })
          if (stages.length > 32) stages.shift()
        }
        if (last.state === 'completed') return last
        if (['failed', 'cancelled', 'rolled-back'].includes(last.state)) throw new Error(await diagnostic())
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`owned package operation timed out: ${await diagnostic()}`)
    }
    return {
      sdk: client,
      operation,
      fake,
      root,
      close,
      respond(next: FakeSystemOneBehaviour = {}, yes = 0.1) {
        behaviour = next
        probability = yes
      },
      session: (name: string) => client.session.new({ cwd: root, sessionKey: `judgment-${name}` }),
      async configure(value: Parameters<Sdk['packages']['config']['save']>[0]['value']) {
        const common = { profile: PROFILE, clientId: await client.clientId() }
        if (!installed) {
          const source = { type: 'file' as const, ref: 'file:./bundled-plugins/judgment' }
          const inspected = await operation(
            await client.packages.inspect({ ...common, commandId: 'judgment-inspect', source }),
            'inspect',
          )
          const preview = inspected.preview
          if (!preview || preview.blockers.length || !preview.capabilityHash)
            throw new Error('shipped judgment preview blocked')
          await operation(
            await client.packages.install({
              ...common,
              commandId: 'judgment-install',
              source,
              expectedIntegrity: preview.integrity,
            }),
            'install',
          )
          await operation(
            await client.packages.trust({
              ...common,
              commandId: 'judgment-trust',
              id: PACKAGE,
              expectedIntegrity: preview.integrity,
              capabilityHash: preview.capabilityHash,
            }),
            'trust',
          )
          await operation(
            await client.packages.enable({ ...common, commandId: 'judgment-enable', id: PACKAGE }),
            'enable',
          )
          installed = true
        }
        const nextKey = JSON.stringify(value)
        if (configKey === nextKey) return
        const config = await client.packages.config.get({ profile: PROFILE, id: PACKAGE })
        const saved = await client.packages.config.save({
          ...common,
          id: PACKAGE,
          rowId: CALLER,
          value,
          expectedRevision: config.revision,
          commandId: `judgment-config-${config.revision}`,
        })
        if (!saved.ok) throw new Error('judgment configuration rejected')
        configKey = nextKey
      },
      async turn(session: Session, text: string): Promise<TurnCapture> {
        const events: EventEnvelope[] = []
        const iterator = session
          .events({
            types: [
              'tool/result',
              'x/plugin/524280817e87343c/rules.reminded',
              'user/message',
              'assistant/message',
              'cost/ledger',
              'effect/settled',
              'x/core/side-call-intent',
              'turn/end',
              'x/plugin/524280817e87343c/stop.continued',
            ],
          })
          [Symbol.asyncIterator]()
        const collect = (async () => {
          for (;;) {
            const item = await iterator.next()
            if (item.done) break
            const event = item.value
            events.push(event)
            if (event.type === 'turn/end') break
          }
        })()
        // Observe early attach failures immediately, while preserving the error for the awaited check.
        void collect.catch(() => undefined)
        const cancellation = new AbortController()
        const deadline = setTimeout(() => cancellation.abort(), 20_000)
        const prompt = session.prompt(text, { signal: cancellation.signal })
        try {
          const start = Date.now()
          const result = await bounded(prompt, 'synthetic turn', 25_000)
          if (cancellation.signal.aborted)
            throw new Error('synthetic turn exceeded its cancellation deadline')
          if (result.reason !== 'completed') throw new Error(`synthetic turn ended ${result.reason}`)
          const elapsed = Date.now() - start
          await bounded(collect, 'terminal event delivery', 5000)
          const assistant = events.findLast((event) => event.type === 'assistant/message')
          const end = events.findLast((event) => event.type === 'turn/end')
          if (!assistant || !end) throw new Error('synthetic model or terminal event absent')
          return {
            events,
            elapsed,
            stoppingMs: Date.parse(end.ts) - Date.parse(assistant.ts),
            ui: await session.projectUI(),
            result,
          }
        } catch (error) {
          cancellation.abort()
          try {
            await bounded(session.cancel(), 'failed synthetic turn cancellation', 3000)
            await bounded(
              prompt.catch(() => undefined),
              'failed synthetic turn drain',
              3000,
            )
          } catch {
            // Stop only this fixture if cancellation cannot prove the old turn settled.
            await close()
          }
          throw error
        } finally {
          clearTimeout(deadline)
          await iterator.return?.()
          await collect.catch(() => undefined)
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

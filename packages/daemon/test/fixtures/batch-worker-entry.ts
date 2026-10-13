// A real worker (`runWorker`) over a test Host that loads the real @agnes/base extensions, the batch
// tools and their item-session hook among them, with a scripted model. See fake-worker-entry.ts for
// why the worker module is imported only after the self-start variable is cleared.
//
// Environment:
// - AGNES_BATCH_TRACE: a file this worker appends one line to per model event of interest
//   (`start <ordinal>`, `block <ordinal>`, `abort <ordinal>`, `answer <ordinal>`, `user <text>`).
// - AGNES_BATCH_CONTROL: a JSON file read at every model call; `{ "block": true }` holds an item's
//   answer until its turn is aborted; `{ "escape": true }` makes an item first ask for `write` and
//   `shell` (as an instruction hidden in a file would), tracing each result as `result <ordinal> <tool>: <text>`.
// - AGNES_BATCH_NO_HOOK=1: the batch extension registers its tools but not its tool_call hook.
// An ordinary conversation prompt `hold` is held until its turn is aborted (`hold`, `abort user`).
import { appendFileSync, createReadStream, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { PARSER_VERSION } from '@agnes/ai'
import { fakeModel, stampFor } from '@agnes/ai/testkit'
import { ecosystem as baseEcosystem } from '@agnes/base'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'

const env = { ...process.env }
delete process.env.AGNES_WORKER_TOKEN
const { runWorker } = await import('../../src/worker/main.js')

const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const trace = (line: string): void => {
  if (env.AGNES_BATCH_TRACE) appendFileSync(env.AGNES_BATCH_TRACE, `${line}\n`)
}
const control = (): { block?: boolean; escape?: boolean } => {
  try {
    return JSON.parse(readFileSync(env.AGNES_BATCH_CONTROL ?? '', 'utf8')) as {
      block?: boolean
      escape?: boolean
    }
  } catch {
    return {}
  }
}
const textOf = (message: RequestBody['messages'][number] | undefined): string =>
  message && 'content' in message
    ? message.content
        .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
        .join('')
    : ''
const call = (name: string, args: unknown): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name, args: args as never, ordinal: 0 } },
  { type: 'done', reason: 'toolUse' },
]
const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]

async function* infer(request: RequestBody, signal: AbortSignal): AsyncIterable<InferenceEvent> {
  yield { type: 'sent', stamp: { ...stampFor(request), parser_version: PARSER_VERSION } }
  if (request.kind === 'summary') return yield* say('A title')
  const first = textOf(request.messages.find((message) => message.role === 'user'))
  const last = request.messages.at(-1)
  const item = /^Item (\d+): /mu.exec(first)?.[1]
  if (item !== undefined) {
    // An escaping item asks for write and shell first (as an instruction hidden in a file would),
    // then reads its file; every item answers after its read.
    const plan = control().escape ? ['write', 'shell', 'read'] : ['read']
    // Counted within this turn: a rerun after a crash starts again from its prompt.
    const prompt = request.messages.findLastIndex((message) => message.role === 'user')
    const results = request.messages
      .slice(prompt + 1)
      .filter((message) => message.role === 'tool_result').length
    const asked = plan[results - 1]
    if (asked && asked !== 'read') trace(`result ${item} ${asked}: ${textOf(last).replace(/\s+/gu, ' ')}`)
    const next = plan[results]
    if (next !== undefined) {
      if (results === 0) trace(`start ${item}`)
      if (next === 'write') return yield* call('write', { path: 'pwned.txt', content: 'escaped' })
      if (next === 'shell') return yield* call('shell', { command: 'echo escaped > pwned-shell.txt' })
      const args = /Step 1: call the read tool with (\{.*?\})\./u.exec(first)?.[1]
      return yield* call('read', JSON.parse(args ?? '{}'))
    }
    if (control().block) {
      trace(`block ${item}`)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      trace(`abort ${item}`)
      yield { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'stopped', retryable: false }
      return
    }
    trace(`answer ${item}`)
    const read = last?.role === 'tool_result' ? textOf(last) : ''
    return yield* say(JSON.stringify({ item: Number(item), read: read.includes('content of') }))
  }
  // An ordinary conversation: "batch <tool> <json args>" calls that tool once, then reports its answer.
  if (last?.role === 'tool_result') return yield* say(`tool said: ${textOf(last)}`)
  if (textOf(last) === 'hold') {
    trace('hold')
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    trace('abort user')
    yield { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'stopped', retryable: false }
    return
  }
  const asked = /^batch (\w+) (.*)$/su.exec(textOf(last))
  trace(`user ${textOf(last).split('\n')[0]}`)
  if (asked) return yield* call(asked[1] as string, JSON.parse(asked[2] as string))
  return yield* say('hello')
}

// The built-in batch extension, minus its hook: what a Host without item confinement looks like.
type BatchFactory = (typeof baseEcosystem)['agnes/batch']
const batchWithoutHook =
  (init: Parameters<BatchFactory>[0]): ReturnType<BatchFactory> =>
  (api: Parameters<ReturnType<BatchFactory>>[0]) =>
    baseEcosystem['agnes/batch'](init)(Object.create(api, { registerHook: { value: () => () => undefined } }))

const model = () => fakeModel({ route: 'faux', id: 'faux-1' })

const gateFd = Number(env.AGNES_GATE_FD ?? 3)
const gate = Number.isInteger(gateFd) && gateFd >= 0 ? createReadStream('', { fd: gateFd }) : null

void runWorker(
  env,
  {
    connect: (path) =>
      new Promise((resolve, reject) => {
        const socket = connect(path)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      }),
    gate,
  },
  {
    buildHost: async (profile, workerPrompter, resources) => {
      const { host } = await createTestHost({
        dataDir: profile.dataDir,
        packageDirs: { '@agnes/base': baseDir },
        disableSessionTitle: true,
        ...(resources.batch ? { batch: resources.batch } : {}),
        provider: {
          models: () => [model()],
          infer: (request, options) => infer(request, options.signal),
        },
        ...(env.AGNES_BATCH_NO_HOOK === '1'
          ? {
              packages: {
                '@agnes/base': { ecosystem: { ...baseEcosystem, 'agnes/batch': batchWithoutHook } },
              },
            }
          : {}),
        profileInputs: {
          user: {
            name: 'local-dev',
            provider: {
              package: '@agnes/ai',
              adapters: ['@agnes/ai'],
              routes: [
                {
                  route: 'faux',
                  api: 'faux',
                  baseUrl: 'https://invalid.test',
                  models: [model()],
                },
              ],
            },
          },
        },
        prompter: (req, opts) => workerPrompter.ask(req, opts),
      })
      return host
    },
  },
).catch((error) => {
  console.error('batch worker entry failed to start:', error)
  process.exit(1)
})

import type {
  ModelAdapterConfig,
  ModelAdapterEvent,
  ModelAdapterInstance,
  ModelAdapterStreamOptions,
} from '@agnes/extension-api'
import { defineModelAdapter } from '@agnes/plugin-runtime'
import type { RequestBody } from '@agnes/protocol'
import { demoReply } from './demo.js'
import { absoluteFile, compat, object, readBoundedFile, readModelResponses, validateReply } from './trace.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
/** Ignore routing and ephemeral session/hash identities; retain model input and sampling. */
export function replayRequestKey(request: RequestBody): string {
  return canonical({
    kind: request.kind,
    slot: request.slot,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    sampling: request.sampling ?? null,
  })
}
type Reply = { events: ModelAdapterEvent[]; key?: string }

function instance(
  id: string,
  config: ModelAdapterConfig,
  replies: Map<string, Reply[]>,
  strict: Map<string, boolean>,
  repeatLast = new Set<string>(),
  demoRoutes = new Set<string>(),
): ModelAdapterInstance {
  const cursors = new Map<string, number>()
  const busy = new Set<string>()
  let disposed = false
  return {
    id,
    routes: () => config.routes.map(({ models: _models, keyless: _keyless, ...route }) => route),
    models: (route) => config.routes.find((decl) => decl.route === route)?.models ?? [],
    async *stream(route: string, request: RequestBody, options: ModelAdapterStreamOptions) {
      options.signal.throwIfAborted()
      if (disposed) {
        yield {
          type: 'error',
          reason: 'error',
          code: 'NO_ADAPTER',
          message: `${id} adapter is disposed`,
          retryable: false,
        }
        return
      }
      const key = `${options.sessionKey}\0${route}`
      if (busy.has(key)) {
        yield {
          type: 'error',
          reason: 'error',
          code: 'FORMAT',
          message: `${id} refuses concurrent invocations in one session route`,
          retryable: false,
        }
        return
      }
      const index = cursors.get(key) ?? 0
      const rows = replies.get(route)
      const reply = demoRoutes.has(route)
        ? { events: demoReply(request) }
        : (rows?.[index] ?? (repeatLast.has(route) ? rows?.at(-1) : undefined))
      if (!reply) {
        yield {
          type: 'error',
          reason: 'error',
          code: 'NO_MODEL',
          message: `${id} transcript exhausted at invocation ${index}`,
          retryable: false,
        }
        return
      }
      if (strict.get(route) && reply.key !== replayRequestKey(request)) {
        yield {
          type: 'error',
          reason: 'error',
          code: 'CONTRACT_MISMATCH',
          message: `replay request mismatch at invocation ${index}`,
          retryable: false,
        }
        return
      }
      busy.add(key)
      cursors.set(key, index + 1)
      try {
        for (const event of reply.events) {
          options.signal.throwIfAborted()
          yield structuredClone(event)
        }
      } finally {
        busy.delete(key)
      }
    },
    dispose() {
      disposed = true
      cursors.clear()
    },
  }
}
const capabilities = { imageInput: true, tools: true, streaming: true }
export const replayAdapter = defineModelAdapter({
  id: 'replay',
  api: 'replay',
  version: '1.0.0',
  capabilities,
  async create(config: ModelAdapterConfig): Promise<ModelAdapterInstance> {
    const replies = new Map<string, Reply[]>()
    const strict = new Map<string, boolean>()
    for (const route of config.routes) {
      const options = compat(route.compat)
      if (options.match !== undefined && options.match !== 'strict' && options.match !== 'sequence')
        throw new Error('replay match must be strict or sequence')
      if (options.recordedSession !== undefined && typeof options.recordedSession !== 'string')
        throw new Error('invalid recordedSession')
      const rows = await readModelResponses(
        absoluteFile(options.file),
        options.recordedSession as string | undefined,
      )
      // One route per transcript keeps a route-local cursor unambiguous.
      if (new Set(rows.map((row) => row.request.route)).size !== 1)
        throw new Error('replay trace must contain one model route')
      replies.set(
        route.route,
        rows.map((row) => ({ events: row.events, key: replayRequestKey(row.request) })),
      )
      strict.set(route.route, options.match !== 'sequence')
    }
    return instance('replay', config, replies, strict)
  },
})
export const scriptedAdapter = defineModelAdapter({
  id: 'scripted',
  api: 'scripted',
  version: '1.0.0',
  capabilities,
  async create(config: ModelAdapterConfig): Promise<ModelAdapterInstance> {
    const replies = new Map<string, Reply[]>()
    const repeatLast = new Set<string>()
    const demoRoutes = new Set<string>()
    for (const route of config.routes) {
      const options = compat(route.compat)
      if (options.demo !== undefined && typeof options.demo !== 'boolean')
        throw new Error('scripted demo must be boolean')
      if (options.demo === true) {
        if (options.file !== undefined || options.replies !== undefined)
          throw new Error('scripted demo cannot be combined with file or replies')
        demoRoutes.add(route.route)
        continue
      }
      if (options.replies !== undefined && options.file !== undefined)
        throw new Error('scripted route must use either inline replies or file')
      if (options.repeatLast !== undefined && typeof options.repeatLast !== 'boolean')
        throw new Error('scripted repeatLast must be boolean')
      if (options.repeatLast === true) repeatLast.add(route.route)
      const document: unknown =
        options.replies === undefined
          ? JSON.parse(await readBoundedFile(absoluteFile(options.file)))
          : { schemaVersion: 1, replies: options.replies }
      if (
        !object(document) ||
        document.schemaVersion !== 1 ||
        !Array.isArray(document.replies) ||
        !document.replies.length
      )
        throw new Error('invalid scripted replies document')
      replies.set(
        route.route,
        document.replies.map((reply) => ({ events: validateReply(reply) })),
      )
    }
    return instance('scripted', config, replies, new Map(), repeatLast, demoRoutes)
  },
})

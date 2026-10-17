/** Synthetic SDK port for the offline walkthrough. No daemon, business tools or network. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readModelResponses, replayAdapter, scriptedAdapter } from '@agnes/model-adapters'
import { digest, runEvaluation } from './runner.mjs'

export function syntheticDataset(variant = 'baseline', replay = 'scripted', transcript = null) {
  const components = {
    prompt: 'Resolve the synthetic order using fixture.lookup, then answer ready.',
    tools: ['fixture.lookup'],
    fixture: { order: 'ready' },
    model: {
      adapter: replay === 'scripted' ? 'scripted' : 'replay',
      variant,
      reply: replyFor(variant),
      ...(replay !== 'scripted' ? { transcript } : {}),
    },
    loop: { id: 'synthetic-fixture-loop', version: 1, implementation: offlineFactory.toString() },
    skills: [],
    pins: ['fixture-loop@1'],
  }
  const dataset = {
    schemaVersion: 1,
    id: 'synthetic-orders',
    hashes: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, digest(v)])),
    seed: null,
    replay,
    budget: { wallMs: 5000, tokens: 100 },
    cases: [
      {
        id: 'order-ready',
        input: 'Check synthetic order',
        expected: {
          output: 'ready',
          requiredTools: ['fixture.lookup'],
          allowedTools: ['fixture.lookup'],
          effects: [{ tool: 'fixture.lookup', result: 'ready' }],
        },
      },
    ],
  }
  return { dataset, components }
}
export const replyFor = (variant) => ({
  output: variant === 'wrong-output' ? 'wrong' : 'ready',
  calls: variant === 'missing-step' ? [] : [variant === 'unauthorized' ? 'business.send' : 'fixture.lookup'],
})
export function offlineFactory({ components, replay = 'scripted', traceFile, omitUsage = false, onRequest }) {
  return async ({ signal }) => {
    signal.throwIfAborted()
    const home = await mkdtemp(join(tmpdir(), 'agnes-eval-'))
    const cwd = join(home, 'workspace')
    let adapter
    try {
      await mkdir(cwd, { mode: 0o700 })
      let actualComponents = components
      let replayFile
      if (replay !== 'scripted') {
        const transcript = await readModelResponses(traceFile)
        actualComponents = { ...components, model: { ...components.model, transcript } }
        replayFile = join(home, 'transcript.jsonl')
        await writeFile(replayFile, transcript.map((row) => JSON.stringify(row)).join('\n'), { mode: 0o600 })
      }
      const events = [
        { type: 'text_delta', delta: JSON.stringify(components.model.reply) },
        {
          type: 'usage',
          tokens: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
          creditSource: 'estimated',
        },
        { type: 'done', reason: 'stop' },
      ]
      adapter = await (replay === 'scripted' ? scriptedAdapter : replayAdapter).create({
        routes: [
          {
            route: 'fixture',
            api: replay === 'scripted' ? 'scripted' : 'replay',
            baseUrl: 'http://127.0.0.1',
            models: [],
            compat: replay === 'scripted' ? { replies: [events] } : { file: replayFile, match: replay },
          },
        ],
      })
      const observation = { output: '', tools: [], effects: [] }
      let lastSeq = 0,
        rows = [],
        notify,
        done = false
      const emit = (type, data) => {
        rows.push({ seq: ++lastSeq, ts: new Date(0).toISOString(), type, data, lane: 'main' })
        notify?.()
        notify = undefined
      }
      const session = {
        id: 'synthetic',
        get lastServerSeq() {
          return lastSeq
        },
        async attach() {},
        async detach() {
          done = true
          notify?.()
        },
        onPermissionRequest() {
          return () => {}
        },
        async setModel() {},
        async cancel() {
          done = true
          notify?.()
        },
        events() {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  while (!rows.length && !done)
                    await new Promise((resolve) => {
                      notify = resolve
                    })
                  return rows.length ? { value: rows.shift(), done: false } : { done: true }
                },
                async return() {
                  done = true
                  notify?.()
                  return { done: true }
                },
              }
            },
          }
        },
        async prompt(input) {
          emit('turn/start', { turn: 1 })
          const request = {
            kind: 'inference',
            sessionKey: 'synthetic',
            slot: 'primary',
            route: 'fixture',
            model: 'fixture',
            contractId: null,
            derivedHash: 'a'.repeat(64),
            system: components.prompt,
            messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
            tools: [],
          }
          onRequest?.(request)
          let text = '',
            reason = 'completed'
          for await (const event of adapter.stream('fixture', request, {
            sessionKey: 'synthetic',
            signal,
            toolNames: [],
            timeoutMs: { firstToken: 1000, total: 5000 },
          })) {
            if (event.type === 'text_delta') text += event.delta
            if (event.type === 'usage' && !omitUsage) emit('cost/ledger', { tokens: event.tokens })
            if (event.type === 'error') reason = 'failed'
          }
          if (reason === 'completed') {
            const response = JSON.parse(text)
            observation.output = response.output
            for (const tool of response.calls) {
              observation.tools.push(tool)
              emit('tool/call', { name: tool })
              if (!components.tools.includes(tool) || tool !== 'fixture.lookup') {
                reason = 'failed'
                break
              }
              observation.effects.push({ tool, result: components.fixture.order })
            }
          }
          emit('turn/end', { reason })
          // Yield so the SDK event consumer observes the complete synthetic stream before prompt settles.
          await new Promise((resolve) => setImmediate(resolve))
          return { reason, lastSeq }
        },
      }
      return {
        client: {
          async createSession() {
            return session
          },
        },
        cwd,
        components: actualComponents,
        replay,
        seed: null,
        effectPolicy: 'fixture-only',
        drainMs: 0,
        observe: () => structuredClone(observation),
        async close() {
          await adapter.dispose()
          await rm(home, { recursive: true, force: true })
        },
      }
    } catch (error) {
      await adapter?.dispose()
      await rm(home, { recursive: true, force: true })
      throw error
    }
  }
}
export async function demo() {
  const result = []
  for (const variant of ['baseline', 'missing-step', 'wrong-output', 'unauthorized']) {
    const { dataset, components } = syntheticDataset(variant)
    result.push(await runEvaluation(dataset, { variant, openCase: offlineFactory({ components }) }))
  }
  return result
}

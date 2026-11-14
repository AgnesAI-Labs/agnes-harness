// An in-process application plugin whose tool reaches its own managed service through the handle
// returned by ctx.profileRuntime.register. The test copies this file and replaces the exchange
// placeholder with a directory it reads; nothing else leaves the worker.
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const exchange = '__EXCHANGE__'
const record = (entry) =>
  appendFileSync(join(exchange, 'events.jsonl'), `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
const Kind = Symbol.for('TypeBox.Kind')
const parameters = {
  [Kind]: 'Object',
  type: 'object',
  properties: { mode: { [Kind]: 'String', type: 'string', enum: ['echo', 'wait'] } },
  required: ['mode'],
  additionalProperties: false,
}
const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  deferLoading: false,
  requiresApproval: 'never',
}

export const bundledAppProbe = {
  inject: ['tools', 'profileRuntime'],
  apply(ctx) {
    const handle = ctx.profileRuntime.register({
      id: 'app',
      configSchema: { type: 'object', properties: {}, additionalProperties: false },
      defaultConfig: {},
      // Open storage, register shutdown and report ready; long work never runs inside start().
      async start(init) {
        writeFileSync(join(exchange, 'db.json'), JSON.stringify({ opened: true }))
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        const timer = setInterval(() => record({ kind: 'tick' }), 100)
        init.onShutdown(async (reason) => {
          clearInterval(timer)
          const exited = new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve()
            else child.once('exit', resolve)
          })
          child.kill()
          await exited
          record({ kind: 'shutdown', reason })
          return { state: 'settled' }
        })
        init.ready()
        record({ kind: 'started', child: child.pid })
        return {
          async handleTool({ sessionId, input, signal }) {
            record({
              kind: 'call',
              sessionId,
              mode: input.mode,
              signal: signal instanceof AbortSignal,
              aborted: signal.aborted,
            })
            if (input.mode === 'wait') {
              await new Promise((resolve) => {
                if (signal.aborted) resolve()
                else signal.addEventListener('abort', resolve, { once: true })
              })
              record({ kind: 'aborted', sessionId })
              return { content: [{ type: 'text', text: 'cancelled' }], isError: true }
            }
            return { content: [{ type: 'text', text: `service answered ${sessionId}` }] }
          },
        }
      },
    })
    ctx.tools.register({
      name: 'app_probe',
      description: 'Ask the bundled application probe to answer or to wait for cancellation.',
      parameters,
      meta,
      async execute(args, tool) {
        const service = await handle.get()
        return service.handleTool({
          sessionId: tool.session.key,
          input: args,
          signal: tool.signal,
        })
      },
    })
  },
}

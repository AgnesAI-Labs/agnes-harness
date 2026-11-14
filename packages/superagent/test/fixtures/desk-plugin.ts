// A pairing target for a real daemon, in the manner of the desk in packages/daemon/test/channel-targets.e2e.test.ts: a
// managed service that declares channel targets and appends every event the Host hands it to `events.jsonl`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelTargetEvent } from '@agnes/extension-api'
import { managedServiceCapabilities } from '@agnes/extension-api'

export const DESK_PACKAGE = '@acme/desk'
const empty = { type: 'object', properties: {}, additionalProperties: false } as const

/** Writes the desk plugin into `directory`; returns the events it received, in order. */
export function writeDeskPlugin(directory: string) {
  const exchange = join(directory, 'exchange')
  mkdirSync(exchange, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: DESK_PACKAGE,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            id: 'ext:acme/desk/main',
            export: 'main',
            apiRange: '^5.15.0',
            runtime: 'in-process',
            inject: ['profileRuntime'],
            capabilities: {
              store: true,
              managedServices: [
                {
                  id: 'desk',
                  scope: 'profile',
                  artifact: { kind: 'in-process' },
                  healthPath: '/health',
                  listeners: [],
                  startupTimeoutMs: 30_000,
                  shutdownTimeoutMs: 5_000,
                  apiVersion: '1.0.0',
                  requires: [],
                  channelTargets: true,
                },
              ],
              services: managedServiceCapabilities('desk', empty),
            },
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(directory, 'index.mjs'),
    `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const exchange = ${JSON.stringify(exchange)}
export const main = {
  inject: ['profileRuntime'],
  apply(ctx) {
    ctx.profileRuntime.register({
      id: 'desk',
      configSchema: ${JSON.stringify(empty)},
      defaultConfig: {},
      async start(init) {
        init.channels.onEvent(async (event) => appendFileSync(join(exchange, 'events.jsonl'), JSON.stringify(event) + '\\n'))
        init.onShutdown(async () => ({ state: 'settled' }))
        init.ready()
        return {}
      },
    })
  },
}
`,
  )
  return {
    directory,
    events: (): ChannelTargetEvent[] =>
      existsSync(join(exchange, 'events.jsonl'))
        ? readFileSync(join(exchange, 'events.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as ChannelTargetEvent)
        : [],
  }
}

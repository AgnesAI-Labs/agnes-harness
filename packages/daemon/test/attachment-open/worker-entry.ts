// A real worker over the real worker wire, with a test host whose model accepts images and returns a
// token count, so image turns complete. Spawned as its own process, like ../fake-worker-entry.ts.
import { createReadStream } from 'node:fs'
import { connect } from 'node:net'
import { PARSER_VERSION } from '@agnes/ai'
import { fakeModel, stampFor } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import { say } from '../host.js'

// See ../fake-worker-entry.ts: the worker module starts itself when the token variable is set, so
// the variable is cleared before the module is imported and handed to `runWorker` explicitly.
const env = { ...process.env }
delete process.env.AGNES_WORKER_TOKEN
const { runWorker } = await import('../../src/worker/main.js')

const gateFd = Number(env.AGNES_GATE_FD ?? 3)
const gate = Number.isInteger(gateFd) && gateFd >= 0 ? createReadStream('', { fd: gateFd }) : null
const model = fakeModel({ route: 'faux', id: 'faux-1', input: ['text', 'image'], contextWindow: 50_000_000 })

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
    buildHost: async (profile, workerPrompter) =>
      (
        await createTestHost({
          dataDir: profile.dataDir,
          provider: {
            models: () => [model],
            count: async (wire: { derivedHash: string }) => ({
              tokens: 2000,
              source: 'provider',
              boundHash: wire.derivedHash,
            }),
            async *infer(request: Parameters<typeof stampFor>[0]) {
              yield { type: 'sent', stamp: { ...stampFor(request), parser_version: PARSER_VERSION } }
              yield* say('assistant answer '.repeat(20))
            },
          } as never,
          profileInputs: {
            user: {
              name: 'local-dev',
              provider: {
                package: '@agnes/ai',
                adapters: ['@agnes/ai'],
                routes: [{ route: 'faux', api: 'faux', baseUrl: 'https://invalid.test', models: [model] }],
              },
            },
          },
          prompter: (req, opts) => workerPrompter.ask(req, opts),
          seams: {
            principals: {
              resolve: async (credential) => ({
                id: (credential as { userId?: string }).userId ?? 'unknown',
                org: 'example',
                role: 'member',
                deptPath: [],
                attrs: {},
              }),
            },
          },
        })
      ).host,
  },
).catch((e) => {
  console.error('attachment-open worker failed to start:', e)
  process.exit(1)
})

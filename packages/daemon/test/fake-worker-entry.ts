import { createReadStream } from 'node:fs'
import { connect } from 'node:net'
import { PARSER_VERSION } from '@agnes/ai'
import { fakeModel, stampFor } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import { say } from './host.js'

// A `WorkerPool.workerEntry` override (the same extension point `worker-pool.test.ts`'s own
// `fake-worker.ts` uses, via `execPath: process.execPath` + `execArgv: ['--import', 'tsx']`), but
// unlike that file this one runs a REAL worker over the REAL internal wire protocol
// (`runWorker`, from `src/worker/main.ts`) - just with its `Host` built by
// `@agnes/host/testkit`'s `createTestHost` (in-memory package loader, scripted provider, no real
// package registry or LLM credentials) instead of a real assembly. That is exactly what
// `runWorker`'s `deps.buildHost` hook (added in this task) is for.
//
// This file is deliberately test/-only, never touched from src/: `@agnes/ai/testkit` (which
// `createTestHost` pulls in for its `ScriptedProvider`) is a `@agnes/daemon` devDependency, and
// `tools/guards/dependency-allowlist.json` only lets this package's *shipped* code (src/) depend on
// `@agnes/protocol` and `@agnes/host`. Spawning this file as its own subprocess via `workerEntry`
// keeps that import graph entirely inside test/, rather than adding an `AGNES_TEST_FAKE_HOST`
// env-var branch to `worker/main.ts` itself (the plan's own sample suggested exactly that env var,
// but it does not exist in the real, already-landed file - see this task's report for why this
// `workerEntry`-override shape was chosen instead).
//
// `worker/main.ts`'s own bottom self-starting block fires purely on `process.env.AGNES_WORKER_TOKEN`
// being set - not on "am I the process entry module" - and `WorkerPool` always sets that var for
// every spawned worker, fake ones included. A plain `import { runWorker } from '../src/worker/main.js'`
// at the top of this file would therefore trigger that REAL self-start block too (it runs at module
// load, unconditionally) - a second, uncontrolled `runWorker(process.env, ..., {})` call racing this
// file's own deliberate one, using the real `createHost` path this fixture exists to avoid (reverse-
// verified: reverting to a static import reproduces exactly the `E_DEP_MISSING: createHost needs a
// package loader` crash this file's whole design works around). Capturing the env, clearing the
// trigger var, and only THEN dynamically importing the module keeps that block from ever firing here,
// while `runWorker` below still gets the real, complete env (token included) it needs.
const env = { ...process.env }
delete process.env.AGNES_WORKER_TOKEN
const { runWorker } = await import('../src/worker/main.js')

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
    buildHost: async (profile, workerPrompter) => {
      const { host } = await createTestHost({
        dataDir: profile.dataDir,
        // Pin the parser contract explicitly because this worker exercises the real Host/Core
        // contract fence; changing the testkit default must not silently change this fixture.
        // One scripted turn unless a test that prompts this worker repeatedly asks for more.
        script: Array.from(
          { length: Number(env.AGNES_FAKE_WORKER_TURNS ?? '1') },
          () => (request: Parameters<typeof stampFor>[0]) => [
            {
              type: 'sent' as const,
              stamp: { ...stampFor(request), parser_version: PARSER_VERSION },
            },
            ...say(env.AGNES_FAKE_WORKER_TEXT ?? 'hello world'),
          ],
        ),
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
                  models: [fakeModel({ route: 'faux', id: 'faux-1' })],
                },
              ],
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
      return host
    },
  },
).catch((e) => {
  console.error('fake worker entry failed to start:', e)
  process.exit(1)
})

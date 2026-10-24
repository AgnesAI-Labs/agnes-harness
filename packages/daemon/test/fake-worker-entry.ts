import { appendFileSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { PARSER_VERSION } from '@agnes/ai'
import { fakeModel, stampFor } from '@agnes/ai/testkit'
import type { ToolContext } from '@agnes/extension-api'
import { createTestHost, type TestHostOptions } from '@agnes/host/testkit'
import { readDevelopmentPlugin } from '@agnes/package-manager'
import type { Context } from '@agnes/plugin-runtime'
import type { InferenceEvent } from '@agnes/protocol'
import { ConfigEmptyParams, WorkspaceAddParams } from '@agnes/protocol/gen/agnes-v1'
import { say } from '../../daemon-rpc/test/host.js'

// A `WorkerPool.workerEntry` override (the same extension point `worker-pool.e2e.test.ts`'s own
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

async function permissionFixture(dataDir: string): Promise<Partial<TestHostOptions>> {
  if (env.AGNES_FAKE_WORKER_PERMISSION !== '1' && env.AGNES_FAKE_WORKER_READ !== '1') return {}
  const packageId = '@fixture/permission'
  const directory = join(dataDir, 'permission-plugin')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'index.mjs'), 'export const version = "1.0.0"\n')
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: packageId,
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            export: 'main',
            id: 'ext:@fixture/permission/main',
            apiRange: '^5.0.0',
            default: true,
            inject: ['tools'],
            provide: [],
            runtime: 'in-process',
          },
        ],
      },
    }),
  )
  const source = { ...(await readDevelopmentPlugin(directory, 'local-dev')), trusted: true }
  const plugin = {
    inject: ['tools'],
    apply(ctx: Context) {
      if (env.AGNES_FAKE_WORKER_READ === '1')
        // Reads through the invocation's own file fence, as the session's tools do.
        ctx.tools.register({
          name: 'fence_read',
          description: 'Reads one file through the session file fence',
          // Any params schema with a required string `path`.
          parameters: WorkspaceAddParams.$defs.WorkspaceAddParams,
          meta: {
            isReadOnly: true,
            isDestructive: false,
            isConcurrencySafe: true,
            isOpenWorld: false,
            replay: 'never',
            costHint: {},
            deferLoading: false,
            requiresApproval: 'never',
          },
          execute: async (input: unknown, context: ToolContext) => {
            const { path } = input as { path: string }
            const text = await context.fs.read(path).then(
              (bytes) => new TextDecoder().decode(bytes),
              (error: { code?: string }) => `FS_ERROR:${error.code ?? 'unknown'}`,
            )
            return { content: [{ type: 'text', text }] }
          },
        })
      if (env.AGNES_FAKE_WORKER_PERMISSION === '1')
        ctx.tools.register({
          name: 'permission_probe',
          description: 'Plain permission test tool',
          // The probe has no arguments; the RPC import also carries hundreds of unrelated $defs.
          parameters: ConfigEmptyParams.$defs.ConfigEmptyParams,
          meta: {
            isReadOnly: false,
            isDestructive: true,
            isConcurrencySafe: false,
            isOpenWorld: false,
            replay: 'never',
            costHint: {},
            deferLoading: false,
            requiresApproval: 'always',
          },
          execute: async (_input: unknown, context: ToolContext) => {
            if (env.AGNES_FAKE_WORKER_MCP === '1') {
              if (!context.mcpManage) throw new Error('Missing MCP management port')
              const prepared = (await context.mcpManage.request({
                action: 'prepare',
                definition: {
                  serverId: 'revocation-probe',
                  displayName: 'Revocation probe',
                  transport: { kind: 'http', url: 'https://mcp.example.test/api' },
                  secretBinding: { kind: 'none' },
                },
              })) as { proposalId: string }
              await context.mcpManage.request({ action: 'commit', proposalId: prepared.proposalId })
            }
            if (env.AGNES_FAKE_WORKER_RECOVERY === '1')
              appendFileSync(join(dataDir, 'permission-dispatched'), 'yes\n')
            else writeFileSync(join(dataDir, 'permission-dispatched'), 'yes')
            return { content: [{ type: 'text', text: 'ran' }] }
          },
        })
    },
  }
  return {
    lock: {
      packages: Object.fromEntries([
        ...['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
          id,
          {
            version: '0.1.0',
            source: { type: 'builtin', ref: 'builtin' },
            integrity: 'builtin:0.1.0',
            trust: 'builtin',
            enabled: true,
          },
        ]),
        [
          packageId,
          {
            version: source.snapshot.version,
            integrity: source.snapshot.integrity,
            trust: 'trusted',
            enabled: true,
          },
        ],
      ]),
    },
    packageDirs: { [packageId]: directory },
    runtimePluginSnapshots: [source],
    runtimePluginCatalogue: [source],
    extensionLoader: {
      async import() {
        return { main: plugin }
      },
    },
  }
}

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
    buildHost: async (profile, workerPrompter, capabilities) => {
      if (env.AGNES_FAKE_WORKER_MCP === '1')
        writeFileSync(join(profile.dataDir, 'mcp-worker-pid'), String(process.pid))
      if (env.AGNES_FAKE_WORKER_RECOVERY === '1')
        writeFileSync(join(profile.dataDir, 'fixture-worker-pid'), String(process.pid))
      const { host } = await createTestHost({
        dataDir: profile.dataDir,
        mcpManage: capabilities.mcpManage,
        ...(await permissionFixture(profile.dataDir)),
        ...(env.AGNES_FAKE_WORKER_QUEUE === '1'
          ? {
              provider: {
                models: () => [fakeModel({ route: 'faux', id: 'faux-1' })],
                async *infer(request, options): AsyncIterable<InferenceEvent> {
                  yield { type: 'sent', stamp: { ...stampFor(request), parser_version: PARSER_VERSION } }
                  const prompt = request.messages.filter((message) => message.role === 'user').at(-1)
                  if (
                    request.kind !== 'summary' &&
                    prompt?.content.some((block) => block.type === 'text' && block.text === 'queue-A')
                  ) {
                    await new Promise<void>((resolve) => {
                      options.signal.addEventListener('abort', () => resolve(), { once: true })
                      if (options.signal.aborted) resolve()
                    })
                    yield {
                      type: 'error',
                      reason: 'aborted',
                      code: 'ABORTED',
                      message: 'stopped',
                      retryable: false,
                    }
                    return
                  }
                  yield* say('completed queue input')
                },
              },
            }
          : {}),
        // `read <path>` prompts call a fixture tool that reads through the session file fence; its outcome is appended to read-log.jsonl.
        ...(env.AGNES_FAKE_WORKER_READ === '1'
          ? {
              provider: {
                models: () => [fakeModel({ route: 'faux', id: 'faux-1' })],
                async *infer(request): AsyncIterable<InferenceEvent> {
                  yield { type: 'sent', stamp: { ...stampFor(request), parser_version: PARSER_VERSION } }
                  const textOf = (message: (typeof request.messages)[number]) =>
                    message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
                  const askIndex = request.messages.findLastIndex(
                    (message) => message.role === 'user' && /^read \//.test(textOf(message)),
                  )
                  const ask = request.messages[askIndex]
                  const result = request.messages.slice(askIndex + 1).find((m) => m.role === 'tool_result')
                  if (request.kind !== 'summary' && ask && !result) {
                    yield {
                      type: 'toolcall_end',
                      via: 'native',
                      call: {
                        toolUseId: '',
                        name: 'fence_read',
                        args: { path: textOf(ask).slice('read '.length) },
                        ordinal: 0,
                      },
                    }
                    yield { type: 'done', reason: 'toolUse' }
                    return
                  }
                  if (ask && result)
                    appendFileSync(
                      join(profile.dataDir, 'read-log.jsonl'),
                      `${JSON.stringify({
                        path: textOf(ask).slice('read '.length),
                        isError: result.role === 'tool_result' && result.isError === true,
                        text: textOf(result),
                      })}\n`,
                    )
                  yield* say('read finished')
                },
              },
            }
          : {}),
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
            ...(env.AGNES_FAKE_WORKER_PERMISSION === '1' &&
            !request.messages
              .slice(
                env.AGNES_FAKE_WORKER_REPEAT_PERMISSION === '1'
                  ? request.messages.findLastIndex((message) => message.role === 'user')
                  : 0,
              )
              .some((message) => message.role === 'tool_result')
              ? [
                  {
                    type: 'toolcall_end' as const,
                    via: 'native' as const,
                    call: { toolUseId: '', name: 'permission_probe', args: {}, ordinal: 0 },
                  },
                  { type: 'done' as const, reason: 'toolUse' as const },
                ]
              : say(env.AGNES_FAKE_WORKER_TEXT ?? 'hello world')),
          ],
        ),
        profileInputs: {
          user: {
            name: 'local-dev',
            provider: {
              package: '@agnes/ai',
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
          ...(env.AGNES_FAKE_WORKER_PERMISSION === '1'
            ? {
                approval: {
                  ask: (req: Parameters<typeof workerPrompter.ask>[0], opts?: { signal: AbortSignal }) =>
                    workerPrompter.ask(req, { signal: opts?.signal ?? new AbortController().signal }),
                },
              }
            : {}),
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

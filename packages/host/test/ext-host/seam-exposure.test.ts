import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LeaseView, PlatformFacts, SessionRef } from '@agnes/extension-api'
import { serviceFixture } from '@agnes/extension-api/testkit'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatform } from '../../src/adapters/platform.js'
import {
  connectIsolatedHooksRunner,
  type IsolatedHooksRunner,
} from '../../src/ext-host/hooks-isolation-client.js'
import { createTestHost, runOnce, type TestHost } from '../../testkit/index.js'

// What the spec pins, sorted the way Object.keys(...).sort() will hand it back (spec §6.1).
const HOOK_KEYS = ['lease', 'log', 'platform', 'projections', 'replayed', 'session', 'signal']
const FACTORY_KEYS = ['extId', 'info', 'lease', 'log', 'platform', 'signal', 'trust', 'version']
const fixturePlatform = createPlatform()
const FACTS: PlatformFacts = {
  shell: fixturePlatform.shell(),
  fs: fixturePlatform.fs(),
  terminal: { color: false },
}

type Probe = {
  at: string
  keys: string[]
  platform: unknown
  sandboxKeys?: string[]
  capability?: unknown
  enforcement?: unknown
}
const probes = (): Probe[] => (Reflect.get(globalThis, '__agnesSeamExposure') as Probe[] | undefined) ?? []

const held: { root: string; host: TestHost['host'] }[] = []
const running: { child: ReturnType<typeof spawn>; runner?: IsolatedHooksRunner }[] = []
afterEach(async () => {
  for (const h of held.splice(0)) {
    await h.host.close()
    rmSync(h.root, { recursive: true, force: true })
  }
  for (const item of running.splice(0)) {
    await item.runner?.close().catch(() => undefined)
    item.child.kill('SIGKILL')
  }
  Reflect.deleteProperty(globalThis, '__agnesSeamExposure')
})

const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]
// A third-party extension: not under packages/base, only the public author API, loaded through the
// real profile → package → manifest → entry path. It reports what each moment handed it.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-seam-exposure-'))
  const pkg = join(root, 'package'),
    ext = join(pkg, 'consumer')
  mkdirSync(ext, { recursive: true })
  const { handler: _, ...cap } = serviceFixture()
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ agnes: { extensions: ['./consumer'] } }))
  writeFileSync(
    join(ext, 'agnes.extension.json'),
    JSON.stringify({
      id: 'fixture/seam-consumer',
      version: '1.0.0',
      apiRange: '^1.1',
      entry: './index.js',
      capabilities: {
        tools: { prefix: 'sx_', names: ['sx_probe'] },
        hooks: ['session_start'],
        services: [cap],
      },
    }),
  )
  writeFileSync(
    join(ext, 'index.js'),
    `const report = (p) => { (globalThis.__agnesSeamExposure ??= []).push(p) };
const facts = (v) => ({ shell: v.shell, fs: v.fs, terminal: v.terminal });
// A genuinely third-party, un-npm-installed fixture cannot bare-import '@sinclair/typebox' (there is
// no node_modules above this temp directory for the real native loader to resolve it from). TypeBox's
// Value.Check only recognizes a schema carrying its Kind marker, so this tags a plain JSON Schema
// object with that marker via the global symbol registry (Symbol.for), which needs no import at all -
// the same shape Type.Object({}, { additionalProperties: false }) produces.
const parameters = { [Symbol.for('TypeBox.Kind')]: 'Object', type: 'object', properties: {}, required: [], additionalProperties: false };
export default (api) => {
  report({ at: 'factory', keys: Object.keys(api.ctx).sort(), platform: api.ctx.platform });
  api.registerHook('session_start', (_payload, hctx) => {
    report({ at: 'hook', keys: Object.keys(hctx).sort(), platform: hctx.platform });
  });
  api.registerTool({
    name: 'sx_probe',
    description: 'reports the tool context surface',
    parameters,
    meta: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, isOpenWorld: false, replay: 'safe',
      costHint: undefined, deferLoading: false, requiresApproval: 'never' },
    async execute(_args, ctx) {
      report({ at: 'tool', keys: Object.keys(ctx).sort(), sandboxKeys: Object.keys(ctx.sandbox).sort(),
        platform: facts(ctx.platform), capability: ctx.platform.capability('fixture.probe'),
        enforcement: ctx.sandbox.enforcement() });
      return { content: [{ type: 'text', text: 'probed' }] };
    },
  });
  api.registerService({ ...${JSON.stringify(cap)}, async handler(input, sctx) {
    report({ at: 'service', keys: Object.keys(sctx).sort(), platform: facts(sctx.platform),
      capability: sctx.platform.capability('fixture.probe') });
    return { value: input.value };
  } });
};`,
  )
  return { root, pkg, cap }
}

describe('seam exposure: what a third-party extension can reach at each moment (spec 2026-09-15 §4 / §6.2)', () => {
  it('does not expose the retired third-party extension seam during Host startup', async () => {
    const { root, pkg, cap } = fixture()
    const { host } = await createTestHost({
      dataDir: root,
      script: [say('done')],
      packageDirs: { '@agnes/code': pkg },
      platformCaps: { 'fixture.probe': 'unavailable' },
      profileInputs: {
        user: { name: 'local-dev', policy: { capabilityCeiling: ['tools', 'hooks', 'services'] } },
      },
      serviceAuthority: {
        async resolve() {
          return {
            source: 'surface',
            subjectCredential: 'trusted',
            grants: [{ extension: 'fixture/seam-consumer', name: cap.name, range: '^1.0' }],
          }
        },
      },
    })
    held.push({ root, host })
    expect(host.extensions()).toEqual([])
    const turn = await runOnce(host, { prompt: 'probe', cwd: root })
    expect(turn.toolCalls).toEqual([])
    const session = await host.createSession({ cwd: root, key: 'service-context' })
    await expect(
      host.callService(
        {
          sessionId: session.key,
          extension: 'fixture/seam-consumer',
          service: cap.name,
          input: { value: 7 },
        },
        'opaque',
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(probes()).toEqual([])
  })

  it('carries the same facts into an isolated extension: factory ctx and hook ctx across the JSON boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-seam-exposure-isolated-'))
    const ext = join(root, 'isolated')
    mkdirSync(ext, { recursive: true })
    const manifestFile = join(ext, 'agnes.extension.json')
    const entry = join(ext, 'index.js')
    writeFileSync(
      manifestFile,
      JSON.stringify({
        id: 'fixture/isolated-consumer',
        version: '1.0.0',
        apiRange: '^1.1',
        entry: './index.js',
        runtime: { supports: ['isolated'] },
        capabilities: { hooks: ['before_step'] },
      }),
    )
    writeFileSync(
      entry,
      `export default (api) => {
  api.registerHook('before_step', (_payload, hctx) => ({
    block: true,
    reason: JSON.stringify({ factory: api.ctx.platform, factoryKeys: Object.keys(api.ctx).sort(), hook: hctx.platform, hookKeys: Object.keys(hctx).sort() }),
  }));
};`,
    )
    const digest = (file: string) => `sha256-${createHash('sha256').update(readFileSync(file)).digest('hex')}`
    const nonce = randomUUID(),
      packageDigest = 'package-sha256',
      manifestDigest = digest(manifestFile)
    const runnerEntry = resolve(import.meta.dirname, '../../../base/src/hooks-isolation-runner.ts')
    const child = spawn(process.execPath, ['--import', 'tsx', runnerEntry], {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: {
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        AGNES_ISOLATION_NONCE: nonce,
        AGNES_PACKAGE_DIGEST: packageDigest,
        AGNES_MANIFEST_DIGEST: manifestDigest,
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lease: LeaseView = {
      expiresAt: '2099-01-01T00:00:00.000Z',
      scope: { events: true },
      budget: { remaining: 100 },
    }
    const session: SessionRef = {
      key: 'isolated-1',
      lane: 'main',
      workspaceRoot: '/workspace',
      turn: 1,
      step: 1,
    }
    const runner = await connectIsolatedHooksRunner(
      child,
      {
        nonce,
        packageDigest,
        manifestDigest,
        extensionId: 'fixture/isolated-consumer',
        data: {
          kind: 'extension',
          packageDirectory: root,
          entry,
          entryDigest: digest(entry),
          manifestFile,
          context: {
            extId: 'fixture/isolated-consumer',
            version: '1.0.0',
            trust: 'trusted',
            lease,
            info: { agnesVersion: '0.1.0', apiVersion: '1.1.0', profileName: 'test' },
            platform: FACTS,
          },
        },
      },
      async () => {
        throw new Error('no capability in this test')
      },
    )
    running.push({ child, runner })
    try {
      // A `kind: 'extension'` bootstrap (unlike the fixed hooks-runner adapter) keys its handlers by
      // the generated registration id from the 'ready' message, not by the bare event name, so the
      // invocation must carry that id (mirroring isolatedHooksRunnerFactory's own driving in
      // hooks-isolation-client.ts) rather than defaulting to the event.
      const registrationId = runner.registrations?.find((r) => r.event === 'before_step')?.id
      // A regression here (e.g. the runner not reporting registrations) must fail as a clear
      // assertion, not silently fall through to an unhandled-rejection child-process crash.
      expect(registrationId).toBeDefined()
      const returned = await runner.invoke(
        'before_step',
        { turn: 1, step: 1, budget: { remaining: 10, cap: 20 }, depth: 0 },
        { session, lease, replayed: false, platform: FACTS, signal: new AbortController().signal },
        registrationId,
      )
      expect(returned).toMatchObject({ block: true })
      const seen = JSON.parse((returned as { reason: string }).reason) as Record<string, unknown>
      expect(seen.factory).toEqual(FACTS)
      expect(seen.hook).toEqual(FACTS)
      expect(seen.factoryKeys).toEqual(FACTORY_KEYS)
      expect(seen.hookKeys).toEqual(HOOK_KEYS)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// Manual review probe: real source Host + loopback SSE model + real local filesystem/sandbox.
// Run with the mise Node 24 executable under the shared heavy-lock, as documented in the report.
// No operator home, model account or credential file is read. All effects stay in a fresh temp tree.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProvider, NullContractStore, PiAdapter } from '../../packages/ai/src/index.ts'
import { createAutoReviewPolicy } from '../../packages/base/extensions/approval-policy/src/auto-review.ts'
import { writePlanMode } from '../../packages/base/extensions/plan-mode/src/state.ts'
import { createPluginManageRequests } from '../../packages/daemon/src/supervisor/plugin-manage-requests.ts'
import { runAuthoringTests } from '../../packages/daemon-admin/src/packages/authoring-tests.ts'
import {
  createPackageAdminService,
  FilePackageOperationStore,
} from '../../packages/daemon-admin/src/packages/index.ts'
import { LocalEndpoint } from '../../packages/daemon-foundation/src/local/endpoint.ts'
import { defaultToolPolicy, type ToolPolicyInput } from '../../packages/extension-api/src/index.ts'
import { createHost, type HostSession } from '../../packages/host/src/index.ts'
import { startWireCapture } from '../../packages/host/testkit/wire-capture.ts'
import { resolveProfile } from '../../packages/host-common/src/profile/resolve.ts'
import { createJitiPackageLoader } from '../../packages/host-extensions/src/assemble/packages.ts'
import { createSkillInstaller } from '../../packages/host-extensions/src/resources/skill-install.ts'
import { openMemory } from '../../packages/memory-file/src/index.ts'
import {
  createPackageManager,
  emptyLock,
  hashDirectory,
  type RuntimePluginSnapshot,
  writeLock,
} from '../../packages/package-manager/src/index.ts'
import { discoverSkillRoot, skillRoots } from '../../packages/resource-control-worker/src/index.ts'
import { requestPluginManage } from '../../packages/worker-runtime/src/plugin-manage.ts'

const repo = resolve('.')
// The production author runner launches `node` by name; keep its subprocess on this same runtime.
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ''}`
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agh-pc-perm-review-')))
let queued: { name: string; args: Record<string, unknown> } | undefined
const wire = await startWireCapture(() => {
  const toolCall = queued
  queued = undefined
  return toolCall ? { toolCall } : { text: 'probe completed' }
})
const endpoint = wire.baseUrl('openai-completions')
const model = {
  id: 'probe',
  name: 'probe',
  route: 'probe',
  api: 'openai-completions',
  baseUrl: endpoint,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const importer = { import: (file: string) => import(pathToFileURL(file).href) }
const rows: unknown[] = []
try {
  for (const preset of ['read-only', 'workspace-write', 'full-access', 'standard']) {
    const home = join(scratch, preset, 'home'),
      workspace = join(scratch, preset, 'workspace')
    const outside = join(scratch, preset, 'outside')
    for (const path of [home, workspace, outside, join(home, 'profiles/local-dev')])
      await mkdir(path, { recursive: true })
    await writeFile(join(workspace, 'input.txt'), 'synthetic workspace input')
    await writeFile(join(outside, 'input.txt'), 'synthetic outside input')
    await mkdir(join(home, 'auth'), { recursive: true })
    await writeFile(join(home, 'auth/probe.txt'), 'synthetic protected marker')
    await mkdir(join(workspace, 'skill'), { recursive: true })
    await writeFile(
      join(workspace, 'skill/SKILL.md'),
      '---\nname: probe\ndescription: Synthetic review skill\n---\nUse concise summaries.\n',
    )
    const memory = openMemory({ home, workspaceRoot: workspace, sessionKey: 'setup' })
    const initial = await memory.inspect()
    await memory.configure({ ...initial.settings, mode: 'ask' })
    const memoryPath = join(memory.root, 'probe.md')
    const helperDirectory = join(home, 'synthetic-helper-snapshot')
    await cp(join(repo, 'packages/package-manager/bundled-plugins/skill-helper'), helperDirectory, {
      recursive: true,
    })
    const source: RuntimePluginSnapshot = {
      snapshot: {
        packageId: '@agnes/skill-helper',
        version: '0.3.0',
        snapshotId: `sha256-${'3'.repeat(64)}`,
        integrity: `sha256-${'4'.repeat(64)}`,
        treeIntegrity: hashDirectory(helperDirectory, { exclude: [] }),
        capabilityHash: 'synthetic',
        directory: helperDirectory,
        profile: 'local-dev',
        contributions: [],
      },
      generation: 1,
      trusted: true,
    }
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: Object.fromEntries(
            ['@agnes/ai', '@agnes/base', '@agnes/code', '@agnes/skill-helper'].map((id) => [
              id,
              {
                version: '0.3.0',
                integrity: source.snapshot.integrity,
                trust: id === '@agnes/skill-helper' ? 'trusted' : 'builtin',
                enabled: true,
              },
            ]),
          ),
        },
        user: {
          name: 'local-dev',
          packages: [{ id: '@agnes/skill-helper', source: `file:${helperDirectory}` }],
          dataDir: join(home, 'data'),
          cacheDir: join(home, 'cache'),
          presets: { default: preset, allowed: ['standard', 'read-only', 'workspace-write', 'full-access'] },
          computerUse: { enabled: false },
          provider: {
            package: '@agnes/ai',
            routes: [
              {
                route: 'probe',
                api: 'openai-completions',
                baseUrl: endpoint,
                keyless: true,
                models: [model],
              },
            ],
          },
        },
      },
      {
        platform: { os: process.platform, arch: process.arch, capabilities: {} },
        agnesVersion: '0.0.0',
        now: new Date().toISOString(),
      },
    )
    let prompts: string[] = [],
      permit = false,
      unattended = false
    const installer = createSkillInstaller(join(home, 'skill-installs'), {
      roots: skillRoots,
      discover: discoverSkillRoot,
    })
    const loader = createJitiPackageLoader(importer)
    const manager = createPackageManager({
      dataDir: home,
      cwd: workspace,
      agnesVersion: '0.0.0',
      references: async () => [],
    })
    // The author Host has an explicit live snapshot authority and no package lock.
    // Candidate administration uses its own synthetic writable profile.
    const candidateProfile = join(home, 'candidate-admin/profiles/local-dev')
    await mkdir(candidateProfile, { recursive: true })
    writeLock(candidateProfile, {
      ...emptyLock('local-dev', '0.0.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((kind) => [
          kind,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
    })
    const admin = createPackageAdminService({
      manager,
      profileDirectory: async () => candidateProfile,
      operations: new FilePackageOperationStore(join(home, 'operations')),
      clock: () => new Date().toISOString(),
      authoringTestRunner: runAuthoringTests,
    })
    const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
    Object.assign(ep.conn, { authKind: 'local', credentialKind: 'local', clientId: 'probe' })
    ep.conn.capabilities.permission = true
    ep.request = async () => {
      prompts.push('plugin_candidate_test')
      return { outcome: { outcome: 'selected', optionId: 'reject_once' } }
    }
    const handler = createPluginManageRequests({
      directory: home,
      profile: 'local-dev',
      service: () => admin,
      current: () => ep.conn,
      connections: () => [ep.conn],
      endpoint: () => ep,
      owner: () => ({ principalId: 'local', active: true }),
    })
    let activeSession: HostSession | undefined
    const host = await createHost(profile, {
      dataDir: join(home, 'data'),
      profileDir: join(home, 'profiles/local-dev'),
      workspaceRoot: workspace,
      hostRoot: repo,
      homeDir: join(scratch, 'os-home'),
      env: { PATH: process.env.PATH, AGH_HOME: home, AGNES_PROFILE: 'local-dev' },
      packageDirs: new Map(['ai', 'base', 'code'].map((id) => [`@agnes/${id}`, join(repo, 'packages', id)])),
      loader,
      runtimePluginSnapshots: [source],
      runtimePluginCatalogue: [source],
      runtimePluginSources: async () => [source],
      extensionLoader: importer,
      skillInstall: async (invocation, signal) =>
        installer.request(
          invocation,
          {
            principalId: 'local',
            profile: 'local-dev',
            workspaceRoot: workspace,
            agnesHome: home,
            assertActive() {},
            async ask(summary) {
              prompts.push(
                summary.startsWith('Install skill') ? 'skill-install-confirm' : 'skill-read-confirm',
              )
              return !summary.startsWith('Install skill')
            },
            async resources(method) {
              if (method === '_agnes/v1/resources.list') return { items: [] }
              throw new Error('rejected install must not register resources')
            },
          },
          signal,
        ),
      pluginManage: (input, signal) => {
        const session = activeSession
        assert.ok(session)
        return requestPluginManage(session, input, signal, {
          currentSessionKey: () => session.key,
          request: (method, args, sig) => handler(session.key, crypto.randomUUID(), method, args, sig),
        })
      },
      providerFactory: () => {
        const adapter = new PiAdapter({
          manualRoutes: [
            {
              route: 'probe',
              api: 'openai-completions',
              baseUrl: endpoint,
              keyless: true,
              models: [model],
            },
          ],
          maxRetries: 0,
        })
        // A public fixture string satisfies the HTTP library; it authenticates no real service.
        adapter.bindCredential('probe', 'synthetic-probe-only')
        return createProvider({
          adapters: [adapter],
          routes: { primary: { route: 'probe', model: 'probe' } },
          contract: new NullContractStore(),
          clock: Date.now,
          secrets: () => {
            throw new Error('probe never reads credentials')
          },
        })
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      disableSessionTitle: true,
      prompter: {
        async ask(req) {
          prompts.push(req.tool?.name ?? req.summary)
          if (unattended) return { verdict: 'unavailable' as const, reason: 'no-handler' as const }
          return {
            verdict: permit ? ('allowed-once' as const) : ('rejected' as const),
            ...(!permit ? { reason: 'user-rejected' as const } : {}),
            answeredBy: { id: 'reviewer', org: 'local', role: 'user', deptPath: [], attrs: {} },
          }
        },
      },
    })
    try {
      const operations = [
        ['read-inside', 'read', { path: 'input.txt' }],
        ['read-outside', 'read', { path: join(outside, 'input.txt') }],
        ['write-inside', 'write', { path: 'created.txt', content: 'synthetic' }],
        ['write-outside', 'write', { path: join(outside, 'created.txt'), content: 'synthetic' }],
        ['shell-echo', 'shell', { command: 'echo synthetic' }],
        ['shell-no-handler', 'shell', { command: 'echo synthetic' }],
        ['shell-write-outside', 'shell', { command: `echo synthetic > '${join(outside, 'shell.txt')}'` }],
        ['web-public', 'web_fetch', { url: 'https://example.com' }],
        ['web-loopback', 'web_fetch', { url: endpoint }],
        ['memory-write-ask', 'write', { path: memoryPath, content: 'Use concise summaries.\n' }],
        [
          'candidate-test',
          'skill_helper_install',
          { action: 'test', proposalId: `candidate-${'1'.repeat(32)}` },
        ],
        ['skill-install', 'skill_helper_import', { source: join(workspace, 'skill') }],
        ['shell-echo-approved', 'shell', { command: 'echo synthetic' }],
        [
          'shell-outside-approved',
          'shell',
          { command: `echo synthetic > '${join(outside, 'approved.txt')}'` },
        ],
        [
          'shell-network-approved',
          'shell',
          { command: 'curl --connect-timeout 2 --max-time 4 -sS https://example.com -o /dev/null' },
        ],
        ['memory-write-auto', 'write', { path: memoryPath, content: 'Use concise summaries.\n' }],
        ['yolo-write-outside', 'write', { path: join(outside, 'yolo.txt'), content: 'synthetic' }],
        ['protected-auth-read', 'read', { path: join(home, 'auth/probe.txt') }],
        [
          'protected-profiles-write',
          'write',
          { path: join(home, 'profiles/probe.txt'), content: 'synthetic' },
        ],
        ['plan-write', 'write', { path: 'plan-blocked.txt', content: 'synthetic' }],
        ['plan-exit', 'exit_plan_mode', { plan: '## Synthetic plan\nRead synthetic input.' }],
      ] as const
      for (const [operation, name, args] of operations) {
        const session = await host.createSession({ key: `${preset}-${operation}`, cwd: workspace, preset })
        activeSession = session
        if (operation === 'yolo-write-outside') await session.setYolo(true, session.d.actor)
        ep.conn.attached.set(session.key, {} as never)
        permit =
          operation.endsWith('-approved') || operation === 'skill-install' || operation === 'candidate-test'
        unattended = operation === 'shell-no-handler'
        if (operation === 'memory-write-auto') await memory.configure({ ...initial.settings, mode: 'auto' })
        if (operation.startsWith('plan-'))
          writePlanMode(workspace, {
            active: true,
            instruction: 'Plan only',
            updatedAt: new Date().toISOString(),
          })
        let callArgs: Record<string, unknown> = { ...args }
        if (operation === 'candidate-test') {
          const candidate = (await handler(session.key, crypto.randomUUID(), 'plugin-manage', {
            sessionKey: session.key,
            packageId: '@agnes/base',
            snapshotId: 'synthetic',
            rowId: 'ext:creator/main',
            leaseId: 'synthetic',
            toolUseId: 'fixture-prepare',
            turn: 0,
            input: {
              action: 'candidate.create',
              files: [
                {
                  path: 'package.json',
                  content: JSON.stringify({
                    name: 'synthetic-review-plugin',
                    version: '0.1.0',
                    type: 'module',
                    license: 'MIT',
                    exports: './index.mjs',
                    agnes: {
                      plugins: [
                        {
                          id: 'ext:synthetic-review-plugin/main',
                          export: 'main',
                          apiRange: '^4.0.0',
                          inject: ['tools'],
                        },
                      ],
                    },
                  }),
                },
                { path: 'index.mjs', content: 'export const main = { inject: ["tools"], apply() {} }' },
                {
                  path: 'test/probe.test.mjs',
                  content: `import test from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; test("synthetic protected-path read by candidate Node runner", () => assert.equal(readFileSync(${JSON.stringify(join(home, 'auth/probe.txt'))}, "utf8"), "synthetic protected marker"));`,
                },
              ],
            },
          })) as { candidateId: string; candidateHash: string }
          callArgs = { action: 'test', proposalId: candidate.candidateId }
        }
        prompts = []
        queued = { name, args: callArgs }
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: `Synthetic permission probe: ${operation}` }],
          actor: session.d.actor,
        })
        let outcome = await session.run({ until: 'turn-end', signal: AbortSignal.timeout(25000) })
        assert.notEqual(outcome.reason, 'error', JSON.stringify(outcome))
        let result = (await session.scan({ type: 'tool/result', limit: 10 })).map((row) => row.data)
        if (operation === 'candidate-test' && preset === 'full-access') {
          const candidate = result
            .flatMap((data) => (data as { content?: { type: string; text?: string }[] }).content ?? [])
            .filter((content) => content.type === 'text')
            .map((content) => {
              try {
                return JSON.parse(content.text ?? '')
              } catch {
                return {}
              }
            })
            .find((value) => value.tests?.state === 'passed')
          assert.ok(candidate, `The real candidate Node test must pass: ${JSON.stringify(result)}`)
          assert.equal(prompts.length, 0, 'Explicit full access must not prompt for candidate tests')
        }
        if (operation === 'skill-install' && preset !== 'read-only') {
          const prepared = result
            .flatMap((data) => (data as { content?: { type: string; text?: string }[] }).content ?? [])
            .filter((content) => content.type === 'text')
            .map((content) => {
              try {
                return JSON.parse(content.text ?? '')
              } catch {
                return {}
              }
            })
            .find((value) => value.state === 'prepared')
          assert.ok(prepared?.proposalId, `Skill import must actually prepare: ${JSON.stringify(result)}`)
          queued = {
            name: 'skill_helper_install',
            args: { action: 'commit', proposalId: prepared.proposalId },
          }
          await session.enqueue('next-turn', {
            content: [{ type: 'text', text: 'Commit the synthetic prepared Skill' }],
            actor: session.d.actor,
          })
          outcome = await session.run({ until: 'turn-end', signal: AbortSignal.timeout(25000) })
          assert.notEqual(outcome.reason, 'error', JSON.stringify(outcome))
          result = (await session.scan({ type: 'tool/result', limit: 10 })).map((row) => row.data)
          assert.ok(
            prompts.includes('skill-install-confirm'),
            'The domain install confirmation must be reached',
          )
        }
        const disk = await Promise.all(
          ['created.txt', join(outside, 'created.txt'), join(outside, 'approved.txt'), memoryPath].map(
            async (path) => ({
              path,
              content: await readFile(resolve(workspace, path), 'utf8').catch(() => null),
            }),
          ),
        )
        const entry = { preset, operation, prompts: [...prompts], outcome, result, disk }
        rows.push(entry)
        process.stdout.write(`${JSON.stringify(entry).replaceAll(scratch, '<tmp>')}\n`)
        queued = undefined
        await session.close()
      }
    } finally {
      await host.close()
      await ep.close()
    }
  }
  assert.ok(wire.requests.length > 0, 'real HTTP model requests must occur')
  process.stdout.write(
    `${JSON.stringify({ operation: 'probe-summary', checks: rows.length, httpRequests: wire.requests.length, node: process.version, platform: process.platform, arch: process.arch })}\n`,
  )
  const review = createAutoReviewPolicy(defaultToolPolicy)
  const input: ToolPolicyInput = {
    sessionKey: 'probe',
    workspaceRoot: scratch,
    cwd: scratch,
    actor: { id: 'human', org: 'synthetic', role: 'user', deptPath: [], attrs: {} },
    call: { id: 'probe', name: 'shell', args: { command: 'echo synthetic' } },
    policy: {
      isReadOnly: false,
      isDestructive: true,
      replay: 'never',
      requiresApproval: 'destructive',
      approvalScopes: [],
    },
    fullAccess: false,
    tainted: false,
    approvalMode: 'auto-review',
  }
  const first = await review.decide(input, new AbortController().signal)
  assert.ok(first.review)
  const next = await review.decide(
    {
      ...input,
      tainted: true,
      config: {
        overrides: [{ tool: 'shell', scopeHash: first.review.scopeHash, decision: 'allow', risk: 'low' }],
      },
    },
    new AbortController().signal,
  )
  assert.equal(next.effect, 'allow')
  process.stdout.write(
    `${JSON.stringify({ operation: 'auto-review-tainted-exact-override', effect: next.effect, source: next.review?.source })}\n`,
  )
} finally {
  await wire.close()
  await rm(scratch, { recursive: true, force: true })
}

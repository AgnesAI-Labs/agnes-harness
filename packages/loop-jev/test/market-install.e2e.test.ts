import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type FakeSystemOne, startFakeSystemOne } from '@agnes/ai/testkit'
import { initializeHome } from '@agnes/host'
import type { PackageOperationReceipt } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { answersFor, PICK_LS, PICK_RESPOND } from './helpers/fake-jev.js'

// The user's path end to end, against the real daemon: find the Jev loop in the Market catalogue,
// install it from the payload the release ships, trust and enable it, see it in the loop picker's
// data, configure it, and run a turn on it. The daemon is the source daemon the other daemon
// end-to-end tests use (production loader, real package manager, real plugin configuration).
const sourceDaemon = fileURLToPath(
  new URL('../../daemon/test/fixtures/source-loop-daemon.ts', import.meta.url),
)
const PROFILE = 'local-dev'
const PACKAGE = '@agnes/jev-loop'
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(
      new URL('../../package-manager/bundled-plugins/jev-loop/package.json', import.meta.url),
      'utf8',
    ),
  ) as { version: string }
).version
const ROW = 'ext:agnes.jev/loop'
const LOOP = { id: 'agnes.jev', version: '0.1.0' }
const JEV_KEY = 'TEST-KEY-0123456789'
const JEV_MODEL = 'typesafe/jev-1.13-20260917'

const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 120_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type Sdk = ReturnType<typeof createClient>
async function operation(sdk: Sdk, receipt: PackageOperationReceipt) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const result = await sdk.packages.operation.get({
      profile: receipt.profile,
      operationId: receipt.operationId,
    })
    if (result.state === 'completed') return result
    if (['failed', 'cancelled', 'rolled-back'].includes(result.state))
      throw new Error(`package ${result.operation}: ${JSON.stringify(result.error)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`package ${receipt.operationId} timed out`)
}

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']

describe('the Jev loop installed from the Market into a real daemon', () => {
  let root: string
  let fake: FakeSystemOne
  let daemon: ChildProcess
  let exited: Promise<number | null>
  let sdk: Sdk
  let socketPath: string | undefined
  let stderr = ''

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-jev-market-')))
    // Every pick is the first option except the two phases the scenario scripts: list, then answer.
    fake = await startFakeSystemOne((n, seen) => {
      const questions = (seen.body as { questions?: Record<string, unknown> } | null)?.questions ?? {}
      return { answers: answersFor(questions, { pick: n === 0 ? PICK_LS : PICK_RESPOND, confidence: 0.9 }) }
    })
    initializeHome(root, PROFILE)
    const secrets = join(root, 'credentials')
    mkdirSync(join(secrets, 'jev'), { recursive: true, mode: 0o700 })
    writeFileSync(join(secrets, 'jev', 'key'), JEV_KEY, { mode: 0o600 })
    const model = (over: Record<string, unknown>) => ({
      name: over.id,
      reasoning: false,
      input: ['text'],
      contextWindow: 65536,
      maxTokens: 8192,
      toolCallFormats: ['native'],
      thinkingReplay: 'drop',
      contract_id: null,
      ...over,
    })
    const reply = [
      { type: 'text_delta', delta: 'The workspace has a credentials folder.' },
      {
        type: 'usage',
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ]
    writeFileSync(
      join(root, 'profiles', PROFILE, 'profile.yaml'),
      JSON.stringify({
        name: PROFILE,
        computerUse: { enabled: false },
        // The first request that needs the shared worker boots it, and assembling its Host takes
        // about 15 s on an idle machine; the 30 s default fails on a loaded or swapping one.
        limits: { 'worker.startup_ms': 120_000 },
        adapters: { secrets: { kind: 'file', path: secrets } },
        provider: {
          package: '@agnes/ai',
          catalog: { include: [] },
          routes: [
            {
              route: 'jev',
              api: 'typesafe-systemone',
              baseUrl: fake.url,
              credentialRef: 'secret://jev/key',
              models: [
                model({
                  id: JEV_MODEL,
                  api: 'typesafe-systemone',
                  route: 'jev',
                  baseUrl: fake.url,
                  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
                  toolCallFormats: [],
                }),
              ],
            },
            {
              route: 'main',
              api: 'scripted',
              baseUrl: 'https://scripted.invalid',
              compat: { replies: [reply], repeatLast: true },
              models: [
                model({
                  id: 'main-1',
                  api: 'scripted',
                  route: 'main',
                  baseUrl: 'https://scripted.invalid',
                  cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
                  contextWindow: 200000,
                }),
              ],
            },
          ],
        },
      }),
    )
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: root }
    // The stand-in is on loopback; a proxy set on the machine must not sit in between.
    for (const key of PROXY_VARIABLES) delete env[key]
    env.NO_PROXY = '127.0.0.1,localhost'
    daemon = spawn(process.execPath, ['--import', 'tsx', sourceDaemon, root, root], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve))
    const ready = new Promise<void>((resolve, reject) => {
      daemon.once('error', reject)
      daemon.stderr?.on('data', (data) => {
        stderr += String(data)
        if (stderr.includes('agnesd listening on ')) resolve()
      })
      daemon.once('exit', (code) => reject(new Error(`source daemon exited ${code}: ${stderr}`)))
    })
    await bounded(ready, 'source daemon boot')
    const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
    socketPath = owner.socketPath
    sdk = createClient({
      journal: memoryJournal(),
      timeouts: { request: 120_000 },
      transport: { kind: 'unix', path: owner.socketPath },
    })
    await sdk.initialize()
  }, 180_000)

  afterAll(async () => {
    await sdk?.close()
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM')
      const timer = setTimeout(() => daemon.kill('SIGKILL'), 20_000)
      await exited
      clearTimeout(timer)
    }
    await fake?.close()
    if (socketPath) rmSync(dirname(socketPath), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }, 40_000)

  it('offers the loop in the Market, installs and uninstalls it, then installs it again, lists the loop and runs a turn on it', async () => {
    const loops = async () => (await sdk.sessionSelection.loops()).map((l) => `${l.id}@${l.version}`)

    // The Market lists it, tagged as a run mode, before anything is installed; the picker does not.
    const page = await sdk.packages.catalog.list({ profile: PROFILE, query: 'jev', limit: 50 })
    const entry = page.items.find((item) => item.id === PACKAGE)
    expect(entry, JSON.stringify(page.items.map((item) => item.id))).toMatchObject({
      id: PACKAGE,
      version: PACKAGE_VERSION,
      source: { type: 'file', ref: 'file:./bundled-plugins/jev-loop' },
      sourceId: 'builtin-plugins',
      // Optional: the UI offers uninstall for it, unlike the default-enabled helpers.
      presentation: { origin: 'official', optional: true },
      provides: ['loop'],
      metadata: { locales: { 'zh-CN': { displayName: expect.any(String) } } },
    })
    expect(await loops()).not.toContain('agnes.jev@0.1.0')

    // Install, trust and enable: the calls the Market's install button makes.
    const common = { profile: PROFILE, clientId: await sdk.clientId() }
    const source = { type: 'file' as const, ref: 'file:./bundled-plugins/jev-loop' }
    const installFromMarket = async (round: string) => {
      const inspection = await operation(
        sdk,
        await sdk.packages.inspect({ ...common, commandId: `inspect-${round}`, source }),
      )
      const preview = inspection.preview
      if (!preview) throw new Error('the inspection returned no preview')
      expect(preview).toMatchObject({ id: PACKAGE, blockers: [] })
      await operation(
        sdk,
        await sdk.packages.install({
          ...common,
          commandId: `install-${round}`,
          source,
          expectedIntegrity: preview.integrity,
        }),
      )
      await operation(
        sdk,
        await sdk.packages.trust({
          ...common,
          commandId: `trust-${round}`,
          id: PACKAGE,
          expectedIntegrity: preview.integrity,
          capabilityHash: preview.capabilityHash ?? '',
        }),
      )
      await operation(
        sdk,
        await sdk.packages.enable({ ...common, commandId: `enable-${round}`, id: PACKAGE }),
      )
    }
    await installFromMarket('first')

    // The installed row keeps the optional marker, so the UI offers uninstall for it.
    const installed = (await sdk.packages.list({ profile: PROFILE })).packages.find((p) => p.id === PACKAGE)
    expect(installed?.presentation).toMatchObject({ origin: 'official', optional: true })
    // A default-enabled helper is part of the product: it carries no optional marker.
    const helper = (await sdk.packages.list({ profile: PROFILE })).packages.find(
      (p) => p.id === '@agnes/skill-helper',
    )
    expect(helper?.presentation?.origin).toBe('official')
    expect(helper?.presentation).not.toHaveProperty('optional')

    // Uninstall works: disable, then remove. The loop leaves the picker and the Market offers it again.
    // This runs before any session uses the loop, because the daemon refuses to disable the provider
    // of a loop a live session is bound to.
    expect(await loops()).toContain('agnes.jev@0.1.0')
    await operation(sdk, await sdk.packages.disable({ ...common, commandId: 'disable', id: PACKAGE }))
    expect(await loops()).not.toContain('agnes.jev@0.1.0')
    await operation(sdk, await sdk.packages.remove({ ...common, commandId: 'remove', id: PACKAGE }))
    expect((await sdk.packages.list({ profile: PROFILE })).packages.map((p) => p.id)).not.toContain(PACKAGE)
    expect(await loops()).not.toContain('agnes.jev@0.1.0')
    const again = await sdk.packages.catalog.list({ profile: PROFILE, query: 'jev', limit: 50 })
    expect(again.items.map((item) => item.id)).toContain(PACKAGE)
    await installFromMarket('second')

    // The loop picker's data now has it, and names the package it comes from.
    expect(await loops()).toContain('agnes.jev@0.1.0')
    expect(await sdk.sessionSelection.loops()).toContainEqual(
      expect.objectContaining({ ...LOOP, sourcePackage: PACKAGE }),
    )

    // The plugin configuration page can read its schema, rejects a bad value and saves a good one.
    const config = await sdk.packages.config.get({ profile: PROFILE, id: PACKAGE })
    const jevRow = config.entries.find((item) => item.rowId === ROW)
    if (!jevRow) throw new Error(`no configuration entry for ${ROW}`)
    expect(jevRow.reload).toBe('next-session')
    const properties = (jevRow.schema as { properties: Record<string, { properties?: object }> }).properties
    expect(Object.keys(properties.jev?.properties ?? {})).toEqual(
      expect.arrayContaining(['route', 'model', 'deadlineMs', 'maxRetries']),
    )
    const invalid = { jev: { deadlineMs: 5 } }
    const verdict = await sdk.packages.config.validate({
      profile: PROFILE,
      id: PACKAGE,
      rowId: ROW,
      value: invalid,
    })
    expect(verdict.issues.length).toBeGreaterThan(0)
    const save = (value: unknown, revision: string, commandId: string) =>
      sdk.packages.config.save({
        profile: PROFILE,
        id: PACKAGE,
        rowId: ROW,
        value: value as never,
        expectedRevision: revision,
        clientId: common.clientId,
        commandId,
      })
    const rejected = await save(invalid, config.revision, 'save-invalid')
    expect(rejected).toMatchObject({ ok: false, reason: 'invalid' })
    const saved = await save({ jev: { route: 'jev', model: JEV_MODEL } }, config.revision, 'save-valid')
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, reason: 'saved' })
    expect(
      (await sdk.packages.config.get({ profile: PROFILE, id: PACKAGE })).entries.find((i) => i.rowId === ROW)
        ?.value,
    ).toMatchObject({ jev: { route: 'jev', model: JEV_MODEL } })

    // A turn on the installed loop: the bundled index.mjs, not the source, answers it. The loop
    // lists the workspace without the conversation model, then the model answers once.
    const session = await sdk.session.new({ cwd: root, sessionKey: 'market-turn', loop: LOOP })
    const result = await bounded(session.prompt('What is in this workspace?'), 'Jev turn')
    expect(result.reason).toBe('completed')
    expect(JSON.stringify((await session.projectUI()).nodes)).toContain(
      'The workspace has a credentials folder.',
    )
    expect(fake.seen.length).toBeGreaterThanOrEqual(2)
    expect((await sdk.session.runtime(session.id)).loop).toMatchObject(LOOP)
  }, 240_000)
})

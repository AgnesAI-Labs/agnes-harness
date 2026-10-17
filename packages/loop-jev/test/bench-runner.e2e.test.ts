import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FakeSystemOne, startFakeSystemOne } from '@agnes/ai/testkit'
import { createConfigurationService, createCredentialStore, initializeHomeLocked } from '@agnes/host'
import { afterAll, describe, expect, it } from 'vitest'

const out = mkdtempSync(join(tmpdir(), 'agnes-jev-bench-'))
const servers: Array<{ close(): Promise<unknown> }> = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  rmSync(out, { recursive: true, force: true })
})
const runner = new URL('../bench/run.mjs', import.meta.url).pathname
const suite = new URL('./fixtures/bench-mini.json', import.meta.url).pathname

/** The runner talks to loopback endpoints only, so no proxy set on the machine may sit in between. */
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...extra }
  for (const key of [...PROXY_VARIABLES, 'no_proxy', 'BENCH_PYTHON']) delete env[key]
  return { ...env, ...extra }
}
const args = (...rest: string[]) => ['--import', 'tsx', runner, ...rest]
const runSync = (rest: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, args(...rest), { encoding: 'utf8', timeout: 240_000, env: childEnv(extra) })
/** Spawned without blocking: the fake endpoints of the Settings cases live in this process. */
const runAsync = (rest: string[], extra: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args(...rest), { env: childEnv(extra) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => {
      stdout += b
    })
    child.stderr.on('data', (b) => {
      stderr += b
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('error', reject)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const readRecords = (dir: string) =>
  readFileSync(join(dir, 'records.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

const TEST_KEY = 'TEST-KEY-0123456789'
const JEV_MODEL = {
  id: 'typesafe/jev-1.13-20260917',
  name: 'Jev 1.13',
  contextWindow: 65536,
  maxTokens: 32768,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
}

/** An OpenAI-compatible chat endpoint on loopback that lists one model and always answers "ok". */
async function startChat(model: string): Promise<{ baseUrl: string; systems: string[] }> {
  const systems: string[] = []
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: model }] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const system = body.messages.find((m) => m.role === 'system' || m.role === 'developer')
    systems.push(JSON.stringify(system?.content ?? ''))
    const chunk = { id: 'chat-fixture', object: 'chat.completion.chunk', created: 0, model }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`,
    )
    res.end(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push({
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  })
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systems }
}

async function startJev(script: Parameters<typeof startFakeSystemOne>[0] = {}): Promise<FakeSystemOne> {
  const fake = await startFakeSystemOne(script)
  servers.push(fake)
  return fake
}

/** A home configured the way the Settings page saves accounts: no profile file, keys in the home's store. */
async function settingsHome(o: {
  name: string
  chat?: Array<{ baseUrl: string; accountId?: string }>
  jev?: Array<{ baseUrl: string; accountId: string }>
}): Promise<string> {
  const home = join(out, o.name, 'home')
  mkdirSync(join(out, o.name), { recursive: true })
  await initializeHomeLocked(home, 'local-dev')
  const service = createConfigurationService({ home, profile: 'local-dev' })
  let revision = 0
  for (const chat of o.chat ?? []) {
    const saved = await service.save({
      providerId: 'deepseek',
      ...(chat.accountId ? { accountId: chat.accountId } : {}),
      baseUrl: chat.baseUrl,
      apiKey: TEST_KEY,
      model: 'deepseek-flash',
      expectedRevision: revision,
    })
    revision = saved.revision
  }
  for (const [i, jev] of (o.jev ?? []).entries()) {
    const ref = `secret://generic/1111111${i}-1111-4111-8111-111111111111`
    await createCredentialStore({ root: home }).putGeneric(ref, TEST_KEY, {
      label: 'Jev',
      createdAt: '2026-10-17T00:00:00.000Z',
    })
    const saved = await service.save({
      providerId: 'typesafe-systemone',
      accountId: jev.accountId,
      label: 'Jev',
      credentialRef: ref,
      baseUrl: jev.baseUrl,
      model: JEV_MODEL.id,
      models: [JEV_MODEL],
      expectedRevision: revision,
    })
    revision = saved.revision
  }
  return home
}

describe('bench runner', () => {
  it('plans the cells without booting in --dry-run', () => {
    const r = runSync([
      '--suite',
      suite,
      '--lanes',
      'default,jev',
      '--reps',
      '1',
      '--out',
      join(out, 'dry'),
      '--fake',
      '--dry-run',
    ])
    expect(r.status, r.stderr).toBe(0)
    const bundle = readJson(join(out, 'dry', 'bundle.json'))
    expect(Object.keys(bundle.presets)).toHaveLength(2)
    expect(bundle.profile.plugins['loop:agnes.jev']).toMatchObject({
      enabled: true,
      config: { stepCap: 20, jev: { route: 'jev', model: JEV_MODEL.id } },
    })
    const profile = readJson(join(out, 'dry', 'home', 'profiles', 'local-dev', 'profile.yaml'))
    expect(profile.provider.routes.map((route: { api: string }) => route.api)).toEqual([
      'typesafe-systemone',
      'scripted',
    ])
    expect(profile.adapters.secrets).toEqual({ kind: 'file', path: join(out, 'dry', 'home', 'credentials') })
    expect(r.stdout).toContain('mini')
    expect(readdirSync(join(out, 'dry'))).not.toContain('records.jsonl')
  })

  it('runs both lanes end to end with the routes in the profile file, against a fake Jev and a scripted model', () => {
    const dir = join(out, 'fake')
    const r = runSync(['--suite', suite, '--lanes', 'default,jev', '--reps', '1', '--out', dir, '--fake'])
    expect(r.status, r.stderr).toBe(0)
    const report = readJson(join(dir, 'report.json'))
    const records = readRecords(dir)
    expect(records.map((x) => x.lane).sort()).toEqual(['default', 'jev'])
    const jev = records.find((x) => x.lane === 'jev')
    expect(jev.metrics.sideCall).toBeGreaterThan(0)
    expect(jev.metrics.reconciled).toBe(true)
    expect(records.every((x) => x.score.probesPass)).toBe(true)
    expect(report.totals.byLane.jev.passes + report.totals.byLane.default.passes).toBeGreaterThan(0)
    const md = readFileSync(join(dir, 'report.md'), 'utf8')
    expect(md).toContain('# Bench report: bench-mini')
    expect(md).toMatch(/- jev: \d+ requests, 1 tool schema hashes, 0 switches/)
  }, 300_000)

  it('takes the routes from the accounts saved in Settings and runs both lanes', async () => {
    const chat = await startChat('deepseek-flash')
    const jevFake = await startJev()
    const home = await settingsHome({
      name: 'settings',
      chat: [{ baseUrl: chat.baseUrl }],
      jev: [{ baseUrl: jevFake.url, accountId: 'jev-side' }],
    })
    // The probe calls `python`; a stub interpreter stands in so the check needs no Python install.
    const stub = join(out, 'settings', 'stub-python')
    writeFileSync(stub, '#!/bin/sh\necho "STUB_PY_OK $*"\n')
    chmodSync(stub, 0o755)
    const pySuite = join(out, 'settings', 'suite.json')
    const mini = readJson(suite)
    mini.scenarios[0].turns[0].bash.push({ command: 'python -B -c pass', contains: 'STUB_PY_OK -B -c pass' })
    writeFileSync(pySuite, JSON.stringify(mini))
    const dir = join(out, 'settings', 'run')
    const r = await runAsync(
      ['--suite', pySuite, '--lanes', 'default,jev', '--reps', '1', '--out', dir, '--home', home],
      {
        BENCH_PYTHON: stub,
      },
    )
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('jev route account-jev-side')
    const report = readJson(join(dir, 'report.json'))
    expect(report.routes).toEqual({
      source: 'settings',
      jev: { route: 'account-jev-side', model: JEV_MODEL.id },
      chat: { route: 'deepseek', model: 'deepseek-flash' },
    })
    const records = readRecords(dir)
    expect(records.map((x) => x.lane).sort()).toEqual(['default', 'jev'])
    expect(records.every((x) => x.score.probesPass)).toBe(true)
    expect(records.every((x) => x.tools.join(',') === 'edit,find,grep,ls,read,shell,write')).toBe(true)
    const jev = records.find((x) => x.lane === 'jev')
    expect(jev.metrics.sideCall).toBeGreaterThan(0)
    expect(jev.metrics.reconciled).toBe(true)
    // Settings prices the catalogue model, so the cost comes from the ledger rows and the route prices.
    expect(records.every((x) => x.metrics.usdMicros > 0)).toBe(true)
    // Each cell's preset from the bundle reaches the chat model: its cache scope is in the system prompt.
    const bundle = readJson(join(dir, 'bundle.json'))
    const scopes = Object.values(bundle.presets).map(
      (p) => (p as { model: { system_prompt: { personaPrefix: string } } }).model.system_prompt.personaPrefix,
    )
    expect(scopes).toHaveLength(2)
    for (const scope of scopes) expect(chat.systems.some((s) => s.includes(scope))).toBe(true)
    // The plugin row's Jev route from the bundle is the Settings account's route.
    const sideRoutes = readFileSync(join(dir, 'events', 'mini.jev.r1.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === 'cost/ledger' && e.data.purpose === 'side-call')
      .map((e) => e.data.route)
    expect(sideRoutes.length).toBeGreaterThan(0)
    expect(new Set(sideRoutes)).toEqual(new Set(['account-jev-side']))
    expect(jevFake.seen.length).toBe(sideRoutes.length)
    expect(report.totals.byLane.jev.turns + report.totals.byLane.default.turns).toBe(2)
    // Nothing is written into the home's profile: the bench settings travel in the bundle.
    expect(readdirSync(join(home, 'profiles', 'local-dev'))).not.toContain('profile.yaml')
  }, 300_000)

  it('names what is missing or ambiguous in the saved accounts', async () => {
    const plan = (home: string, ...extra: string[]) =>
      runSync([
        '--suite',
        suite,
        '--lanes',
        'default,jev',
        '--reps',
        '1',
        '--out',
        join(home, '..', 'out'),
        '--home',
        home,
        '--dry-run',
        ...extra,
      ])
    const loop = 'http://127.0.0.1:9/v1'
    const noJev = plan(
      await settingsHome({
        name: 'no-jev',
        chat: [{ baseUrl: (await startChat('deepseek-flash')).baseUrl }],
      }),
    )
    expect(noJev.status).toBe(2)
    expect(noJev.stderr).toContain('no Jev side-model account')
    const noChat = plan(await settingsHome({ name: 'no-chat', jev: [{ baseUrl: loop, accountId: 'jev' }] }))
    expect(noChat.status).toBe(2)
    expect(noChat.stderr).toContain('no chat model account')
    const twoJev = await settingsHome({
      name: 'two-jev',
      chat: [{ baseUrl: (await startChat('deepseek-flash')).baseUrl }],
      jev: [
        { baseUrl: loop, accountId: 'jev-a' },
        { baseUrl: loop, accountId: 'jev-b' },
      ],
    })
    const ambiguous = plan(twoJev)
    expect(ambiguous.status).toBe(2)
    expect(ambiguous.stderr).toContain('--jev-route')
    expect(ambiguous.stderr).toContain('account-jev-a, account-jev-b')
    const chosen = plan(twoJev, '--jev-route', 'account-jev-b')
    expect(chosen.status, chosen.stderr).toBe(0)
    expect(chosen.stdout).toContain('jev route account-jev-b')
    const wrong = plan(twoJev, '--jev-route', 'account-jev-b', '--chat-route', 'account-jev-a')
    expect(wrong.status).toBe(2)
    expect(wrong.stderr).toContain('account-jev-a is not a chat model route')
  }, 120_000)

  it('runs the baseline pilot on a home with only a chat account and reports k', async () => {
    const home = await settingsHome({
      name: 'pilot',
      chat: [{ baseUrl: (await startChat('deepseek-flash')).baseUrl }],
    })
    const dir = join(out, 'pilot', 'run')
    const r = await runAsync(['--suite', suite, '--out', dir, '--home', home, '--pilot'])
    expect(r.status, r.stderr).toBe(0)
    const report = readJson(join(dir, 'report.json'))
    expect(report.lanes).toEqual(['default'])
    expect(report.routes.jev).toBeNull()
    expect(report.pilot).toMatchObject({ k: 1, mutableCalls: 0, toolInferences: 0 })
    expect(report.verdict).toBeUndefined()
    expect(readRecords(dir).map((x) => x.lane)).toEqual(['default'])
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('## Pilot')
  }, 300_000)

  it('cancels a turn that outlives its watchdog, keeps it as a failure and exits 1', async () => {
    const chat = await startChat('deepseek-flash')
    const jevFake = await startJev({ hang: true })
    const home = await settingsHome({
      name: 'timeout',
      chat: [{ baseUrl: chat.baseUrl }],
      jev: [{ baseUrl: jevFake.url, accountId: 'jev' }],
    })
    const dir = join(out, 'timeout', 'run')
    const r = await runAsync([
      '--suite',
      suite,
      '--lanes',
      'jev',
      '--out',
      dir,
      '--home',
      home,
      '--turn-timeout-ms',
      '3000',
    ])
    expect(r.status, r.stderr).toBe(1)
    const [record] = readRecords(dir)
    expect(record).toMatchObject({
      lane: 'jev',
      endReason: 'timeout',
      score: { pass: false, completed: false },
    })
    const report = readJson(join(dir, 'report.json'))
    expect(report.flags.join('\n')).toContain('timeout after 3000 ms in turn 1')
  }, 300_000)

  it('refuses a suite whose probes call python when no interpreter can be found', () => {
    const dir = join(out, 'nopy')
    mkdirSync(dir, { recursive: true })
    const pySuite = join(dir, 'suite.json')
    const mini = readJson(suite)
    mini.scenarios[0].turns[0].bash[0].command = 'python -c pass'
    writeFileSync(pySuite, JSON.stringify(mini))
    const r = runSync(
      [
        '--suite',
        pySuite,
        '--lanes',
        'default',
        '--reps',
        '1',
        '--out',
        join(dir, 'out'),
        '--fake',
        '--dry-run',
      ],
      {
        BENCH_PYTHON: join(dir, 'missing-python'),
      },
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('BENCH_PYTHON')
    expect(r.stderr).toContain('missing-python')
  })
})

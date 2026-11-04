import { execFile, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type FakeSystemOne, startFakeSystemOne } from '@agnes/ai/testkit'
import {
  createConfigurationService,
  createCredentialStore,
  createSecretsFile,
  initializeHomeLocked,
} from '@agnes/host'
import { afterAll, describe, expect, it } from 'vitest'
import { sourceTranspileCache } from '../../daemon/test/source-transpile-cache.js'

const out = mkdtempSync(join(tmpdir(), 'agnes-jev-bench-'))
const servers: Array<{ close(): Promise<unknown> }> = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  rmSync(out, { recursive: true, force: true })
})
/** A machine that cannot sandbox a workspace (some CI runners) refuses every session; those runs cannot say anything about the runner. */
const lacksSandbox = (r: { stderr?: string; stdout?: string }) =>
  /E_SANDBOX_WORKSPACE/.test(`${r.stderr ?? ''}${r.stdout ?? ''}`)
const NO_SANDBOX = 'no workspace sandbox on this machine'

/** The message of a failed exit-status check: the runner's stderr, plus the tail of its stdout where the report verdict is printed. */
const why = (r: { stderr?: string; stdout?: string }) =>
  `${r.stderr ?? ''}\n--- stdout tail ---\n${(r.stdout ?? '').slice(-2000)}`

const runner = fileURLToPath(new URL('../bench/run.mjs', import.meta.url))
const suite = fileURLToPath(new URL('./fixtures/bench-mini.json', import.meta.url))

/** The runner talks to loopback endpoints only, so no proxy set on the machine may sit in between. */
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_PROXY: '127.0.0.1,localhost',
    // Each case boots a source Host in a fresh home; share only the plugin transpile cache.
    AGH_BENCH_TRANSPILE_CACHE: sourceTranspileCache(),
    ...extra,
  }
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

/**
 * An OpenAI-compatible chat endpoint on loopback that lists one model and answers "ok". With
 * `toolCalls`, a request whose latest user message asks for "Turn <n>" first gets one `ls` call per
 * request until the turn holds `toolCalls(n)` tool results, so turn n makes toolCalls(n) + 1 requests.
 */
async function startChat(
  model: string,
  toolCalls?: (turn: number) => number,
): Promise<{ baseUrl: string; systems: string[]; bodies: string[] }> {
  const systems: string[] = []
  const bodies: string[] = []
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
    bodies.push(Buffer.concat(chunks).toString('utf8'))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const system = body.messages.find((m) => m.role === 'system' || m.role === 'developer')
    systems.push(JSON.stringify(system?.content ?? ''))
    const chunk = { id: 'chat-fixture', object: 'chat.completion.chunk', created: 0, model }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // The goal of the turn is the latest user message naming a turn; the host may add others.
    const lastUser = body.messages.findLastIndex(
      (m) => m.role === 'user' && /Turn \d+/.test(JSON.stringify(m.content)),
    )
    const asked = /Turn (\d+)/.exec(JSON.stringify(body.messages[lastUser]?.content ?? ''))
    const results = body.messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length
    if (toolCalls && asked && results < toolCalls(Number(asked[1]))) {
      const call = {
        index: 0,
        id: `call-${bodies.length}`,
        type: 'function',
        function: { name: 'ls', arguments: '{"path":"."}' },
      }
      res.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] })}\n\n`,
      )
      res.end(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
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
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systems, bodies }
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
  it('injects nested files using native paths and refuses paths outside the workspace', async () => {
    const { writeTurnFiles } = await import(new URL('../bench/run.mjs', import.meta.url).href)
    const workspace = join(out, 'injected')
    mkdirSync(workspace)
    writeTurnFiles(workspace, [{ name: '资料 folder/nested.txt', content: 'fixture' }])
    expect(readFileSync(join(workspace, '资料 folder', 'nested.txt'), 'utf8')).toBe('fixture')
    for (const name of ['.', '../escaped.txt', join(out, 'absolute-outside.txt')])
      expect(() => writeTurnFiles(workspace, [{ name, content: 'refused' }])).toThrow('leaves the workspace')
    expect(existsSync(join(out, 'escaped.txt'))).toBe(false)
    expect(existsSync(join(out, 'absolute-outside.txt'))).toBe(false)
  })

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
    expect(r.status, why(r)).toBe(0)
    const bundle = readJson(join(out, 'dry', 'bundle.json'))
    expect(Object.keys(bundle.presets)).toHaveLength(2)
    expect(bundle.profile.plugins['ext:agnes.jev/loop']).toMatchObject({
      enabled: true,
      config: { stepCap: 20, jev: { route: 'jev', model: JEV_MODEL.id } },
    })
    const profile = readJson(join(out, 'dry', 'home', 'profiles', 'local-dev', 'profile.yaml'))
    expect(profile.provider.routes.map((route: { api: string }) => route.api)).toEqual([
      'typesafe-systemone',
      'scripted',
    ])
    expect(profile.adapters.secrets).toEqual({ kind: 'file', path: join(out, 'dry', 'home', 'secrets') })
    expect(createSecretsFile({ dir: profile.adapters.secrets.path }).resolve('secret://jev/key')).toBe(
      'TEST-KEY-0123456789',
    )
    expect(r.stdout).toContain('mini')
    expect(readdirSync(join(out, 'dry'))).not.toContain('records.jsonl')
    // A plan installs nothing: the Jev package goes into the home only when a host is about to boot.
    expect(existsSync(join(out, 'dry', 'home', 'profiles', 'local-dev', 'agnes-lock.json'))).toBe(false)
    expect(r.stderr).not.toContain('warning')
  })

  it('releases the fake endpoint when profile publication fails', async () => {
    const setup = new URL('../bench/setup.mjs', import.meta.url).href
    const script = `
      import fs from 'node:fs';
      import { Server } from 'node:net';
      import { syncBuiltinESMExports } from 'node:module';
      let listening = false;
      const listen = Server.prototype.listen;
      Server.prototype.listen = function (...args) {
        this.once('listening', () => { listening = true });
        return Reflect.apply(listen, this, args);
      };
      const write = fs.writeFileSync;
      fs.writeFileSync = function (file, ...args) {
        if (listening && String(file).endsWith('profile.yaml'))
          throw Object.assign(new Error('expected profile publication refusal'), { code: 'EIO' });
        return write(file, ...args);
      };
      syncBuiltinESMExports();
      const { prepareFakeHome } = await import(${JSON.stringify(setup)});
      try {
        await prepareFakeHome(${JSON.stringify(join(out, 'failed-profile'))});
        throw new Error('profile publication should fail');
      } catch (error) {
        if (error.code !== 'EIO') throw error;
        console.log('EXPECTED_PROFILE_FAILURE');
      }
    `
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        env: childEnv(),
        timeout: 60_000,
        windowsHide: true,
      },
    )
    // A leaked listening endpoint keeps this process alive until the watchdog kills it.
    expect(result.stdout.trim()).toBe('EXPECTED_PROFILE_FAILURE')
  }, 75_000)

  // Six cold runner processes (node --import tsx) run one after another. The 5 s Vitest default
  // that applies on Linux is a budget for one in-process test, not for six process starts.
  it('refuses setups whose numbers would not hold', () => {
    const plan = (extra: string[], env: Record<string, string> = {}) =>
      runSync(['--suite', suite, '--out', join(out, 'refuse'), '--fake', '--dry-run', ...extra], env)
    // Workspaces are made in the temp directory, so a temp directory inside a repository is refused.
    const repo = join(out, 'tmp-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'tmp'), { recursive: true })
    const inRepo = plan([], {
      TMPDIR: join(repo, 'tmp'),
      TEMP: join(repo, 'tmp'),
      TMP: join(repo, 'tmp'),
    })
    expect(inRepo.status).toBe(2)
    expect(inRepo.stderr).toContain(`inside the git work tree ${realpathSync(repo)}`)
    const profile = plan(['--profile', 'bench'])
    expect(profile.status).toBe(2)
    expect(profile.stderr).toContain('--profile must be one of local-dev, enterprise')
    const notPilot = join(out, 'not-a-pilot.json')
    writeFileSync(notPilot, JSON.stringify({ verdict: {} }))
    const kFrom = plan(['--k-from', notPilot])
    expect(kFrom.status).toBe(2)
    expect(kFrom.stderr).toContain('is not a pilot report')
    expect(plan(['--k', '2', '--k-from', notPilot]).stderr).toContain('at most one of --k and --k-from')
    const noK = plan(['--reps', '2'])
    expect(noK.status, why(noK)).toBe(0)
    expect(noK.stderr).toContain('warning: no --k or --k-from given')
  }, 60_000)

  it('runs both lanes end to end with the routes in the profile file, against a fake Jev and a scripted model', (ctx) => {
    // The output directory sits inside a git work tree; the sessions' workspaces must not.
    const repo = join(out, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const dir = join(repo, 'bench-out')
    const pilotReport = join(out, 'pilot-report.json')
    writeFileSync(pilotReport, JSON.stringify({ pilot: { k: 1.5 } }))
    const r = runSync([
      '--suite',
      suite,
      '--lanes',
      'default,jev',
      '--reps',
      '1',
      '--out',
      dir,
      '--fake',
      '--k-from',
      pilotReport,
    ])
    if (lacksSandbox(r)) ctx.skip(NO_SANDBOX)
    expect(r.status, why(r)).toBe(0)
    const report = readJson(join(dir, 'report.json'))
    expect(report).toMatchObject({ k: 1.5, kSource: `pilot report ${pilotReport}`, verdict: { valid: true } })
    const records = readRecords(dir)
    expect(records.map((x) => x.lane).sort()).toEqual(['default', 'jev'])
    // The runner put the Jev loop's bundled package into the home, installed, trusted and enabled.
    expect(r.stdout).toContain('installed and enabled @agnes/jev-loop')
    const lock = readJson(join(dir, 'home', 'profiles', 'local-dev', 'agnes-lock.json'))
    expect(lock.packages['@agnes/jev-loop']).toMatchObject({ state: { enabled: true } })
    for (const record of records) {
      expect(record.workspace.startsWith(realpathSync(repo))).toBe(false)
      expect(existsSync(record.workspace)).toBe(false)
      expect(record.kept).toBe(join(dir, 'workspaces', `mini.${record.lane}.r1`))
      expect(existsSync(record.kept)).toBe(true)
    }
    expect(readRecords(dir).find((x) => x.lane === 'jev').jevDecide).toMatchObject({ byStatus: { ok: 2 } })
    const jev = records.find((x) => x.lane === 'jev')
    expect(jev.metrics.sideCall).toBeGreaterThan(0)
    expect(jev.metrics.reconciled).toBe(true)
    expect(records.every((x) => x.score.probesPass)).toBe(true)
    expect(report.totals.byLane.jev.passes + report.totals.byLane.default.passes).toBeGreaterThan(0)
    const md = readFileSync(join(dir, 'report.md'), 'utf8')
    expect(md).toContain('# Bench report: bench-mini')
    expect(md).toMatch(/- jev: \d+ requests, 1 tool schema hashes, 0 switches/)
  }, 300_000)

  it('takes the routes from the accounts saved in Settings and runs both lanes', async (ctx) => {
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
    // The output directory is inside a git work tree whose instruction file must reach no session.
    const repo = join(out, 'settings', 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, 'AGENTS.md'), 'REPO_RULES_MUST_NOT_REACH_THE_BENCH\n')
    const dir = join(repo, 'run')
    const r = await runAsync(
      ['--suite', pySuite, '--lanes', 'default,jev', '--reps', '1', '--out', dir, '--home', home],
      {
        BENCH_PYTHON: stub,
      },
    )
    if (lacksSandbox(r)) ctx.skip(NO_SANDBOX)
    expect(r.status, why(r)).toBe(0)
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
    expect(chat.bodies.length).toBeGreaterThan(0)
    expect(chat.bodies.some((b) => b.includes('REPO_RULES_MUST_NOT_REACH_THE_BENCH'))).toBe(false)
    // The plugin row's Jev route from the bundle is the Settings account's route. The host's own
    // side calls (reply suggestions on the chat route after a completed turn) are counted apart.
    const sideCalls = (lane: string) =>
      readFileSync(join(dir, 'events', `mini.${lane}.r1.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((e) => e.type === 'cost/ledger' && e.data.purpose === 'side-call')
    const onJev = sideCalls('jev').filter((e) => e.data.route === 'account-jev-side')
    expect(onJev.length).toBeGreaterThan(0)
    expect(jevFake.seen.length).toBe(onJev.length)
    expect(sideCalls('default').filter((e) => e.data.route === 'account-jev-side')).toEqual([])
    // The Jev totals hold exactly the calls the Jev endpoint served, whatever else called a model.
    expect(jev.metrics.sideCall).toBe(jevFake.seen.length)
    for (const lane of ['default', 'jev']) {
      const others = sideCalls(lane).filter((e) => e.data.route !== 'account-jev-side')
      expect(report.otherSideCalls[lane]?.count ?? 0).toBe(others.length)
    }
    const suggestions = chat.bodies.filter((b) =>
      b.includes("Write the user's most likely next message to the assistant"),
    ).length
    // The host does make such calls here, so the separation above is exercised, not vacuous.
    expect(suggestions).toBeGreaterThan(0)
    // Shutdown can settle an auxiliary intent before the provider receives it. Partition every
    // durable side-call row exactly; received HTTP requests cannot count those interrupted intents.
    expect(report.otherSideCalls.default.count + report.otherSideCalls.jev.count + jev.metrics.sideCall).toBe(
      [...sideCalls('default'), ...sideCalls('jev')].length,
    )
    // Other side calls never reach the cost the gates compare.
    const configured = await createConfigurationService({ home, profile: 'local-dev' }).profileInput()
    const chatPrice = configured.provider?.routes
      ?.find((route) => route.route === 'deepseek')
      ?.models?.find((model) => model.id === 'deepseek-flash')?.cost
    if (!chatPrice) throw new Error('Saved chat model has no catalogue price')
    const ledgerCost = (lane: string) =>
      sideCalls(lane)
        .filter((e) => e.data.route !== 'account-jev-side')
        .reduce((sum, e) => {
          expect(e.data).toMatchObject({ route: 'deepseek', model: 'deepseek-flash' })
          // Shutdown may interrupt a hint before usage arrives. The report prices its durable
          // token estimate with the saved model catalogue instead of treating missing billing as free.
          const tokens = e.data.tokens
          return (
            sum +
            (e.data.billing?.usdMicros ??
              tokens.input * chatPrice.input +
                tokens.output * chatPrice.output +
                tokens.cacheRead * chatPrice.cacheRead +
                tokens.cacheWrite * chatPrice.cacheWrite)
          )
        }, 0)
    expect(report.otherSideCalls.jev.usdMicros).toBe(ledgerCost('jev'))
    const jevTurnCost = records.find((x) => x.lane === 'jev').metrics.usdMicros
    expect(report.totals.byLane.jev.usdMicros).toBe(jevTurnCost)
    expect(report.totals.byLane.jev.turns + report.totals.byLane.default.turns).toBe(2)
    // Nothing is written into the home's profile: the bench settings travel in the bundle.
    expect(readdirSync(join(home, 'profiles', 'local-dev'))).not.toContain('profile.yaml')
  }, 300_000)

  it('reports each turn of a multi-turn session with its own requests, steps, cost and wall time', async (ctx) => {
    // Turn n makes n model requests on the default lane: n - 1 `ls` calls, then the answer.
    const chat = await startChat('deepseek-flash', (turn) => turn - 1)
    const jevFake = await startJev()
    const home = await settingsHome({
      name: 'window',
      chat: [{ baseUrl: chat.baseUrl }],
      jev: [{ baseUrl: jevFake.url, accountId: 'jev' }],
    })
    const multi = join(out, 'window', 'suite.json')
    const probe = [{ command: 'node -e "console.log(1)"', contains: '1' }]
    writeFileSync(
      multi,
      JSON.stringify({
        suite: 'bench-window',
        scenarios: [
          {
            id: 'three',
            category: 'plumbing',
            turns: [1, 2, 3].map((n) => ({
              goal: `Turn ${n}: say ok.`,
              answer_contains: ['ok'],
              bash: probe,
            })),
          },
        ],
      }),
    )
    const dir = join(out, 'window', 'run')
    const r = await runAsync(['--suite', multi, '--lanes', 'default,jev', '--out', dir, '--home', home])
    if (lacksSandbox(r)) ctx.skip(NO_SANDBOX)
    expect(r.status, why(r)).toBe(0)
    const records = readRecords(dir)
    const events = (lane: string) =>
      readFileSync(join(dir, 'events', `three.${lane}.r1.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    const of = (lane: string) => records.filter((x) => x.lane === lane).sort((a, b) => a.turn - b.turn)
    // The default lane: exactly n requests and n steps in turn n, each turn priced on its own rows.
    const all = events('default')
    const inference = all.filter((e) => e.type === 'cost/ledger' && e.data.purpose === 'inference')
    expect(inference).toHaveLength(6)
    const def = of('default')
    expect(def.map((x) => x.metrics.inference)).toEqual([1, 2, 3])
    expect(def.map((x) => x.steps)).toEqual([1, 2, 3])
    const starts = all.filter((e) => e.type === 'turn/start')
    const ends = all.filter((e) => e.type === 'turn/end')
    expect(starts).toHaveLength(3)
    for (const [i, x] of def.entries()) {
      const own = inference.filter((e) => e.seq > starts[i].seq && e.seq < ends[i].seq)
      expect(x.metrics.usdMicros).toBe(own.reduce((sum, e) => sum + e.data.billing.usdMicros, 0))
      expect(x.wallMs).toBe(Date.parse(ends[i].ts) - Date.parse(starts[i].ts))
      expect(x.endReason).toBe(ends[i].data.reason)
    }
    // On every lane the turns add up to the session's own ledger, and the report says so.
    const report = readJson(join(dir, 'report.json'))
    for (const lane of ['default', 'jev']) {
      const rows = events(lane).filter((e) => e.type === 'cost/ledger' && e.data.purpose === 'inference')
      expect(of(lane).reduce((sum, x) => sum + x.metrics.inference, 0)).toBe(rows.length)
      expect(report.totals.byLane[lane].inference).toBe(rows.length)
    }
    expect(report.sessionChecks.every((c: { ok: boolean }) => c.ok)).toBe(true)
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).not.toContain('COUNTS DO NOT ADD UP')
    // The pilot's k counts each tool-using request once: 1 in turn 2 and 2 in turn 3, all read-only.
    const pilotDir = join(out, 'window', 'pilot')
    const pilot = await runAsync(['--suite', multi, '--out', pilotDir, '--home', home, '--pilot'])
    expect(pilot.status, why(pilot)).toBe(0)
    expect(readJson(join(pilotDir, 'report.json')).pilot).toEqual({
      k: 1,
      mutableCalls: 0,
      toolInferences: 3,
      callsPerInference: { '0 mutable + 1 read-only': 3 },
    })

    // A rescore from the saved files, with no home and no network, gives the live numbers back.
    const again = join(out, 'window', 'rescored')
    const rescored = runSync(['--rescore', dir, '--out', again], { AGH_HOME: join(out, 'window', 'no-home') })
    expect(rescored.status, why(rescored)).toBe(0)
    const live = readJson(join(dir, 'report.json'))
    const redo = readJson(join(again, 'report.json'))
    expect(redo.rescoredFrom).toBe(dir)
    expect(redo.totals).toEqual(live.totals)
    expect(redo.sessionChecks).toEqual(live.sessionChecks)
    expect(redo.verdict).toEqual(live.verdict)
    type Rec = ReturnType<typeof readRecords>[number]
    const pick = (x: Rec) => ({
      key: `${x.lane}.${x.turn}`,
      inference: x.metrics.inference,
      sideCall: x.metrics.sideCall,
      usdMicros: x.metrics.usdMicros,
      reconciled: x.metrics.reconciled,
      wallMs: x.wallMs,
      steps: x.steps,
      endReason: x.endReason,
      score: x.score,
    })
    const sorted = (rows: Rec[]) => rows.map(pick).sort((a, b) => a.key.localeCompare(b.key))
    expect(sorted(readRecords(again))).toEqual(sorted(records))
    const pilotAgain = join(out, 'window', 'pilot-rescored')
    expect(runSync(['--rescore', pilotDir, '--out', pilotAgain]).status).toBe(0)
    expect(readJson(join(pilotAgain, 'report.json')).pilot).toEqual(
      readJson(join(pilotDir, 'report.json')).pilot,
    )
    // The original is never overwritten.
    const same = runSync(['--rescore', dir, '--out', dir])
    expect(same.status).toBe(2)
    expect(same.stderr).toContain('must be a new directory')
    expect(runSync(['--rescore', dir, '--out', again]).stderr).toContain('already holds a report')
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
    expect(chosen.status, why(chosen)).toBe(0)
    expect(chosen.stdout).toContain('jev route account-jev-b')
    const wrong = plan(twoJev, '--jev-route', 'account-jev-b', '--chat-route', 'account-jev-a')
    expect(wrong.status).toBe(2)
    expect(wrong.stderr).toContain('account-jev-a is not a chat model route')
  }, 120_000)

  it('runs the baseline pilot on a home with only a chat account and reports k', async (ctx) => {
    const home = await settingsHome({
      name: 'pilot',
      chat: [{ baseUrl: (await startChat('deepseek-flash')).baseUrl }],
    })
    const dir = join(out, 'pilot', 'run')
    const r = await runAsync(['--suite', suite, '--out', dir, '--home', home, '--pilot'])
    if (lacksSandbox(r)) ctx.skip(NO_SANDBOX)
    expect(r.status, why(r)).toBe(0)
    const report = readJson(join(dir, 'report.json'))
    expect(report.lanes).toEqual(['default'])
    expect(report.routes.jev).toBeNull()
    expect(report.pilot).toMatchObject({ k: 1, mutableCalls: 0, toolInferences: 0 })
    expect(report.verdict).toBeUndefined()
    expect(readRecords(dir).map((x) => x.lane)).toEqual(['default'])
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('## Pilot')
  }, 300_000)

  it('cancels a turn that outlives its watchdog, keeps it as a failure and exits 1', async (ctx) => {
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
    if (lacksSandbox(r)) ctx.skip(NO_SANDBOX)
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

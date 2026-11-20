import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSea } from 'node:sea'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync } from 'node:zlib'
import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import { createSqliteStorage } from '@agnes/host'
import type { ConfigAccount, EventEnvelope } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { adaptHostTables } from '../src/supervisor/storage-adapters.js'
import { openTelemetry } from '../src/supervisor/telemetry/service.js'
import { telemetryEnvironment, telemetryInstallId } from '../src/supervisor/telemetry/settings.js'
import { telemetryRuntime } from '../src/supervisor/telemetry/wire.js'

vi.mock('node:sea', { spy: true })

it.each([
  [undefined, { version: '0.1.0', distribution: 'dev' }, '0.1.0', 'dev'],
  [undefined, { version: '0.1.0', distribution: 'npm' }, '0.1.0', 'npm'],
  [undefined, { version: '0.1.0', distribution: 'sea' }, '0.1.0', 'sea'],
  ['desktop', { version: '0.1.0', distribution: 'dev' }, '0.1.0', 'desktop'],
  ['npm', { version: '0.1.0', distribution: 'dev' }, '0.1.0', 'npm'],
  ['unknown', { version: '0.1.0', distribution: 'dev' }, '0.1.0', 'dev'],
  [undefined, { version: '0.1.0', distribution: 'unknown' }, '0.1.0', 'npm'],
  [undefined, { version: '0.1.0' }, '0.1.0', 'npm'],
  [undefined, { version: '0.0.0' }, '0.0.0', 'dev'],
  [undefined, {}, 'dev', 'dev'],
] as const)('resolves override %s and build %j to %s/%s', (override, compiled, version, distribution) => {
  expect(telemetryRuntime(override, compiled)).toMatchObject({ app_version: version, distribution })
})

it('identifies a running SEA executable even with a runtime override', () => {
  vi.mocked(isSea).mockReturnValueOnce(true)
  expect(telemetryRuntime('desktop', { version: '0.1.0', distribution: 'npm' })).toMatchObject({
    app_version: '0.1.0',
    distribution: 'sea',
  })
})

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function homeDir() {
  const home = await mkdtemp(join(tmpdir(), 'agh-telemetry-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return home
}

type Trace = {
  install_id: string
  session: { session_id: string; parent_session_id: string | null }
  watermark: { from_seq: number; to_seq: number; session_head_seq: number }
  route_providers: Record<string, { provider_id: string; auth_type: string }>
  events: { seq: number; type: string; data: unknown }[]
}
type Capture = {
  at: number
  body: unknown
  decodedBytes: number
  wireBytes: number
  contentType?: string
  encoding?: string
  idempotency?: string
  schema?: string
}
function traceAt(captures: Capture[], index: number): Trace {
  const capture = captures[index]
  if (!capture) throw new Error('Missing trace batch')
  return capture.body as Trace
}
async function receiver() {
  const received = {
    '/v1/telemetry/report': [] as Capture[],
    '/v1/traces/batches': [] as Capture[],
  }
  let ack = true
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const path = req.url === '/v1/traces/batches' ? req.url : '/v1/telemetry/report'
    const encoding = req.headers['content-encoding']
    const decoded = encoding === 'gzip' ? gunzipSync(raw) : raw
    const body: unknown = JSON.parse(decoded.toString())
    const contentType = req.headers['content-type']
    const schema = req.headers['x-agh-schema-version']
    const idempotency = req.headers['x-idempotency-key']
    received[path].push({
      at: Date.now(),
      body,
      decodedBytes: decoded.byteLength,
      wireBytes: raw.byteLength,
      ...(contentType ? { contentType } : {}),
      ...(encoding ? { encoding } : {}),
      ...(typeof schema === 'string' ? { schema } : {}),
      ...(typeof idempotency === 'string' ? { idempotency } : {}),
    })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: path === '/v1/telemetry/report' || ack }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address() as { port: number }
  return {
    reports: received['/v1/telemetry/report'],
    traces: received['/v1/traces/batches'],
    endpoint: `http://127.0.0.1:${address.port}`,
    acknowledge(next: boolean) {
      ack = next
    },
  }
}

const actor = { id: 'fixture-owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const clock = () => Date.now()
const ACCOUNT_ID = '1aafc42c-75cf-4a10-9da4-1c77c2b43340'
const ROUTE = `account-${ACCOUNT_ID}`
const BASE_URL = 'https://private-model-fixture.invalid:8181/v2'
const LABEL = 'private fixture account label'
const CREDENTIAL = 'custom-short-fixture-key'
const KEY = 'synthetic-private-session'
const accounts = [
  {
    accountId: ACCOUNT_ID,
    label: LABEL,
    route: ROUTE,
    providerId: 'deepseek',
    authType: 'api-key',
    baseUrl: BASE_URL,
    model: 'deepseek-chat',
    models: [],
    enabled: true,
    credentialConfigured: true,
  },
  {
    accountId: 'secondary-private-id',
    label: 'secondary private route',
    route: 'account-secondary-private-id',
    providerId: 'openai-compatible',
    authType: 'api-key',
    baseUrl: 'http://private-second.invalid',
    model: 'custom-company-identifier',
    models: [],
    enabled: true,
    credentialConfigured: true,
  },
] as const satisfies readonly ConfigAccount[]

async function fixture(
  env: NodeJS.ProcessEnv = { VITEST: 'true' },
  allowInTest = true,
  configuredAccounts: readonly ConfigAccount[] = accounts,
) {
  const home = await homeDir()
  const sessionCwd = await mkdtemp(join(tmpdir(), 'agh-telemetry-workspace-'))
  cleanups.push(() => rm(sessionCwd, { recursive: true, force: true }))
  const server = await receiver()
  await mkdir(join(home, 'tables'))
  const storage = createSqliteStorage({ file: join(home, 'sessions.db'), tablesDir: join(home, 'tables') })
  cleanups.push(() => storage.close())
  const table = () => adaptHostTables(storage.tables('@agnes/telemetry')).table('trace_upload_watermarks')
  const ledger = new Map<string, EventEnvelope[]>()
  const scan = vi.fn(
    (key: string) =>
      async (query: {
        fromSeq?: number
        toSeq?: number
        type?: string | string[]
        limit?: number
        order?: 'asc' | 'desc'
      }) => {
        const types = query.type === undefined ? undefined : [query.type].flat()
        const rows =
          ledger
            .get(key)
            ?.filter(
              (row) =>
                row.seq >= (query.fromSeq ?? 1) &&
                row.seq <= (query.toSeq ?? Infinity) &&
                (!types || types.includes(row.type)),
            ) ?? []
        return (query.order === 'desc' ? rows.reverse() : rows).slice(0, query.limit)
      },
  )
  const options: Parameters<typeof openTelemetry>[0] = {
    home,
    allowInTest,
    env: {
      AGH_TELEMETRY_ENDPOINT: server.endpoint,
      AGH_TELEMETRY_FLUSH_MS: '60000',
      AGH_TELEMETRY_TRACE_DEBOUNCE_MS: '5',
      AGH_TELEMETRY_RETRY_MS: '20',
      ...env,
    },
    scan,
    table,
    configuration: {
      get: async () => ({
        accounts: [...configuredAccounts],
        provider: null,
        profile: 'test',
        configured: true,
        revision: 0,
        effect: 'new-sessions',
      }),
    },
    credentials: () => [CREDENTIAL],
    paths: () => ({ privatePaths: ['/private/var/synthetic-agh-state'], workspacePaths: [] }),
  }
  let telemetry = await openTelemetry(options)
  cleanups.push(() => telemetry.dispose())
  function append(type: string, data: EventEnvelope['data'], key: string, at: number, lane = 'main') {
    let rows = ledger.get(key)
    if (!rows) {
      rows = []
      ledger.set(key, rows)
    }
    const seq = rows.length + 1
    const entry = {
      type,
      seq,
      data,
      ts: new Date(at).toISOString(),
      id: String(seq).padStart(26, '0'),
      origin: 'system',
      trust: 'trusted',
      actor,
      lane,
    } as EventEnvelope
    rows.push(entry)
    return entry
  }
  function row(type: string, data: EventEnvelope['data'] = {}, key = KEY, lane = 'main') {
    const entry = append(type, data, key, clock(), lane)
    telemetry.observe(key, entry, () => ({ cwd: sessionCwd }))
    return entry.seq
  }
  /** A row committed an hour ago that no running uploader observed. */
  function history(type: string, data: EventEnvelope['data'] = {}, key = KEY) {
    return append(type, data, key, clock() - 3_600_000).seq
  }
  /** A row a daemon committed while it was not observing for upload, such as one with telemetry off by env. */
  function unobserved(type: string, data: EventEnvelope['data'] = {}, key = KEY) {
    return append(type, data, key, clock()).seq
  }
  /** Close this daemon's telemetry and open the same home again, as a daemon restart does. */
  async function restart(env: NodeJS.ProcessEnv = {}) {
    await telemetry.dispose()
    telemetry = await openTelemetry({ ...options, env: { ...options.env, ...env } })
    cleanups.push(() => telemetry.dispose())
    return telemetry
  }
  return {
    home,
    sessionCwd,
    server,
    table,
    get telemetry() {
      return telemetry
    },
    options,
    row,
    history,
    unobserved,
    restart,
    scan,
  }
}

const acked = (table: TableHandle, key = KEY) =>
  table.get<{ last_acked_seq: number }>(
    'SELECT last_acked_seq FROM trace_upload_watermarks WHERE session_key = ?',
    [key],
  )?.last_acked_seq
const seqs = (trace: Trace) => trace.events.map((event) => event.seq)

/** Letters and spaces drawn at random: no secret shape, and close to incompressible for gzip. */
function randomWords(bytes: number): string {
  return Buffer.from(
    randomBytes(bytes).map((byte, index) => (index % 8 === 7 ? 32 : 97 + (byte % 26))),
  ).toString('latin1')
}

it('uploads complete gzip ranges, scrubs the trace copy, and hot-disables trace scanning independently of activity', async () => {
  const { home, sessionCwd, server, table, telemetry, options, row, scan } = await fixture()
  const binary = Buffer.from('binary attachment fixture').toString('base64')
  const privateText = `${LABEL} ${ACCOUNT_ID} ${BASE_URL} ${CREDENTIAL} ${home}/state ${sessionCwd}/source.txt /var/synthetic-agh-state/cache sk-fixture-123456789abcdef`
  const long = `head ${'body '.repeat(55_000)} tail`
  const effect = `e-${'1234abcd'.repeat(4)}`
  expect(await telemetry.admin({})).toEqual({
    settings: { analyticsEnabled: true, traceUploadEnabled: true },
    status: { disabledByEnv: false, endpointConfigured: true },
  })
  telemetry.sessionCreated(KEY, 'web')
  row('session/start', { key: KEY, preset: 'base' })
  row('turn/start', { turn: 1, trigger: 'prompt' })
  row('effect/intent', { id: effect, kind: 'inference' })
  row('request/sent', { effectId: effect, model: { route: ROUTE, id: 'deepseek-chat' }, baseUrl: BASE_URL })
  row('user/message', {
    content: [
      { type: 'text', text: privateText },
      { type: 'image', data: binary, mimeType: 'image/png' },
    ],
  })
  row('cost/ledger', {
    route: ROUTE,
    effectId: effect,
    purpose: 'inference',
    model: 'deepseek-chat',
    tokens: { input: 40, output: 10, cacheRead: 15, cacheWrite: 2, reasoning: 3 },
  })
  row('assistant/message', { content: [{ type: 'text', text: long }] })
  await delay(25)
  expect(server.traces).toHaveLength(0)
  const first = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(server.traces).toHaveLength(1))
  await vi.waitFor(() => expect(acked(table())).toBe(first))
  const install = (await readFile(join(home, 'telemetry-id'), 'utf8')).trim()
  const hash = (value: string) => createHash('sha256').update(`${install}:${value}`).digest('hex')
  const trace1 = traceAt(server.traces, 0)
  expect(trace1.watermark).toEqual({ from_seq: 1, to_seq: first, session_head_seq: first })
  expect(trace1.session.session_id).toBe(`agn_${hash(KEY).slice(0, 24)}`)
  expect(server.traces[0]).toMatchObject({
    encoding: 'gzip',
    schema: '1',
    contentType: 'application/json',
    idempotency: `${install}:${trace1.session.session_id}:1-${first}`,
  })
  const safeRoute = `account-${hash(ROUTE).slice(0, 8)}`
  expect(trace1.route_providers).toEqual({ [safeRoute]: { provider_id: 'deepseek', auth_type: 'api_key' } })
  expect(trace1.events.find((event) => event.type === 'request/sent')?.data).toMatchObject({
    model: { route: safeRoute, id: 'deepseek-chat' },
    baseUrl: '<redacted>',
    effectId: `id_${hash(effect).slice(0, 24)}`,
  })
  expect(trace1.events.find((event) => event.type === 'effect/intent')?.data).toMatchObject({
    id: `id_${hash(effect).slice(0, 24)}`,
  })
  expect(trace1.events.find((event) => event.type === 'cost/ledger')?.data).toMatchObject({
    effectId: `id_${hash(effect).slice(0, 24)}`,
  })
  const serialized = JSON.stringify(trace1)
  for (const value of [
    LABEL,
    ACCOUNT_ID,
    BASE_URL,
    CREDENTIAL,
    home,
    sessionCwd,
    binary,
    KEY,
    'sk-fixture',
    effect,
  ])
    expect(serialized).not.toContain(value)
  expect(serialized).toContain('[omitted-binary mime=image/png bytes=25]')
  expect(serialized).toContain('<workspace>/source.txt')
  expect(serialized).toContain('<agh_home>/state')
  expect(serialized).toContain('<agh_home>/cache')
  expect(serialized).not.toContain('/var/synthetic-agh-state')
  expect(serialized).toMatch(/head body .*truncated \d+ bytes.* tail/)
  expect(JSON.stringify(await scan(KEY)({ type: 'user/message' }))).toContain(binary)

  row('turn/start', { turn: 2, trigger: 'prompt' })
  row('request/sent', { model: { route: accounts[1].route, id: accounts[1].model } })
  row('x/feedback/item', { sessionId: KEY, target: { turn: 1, messageSeq: first - 1 }, rating: 'up' })
  await delay(25)
  expect(server.traces).toHaveLength(1)
  const second = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(acked(table())).toBe(second))
  const trace2 = traceAt(server.traces, 1)
  expect(trace2.watermark).toEqual({ from_seq: first + 1, to_seq: second, session_head_seq: second })
  expect(trace2.session.session_id).toBe(trace1.session.session_id)
  expect(trace2.events.find((event) => event.type === 'request/sent')?.data).toMatchObject({
    model: { id: 'custom' },
  })

  row('x/feedback/growth', { draft: 'should never enter the upload' })
  const feedback = row('x/feedback/item', {
    sessionId: KEY,
    target: { turn: 2, messageSeq: second - 1 },
    rating: 'down',
    note: privateText,
  })
  await vi.waitFor(() => expect(acked(table())).toBe(feedback))
  const trace3 = traceAt(server.traces, 2)
  expect(trace3.watermark).toEqual({ from_seq: second + 1, to_seq: feedback, session_head_seq: feedback })
  expect(trace3.events.map((event) => event.type)).toEqual(['x/feedback/item'])
  expect(trace3.events[0]?.data).toMatchObject({ sessionId: trace1.session.session_id, rating: 'down' })
  expect(JSON.stringify(trace3)).not.toContain(CREDENTIAL)

  await telemetry.admin({ settings: { traceUploadEnabled: false } })
  const count = scan.mock.calls.length
  row('turn/start', { turn: 3, trigger: 'prompt' })
  row('user/message', { content: [{ type: 'text', text: 'Conversation still accepts input' }] })
  row('turn/end', { reason: 'completed' })
  await telemetry.dispose()
  expect(scan).toHaveBeenCalledTimes(count)
  expect(server.traces).toHaveLength(3)
  expect(server.reports).toHaveLength(1)
  const [report] = server.reports
  if (!report) throw new Error('Missing analytics report')
  expect(report.schema).toBe('1')
  expect(report.body).toEqual({
    schema_version: 1,
    report_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    window_start: expect.any(String),
    window_end: expect.any(String),
    context: {
      install_id: install,
      trace_upload_enabled: false,
      app_version: expect.any(String),
      os: expect.any(String),
      os_release: expect.any(String),
      arch: expect.any(String),
      node_version: expect.any(String),
      distribution: expect.any(String),
    },
    activity: {
      surfaces: ['web'],
      daemon_starts: 1,
      sessions_created: 1,
      turns_submitted: 3,
      compactions: 0,
    },
    models: [
      {
        provider_id: 'deepseek',
        model_id: 'deepseek-chat',
        auth_type: 'api_key',
        surface: 'web',
        turns: 1,
        errors: 0,
        input_tokens: 40,
        output_tokens: 10,
        cache_read_tokens: 15,
        cache_write_tokens: 2,
        reasoning_tokens: 3,
      },
      {
        provider_id: 'openai-compatible',
        model_id: 'custom',
        auth_type: 'api_key',
        surface: 'web',
        turns: 1,
        errors: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      },
    ],
  })
  const reopened = await openTelemetry(options)
  expect((await reopened.admin({})).settings).toEqual({ analyticsEnabled: true, traceUploadEnabled: false })
  await reopened.dispose()
  if (process.platform !== 'win32')
    expect((await stat(join(home, 'telemetry.json'))).mode & 0o777).toBe(0o600)
})

const relayAccountId = 'fixture-relay-id'
const relayLabel = 'fixture-relay-label'
const relayRoute = `account-${relayAccountId}`
const apiUrl = 'https://api.llm.sg/v1'
const vendorModel = 'anthropic/claude-sonnet-4-6'
const minimaxModel = 'minimax/minimax-m2.5'

it.each([
  [apiUrl, relayRoute, undefined, vendorModel, 'llm-sg', vendorModel, 'api_key'],
  [apiUrl, `${relayRoute}-a1b2c3`, 'api-key', minimaxModel, 'llm-sg', minimaxModel, 'api_key'],
  ['https://llm.sg/v1', relayRoute, 'api-key', 'openai/gpt-5.4', 'llm-sg', 'openai/gpt-5.4', 'api_key'],
  ['https://API.LLM.SG/v1', relayRoute, 'oauth', vendorModel, 'llm-sg', vendorModel, 'oauth'],
  ['https://notllm.sg/v1', relayRoute, 'api-key', vendorModel, 'openai-compatible', 'custom', 'api_key'],
  [
    'http://private-second.invalid',
    relayRoute,
    'api-key',
    minimaxModel,
    'openai-compatible',
    'custom',
    'api_key',
  ],
  ['invalid-url', relayRoute, 'api-key', vendorModel, 'openai-compatible', 'custom', 'api_key'],
  [apiUrl, relayRoute, 'api-key', 'sk-fixture-123456789abcdef', 'llm-sg', 'custom', 'api_key'],
  [apiUrl, relayRoute, 'api-key', relayLabel, 'llm-sg', 'custom', 'api_key'],
  [apiUrl, relayRoute, 'api-key', relayAccountId, 'llm-sg', 'custom', 'api_key'],
  [apiUrl, relayRoute, 'api-key', 'C:/fixture/model', 'llm-sg', 'custom', 'api_key'],
] as const)(
  'reports relay %s via %s (%s) with model %s as %s/%s (%s)',
  async (baseUrl, route, authType, model, provider_id, model_id, auth_type) => {
    const account = {
      accountId: relayAccountId,
      label: relayLabel,
      route: relayRoute,
      providerId: 'openai-compatible',
      ...(authType ? { authType } : {}),
      baseUrl,
      model,
      models: [],
      enabled: true,
      credentialConfigured: true,
    } satisfies ConfigAccount
    const { home, server, table, telemetry, row } = await fixture(undefined, undefined, [account])
    telemetry.sessionCreated(KEY, 'web')
    row('session/start', { key: KEY })
    row('turn/start', { trigger: 'prompt' })
    const request = row('request/sent', { baseUrl, model: { route, id: model } })
    const cost = row('cost/ledger', { route, model, purpose: 'inference', tokens: { input: 1 } })
    const end = row('turn/end', { reason: 'completed' })
    await vi.waitFor(() => expect(acked(table())).toBe(end))
    await telemetry.dispose()

    const install = (await readFile(join(home, 'telemetry-id'), 'utf8')).trim()
    const safeRoute = `account-${createHash('sha256').update(`${install}:${route}`).digest('hex').slice(0, 8)}`
    const trace = traceAt(server.traces, 0)
    const provider = { provider_id, auth_type }
    expect(trace.route_providers).toEqual({ [safeRoute]: provider })
    expect(trace.events.find((event) => event.seq === request)?.data).toMatchObject({
      baseUrl: '<redacted>',
      model: { route: safeRoute, id: model_id },
    })
    expect(trace.events.find((event) => event.seq === cost)?.data).toMatchObject({
      route: safeRoute,
      model: model_id,
    })
    expect(server.reports[0]?.body).toMatchObject({
      models: [{ ...provider, model_id, turns: 1, input_tokens: 1 }],
    })
  },
)

it('attributes dedicated task experience costs to llm.sg without an account or request receipt', async () => {
  const { server, table, telemetry, row } = await fixture()
  const route = 'task-experience'
  row('session/start', { key: KEY })
  row('turn/start', { trigger: 'prompt' })
  row(
    'cost/ledger',
    { route, model: minimaxModel, purpose: 'side-call', tokens: { input: 12, output: 3 } },
    KEY,
    'refinement',
  )
  const end = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(acked(table())).toBe(end))
  await telemetry.dispose()

  const trace = traceAt(server.traces, 0)
  const provider = { provider_id: 'llm-sg', auth_type: 'api_key' }
  expect(trace.route_providers).toEqual({ [route]: provider })
  expect(trace.events.find((event) => event.type === 'cost/ledger')?.data).toMatchObject({
    route,
    model: minimaxModel,
    purpose: 'side-call',
  })
  expect(server.reports[0]?.body).toMatchObject({
    models: [{ ...provider, model_id: minimaxModel, turns: 1, input_tokens: 12, output_tokens: 3 }],
  })
})

it('splits an oversized backlog at complete turn boundaries and acknowledges each batch', async () => {
  const { server, row, table, telemetry } = await fixture()
  await telemetry.admin({ settings: { analyticsEnabled: false } })
  row('session/start', { key: KEY, preset: 'base' })
  const boundaries = new Set<number>()
  const text = 'large fixture chunk '.repeat(12_000)
  for (let turn = 1; turn <= 3; turn++) {
    row('turn/start', { turn, trigger: 'prompt' })
    for (let part = 0; part < 16; part++) row('assistant/message', { content: [{ type: 'text', text }] })
    boundaries.add(row('turn/end', { reason: 'completed' }))
  }
  const head = Math.max(...boundaries)
  await vi.waitFor(() => expect(acked(table())).toBe(head), { timeout: 6000 })
  expect(server.traces.length).toBeGreaterThan(1)
  let from = 1
  for (const capture of server.traces) {
    expect(capture.decodedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(capture.wireBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    const batch = capture.body as Trace
    expect(batch.watermark.from_seq).toBe(from)
    expect(boundaries.has(batch.watermark.to_seq)).toBe(true)
    expect(batch.events.at(-1)?.type).toBe('turn/end')
    from = batch.watermark.to_seq + 1
  }
  expect(from).toBe(head + 1)
})

it('requires an affirmative ACK and retries the complete range, extended by a later boundary', async () => {
  const { server, row, table } = await fixture()
  server.acknowledge(false)
  row('session/start', { key: KEY, preset: 'base' })
  row('turn/start', { turn: 1, trigger: 'prompt' })
  const end = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(server.traces.length).toBeGreaterThanOrEqual(2))
  expect(acked(table())).toBeUndefined()
  const feedback = row('x/feedback/item', { target: { turn: 1 }, rating: 'up' })
  server.acknowledge(true)
  await vi.waitFor(() => expect(acked(table())).toBe(feedback))
  const ranges = server.traces.map((capture) => (capture.body as Trace).watermark)
  expect(ranges.at(-1)).toEqual({ from_seq: 1, to_seq: feedback, session_head_seq: feedback })
  for (const range of ranges) {
    expect(range.from_seq).toBe(1)
    expect([end, feedback]).toContain(range.to_seq)
  }
})

it('never uploads rows committed while Session Log upload was not enabled for this home', async () => {
  const { server, row, history, restart, table, telemetry } = await fixture()
  await telemetry.admin({ settings: { analyticsEnabled: false } })
  // This session already had history when the daemon that uploads Session Logs first started.
  history('session/start', { key: KEY, preset: 'base' })
  history('turn/start', { turn: 1, trigger: 'prompt' })
  history('user/message', { content: [{ type: 'text', text: 'written before the upgrade' }] })
  history('turn/end', { reason: 'completed' })
  const resumed = row('turn/start', { turn: 2, trigger: 'prompt' })
  row('user/message', { content: [{ type: 'text', text: 'first turn after the upgrade' }] })
  const first = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(acked(table())).toBe(first))
  expect(seqs(traceAt(server.traces, 0))).toEqual([resumed, resumed + 1, first])

  await telemetry.admin({ settings: { traceUploadEnabled: false } })
  row('turn/start', { turn: 3, trigger: 'prompt' })
  row('user/message', { content: [{ type: 'text', text: 'written while upload was off' }] })
  row('turn/end', { reason: 'completed' })
  await delay(5)
  await telemetry.admin({ settings: { traceUploadEnabled: true } })
  const back = row('turn/start', { turn: 4, trigger: 'prompt' })
  row('user/message', { content: [{ type: 'text', text: 'written after upload was on again' }] })
  const second = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(acked(table())).toBe(second))
  expect(seqs(traceAt(server.traces, 1))).toEqual([back, back + 1, second])

  // A daemon run with telemetry disabled by environment observes nothing; its rows stay local.
  await restart({ AGH_TELEMETRY_DISABLED: '1' })
  row('turn/start', { turn: 5, trigger: 'prompt' })
  row('user/message', { content: [{ type: 'text', text: 'written while disabled by env' }] })
  row('turn/end', { reason: 'completed' })
  await delay(5)
  const reopened = await restart({ AGH_TELEMETRY_DISABLED: undefined })
  await reopened.admin({ settings: { analyticsEnabled: false } })
  const later = row('turn/start', { turn: 6, trigger: 'prompt' })
  const third = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(acked(table())).toBe(third))
  expect(seqs(traceAt(server.traces, 2))).toEqual([later, third])

  // A session created after enablement uploads from its first row.
  const fresh = `${KEY}-fresh`
  row('session/start', { key: fresh, preset: 'base' }, fresh)
  row('turn/start', { turn: 1, trigger: 'prompt' }, fresh)
  const freshEnd = row('turn/end', { reason: 'completed' }, fresh)
  await vi.waitFor(() => expect(acked(table(), fresh)).toBe(freshEnd))
  expect(seqs(traceAt(server.traces, 3))).toEqual([1, 2, 3])
  expect(server.traces).toHaveLength(4)
  const uploaded = JSON.stringify(server.traces.map((capture) => capture.body))
  for (const text of [
    'written before the upgrade',
    'written while upload was off',
    'written while disabled by env',
  ])
    expect(uploaded).not.toContain(text)
})

it.each([
  ['the raw batch limit', () => Array.from({ length: 40 }, () => 'oversized fixture chunk '.repeat(10_000))],
  ['the compressed batch limit', () => Array.from({ length: 31 }, () => randomWords(240_000))],
])(
  'uploads a single turn over %s in reduced form and keeps the session moving',
  async (_limit, parts) => {
    const { server, row, table, telemetry } = await fixture()
    await telemetry.admin({ settings: { analyticsEnabled: false } })
    row('session/start', { key: KEY, preset: 'base' })
    row('turn/start', { turn: 1, trigger: 'prompt' })
    for (const text of parts()) row('assistant/message', { content: [{ type: 'text', text }] })
    const big = row('turn/end', { reason: 'completed' })
    await vi.waitFor(() => expect(acked(table())).toBe(big), { timeout: 10_000 })
    const reduced = traceAt(server.traces, 0)
    expect(reduced.watermark).toMatchObject({ from_seq: 1, to_seq: big })
    expect(reduced.events.at(-1)).toMatchObject({ seq: big, type: 'turn/end' })
    expect(JSON.stringify(reduced.events)).toMatch(/\[omitted-oversized bytes=\d+\]/)
    expect(server.traces[0]?.decodedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(server.traces[0]?.wireBytes).toBeLessThanOrEqual(4 * 1024 * 1024)

    const next = row('turn/start', { turn: 2, trigger: 'prompt' })
    row('user/message', { content: [{ type: 'text', text: 'a small turn after the oversized one' }] })
    const end = row('turn/end', { reason: 'completed' })
    await vi.waitFor(() => expect(acked(table())).toBe(end))
    expect(server.traces).toHaveLength(2)
    const after = traceAt(server.traces, 1)
    expect(after.watermark).toMatchObject({ from_seq: big + 1, to_seq: end })
    expect(seqs(after)).toEqual([next, next + 1, end])
    expect(JSON.stringify(after)).toContain('a small turn after the oversized one')
  },
  30_000,
)

it('replaces a turn that stays over the limit even in reduced form with an omitted-for-size record', async () => {
  const { server, row, table, telemetry } = await fixture()
  await telemetry.admin({ settings: { analyticsEnabled: false } })
  row('session/start', { key: KEY, preset: 'base' })
  row('turn/start', { turn: 1, trigger: 'prompt' })
  // Each body stays under the reduced form's per-event marker size, so only the count overflows.
  const text = 'fixture text '.repeat(1150)
  for (let part = 0; part < 600; part++) row('tool/result', { content: [{ type: 'text', text }] })
  const big = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(acked(table())).toBe(big), { timeout: 10_000 })
  const omitted = traceAt(server.traces, 0)
  expect(omitted.watermark).toMatchObject({ from_seq: 1, to_seq: big })
  expect(omitted.events).toEqual([
    expect.objectContaining({
      seq: big,
      type: 'x/telemetry/omitted',
      data: { reason: 'size', from_seq: 1, to_seq: big, events: big, bytes: expect.any(Number) },
    }),
  ])
  expect(omitted.events[0]?.data).toMatchObject({
    bytes: expect.toSatisfy((bytes: number) => bytes > 8 * 1024 * 1024),
  })
  row('turn/start', { turn: 2, trigger: 'prompt' })
  const end = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(acked(table())).toBe(end))
  expect(traceAt(server.traces, 1).watermark).toMatchObject({ from_seq: big + 1, to_seq: end })
}, 30_000)

it('retries a failed upload with growing delays until it is acknowledged, then stays quiet', async () => {
  const { server, row, table, telemetry } = await fixture()
  await telemetry.admin({ settings: { analyticsEnabled: false } })
  server.acknowledge(false)
  row('session/start', { key: KEY, preset: 'base' })
  row('turn/start', { turn: 1, trigger: 'prompt' })
  const end = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(server.traces.length).toBeGreaterThanOrEqual(3))
  expect(acked(table())).toBeUndefined()
  server.acknowledge(true)
  await vi.waitFor(() => expect(acked(table())).toBe(end))
  const attempts = server.traces.map((capture) => capture.at)
  attempts.slice(1).forEach((at, index) => {
    expect(at - (attempts[index] as number)).toBeGreaterThanOrEqual(20 * 2 ** index - 2)
  })
  for (const capture of server.traces)
    expect((capture.body as Trace).watermark).toMatchObject({ from_seq: 1, to_seq: end })
  const settled = server.traces.length
  await delay(150)
  expect(server.traces).toHaveLength(settled)
})

it('stops retrying an upload that keeps failing after a bounded number of attempts', async () => {
  const { server, row, telemetry } = await fixture({ AGH_TELEMETRY_RETRY_MS: '1' })
  await telemetry.admin({ settings: { analyticsEnabled: false } })
  server.acknowledge(false)
  row('session/start', { key: KEY, preset: 'base' })
  row('turn/start', { turn: 1, trigger: 'prompt' })
  row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(server.traces).toHaveLength(8))
  await delay(300)
  expect(server.traces).toHaveLength(8)
})

it('cancels pending retries, including across a restart, when Session Log upload is switched off', async () => {
  const { server, row, telemetry, restart } = await fixture()
  await telemetry.admin({ settings: { analyticsEnabled: false } })
  server.acknowledge(false)
  row('session/start', { key: KEY, preset: 'base' })
  row('turn/start', { turn: 1, trigger: 'prompt' })
  row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(server.traces.length).toBeGreaterThanOrEqual(2))
  await telemetry.admin({ settings: { traceUploadEnabled: false } })
  const attempts = server.traces.length
  await delay(200)
  expect(server.traces).toHaveLength(attempts)
  await telemetry.admin({ settings: { traceUploadEnabled: true } })
  server.acknowledge(true)
  await restart()
  await delay(200)
  expect(server.traces).toHaveLength(attempts)
})

it('re-queues unacknowledged sessions after a daemon restart, a bounded number per start', async () => {
  const { server, row, table, telemetry, restart, sessionCwd } = await fixture({
    AGH_TELEMETRY_RETRY_MS: '60000',
  })
  await telemetry.admin({ settings: { analyticsEnabled: false } })
  server.acknowledge(false)
  const keys = Array.from({ length: 17 }, (_, index) => `${KEY}-${index}`)
  for (const key of keys) {
    telemetry.sessionCreated(key, 'web')
    row('session/start', { key, preset: 'base' }, key)
    row('turn/start', { turn: 1, trigger: 'prompt' }, key)
    row('user/message', { content: [{ type: 'text', text: `${sessionCwd}/notes.txt` }] }, key)
    row('turn/end', { reason: 'completed' }, key)
  }
  await vi.waitFor(() => expect(server.traces).toHaveLength(keys.length))
  expect(keys.filter((key) => acked(table(), key) !== undefined)).toEqual([])
  server.acknowledge(true)
  await restart()
  await vi.waitFor(() => expect(keys.filter((key) => acked(table(), key) === 4)).toHaveLength(16))
  await delay(100)
  expect(keys.filter((key) => acked(table(), key) === 4)).toHaveLength(16)
  await restart()
  await vi.waitFor(() => expect(keys.filter((key) => acked(table(), key) === 4)).toHaveLength(17))
  const recovered = server.traces
    .slice(keys.length)
    .map((capture) => capture.body as Trace & { surface: string })
  expect(recovered).toHaveLength(keys.length)
  for (const trace of recovered) {
    expect(trace.watermark).toMatchObject({ from_seq: 1, to_seq: 4 })
    expect(trace.surface).toBe('web')
    expect(JSON.stringify(trace)).toContain('<workspace>/notes.txt')
    expect(JSON.stringify(trace)).not.toContain(sessionCwd)
  }
})

it('configures the production collector when no endpoint is supplied', () => {
  const { endpoint, endpointConfigured, disabledByEnv } = telemetryEnvironment({}, false)
  expect(endpoint?.href).toBe('https://agh-telemetry.agnes-ai.cn/')
  expect(endpointConfigured).toBe(true)
  expect(disabledByEnv).toBe(false)
})

it.each([
  [{ AGH_TELEMETRY_DISABLED: '1' }, true],
  [{ AGH_TELEMETRY_DISABLED: 'true' }, true],
  [{ AGH_TELEMETRY_DISABLED: 'TrUe' }, true],
  [{ DO_NOT_TRACK: '1' }, true],
  [{ CI: 'true' }, true],
  [{ VITEST: 'true' }, true],
  [{ AGH_TELEMETRY_ENDPOINT: '' }, false],
  [{ AGH_TELEMETRY_ENDPOINT: '   ' }, false],
  [{ AGH_TELEMETRY_ENDPOINT: 'file:///invalid' }, false],
  [{ AGH_TELEMETRY_ENDPOINT: 'http:missing-slashes.invalid' }, false],
  [{ AGH_TELEMETRY_ENDPOINT: 'https://[' }, false],
  [{ AGH_TELEMETRY_ENDPOINT: 'https://u:p@agh-telemetry.agnes-ai.cn' }, false],
  [{ AGH_TELEMETRY_ENDPOINT: 'https://agh-telemetry.agnes-ai.cn?a=1' }, false],
  [{ AGH_TELEMETRY_ENDPOINT: 'https://agh-telemetry.agnes-ai.cn#x' }, false],
] as const)('stays silent with env override %j', async (env, disabledByEnv) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected telemetry request'))
  cleanups.push(() => fetch.mockRestore())
  const { home, telemetry, row, scan } = await fixture({ AGH_TELEMETRY_ENDPOINT: undefined, ...env }, false)
  telemetry.sessionCreated(KEY, 'web')
  row('session/start', { key: KEY })
  row('turn/start', { trigger: 'prompt' })
  row('turn/end', { reason: 'completed' })
  await telemetry.dispose()
  expect((await telemetry.admin({})).status).toEqual({
    disabledByEnv,
    endpointConfigured: disabledByEnv,
  })
  expect(fetch).not.toHaveBeenCalled()
  expect(scan).not.toHaveBeenCalled()
  await expect(stat(join(home, 'telemetry-id'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reuses a private UUID across daemon opens', async () => {
  const home = await homeDir()
  const id = await telemetryInstallId(home)
  expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  expect(await telemetryInstallId(home)).toBe(id)
  if (process.platform !== 'win32') expect((await stat(join(home, 'telemetry-id'))).mode & 0o777).toBe(0o600)
})

it('has no idle traffic and never uploads an internal memory session', async () => {
  const { telemetry, row, server } = await fixture({ AGH_TELEMETRY_FLUSH_MS: '100' })
  await delay(120)
  expect(server.reports).toHaveLength(0)
  row('session/start', { key: KEY, memory: true })
  row('turn/start', { trigger: 'prompt' })
  row('turn/end', { reason: 'completed' })
  await telemetry.dispose()
  expect(server.traces).toHaveLength(0)
  expect(server.reports).toHaveLength(0)
})

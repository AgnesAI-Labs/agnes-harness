import { createHash } from 'node:crypto'
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
  const telemetry = await openTelemetry(options)
  cleanups.push(() => telemetry.dispose())
  function row(type: string, data: EventEnvelope['data'] = {}, key = KEY, lane = 'main') {
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
      ts: new Date(clock()).toISOString(),
      id: String(seq).padStart(26, '0'),
      origin: 'system',
      trust: 'trusted',
      actor,
      lane,
    } as EventEnvelope
    rows.push(entry)
    telemetry.observe(key, entry, () => ({ cwd: sessionCwd }))
    return seq
  }
  return { home, sessionCwd, server, table, telemetry, options, row, scan }
}

const acked = (table: TableHandle) =>
  table.get<{ last_acked_seq: number }>(
    'SELECT last_acked_seq FROM trace_upload_watermarks WHERE session_key = ?',
    [KEY],
  )?.last_acked_seq

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

it('requires an affirmative ACK and retries the complete range on a later boundary', async () => {
  const { server, row, table } = await fixture()
  server.acknowledge(false)
  row('session/start', { key: KEY, preset: 'base' })
  row('turn/start', { turn: 1, trigger: 'prompt' })
  const end = row('turn/end', { reason: 'completed' })
  await vi.waitFor(() => expect(server.traces).toHaveLength(1))
  expect(acked(table())).toBeUndefined()
  server.acknowledge(true)
  const feedback = row('x/feedback/item', { target: { turn: 1 }, rating: 'up' })
  await vi.waitFor(() => expect(acked(table())).toBe(feedback))
  expect(traceAt(server.traces, 0).watermark.to_seq).toBe(end)
  expect(traceAt(server.traces, 1).watermark).toEqual({
    from_seq: 1,
    to_seq: feedback,
    session_head_seq: feedback,
  })
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

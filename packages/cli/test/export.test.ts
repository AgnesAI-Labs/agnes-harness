import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createTestHost } from '@agnes/host/testkit'
import { type EventEnvelope, type HarnessMeta, type UITimeline, validateEvent } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { describe, expect, it, vi } from 'vitest'
import { pendingDecision } from '../../core-ledger/testkit/decision.js'
import { parseArgs } from '../src/args.js'
import { exportSession, formatAgnes, readLedger, sanitizeExportValue } from '../src/commands/export.js'
import { importFile } from '../src/commands/import.js'
import { FakeEndpoint } from './fake-endpoint.js'
import { memoryAdmission, openAdmittedSession } from './import-admission.js'

const SESSION_ID = 'agnes:local:default:cli:dm:export'
const ACTOR = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const FIXTURE_USER = 'fixture-user'
const FIXTURE_HOME = ['', 'Users', FIXTURE_USER].join('/')
const FIXTURE_WORKSPACE = [FIXTURE_HOME, 'work'].join('/')
const FIXTURE_EMAIL = [FIXTURE_USER, 'example.test'].join('@')
const EVENTS: EventEnvelope[] = [
  {
    seq: 1,
    ts: new Date(0).toISOString(),
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'first' }] },
    actor: ACTOR,
    origin: 'principal',
    trust: 'trusted',
  },
  {
    seq: 2,
    ts: new Date(0).toISOString(),
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAC',
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: 'second' }], stopReason: 'end_turn' },
    actor: ACTOR,
    origin: 'model',
    trust: 'trusted',
  },
]
const TIMELINE: UITimeline = {
  sessionId: SESSION_ID,
  upto: 2,
  generation: 1,
  opState: null,
  turns: [],
  nodes: [{ id: 'u1', kind: 'user', seq: 1, content: [{ type: 'text', text: 'first' }] }],
}

// A real SHA-256 and a core-minted ID shape whose numeric runs match privacy patterns.
const REQUEST_HASH = createHash('sha256').update('legitimate-request-432').digest('hex')
const OPAQUE_EVENT_ID = '01J6Z14107653646ABCDEFGHJK'
const TOOL_ID = 't428-493aca471666765577088665b167cd4d'
function roundTripEvents(): EventEnvelope[] {
  const pii = `alice@example.com 13800138000 /workspace/private ${REQUEST_HASH} ${TOOL_ID}`
  const decision = pendingDecision(OPAQUE_EVENT_ID)
  const nested = { derived_hash: REQUEST_HASH, toolUseId: TOOL_ID, data: { content: pii } }
  const rows: Array<[string, unknown]> = [
    [
      'session/start',
      {
        key: SESSION_ID,
        resolvedProfileHash: `sha256-${REQUEST_HASH}`,
        resolvedPresetHash: `sha256-${REQUEST_HASH}`,
        preset: null,
        agnesVersion: '1',
      },
    ],
    ['turn/start', { turn: 1, trigger: 'prompt' }],
    [
      'user/message',
      {
        content: [
          {
            type: 'text',
            text: pii,
            reference: {
              source: 'test',
              id: '13800138000',
              label: pii,
              hash: REQUEST_HASH,
              truncated: false,
            },
          },
        ],
      },
    ],
    ['step/start', { turn: 1, step: 1 }],
    [
      'request/sent',
      {
        derived_hash: REQUEST_HASH,
        sent_hash: REQUEST_HASH,
        prompt_prefix_hash: REQUEST_HASH,
        tool_schema_hash: REQUEST_HASH,
        parser_version: '1',
        contract_id: null,
        model: { route: 'test', id: 'test' },
        transforms: [],
      },
    ],
    ['tool/call', { toolUseId: TOOL_ID, name: 'read', args: { nested }, ordinal: 428 }],
    [
      'tool/result',
      {
        toolUseId: TOOL_ID,
        content: [{ type: 'text', text: pii }],
        structured: { nested },
        isError: false,
        enforcement: { level: 'none', scope: [] },
        authz: { decisionId: 'alice@example.com' },
      },
    ],
    ['assistant/message', { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }],
    ['step/end', { turn: 1, step: 1 }],
    ['turn/end', { reason: 'completed', lastAssistantSeq: 8 }],
    [
      'request/header',
      {
        derived_hash: REQUEST_HASH,
        sent_hash: REQUEST_HASH,
        prompt_prefix_hash: REQUEST_HASH,
        tool_schema_hash: REQUEST_HASH,
        parser_version: '1',
        contract_id: null,
        model: 'test',
        envelopeNonce: '493aca471666765577088665b167cd4d',
      },
    ],
    ['format/deviation', { rule: 'test', model: 'test', parserVersion: '1', sampleHash: REQUEST_HASH }],
    [
      'decision/state',
      {
        ...decision,
        request: {
          ...decision.request,
          subjectDigest: REQUEST_HASH,
          spec: { ...decision.request.spec, subject: nested },
        },
      },
    ],
    ['effect/intent', { effectId: `e-${TOOL_ID.split('-')[1]}`, kind: 'inference', replay: 'never' }],
    [
      'cost/ledger',
      {
        effectId: `e-${TOOL_ID.split('-')[1]}`,
        purpose: 'inference',
        model: 'test',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
    ],
    ['x/privacy/fixture', { ...nested, embedded: { type: 'request/sent', data: nested } }],
  ]
  return rows.map(
    ([type, data], index) =>
      ({
        ...EVENTS[0],
        seq: index + 1,
        id: index === 0 ? OPAQUE_EVENT_ID : `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(index).padStart(2, '0')}`,
        type,
        data,
      }) as EventEnvelope,
  )
}

function endpoint(
  events: EventEnvelope[] = EVENTS,
  timeline: UITimeline = TIMELINE,
  sessionId = SESSION_ID,
): FakeEndpoint {
  let restored = false
  return new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: 'test' } },
    }))
    .on('_agnes/v1/session.integrity', () => ({
      state: 'verified',
      verifiedThroughSeq: events.length,
      lastSeq: events.length,
      legacyThroughSeq: 0,
      verifiedAtMs: 1,
    }))
    .on('session/load', (params) => {
      expect(params).toEqual({ sessionId, cwd: '', mcpServers: [] })
      restored = true
      return {}
    })
    .on('_agnes/v1/session.attach', (params, ep) => {
      expect(restored, 'cold session must be restored before attach').toBe(true)
      const cursor = (params as { cursor?: { fromSeq: number } }).cursor
      for (const event of events.filter((row) => row.seq > (cursor?.fromSeq ?? 0))) {
        const meta: HarnessMeta = {
          promptTurnId: 'turn-export',
          eventSequence: event.seq,
          generation: 1,
          lane: 'main',
          phase: 'event',
        }
        // Deliberately synchronous with the RPC handler. A reader that awaits attach before
        // registering events loses this entire replay even though the attach succeeds.
        ep.pushEvent(sessionId, event, meta)
      }
      return { generation: 1, lastSeq: events.at(-1)?.seq ?? 0, resolvedProfileHash: null }
    })
    .on('_agnes/v1/session.projectUI', (params) => {
      expect(params).toMatchObject({ sessionId })
      expect(params).toMatchObject({ upto: events.at(-1)?.seq ?? 0 })
      return events.length > 0
        ? { ...timeline, sessionId }
        : { sessionId, upto: 0, generation: 1, opState: null, turns: [], nodes: [] }
    })
    .on('_agnes/v1/session.detach', () => ({}))
}

async function clientFor(ep = endpoint()) {
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep }, journal: memoryJournal() })
  await client.initialize()
  return client
}

describe('export', () => {
  it('does not attach or write an output when durable session restoration fails', async () => {
    const ep = endpoint().on('session/load', () => {
      throw new Error('durable session missing')
    })
    const client = await clientFor(ep)
    const writeFile = vi.fn()
    try {
      await expect(
        exportSession(
          parseArgs(['export', SESSION_ID, '--raw', '-o', 'out.agnes']),
          {
            cwd: '/workspace',
            io: { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
            writeFile,
          },
          client,
        ),
      ).rejects.toThrow('durable session missing')
      expect(writeFile).not.toHaveBeenCalled()
      expect(ep.calls.some((call) => call.method === '_agnes/v1/session.attach')).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('refuses a handle installed by another caller during restoration', async () => {
    const ep = endpoint()
    const client = await clientFor(ep)
    vi.spyOn(client, 'restoreSession').mockImplementation(async () => {
      await client.session.load(SESSION_ID)
    })
    try {
      await expect(readLedger(client, SESSION_ID)).rejects.toThrow('already opened that session')
      expect(ep.calls.some((call) => call.method === '_agnes/v1/session.attach')).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('captures synchronous attach replay through the server watermark', async () => {
    const ep = endpoint()
    const client = await clientFor(ep)
    try {
      const ledger = await readLedger(client, SESSION_ID)
      expect(ledger).toEqual({ events: EVENTS, timeline: TIMELINE, lastSeq: 2 })
      expect(ep.calls.filter((call) => call.method === 'session/load')).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  it('rewinds a persisted sdk cursor instead of silently exporting only its suffix', async () => {
    const ep = endpoint()
    const client = await clientFor(ep)
    await client.journal.setCursor(SESSION_ID, { fromSeq: 2, generation: 1 })
    try {
      expect((await readLedger(client, SESSION_ID)).events).toEqual(EVENTS)
      const attach = ep.calls.find((call) => call.method === '_agnes/v1/session.attach')
      expect(attach?.params).toMatchObject({ cursor: { fromSeq: 0, generation: 1 } })
    } finally {
      await client.close()
    }
  })

  it('finishes an empty ledger without waiting for an event that cannot arrive', async () => {
    const client = await clientFor(endpoint([]))
    try {
      await expect(readLedger(client, SESSION_ID)).resolves.toMatchObject({ events: [], lastSeq: 0 })
    } finally {
      await client.close()
    }
  })

  it('turns an sdk-dropped invalid row into an error instead of waiting forever', async () => {
    const invalid = {
      ...EVENTS[0],
      data: { content: [{ type: 'not-a-content-block', text: 'bad' }] },
    } as EventEnvelope
    const client = await clientFor(endpoint([invalid]))
    try {
      await expect(readLedger(client, SESSION_ID)).rejects.toThrow('invalid ledger event at sequence 1')
    } finally {
      await client.close()
    }
  })

  it('writes native envelopes as JSONL and never includes sdk delivery metadata', () => {
    const text = new TextDecoder().decode(formatAgnes(EVENTS))
    expect(text.endsWith('\n')).toBe(true)
    expect(
      text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual(EVENTS)
    expect(text).not.toContain('_meta')
    expect(formatAgnes([])).toHaveLength(0)
  })

  it.each(['sharegpt', 'claude-code'] as const)(
    'redacts the %s sharing format before bridge conversion',
    async (format) => {
      const source = EVENTS[0]
      if (!source) throw new Error('export fixture is empty')
      const client = await clientFor(
        endpoint([
          {
            ...source,
            data: {
              content: [{ type: 'text', text: 'mail alice@example.com under /workspace/private' }],
            },
          },
        ]),
      )
      let output = ''
      const io = {
        stdout: {
          write: (chunk: string | Uint8Array) =>
            (output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)),
        },
        stderr: { write: vi.fn() },
      }
      try {
        await exportSession(
          parseArgs(['export', SESSION_ID, '--format', format]),
          { cwd: '/workspace', io },
          client,
        )
        expect(output).toContain('[REDACTED:email]')
        expect(output).toContain('<workspace>/private')
        expect(output).not.toContain('alice@example.com')
        if (format === 'claude-code') expect(output).not.toContain('"cwd":"/workspace"')
        expect(io.stderr.write).not.toHaveBeenCalled()
      } finally {
        await client.close()
      }
    },
  )

  it('keeps raw sharing an explicit warned escape hatch', async () => {
    const client = await clientFor()
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    try {
      await exportSession(
        parseArgs(['export', SESSION_ID, '--raw', '--format', 'sharegpt']),
        { cwd: '/workspace', io },
        client,
      )
      expect(io.stdout.write).toHaveBeenCalledOnce()
      expect(io.stderr.write).toHaveBeenCalledWith(expect.stringContaining('--raw'))
    } finally {
      await client.close()
    }
  })

  it('round-trips default native exports without corrupting protocol hashes or tool identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-export-import-'))
    const { host } = await createTestHost({ dataDir: root })
    const admission = await memoryAdmission(host, root)
    const events = roundTripEvents()
    expect(events.every((event) => validateEvent(event).ok)).toBe(true)
    const client = await clientFor(endpoint(events))
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    try {
      await exportSession(parseArgs(['export', SESSION_ID]), { cwd: '/workspace', io }, client)
      const bytes = io.stdout.write.mock.calls[0]?.[0] as Uint8Array
      const output = new TextDecoder().decode(bytes)
      // These same strings in user content and nested tool JSON remain subject to PII redaction.
      expect(output).not.toContain('alice@example.com')
      expect(output).not.toContain('13800138000')
      expect(output).toContain('[REDACTED:phone]')
      expect(output).toContain('[REDACTED:id]')
      expect(output).toContain('<workspace>/private')
      const rows = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as EventEnvelope)
      expect(rows.map((row) => validateEvent(row).ok)).toEqual(events.map(() => true))
      expect(rows[0]?.id).toBe(OPAQUE_EVENT_ID)
      expect(rows[0]?.data).toMatchObject({
        resolvedProfileHash: `sha256-${REQUEST_HASH}`,
        resolvedPresetHash: `sha256-${REQUEST_HASH}`,
      })
      expect(rows.find((row) => row.type === 'effect/intent')?.data).toMatchObject({
        effectId: 'e-493aca471666765577088665b167cd4d',
      })
      expect(rows.find((row) => row.type === 'cost/ledger')?.data).toMatchObject({
        effectId: 'e-493aca471666765577088665b167cd4d',
      })
      expect(rows.find((row) => row.type === 'decision/state')?.data).toMatchObject({
        handle: { id: OPAQUE_EVENT_ID },
        request: { operationId: OPAQUE_EVENT_ID, spec: { key: OPAQUE_EVENT_ID } },
      })
      expect(rows.find((row) => row.type === 'tool/call')?.data).toMatchObject({
        args: {
          nested: {
            derived_hash: expect.stringContaining('[REDACTED:phone]'),
            toolUseId: expect.stringContaining('[REDACTED:id]'),
          },
        },
      })
      expect(rows.at(-1)?.data).toMatchObject({ derived_hash: expect.stringContaining('[REDACTED:phone]') })
      expect(rows.find((row) => row.type === 'request/sent')?.data).toMatchObject({
        derived_hash: REQUEST_HASH,
        sent_hash: REQUEST_HASH,
        tool_schema_hash: REQUEST_HASH,
      })
      expect(
        rows
          .filter((row) => row.type === 'tool/call' || row.type === 'tool/result')
          .map((row) => (row.data as { toolUseId: string }).toolUseId),
      ).toEqual([TOOL_ID, TOOL_ID])
      await expect(
        importFile(parseArgs(['import', 'default.jsonl', '--key', 'restored']), {
          cwd: root,
          env: {},
          host,
          admission,
          io,
          readFile: () => bytes,
        }),
      ).resolves.toBe(0)
      const restored = await openAdmittedSession(host, admission, 'restored', root)
      try {
        const landed = await restored.scan({ limit: 100 })
        expect(landed).toHaveLength(events.length)
        expect(
          landed
            .filter((row) => row.type === 'tool/call' || row.type === 'tool/result')
            .map((row) => (row.data as { toolUseId: string }).toolUseId),
        ).toEqual([TOOL_ID, TOOL_ID])
      } finally {
        await restored.close()
      }
      expect(io.stderr.write).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await host.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Native rows point at each other by sequence number, so every format reads every row. Streamed
  // text is never a row; the only assistant text outside a message is an interrupted stream's, and
  // it is redacted whole like any other value.
  it('exports every row and redacts the text an interrupted stream recorded', async () => {
    const [user, assistant] = EVENTS
    if (!user || !assistant) throw new Error('export fixture is empty')
    const cut: EventEnvelope = {
      ...assistant,
      seq: 2,
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAD',
      type: 'assistant/output',
      data: {
        state: 'interrupted',
        effectId: 'e1',
        chars: { text: 21, thinking: 0 },
        estimatedTokens: 6,
        content: [{ type: 'text', text: 'mail alice@example.com' }],
      },
    }
    const events = [
      user,
      cut,
      { ...assistant, seq: 3 },
      {
        ...user,
        seq: 4,
        type: 'x/feedback/item',
        ignorable: true,
        data: { id: 'feedback-1', note: 'Cite evidence', rating: 'down', target: { messageSeq: 3, turn: 1 } },
      } as EventEnvelope,
      {
        ...user,
        seq: 5,
        type: 'x/feedback/growth',
        ignorable: true,
        data: {
          feedbackId: 'feedback-1',
          feedbackRevision: 4,
          messageSeq: 3,
          candidateId: 'candidate-local',
          candidateHash: 'sha256-' + 'a'.repeat(64),
        },
      } as EventEnvelope,
    ]
    const exported = async (argv: string[]) => {
      const ep = endpoint(events)
      const client = await clientFor(ep)
      const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
      try {
        await exportSession(parseArgs(['export', SESSION_ID, ...argv]), { cwd: '/workspace', io }, client)
        const attach = ep.calls.find((call) => call.method === '_agnes/v1/session.attach')?.params
        const output = new TextDecoder().decode(io.stdout.write.mock.calls[0]?.[0] as Uint8Array)
        return { attach, output }
      } finally {
        await client.close()
      }
    }

    const redacted = await exported([])
    expect((redacted.attach as { filter?: unknown } | undefined)?.filter).toEqual({ acpUpdates: false })
    const rows = redacted.output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EventEnvelope)
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5])
    expect(rows.slice(3).map((row) => row.type)).toEqual(['x/feedback/item', 'x/feedback/growth'])
    expect(rows[3]?.data).toMatchObject({ id: 'feedback-1', rating: 'down', note: 'Cite evidence' })
    expect(redacted.output).not.toContain('alice@example.com')
    expect((await exported(['--raw'])).output).toContain('alice@example.com')
  })

  it('omits encoded media and redacts metadata, home paths, and usernames in native output', async () => {
    const source = EVENTS[0]
    if (!source) throw new Error('export fixture is empty')
    const media = 'c2VjcmV0LWJpbmFyeQ=='
    const privateEvents: EventEnvelope[] = [
      {
        ...source,
        actor: { ...source.actor, attrs: { owner: FIXTURE_EMAIL, home: `${FIXTURE_HOME}/.ssh` } },
        data: {
          content: [
            { type: 'text', text: `${FIXTURE_WORKSPACE}/private` },
            { type: 'file', name: 'private.bin', mimeType: 'application/octet-stream', data: media },
            {
              type: 'resource_link',
              uri: 'test:resource',
              attachment: {
                artifact: { sha256: REQUEST_HASH, size: 1, mime: 'text/plain' },
                thumbnail: { sha256: REQUEST_HASH, size: 1, mime: 'image/png' },
              },
            },
          ],
        },
      },
    ]
    const client = await clientFor(endpoint(privateEvents))
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    try {
      await exportSession(
        parseArgs(['export', SESSION_ID]),
        { cwd: FIXTURE_WORKSPACE, home: FIXTURE_HOME, username: FIXTURE_USER, io },
        client,
      )
      const output = new TextDecoder().decode(io.stdout.write.mock.calls[0]?.[0] as Uint8Array)
      expect(sanitizeExportValue({ type: 'image', data: media, mimeType: 'image/png' })).toEqual({
        type: 'image',
        data: '[OMITTED:image:base64]',
        mimeType: 'image/png',
      })
      expect(sanitizeExportValue({ type: 'audio', data: media, mimeType: 'audio/wav' })).toEqual({
        type: 'audio',
        data: '[OMITTED:audio:base64]',
        mimeType: 'audio/wav',
      })
      expect(output).toContain('[REDACTED:email]')
      expect(output).toContain('<workspace>/private')
      expect(output).toContain('~/.ssh')
      expect(output).not.toContain(media)
      expect(output).toContain('[OMITTED:file:base64]')
      expect(output).toContain(REQUEST_HASH)
      expect(validateEvent(JSON.parse(output.trim())).ok).toBe(true)
      expect(output).not.toContain(FIXTURE_HOME)
    } finally {
      await client.close()
    }
  })

  it('redacts the HTML session identity and omits media payloads', async () => {
    const privateId = `agnes:${FIXTURE_EMAIL}:${FIXTURE_HOME}/private`
    const media = 'c2VjcmV0LWltYWdl'
    const timeline: UITimeline = {
      ...TIMELINE,
      sessionId: privateId,
      nodes: [
        {
          id: 'private',
          kind: 'user',
          seq: 1,
          content: [
            { type: 'image', data: media, mimeType: 'image/png' },
            { type: 'text', text: `${FIXTURE_EMAIL} ${FIXTURE_HOME}/private` },
          ],
        },
      ],
    }
    const client = await clientFor(endpoint(EVENTS, timeline, privateId))
    let output = ''
    const io = {
      stdout: {
        write: (chunk: string | Uint8Array) =>
          (output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)),
      },
      stderr: { write: vi.fn() },
    }
    try {
      await exportSession(
        parseArgs(['export', privateId, '--html']),
        { cwd: FIXTURE_WORKSPACE, home: FIXTURE_HOME, username: FIXTURE_USER, io },
        client,
      )
      expect(output).toContain('[REDACTED:email]')
      expect(output).not.toContain(privateId)
      expect(output).not.toContain(media)
      expect(output).not.toContain(FIXTURE_HOME)
      expect(output).toContain('redacted')
    } finally {
      await client.close()
    }
  })

  it('exports raw native bytes only after an explicit warning and resolves relative output paths', async () => {
    const client = await clientFor()
    const writes: Array<{ path: string; bytes: Uint8Array }> = []
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    try {
      await expect(
        exportSession(
          parseArgs(['export', SESSION_ID, '--raw', '-o', 'dump.agnes']),
          {
            cwd: '/workspace',
            io,
            writeFile: async (path, bytes) => {
              writes.push({ path, bytes })
            },
          },
          client,
        ),
      ).resolves.toBe(0)
      expect(io.stderr.write).toHaveBeenCalledWith(
        'warning: --raw exports without redaction (secrets, paths, PII)\n',
      )
      expect(io.stdout.write).not.toHaveBeenCalled()
      expect(writes).toHaveLength(1)
      expect(writes[0]?.path).toBe(resolve('/workspace', 'dump.agnes'))
      expect(new TextDecoder().decode(writes[0]?.bytes)).toContain('"type":"user/message"')
    } finally {
      await client.close()
    }
  })

  it('tightens an existing raw output file to owner-only before replacing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-export-'))
    const path = join(root, 'dump.agnes')
    writeFileSync(path, 'old')
    chmodSync(path, 0o644)
    const client = await clientFor()
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    try {
      await exportSession(parseArgs(['export', SESSION_ID, '--raw', '-o', path]), { cwd: root, io }, client)
      if (process.platform === 'win32') expect(hasPrivateDaclSync(path)).toBe(true)
      else expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readFileSync(path, 'utf8')).toContain('"type":"user/message"')
    } finally {
      await client.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('routes explicit raw HTML through the existing inert renderer', async () => {
    const client = await clientFor()
    let output = ''
    const io = {
      stdout: {
        write: (chunk: string | Uint8Array) =>
          (output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)),
      },
      stderr: { write: vi.fn() },
    }
    try {
      await exportSession(
        parseArgs(['export', SESSION_ID, '--raw', '--html']),
        {
          cwd: '/workspace',
          io,
          now: () => new Date('2026-09-11T00:00:00.000Z'),
        },
        client,
      )
      expect(output).toContain('<!doctype html>')
      expect(output).toContain(`${SESSION_ID} · 2026-09-11T00:00:00.000Z · raw`)
      expect(output).not.toContain('<script')
    } finally {
      await client.close()
    }
  })
})

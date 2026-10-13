import { randomBytes } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import type { EventEnvelope, UITimeline } from '@agnes/protocol'
import type { BrowserLog, DiagnosticsInclude } from '@agnes/web-units'
import { describe, expect, it } from 'vitest'
import { type CollectInput, collectDiagnostics, type RpcCall } from '../src/diagnostics-bundle.js'

function readZip(zip: Uint8Array): Map<string, string> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd--
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true)
    const csize = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const raw = zip.subarray(start, start + csize)
    out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(raw) : raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const ALL: DiagnosticsInclude = { conversation: true, logs: true, system: true }
const NOW = new Date(Date.UTC(2026, 9, 13, 1, 2, 3))
const SESSION = 'agnes:local:default:cli:dm:attachments'
const ACTOR = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const REF_SHA = 'a'.repeat(64)
const THUMB_SHA = 'b'.repeat(64)
// Attachment bytes as base64: what must never reach any file of the bundle.
const FILE_DATA = randomBytes(3000).toString('base64')
const IMAGE_DATA = randomBytes(3000).toString('base64')

const referenceImage = {
  type: 'image',
  mimeType: 'image/png',
  name: 'shot.png',
  attachment: { sha256: REF_SHA, bytes: 9000 },
  width: 640,
  height: 480,
  thumbnail: { sha256: THUMB_SHA, bytes: 700, width: 320, height: 240 },
}
const leanFile = {
  type: 'file',
  mimeType: 'application/zip',
  name: 'old.zip',
  dataOmitted: { bytes: 20 * 1024 * 1024 },
}

const ev = (seq: number, type: string, data: unknown): EventEnvelope =>
  ({
    seq,
    ts: '2026-10-13T01:00:00.000Z',
    id: `ev-${seq}`,
    type,
    data,
    actor: ACTOR,
    origin: 'principal',
    trust: 'trusted',
  }) as EventEnvelope

// The rows as the daemon serves them to a client that reads references: old inline data replaced,
// references and the lean form as stored.
const EVENTS = [
  ev(1, 'user/message', { content: [{ type: 'text', text: 'here' }, referenceImage, leanFile] }),
  ev(2, 'user/message', {
    content: [{ type: 'file', mimeType: 'text/plain', name: 'small.txt', data: '[OMITTED:file:base64]' }],
  }),
]

// The Web's own projection: user nodes are a copy of the message content, old inline data included.
const PROJECTION = {
  sessionId: SESSION,
  upto: 2,
  generation: 1,
  opState: null,
  turns: [],
  nodes: [
    { id: 'u1', kind: 'user', seq: 1, content: [{ type: 'text', text: 'here' }, referenceImage, leanFile] },
    {
      id: 'u2',
      kind: 'user',
      seq: 2,
      content: [
        { type: 'file', mimeType: 'text/plain', name: 'small.txt', data: FILE_DATA },
        { type: 'image', mimeType: 'image/png', data: IMAGE_DATA },
      ],
    },
  ],
} as unknown as UITimeline

const browserLog: BrowserLog = { collectedAt: NOW.toISOString(), entries: [], dropped: 0, limit: 1000 }

const call: RpcCall = async (method) => {
  switch (method.slice('_agnes/v1/'.length)) {
    case 'diagnostics.collect':
      return {
        collectedAt: NOW.toISOString(),
        agh: { version: '9.9.9' },
        runtime: { platform: 'darwin', arch: 'arm64', osRelease: '25', node: '24', pid: 1, uptimeMs: 1 },
        logs: [],
      }
    case 'apis.list':
      return { profile: { name: 'default', resolvedProfileHash: null, presets: {} }, families: [] }
    case 'config.get':
      return {}
    case 'diagnostics.events':
      return { events: EVENTS, lastSeq: 2, nextAfterSeq: null }
    default:
      throw new Error(`unexpected ${method}`)
  }
}

const input: CollectInput = {
  call,
  sessionId: SESSION,
  sessionTitle: 'attachments',
  projection: PROJECTION,
  projectionHasEarlier: false,
  browserLog,
  browser: {},
  now: NOW,
}

/** Every 64-character window of the base64, stepped so a fragment cut anywhere is found. */
const fragments = (data: string) =>
  Array.from({ length: Math.floor((data.length - 64) / 16) }, (_, i) => data.slice(i * 16, i * 16 + 64))

describe('diagnostics bundles of a session with attachments', () => {
  it('carry attachment metadata and never attachment bytes', async () => {
    const out = await collectDiagnostics(input, ALL, new AbortController().signal)
    const files = readZip(out.zip)
    expect(files.has('trace.json')).toBe(true)
    for (const [name, text] of files)
      for (const fragment of [...fragments(FILE_DATA), ...fragments(IMAGE_DATA)])
        expect(text.includes(fragment), `${name} carries attachment bytes`).toBe(false)

    const rows = (files.get('events.jsonl') ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EventEnvelope)
    const content = (rows[0]?.data as { content?: unknown[] } | undefined)?.content ?? []
    expect(content[1]).toMatchObject({
      attachment: { sha256: REF_SHA, bytes: 9000 },
      thumbnail: { sha256: THUMB_SHA, bytes: 700 },
    })
    expect(content[2]).toMatchObject({ dataOmitted: { bytes: 20 * 1024 * 1024 } })
    const trace = JSON.parse(files.get('trace.json') ?? '{}') as {
      nodes: Array<{ content: Array<Record<string, unknown>> }>
    }
    expect(trace.nodes[1]?.content).toEqual([
      { type: 'file', mimeType: 'text/plain', name: 'small.txt', data: '[OMITTED:file:base64]' },
      { type: 'image', mimeType: 'image/png', data: '[OMITTED:image:base64]' },
    ])
    expect(trace.nodes[0]?.content[1]).toMatchObject({ attachment: { sha256: REF_SHA, bytes: 9000 } })
  })
})

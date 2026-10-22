import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@agnes/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { sessionsCommand } from '../src/commands/sessions.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agh-deliv-'))
})
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  rmSync(dir, { recursive: true, force: true })
})

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const CHUNK = 1024 * 1024
const small = Buffer.from('hello deliverable')
const big = Buffer.alloc(CHUNK + 10, 7)
const ref = (b: Buffer, mime = 'text/plain') => ({ sha256: sha(b), size: b.length, mime })

type Opts = { tamper?: boolean; refuse?: boolean }

/** A daemon that delivered two files in one present call (the first name tries to escape its directory). */
async function run(argv: string[], opts: Opts = {}) {
  const files = [
    { name: '../../etc/evil.txt', description: 'd', ref: ref(small) },
    { name: 'big.bin', description: '', ref: ref(big, 'application/octet-stream') },
  ]
  const bytes = new Map([
    [sha(small), small],
    [sha(big), big],
  ])
  const endpoint = new FakeEndpoint()
  endpoint
    .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .on('session/load', () => ({}))
    .on('_agnes/v1/session.deliverables', () => ({
      sessionId: 's1',
      upto: 9,
      items: [{ callSeq: 3, resultSeq: 4, toolUseId: 'tu1', structured: { deliverables: files } }],
    }))
    .on('_agnes/v1/artifact.read', (params) => {
      if (opts.refuse) return { ok: false, status: 403, code: 'artifact_forbidden' }
      const p = params as { artifact: { sha256: string; size: number; mime: string }; range?: string }
      let data = bytes.get(p.artifact.sha256) as Buffer
      let status = 200
      let contentRange: string | undefined
      if (p.range) {
        const [start, end] = p.range.slice(6).split('-').map(Number) as [number, number]
        data = data.subarray(start, end + 1)
        status = 206
        contentRange = `bytes ${start}-${end}/${p.artifact.size}`
      }
      if (opts.tamper) data = Buffer.alloc(data.length, 1)
      return {
        ok: true,
        status,
        acceptRanges: 'bytes',
        etag: `"${p.artifact.sha256}"`,
        artifact: p.artifact,
        contentLength: data.length,
        base64: data.toString('base64'),
        ...(contentRange ? { contentRange } : {}),
      }
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  const exit = await sessionsCommand(parseArgs([...argv, '--cwd', dir]), client, {
    stdout: { write: (t: string) => (out += t) } as never,
    stderr: { write: () => true } as never,
  }).catch((e: Error) => e)
  return { exit, out, calls: endpoint.calls }
}

describe('sessions deliverables', () => {
  it('lists numbered files on inert lines, with ids and hashes in --json', async () => {
    const r = await run(['sessions', 'deliverables', 's1'])
    expect(r.exit).toBe(0)
    expect(r.out).toBe(
      `1\t../../etc/evil.txt\t${small.length}\ttext/plain\n2\tbig.bin\t${big.length}\tapplication/octet-stream\n`,
    )
    const json = JSON.parse((await run(['sessions', 'deliverables', 's1', '--json'])).out)
    expect(json.items[1]).toMatchObject({ index: 2, id: 'main:tu1:1', sha256: sha(big), size: big.length })
  })

  it('--save takes only the basename, verifies the bytes and refuses to overwrite without --force', async () => {
    const r = await run(['sessions', 'deliverables', 's1', '--save', '1'])
    expect(r.exit).toBe(0)
    const path = join(dir, 'evil.txt')
    expect(readFileSync(path)).toEqual(small)
    expect(r.out).toBe(`saved ${path} (${small.length} bytes, sha256 ${sha(small)})\n`)
    const again = await run(['sessions', 'deliverables', 's1', '--save', '1'])
    expect(again.exit).toMatchObject({
      name: 'CommandError',
      message: expect.stringContaining('use --force'),
    })
    expect(again.calls.some((c) => c.method === '_agnes/v1/artifact.read')).toBe(false)
    writeFileSync(path, 'old')
    expect((await run(['sessions', 'deliverables', 's1', '--save', '1', '--force'])).exit).toBe(0)
    expect(readFileSync(path)).toEqual(small)
  })

  it('reads a file larger than one RPC chunk in ranges, by id, into --out', async () => {
    const r = await run(['sessions', 'deliverables', 's1', '--save', 'main:tu1:1', '--out', 'copy.bin'])
    expect(r.exit).toBe(0)
    expect(readFileSync(join(dir, 'copy.bin'))).toEqual(big)
    expect(
      r.calls
        .filter((c) => c.method === '_agnes/v1/artifact.read')
        .map((c) => (c.params as { range: string }).range),
    ).toEqual([`bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${CHUNK + 9}`])
  })

  it('leaves no file behind when the bytes do not match the sha256, or the daemon refuses', async () => {
    const bad = await run(['sessions', 'deliverables', 's1', '--save', '1', '--out', 'x.txt'], {
      tamper: true,
    })
    expect(bad.exit).toMatchObject({
      name: 'CommandError',
      message: expect.stringContaining('digest mismatch'),
    })
    const refused = await run(['sessions', 'deliverables', 's1', '--save', '1', '--out', 'x.txt'], {
      refuse: true,
    })
    expect(String((refused.exit as Error).message)).toContain('artifact_forbidden')
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(dir, 'x.txt'))).toBe(false)
  })

  it('rejects an unknown deliverable and stray flags as usage errors', async () => {
    for (const argv of [
      ['sessions', 'deliverables'],
      ['sessions', 'deliverables', 's1', '--save', '9'],
      ['sessions', 'deliverables', 's1', '--force'],
    ])
      expect((await run(argv)).exit).toMatchObject({ name: 'UsageError' })
  })
})

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestHost } from '@agnes/host/testkit'
import type { ArtifactReadParams, EventEnvelope } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { formatAgnes } from '../src/commands/export.js'
import { importFile } from '../src/commands/import.js'
import { bundleOriginals, readNativeBundle, writeNativeBundle } from '../src/commands/native-bundle.js'
import { memoryAdmission, openAdmittedSession } from './import-admission.js'

const original = Buffer.from('synthetic original bytes')
const ref = {
  sha256: createHash('sha256').update(original).digest('hex'),
  size: original.length,
  mime: 'text/plain',
}
const client = (bytes = original, sessionId = 's') =>
  ({
    call: async (_method: string, p: ArtifactReadParams) => {
      expect(_method).toBe('_agnes/v1/artifact.read')
      expect(p.sessionId).toBe(sessionId)
      expect(p.range).toBe(`bytes=0-${ref.size - 1}`)
      expect(p.laneId).toBe('main')
      expect(p.artifact).toEqual(ref)
      return {
        ok: true,
        status: 206,
        artifact: ref,
        acceptRanges: 'bytes',
        contentLength: bytes.length,
        contentRange: `bytes 0-${ref.size - 1}/${ref.size}`,
        etag: `"${ref.sha256}"`,
        base64: bytes.toString('base64'),
      }
    },
  }) as unknown as Client

it('round-trips current-product rows and original bytes through the public artifact seam', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-native-'))
  // Content-addressed fake for the public seam; the default test seam returns a fixed identity.
  const originals = new Map<string, Uint8Array>()
  const { host } = await createTestHost({
    dataDir: dir,
    seams: {
      artifacts: {
        put: async (bytes, options) => {
          const sha256 = createHash('sha256').update(bytes).digest('hex')
          originals.set(sha256, bytes.slice())
          return { sha256, size: bytes.length, mime: options?.mime ?? 'application/octet-stream' }
        },
        get: async (artifact) => {
          const bytes = originals.get(artifact.sha256)
          if (!bytes) throw new Error('missing original')
          return bytes.slice()
        },
      },
    },
  })
  const admission = await memoryAdmission(host, dir)
  const source = await openAdmittedSession(host, admission, 'agnes:local:default:cli:dm:source', dir)
  try {
    await source.append([
      {
        type: 'artifact/job',
        register: 'artifact/job',
        data: { jobId: 'done', status: 'done', ref },
        actor: source.d.actor,
        origin: 'system',
        trust: 'trusted',
      },
    ])
    const rows = (await source.scan({ limit: 50 })) as EventEnvelope[]
    const path = join(dir, 'bundle.agnes')
    await writeNativeBundle(path, rows, formatAgnes(rows), client(original, source.key), source.key)
    const checked = await readNativeBundle(path, readFileSync(path))
    expect(Buffer.from(checked?.raw ?? [])).toEqual(Buffer.from(formatAgnes(rows)))
    expect(await checked?.readOriginal(ref)).toEqual(original)
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    const key = 'agnes:local:default:cli:dm:imported'
    await expect(
      importFile(parseArgs(['import', path, '--key', key]), { env: {}, cwd: dir, host, admission, io }),
    ).resolves.toBe(0)
    const imported = await openAdmittedSession(host, admission, key, dir)
    try {
      expect(Buffer.from(await imported.d.runtime.artifactGet(ref))).toEqual(original)
      const body = await imported.scan({ fromSeq: 2, limit: 50 })
      expect(body).toEqual(rows.slice(1))
    } finally {
      await imported.close()
    }
  } finally {
    await source.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each(['changed', 'missing', 'symlink', 'manifest', 'ledger'] as const)(
  'rejects a %s original bundle before reserving a target',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-native-refusal-'))
    const path = join(dir, 'bundle.agnes')
    const events = [{ seq: 1, lane: 'main', data: { ref } }] as EventEnvelope[]
    try {
      await writeNativeBundle(path, events, formatAgnes(events), client(), 's')
      const target = join(`${path}.artifacts`, ref.sha256)
      if (mode === 'changed') writeFileSync(target, Buffer.alloc(original.length))
      if (mode === 'missing') rmSync(target)
      if (mode === 'symlink') {
        rmSync(target)
        writeFileSync(join(dir, 'other'), original)
        symlinkSync(join(dir, 'other'), target)
      }
      if (mode === 'manifest')
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace(`"size":${formatAgnes(events).length}`, '"size":0'),
        )
      if (mode === 'ledger') writeFileSync(path, `${readFileSync(path, 'utf8')}{}\n`)
      const reserve = vi.fn()
      await expect(
        importFile(parseArgs(['import', path]), {
          env: {},
          cwd: dir,
          host: {} as never,
          admission: { reserve } as never,
          io: { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
        }),
      ).rejects.toThrow()
      expect(reserve).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

it('publishes nothing when the authorized original bytes have the wrong digest and preserves existing bundles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-native-export-'))
  const path = join(dir, 'bundle.agnes')
  const events = [{ seq: 1, lane: 'main', data: { ref } }] as EventEnvelope[]
  try {
    await expect(
      writeNativeBundle(path, events, formatAgnes(events), client(Buffer.alloc(original.length)), 's'),
    ).rejects.toThrow('digest')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.artifacts`)).toBe(false)
    await writeNativeBundle(path, events, formatAgnes(events), client(), 's')
    const before = readFileSync(path)
    await expect(writeNativeBundle(path, events, formatAgnes(events), client(), 's')).rejects.toThrow()
    expect(readFileSync(path)).toEqual(before)
    expect(readFileSync(join(`${path}.artifacts`, ref.sha256))).toEqual(original)
    expect(() => bundleOriginals([{ data: { uri: `artifact://${ref.sha256}` } }] as EventEnvelope[])).toThrow(
      'identity',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

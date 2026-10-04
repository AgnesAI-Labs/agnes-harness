import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ArtifactDownloadTicket,
  ArtifactReadStreamEndResult,
  ArtifactViewRef,
  RuntimeError,
} from '@agnes/protocol/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ArtifactByteStream,
  type ArtifactPorts,
  createArtifactActions,
} from '../../src/runtime/artifact-actions.js'
import type { RuntimeCallResult } from '../../src/runtime/ports.js'

type End = RuntimeCallResult<ArtifactReadStreamEndResult>
const target = { artifactId: 'file-1', version: 2 }
const body = [new TextEncoder().encode('hello '), new TextEncoder().encode('world')]
const bytes = Buffer.concat(body)
const summary = { bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') }
const ok = <T>(value: T) => ({ state: 'ok' as const, value })
const failed = (code: RuntimeError['code'], detailCode: string) => ({
  state: 'failed' as const,
  error: {
    code,
    detailCode,
    message: detailCode,
    retryAdvice: { kind: 'never' as const },
    diagnosticId: 'd-1',
  },
})

function stream(end: End = ok(summary)): ArtifactByteStream & { cancel: ReturnType<typeof vi.fn> } {
  return {
    metadata: { streamId: 'stream-1', offset: 0, totalBytes: bytes.length },
    chunks: (async function* () {
      yield* body
    })(),
    ended: Promise.resolve(end),
    cancel: vi.fn(async () => undefined),
    close: async () => undefined,
  }
}

function actions(opened: RuntimeCallResult<ArtifactByteStream> = ok(stream())) {
  const ports = {
    describe: vi.fn(async (): Promise<RuntimeCallResult<ArtifactViewRef>> => failed('internal', 'unused')),
    openDownload: vi.fn(
      async (): Promise<RuntimeCallResult<ArtifactDownloadTicket>> => ({
        state: 'refused',
        reason: 'reload-required',
      }),
    ),
    openStream: vi.fn(async () => opened),
  } satisfies ArtifactPorts
  return {
    ports,
    artifacts: createArtifactActions({ ports, baseUrl: 'https://agnes.test/mount', locale: 'en' }),
  }
}

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agnes-cli-tui-artifact-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runtime artifact actions', () => {
  it('describes only title, type, size, version and state', async () => {
    const { ports, artifacts } = actions()
    ports.describe.mockResolvedValueOnce(
      ok({ ...target, title: 'report\u202e.pdf', mime: 'application/pdf', size: 11, status: 'ready' }),
    )
    expect(await artifacts.describe(target)).toEqual({
      state: 'done',
      text: 'report.pdf (application/pdf, 11 bytes, version 2, ready)',
    })
    ports.describe.mockResolvedValueOnce(
      ok({ ...target, title: null, mime: null, size: null, status: 'revoked' }),
    )
    expect((await artifacts.describe(target)).text).toBe('- (-, - bytes, version 2, revoked)')
  })

  it('issues a link only on request, joined to the deployment base and shown with its expiry', async () => {
    const { ports, artifacts } = actions()
    const ticket = { ...target, expiresAt: '2026-10-01T00:05:00Z', grantRevision: 1 }
    ports.openDownload.mockResolvedValueOnce(
      ok({ ...ticket, url: '/api/runtime/artifact/download/t-1?nonce=n' }),
    )
    expect(await artifacts.link(target)).toEqual({
      state: 'done',
      text: 'Download link, valid until 2026-10-01T00:05:00Z: https://agnes.test/mount/api/runtime/artifact/download/t-1?nonce=n',
    })
    expect(ports.openDownload).toHaveBeenCalledWith({ ...target, disposition: 'attachment' })
    ports.openDownload.mockResolvedValueOnce(ok({ ...ticket, url: 'https://elsewhere.test/t-1' }))
    expect((await artifacts.link(target)).state).toBe('failed')
    ports.openDownload.mockResolvedValueOnce(failed('denied', 'ticket_expired'))
    expect(await artifacts.link(target)).toEqual({
      state: 'expired',
      text: 'The download link expired; request a new one.',
    })
    // A client that must reload is refused before anything is sent, and nothing is retried.
    expect(await artifacts.link(target)).toEqual({
      state: 'failed',
      text: 'The artifact request failed: reload-required',
    })
    expect(ports.openDownload).toHaveBeenCalledTimes(4)
  })

  it('writes the file only after the end summary matches what was written', async () => {
    const { ports, artifacts } = actions()
    const path = join(dir, 'out.txt')
    expect(await artifacts.download(target, path)).toEqual({ state: 'done', text: `Saved to ${path}.` })
    expect(await readFile(path, 'utf8')).toBe('hello world')
    expect(await readdir(dir)).toEqual(['out.txt'])
    expect(ports.openStream).toHaveBeenCalledWith(target)
  })

  it('replaces an existing file only once the user confirms', async () => {
    const path = join(dir, 'out.txt')
    await writeFile(path, 'mine')
    const refused = actions()
    expect(await refused.artifacts.download(target, path)).toEqual({
      state: 'exists',
      text: `${path} already exists; confirm to replace it.`,
    })
    expect(refused.ports.openStream).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe('mine')
    expect((await actions().artifacts.download(target, path, true)).state).toBe('done')
    expect(await readFile(path, 'utf8')).toBe('hello world')
  })

  it.each<[string, End, string, string[]]>([
    ['a digest mismatch', ok({ ...summary, digest: '0'.repeat(64) }), 'failed', []],
    ['a length mismatch', ok({ ...summary, bytes: summary.bytes + 1 }), 'failed', []],
    ['access revoked mid-stream', failed('denied', 'revoked'), 'revoked', []],
    ['a permission error', failed('denied', 'permission_denied'), 'revoked', []],
    ['an interruption', { state: 'unknown', reason: 'stream interrupted' }, 'interrupted', ['out.txt.part']],
    ['a server failure', failed('internal', 'storage'), 'failed', ['out.txt.part']],
  ])('never leaves a finished file after %s', async (_name, end, state, left) => {
    const { ports, artifacts } = actions(ok(stream(end)))
    expect((await artifacts.download(target, join(dir, 'out.txt'))).state).toBe(state)
    expect(await readdir(dir)).toEqual(left)
    expect(ports.openStream).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the stream is refused at the start', async () => {
    const { artifacts } = actions(failed('denied', 'revoked'))
    expect(await artifacts.download(target, join(dir, 'out.txt'))).toEqual({
      state: 'revoked',
      text: 'Access to this artifact has been revoked.',
    })
    expect(await readdir(dir)).toEqual([])
  })

  it('cancels the stream when the part file cannot be written', async () => {
    const opened = stream()
    const { artifacts } = actions(ok(opened))
    expect((await artifacts.download(target, join(dir, 'missing', 'out.txt'))).state).toBe('interrupted')
    expect(opened.cancel).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual([])
  })
})

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRuntimeTarget,
  decodeRuntimeTargetBytes,
  encodeRuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { runRuntimeTargetProbe } from '../src/runtime-target-probe.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function targetArtifact() {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [],
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
      resources: { mcp: [], skills: {} },
    }),
  )
}

async function targetFile(bytes: Uint8Array): Promise<string> {
  const root = join(tmpdir(), `agnes-runtime-probe-worker-${randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: false, mode: 0o700 })
  const file = join(root, 'runtime-target.json')
  await writeFile(file, bytes, { mode: 0o600, flag: 'wx' })
  await chmod(file, 0o600)
  return file
}

describe('isolated runtime target probe entry', () => {
  it('validates exact canonical bytes without opening a Host or business session', async () => {
    const artifact = targetArtifact()
    const file = await targetFile(decodeRuntimeTargetBytes(artifact))

    const target = await runRuntimeTargetProbe({
      AGNES_WORKER_KIND: 'probe',
      AGNES_WORKER_KEY: `@probe:${artifact.digest}`,
      AGNES_RUNTIME_TARGET_FILE: file,
    })

    expect(target.resource.target).toEqual(artifact.identity)
    expect(Object.isFrozen(target)).toBe(true)
  })

  it('rejects a key for different bytes before decoding the target', async () => {
    const artifact = targetArtifact()
    const file = await targetFile(decodeRuntimeTargetBytes(artifact))
    await expect(
      runRuntimeTargetProbe({
        AGNES_WORKER_KIND: 'probe',
        AGNES_WORKER_KEY: `@probe:sha256-${'0'.repeat(64)}`,
        AGNES_RUNTIME_TARGET_FILE: file,
      }),
    ).rejects.toMatchObject({ code: 'E_RUNTIME_PROBE_DIGEST' })
  })

  it('rejects non-canonical bytes even when the probe key matches them', async () => {
    const artifact = targetArtifact()
    const pretty = Buffer.from(
      JSON.stringify(JSON.parse(Buffer.from(decodeRuntimeTargetBytes(artifact)).toString('utf8')), null, 2),
    )
    const file = await targetFile(pretty)
    const digest = `sha256-${createHash('sha256').update(pretty).digest('hex')}`
    await expect(
      runRuntimeTargetProbe({
        AGNES_WORKER_KIND: 'probe',
        AGNES_WORKER_KEY: `@probe:${digest}`,
        AGNES_RUNTIME_TARGET_FILE: file,
      }),
    ).rejects.toThrow(/E_RUNTIME_TARGET_CANONICAL/)
  })

  it.each([
    [{}, 'kind'],
    [{ AGNES_WORKER_KIND: 'probe' }, 'key'],
    [{ AGNES_WORKER_KIND: 'probe', AGNES_WORKER_KEY: '@probe:bad' }, 'key'],
  ])('rejects an incomplete probe environment (%s: %s)', async (env, _label) => {
    await expect(runRuntimeTargetProbe(env)).rejects.toMatchObject({ code: 'E_RUNTIME_PROBE_ENV' })
  })
})

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { openModelCaptureStore } from '../../src/runtime/model/model-capture-store.js'
import { createModelSourceReader } from '../../src/runtime/model/model-source-reader.js'
import {
  fixtureCatalog,
  fixtureContext,
  fixtureFrame,
  fixturePorts,
  preparedRef,
} from './model-source-fixture.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const storeFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-reader-'))
  dirs.push(dir)
  return join(dir, 'captures', 'model-captures.sqlite')
}
const child = fileURLToPath(new URL('./fixtures/model-source-reader-child.ts', import.meta.url))
function coldRead(path: string, ref: unknown) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', child, path, JSON.stringify(ref)], {
    encoding: 'utf8',
    timeout: 60000,
  })
  if (run.status !== 0) throw new Error(`child failed: ${run.stderr}`)
  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as {
    ok: boolean
    digest?: string
    detailCode?: string
    network: number
  }
}

describe('model source reader in a fresh process', () => {
  it('loads the same source from the retained capture file and sends nothing', async () => {
    const path = storeFile()
    const store = openModelCaptureStore(path)
    store.retain(fixtureCatalog())
    store.close()
    const ref = preparedRef()
    const { ports } = fixturePorts()
    const here = await createModelSourceReader(ports).load(ref, fixtureFrame(ref), fixtureContext())
    if (!here.ok) throw new Error(here.error.detailCode)
    expect(coldRead(path, ref)).toEqual({
      ok: true,
      digest: canonicalJsonDigest(here.value as never),
      network: 0,
    })
  })

  it('refuses with a missing capture when the fresh process has another, empty store', () => {
    const path = storeFile()
    openModelCaptureStore(path).close()
    expect(coldRead(path, preparedRef())).toEqual({
      ok: false,
      detailCode: 'model_source_capture',
      network: 0,
    })
  })
})

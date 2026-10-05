import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fakeModel } from '@agnes/ai/testkit'
import type { RouteDecl } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { captureModelCatalog } from '../../src/runtime/model/model-catalog-capture.js'
import { ModelCaptureConflict, openModelCaptureStore } from '../../src/runtime/model/model-capture-store.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const file = () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-'))
  dirs.push(dir)
  return join(dir, 'runtime-services', 'model-captures.sqlite')
}
const catalog = (output = 2) =>
  captureModelCatalog({
    routes: () => [{ route: 'r1', api: 'openai-completions', baseUrl: 'https://fake.invalid' } as RouteDecl],
    models: () => [fakeModel({ id: 'a', route: 'r1', cost: { input: 1, output, cacheRead: 0, cacheWrite: 0 } })],
    seal: () => {},
  })

describe('model capture store', () => {
  it('retains a catalog and reads the same content back after reopening the file', () => {
    const path = file()
    const first = openModelCaptureStore(path)
    const digest = first.retain(catalog())
    first.close()
    const reopened = openModelCaptureStore(path)
    const read = reopened.read(digest)
    expect(read?.digest).toBe(digest)
    expect(read?.select('r1', 'a')?.model.cost.output).toBe(2)
    reopened.close()
  })

  it('treats retaining the same content twice as a no-op and keeps different catalogs apart', () => {
    const store = openModelCaptureStore(file())
    expect(store.retain(catalog(2))).toBe(store.retain(catalog(2)))
    expect(store.retain(catalog(3))).not.toBe(store.retain(catalog(2)))
    store.close()
  })

  it('answers undefined for a digest it never retained', () => {
    const store = openModelCaptureStore(file())
    expect(store.read('f'.repeat(64))).toBeUndefined()
    store.close()
  })

  it('refuses stored content that no longer matches its digest', () => {
    const path = file()
    const store = openModelCaptureStore(path)
    const digest = store.retain(catalog())
    const direct = new DatabaseSync(path)
    direct.prepare('UPDATE captures SET body = replace(body, \'"output":2\', \'"output":9\') WHERE digest = ?').run(digest)
    direct.close()
    expect(store.read(digest)).toBeUndefined()
    store.close()
  })

  it('refuses to retain different content under a digest that already holds something else', () => {
    const path = file()
    const store = openModelCaptureStore(path)
    const wanted = catalog(2)
    const direct = new DatabaseSync(path)
    direct.prepare('INSERT INTO captures(digest, body) VALUES(?, ?)').run(wanted.digest, '[]')
    direct.close()
    expect(() => store.retain(wanted)).toThrow(ModelCaptureConflict)
    store.close()
  })
})

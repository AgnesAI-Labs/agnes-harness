import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NullContractStore } from '@agnes/ai'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { afterEach, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const fixture = fileURLToPath(new URL('../../../ai/fixtures/contract/', import.meta.url))
const id = 'agnes-model-contract@0'
const routes = [
  {
    route: 'gw',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [fakeModel({ id: 'm1', route: 'gw' })],
  },
]
const dirs: string[] = []
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-host-contract-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('loads configured disk artifacts before invoking a replacement provider', async () => {
  const dataDir = temp()
  let calls = 0
  const t = await createTestHost({
    dataDir,
    profileInputs: {
      user: {
        name: 'contract',
        provider: { package: '@agnes/ai', routes, contract: { dir: fixture, contractIds: [id] } },
      },
    },
    provider: (_profile, opts) => {
      calls++
      expect(opts.contractStore.prefixBytes(id)).toEqual(
        new Uint8Array(readFileSync(join(fixture, id, 'prefix.bin'))),
      )
      expect(opts.contractStore.tools(id).map((t) => t.name)).toEqual(['shell', 'edit'])
      return new ScriptedProvider({ scripts: [] })
    },
  })
  try {
    expect(calls).toBe(1)
  } finally {
    await t.host.close()
  }
})
it('omitting contract passes the actual null store default', async () => {
  let calls = 0
  const t = await createTestHost({
    dataDir: temp(),
    provider: (_p, opts) => {
      calls++
      expect(opts.contractStore).toBeInstanceOf(NullContractStore)
      expect(opts.contractStore.prefixHash(null)).toBeNull()
      return new ScriptedProvider({ scripts: [] })
    },
  })
  try {
    expect(calls).toBe(1)
  } finally {
    await t.host.close()
  }
})
it('tampering refuses assembly before any replacement factory and recovers after exact restoration', async () => {
  const dir = temp()
  cpSync(fixture, dir, { recursive: true })
  const file = join(dir, id, 'prefix.bin')
  const original = readFileSync(file)
  writeFileSync(file, 'tampered-artifact')
  let calls = 0
  const options = {
    dataDir: temp(),
    profileInputs: {
      user: {
        name: 'contract',
        provider: { package: '@agnes/ai', routes, contract: { dir, contractIds: [id] } },
      },
    },
    provider: () => {
      calls++
      return new ScriptedProvider({ scripts: [] })
    },
  }
  await expect(createTestHost(options)).rejects.toMatchObject({
    code: 'E_SEAM_INIT',
    message: expect.stringContaining('CONTRACT_MISMATCH'),
  })
  expect(calls).toBe(0)
  writeFileSync(file, original)
  const t = await createTestHost(options)
  try {
    expect(calls).toBe(1)
  } finally {
    await t.host.close()
  }
})

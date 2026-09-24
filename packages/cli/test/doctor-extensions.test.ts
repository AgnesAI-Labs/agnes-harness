import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Host } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { expect, it } from 'vitest'
import { doctorExtensions } from '../src/commands/doctor-extensions.js'

it('reports a failed extension by error code only, without leaking its error text', async () => {
  const failed = {
    id: '@agnes/code',
    package: '@agnes/code',
    loaded: false,
    trust: 'builtin',
    version: '?',
    error: { code: 'E_EXT_LOAD', message: 'manifest id fixture/mismatch does not match the package' },
  } as unknown as ReturnType<Host['extensions']>[number]
  const result = await doctorExtensions({ extensions: () => [failed] })
  expect(result.status).toBe('warn')
  const rows = result.detail.map((line) => JSON.parse(line))
  expect(rows).toEqual([
    {
      id: '@agnes/code',
      package: '@agnes/code',
      loaded: false,
      trust: 'builtin',
      version: '?',
      errorCode: 'E_EXT_LOAD',
    },
  ])
  expect(JSON.stringify(rows)).not.toContain('fixture/mismatch')
})
it('describes an actual empty Host extension list explicitly', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-cli-ext-empty-'))
  const { host } = await createTestHost({ dataDir })
  try {
    expect(await doctorExtensions(host)).toEqual({
      name: 'extensions',
      status: 'ok',
      detail: ['no extensions declared'],
    })
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
it('does not expose an exception from the extension status source', async () => {
  expect(
    await doctorExtensions({
      extensions: () => {
        throw new Error('PRIVATE-EXTENSION-MARKER')
      },
    }),
  ).toEqual({ name: 'extensions', status: 'fail', detail: ['extension diagnostic failed'] })
})

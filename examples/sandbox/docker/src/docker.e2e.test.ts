import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxUnavailable } from '@agnes/extension-api'
import { afterAll, describe, expect, it } from 'vitest'
import { workspaceRoundtrip } from '../test/workspace-roundtrip.js'
import { createDockerSandboxProvider } from './index.js'

const dir = mkdtempSync(join(tmpdir(), 'agnes-sandbox-docker-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('docker sandbox provider', () => {
  it('reports a missing docker CLI instead of running on the host', async () => {
    const provider = createDockerSandboxProvider(async () => ({
      network: false,
      fsWrite: [],
      platform: ['linux'],
      available: false,
      unavailableReason: 'docker CLI is not available',
    }))
    const instance = await provider.create({})
    expect(instance.capabilities).toMatchObject({
      available: false,
      network: false,
      fsWrite: [],
      unavailableReason: 'docker CLI is not available',
    })
    await expect(instance.exec({ argv: ['echo', 'ok'], cwd: dir })).rejects.toEqual(
      expect.objectContaining({ code: 'SANDBOX_UNAVAILABLE' }),
    )
    expect(sandboxUnavailable('docker CLI is not available').code).toBe('SANDBOX_UNAVAILABLE')
  })

  it('round-trips the client workspace through a Linux container or explicitly refuses an unavailable backend', async () => {
    const provider = createDockerSandboxProvider()
    const instance = await provider.create({ workspaceRoot: dir })
    try {
      // Linux CI owns the real container success gate; refusal cannot replace that acceptance.
      if (process.env.CI && process.platform === 'linux')
        expect(instance.capabilities.available, instance.capabilities.unavailableReason).toBe(true)
      if (!instance.capabilities.available) {
        expect(instance.capabilities).toMatchObject({ network: false, fsWrite: [] })
        expect(instance.capabilities.unavailableReason).toBeTruthy()
        await expect(instance.exec({ argv: ['echo', 'ok'], cwd: dir })).rejects.toMatchObject({
          code: 'SANDBOX_UNAVAILABLE',
          message: `SANDBOX_UNAVAILABLE: ${instance.capabilities.unavailableReason}`,
        })
        return
      }
      const roundtrip = workspaceRoundtrip(dir)
      const result = await instance.exec(roundtrip.request)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('ok')
      expect(readFileSync(roundtrip.output, 'utf8')).toBe(roundtrip.nonce)
    } finally {
      await instance.dispose()
    }
  }, 180_000)
})

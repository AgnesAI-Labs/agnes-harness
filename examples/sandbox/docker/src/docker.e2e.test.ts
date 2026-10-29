import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxUnavailable } from '@agnes/extension-api'
import { afterAll, describe, expect, it } from 'vitest'
import { createDockerSandboxProvider, probeDocker } from './index.js'

const docker = await probeDocker()
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

  it.skipIf(!docker.available)(
    'runs echo in a container when docker is present',
    async () => {
      const provider = createDockerSandboxProvider()
      const instance = await provider.create({ workspaceRoot: dir })
      try {
        const result = await instance.exec({
          argv: ['echo', 'ok'],
          cwd: dir,
          fsWrite: [{ path: dir }],
          limits: { timeoutMs: 180_000 },
        })
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe('ok')
      } finally {
        await instance.dispose()
      }
    },
    180_000,
  )
})

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_LIMITS } from '../src/config.js'
import { startProductionSupervisor, startSupervisor } from '../src/supervisor/supervisor.js'

it.skipIf(process.platform === 'win32')(
  'rejects both direct startup entry points before storage or owner allocation',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ags-preflight-'))
    const options = {
      config: {
        profileName: 'local-dev',
        dataDir: dir,
        socketPath: '/tmp/unused-client.sock',
        workersSocketPath: `/tmp/${'中'.repeat(40)}.sock`,
        limits: DEFAULT_LIMITS,
      },
    } as Parameters<typeof startSupervisor>[0]
    const createStorage = vi.fn()
    try {
      await expect(startSupervisor(options)).rejects.toThrow(/worker.*UTF-8/)
      await expect(startProductionSupervisor(options, { createStorage })).rejects.toThrow(/worker.*UTF-8/)
      expect(createStorage).not.toHaveBeenCalled()
      expect(existsSync(join(dir, 'daemon'))).toBe(false)
      expect(existsSync(join(dir, 'sessions.db'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

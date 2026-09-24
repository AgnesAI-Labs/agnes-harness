import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const entry = new URL('../src/bin.ts', import.meta.url)

describe('agnesd control commands through the real bin', () => {
  it('prints status JSON and uses a nonzero exit when no daemon is running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-bin-status-'))
    try {
      let failure: { code?: unknown; stdout?: unknown } | undefined
      try {
        await execute(
          process.execPath,
          ['--import', 'tsx', fileURLToPath(entry), 'status', '--profile', 'default', '--data-dir', dir],
          { encoding: 'utf8' },
        )
      } catch (error) {
        failure = error as { code?: unknown; stdout?: unknown }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stdout).toBe('{"running":false}\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('makes stop idempotent when no owner exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-bin-stop-'))
    try {
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(entry), 'stop', '--profile', 'default', '--data-dir', dir],
        { encoding: 'utf8' },
      )
      expect(result.stdout).toBe('not-running\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

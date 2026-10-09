import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.runIf(process.platform === 'win32')('uses the hosting Node image when its executable is renamed', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-renamed-node-'))
  try {
    const executable = join(root, 'agnes-test-host.exe')
    copyFileSync(process.execPath, executable)
    const native = createRequire(import.meta.url).resolve('@agnes/system-node/native')
    const result = spawnSync(
      executable,
      [
        '-e',
        `
      const api=require(${JSON.stringify(native)});
      if(!api.processStartTime(process.pid))throw Error('missing process identity');
      if(!api.environmentNamesEqual('Path','PATH'))throw Error('incorrect ordinal comparison');
      process.stdout.write('native-host-ok');
    `,
      ],
      { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('native-host-ok')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

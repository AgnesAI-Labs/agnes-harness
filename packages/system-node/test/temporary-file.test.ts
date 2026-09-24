import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPrivateDirectorySync,
  hasPrivateDaclSync,
  windowsCreateTemporaryPrivateFileSync,
} from '../src/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-temporary-'))
  roots.push(root)
  const privateDir = join(root, 'private')
  createPrivateDirectorySync(privateDir)
  return privateDir
}
describe.skipIf(process.platform !== 'win32')('Windows private temporary files', () => {
  it('allows shared reads, denies other writers, and deletes on owner close', () => {
    const file = join(directory(), 'script.txt')
    const fd = windowsCreateTemporaryPrivateFileSync(file)
    try {
      writeFileSync(fd, '中文 private script')
      expect(hasPrivateDaclSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe('中文 private script')
      expect(() => writeFileSync(file, 'replace')).toThrow()
      expect(() => windowsCreateTemporaryPrivateFileSync(file)).toThrow()
    } finally {
      closeSync(fd)
    }
    expect(existsSync(file)).toBe(false)
  })
  it('deletes when the owning process is forcibly terminated without running cleanup', async () => {
    const file = join(directory(), 'script.txt')
    const native = createRequire(import.meta.url).resolve('@agnes/system-node/native')
    const owner = spawn(
      process.execPath,
      [
        '-e',
        `
      const native=require(${JSON.stringify(native)});
      const fd=native.createTemporaryPrivateFile(${JSON.stringify(file)});
      require('node:fs').writeFileSync(fd,'private script');
      process.stdout.write('ready'); setInterval(()=>{},1000);
    `,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    try {
      await once(owner.stdout, 'data')
      expect(readFileSync(file, 'utf8')).toBe('private script')
      owner.kill('SIGKILL')
      await once(owner, 'exit')
      expect(existsSync(file)).toBe(false)
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill('SIGKILL')
        await once(owner, 'exit')
      }
    }
  })
})

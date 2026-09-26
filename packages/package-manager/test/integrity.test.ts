import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fetchSource, hashDirectory, parseSource } from '../src/index.js'

const race = vi.hoisted(() => ({ replace: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
      fs.copyFileSync(...args)
      if (race.replace) fs.writeFileSync(join(dirname(String(args[0])), 'index.js'), 'changed after copy')
    },
  }
})
const roots: string[] = []
afterEach(() => {
  race.replace = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-integrity-'))
  roots.push(root)
  return root
}
it('detects real source replacement after copy instead of trusting a preflight digest', async () => {
  const root = temp(),
    source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'acme/race', version: '1.0.0' }))
  writeFileSync(join(source, 'index.js'), 'initial')
  race.replace = true
  await expect(
    fetchSource(parseSource('file:./source'), join(root, 'target'), { cwd: root }),
  ).rejects.toMatchObject({ detail: { reason: 'source-changed' } })
})
it.runIf(process.platform !== 'win32')('rejects a real FIFO without opening it for hashing', () => {
  const root = temp()
  execFileSync('mkfifo', [join(root, 'fifo')])
  expect(() => hashDirectory(root)).toThrow('special entry')
})

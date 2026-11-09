import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RefinementRegistry } from '../src/refinement-registry.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const writer = (dataDir: string, tag: string, count: number) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        here('./fixtures/registry-writer.mjs'),
        pathToFileURL(here('../src/refinement-registry.ts')).href,
        dataDir,
        '/work/shared',
        tag,
        String(count),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve(Number(out)) : reject(new Error(`writer exited ${code}`)),
    )
  })

describe('RefinementRegistry across processes', () => {
  it('two processes updating one workspace never lose an acknowledged write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-registry-procs-'))
    dirs.push(dir)
    const per = 150
    const saved = await Promise.all([writer(dir, 'a', per), writer(dir, 'b', per)])
    expect(saved).toEqual([per, per])
    const stored = new RefinementRegistry(dir, '/work/shared', Date.now).read().revocations
    expect(stored).toHaveLength(saved[0] + saved[1])
    expect(new Set(stored.map((r) => `${r.sessionKey}/${r.entryId}`)).size).toBe(per * 2)
  }, 60_000)
})

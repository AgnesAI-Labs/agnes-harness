import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RefinementRegistry } from '../src/refinement-registry.js'

const dirs: string[] = []
afterEach(async () => {
  await cleanupWriters()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const children = new Map<ChildProcess, Promise<void>>()
const startWriter = (args: string[]) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  children.set(child, closed)
  const saved = new Promise<number>((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve(Number(out)) : reject(new Error(`writer exited ${code}`)),
    )
  })
  return { child, closed, saved }
}
const writer = (dataDir: string, tag: string, count: number) =>
  startWriter([
    here('./fixtures/registry-writer.mjs'),
    pathToFileURL(here('../src/refinement-registry.ts')).href,
    dataDir,
    '/work/shared',
    tag,
    String(count),
  ]).saved

const collectWriters = async (writers: Promise<number>[]) => {
  const results = await Promise.allSettled(writers)
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
}
const cleanupWriters = async () => {
  for (const child of children.keys()) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(children.values())
  children.clear()
}

describe('RefinementRegistry across processes', () => {
  it('two processes updating one workspace never lose an acknowledged write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-registry-procs-'))
    dirs.push(dir)
    const per = 150
    const saved = await collectWriters([writer(dir, 'a', per), writer(dir, 'b', per)])
    expect(saved).toEqual([per, per])
    const stored = new RefinementRegistry(dir, '/work/shared', Date.now).read().revocations
    expect(stored).toHaveLength(saved.reduce((total, count) => total + count, 0))
    expect(new Set(stored.map((r) => `${r.sessionKey}/${r.entryId}`)).size).toBe(per * 2)
  }, 60_000)

  it('waits for the other writer to close before reporting a failed writer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-registry-failure-'))
    dirs.push(dir)
    const ready = join(dir, 'ready'),
      release = join(dir, 'release'),
      completed = join(dir, 'completed')
    const survivor = startWriter([
      '-e',
      `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        fs.writeFileSync(${JSON.stringify(completed)}, 'completed');
        process.stdout.write('1');
      }, 10);
    `,
    ])
    const failure = startWriter([
      '-e',
      `
      const fs = require('node:fs');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(ready)})) return;
        clearInterval(timer);
        process.exit(7);
      }, 10);
    `,
    ])
    let settled = false
    const outcome = collectWriters([failure.saved, survivor.saved]).then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    try {
      await failure.closed
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(survivor.child.exitCode).toBe(null)
      writeFileSync(release, 'release')
      expect(await outcome).toEqual(new Error('writer exited 7'))
      expect(existsSync(completed)).toBe(true)
      expect(survivor.child.exitCode).toBe(0)
      expect(await survivor.saved).toBe(1)
    } finally {
      for (const { child, closed } of [failure, survivor]) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closed
      }
      await outcome
    }
  })

  it('closes every owned writer before removing its temporary directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-registry-cleanup-'))
    dirs.push(dir)
    const ready = join(dir, 'ready')
    const running = startWriter([
      '-e',
      `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setInterval(() => fs.writeFileSync(${JSON.stringify(join(dir, 'active'))}, 'active'), 10);
    `,
    ])
    const result = running.saved.catch((error: unknown) => error)
    let closed = false
    void running.closed.then(() => {
      closed = true
    })
    try {
      await expect.poll(() => existsSync(ready)).toBe(true)
      expect(running.child.exitCode).toBe(null)
      await cleanupWriters()
      expect(closed).toBe(true)
      rmSync(dir, { recursive: true, force: true })
      expect(existsSync(dir)).toBe(false)
      expect(await result).toBeInstanceOf(Error)
    } finally {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGKILL')
      await running.closed
      await result
    }
  })
})

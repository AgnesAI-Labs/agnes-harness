import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  type DetachedChild,
  releaseDetachedProcess,
  spawnDetachedProcess,
} from '../../src/adapters/detached-process.js'

function exit(child: DetachedChild): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Detached exit event missing')), 5000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve([code, signal])
    })
  })
}
it('observes a short-lived process after the caller can install listeners', async () => {
  const child = spawnDetachedProcess(process.execPath, ['-e', 'process.exit(7)'], {
    cwd: process.cwd(),
    env: process.env,
  })
  try {
    expect(await exit(child)).toEqual([7, null])
    expect(child.exitCode).toBe(7)
  } finally {
    releaseDetachedProcess(child)
  }
})
it('preserves handle-bound termination and the exit event', async () => {
  const child = spawnDetachedProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
    cwd: process.cwd(),
    env: process.env,
  })
  const exited = exit(child)
  try {
    expect(child.kill('SIGTERM')).toBe(true)
    expect(await exited).toEqual([null, 'SIGTERM'])
    expect(child.kill('SIGKILL')).toBe(false)
  } finally {
    releaseDetachedProcess(child)
  }
})
it('releases the watcher without stopping the independent child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-watch-close-'))
  const child = spawnDetachedProcess(
    process.execPath,
    ['-e', "setTimeout(()=>require('node:fs').writeFileSync('done','alive'),200)"],
    { cwd: root, env: process.env },
  )
  child.unref()
  releaseDetachedProcess(child)
  releaseDetachedProcess(child)
  try {
    await expect.poll(() => readFile(join(root, 'done'), 'utf8'), { timeout: 5000 }).toBe('alive')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

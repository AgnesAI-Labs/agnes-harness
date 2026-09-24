import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { beginRuntimeDirectory } from '../tools/runtime-directory.js'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))
let root: string

it('retains old output and refuses to steal a lock after the builder is killed', async () => {
  const output = join(root, 'runtime')
  const ready = join(root, 'ready')
  await fs.mkdir(output)
  await fs.writeFile(join(output, 'old'), 'old')
  const moduleUrl = new URL('../tools/runtime-directory.ts', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import {beginRuntimeDirectory} from ${JSON.stringify(moduleUrl)};
    import {writeFile} from 'node:fs/promises';
    const transaction=await beginRuntimeDirectory(${JSON.stringify(output)});
    await writeFile(transaction.staging+'/new','new');
    await writeFile(${JSON.stringify(ready)},'ready');
    setInterval(()=>{},1000);
  `,
    ],
    { windowsHide: true, stdio: 'ignore' },
  )
  try {
    await expect
      .poll(
        async () => {
          try {
            return await fs.readFile(ready, 'utf8')
          } catch {
            return undefined
          }
        },
        { timeout: 5000 },
      )
      .toBe('ready')
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    expect(await fs.readFile(join(output, 'old'), 'utf8')).toBe('old')
    await expect(beginRuntimeDirectory(output)).rejects.toThrow('locked')
    expect((await fs.readdir(root)).some((path) => path.startsWith('runtime.tmp-'))).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
})
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'agnes-runtime-commit-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

it('replaces old bytes and prevents another builder from taking the same output', async () => {
  const output = join(root, 'runtime')
  await fs.mkdir(output)
  await fs.writeFile(join(output, 'old'), 'old')
  const transaction = await beginRuntimeDirectory(output)
  await expect(beginRuntimeDirectory(output)).rejects.toThrow('locked')
  await fs.writeFile(join(transaction.staging, 'new'), 'new')
  await transaction.commit()
  await transaction.dispose()
  expect(await fs.readdir(output)).toEqual(['new'])
  expect(await fs.readdir(root)).toEqual(['runtime'])
})

it('retains the backup and lock if restoring the old output also fails', async () => {
  const output = join(root, 'runtime')
  await fs.mkdir(output)
  await fs.writeFile(join(output, 'old'), 'old')
  const transaction = await beginRuntimeDirectory(output)
  const rename = fs.rename
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from) === transaction.staging || basename(String(from)) === 'previous')
      throw Object.assign(new Error('injected failure'), { code: 'ENOSPC' })
    return rename(from, to)
  })
  await expect(transaction.commit()).rejects.toThrow('previous output retained')
  await transaction.dispose()
  expect(await fs.readFile(join(`${output}.build-lock`, 'previous', 'old'), 'utf8')).toBe('old')
  await expect(beginRuntimeDirectory(output)).rejects.toThrow('locked')
})

it('refuses a file output and leaves it unchanged', async () => {
  const output = join(root, 'runtime')
  await fs.writeFile(output, 'not a directory')
  const transaction = await beginRuntimeDirectory(output)
  await expect(transaction.commit()).rejects.toThrow('real directory')
  await transaction.dispose()
  expect(await fs.readFile(output, 'utf8')).toBe('not a directory')
})

it.runIf(process.platform === 'win32')(
  'retries a transient Windows sharing error before publishing',
  async () => {
    const output = join(root, 'runtime')
    const transaction = await beginRuntimeDirectory(output)
    await fs.writeFile(join(transaction.staging, 'new'), 'new')
    const rename = fs.rename
    let attempts = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (++attempts < 3) throw Object.assign(new Error('sharing'), { code: 'EPERM' })
      return rename(from, to)
    })
    await transaction.commit()
    await transaction.dispose()
    expect(attempts).toBe(3)
    expect(await fs.readFile(join(output, 'new'), 'utf8')).toBe('new')
  },
)

it('reports a committed output separately from old-backup cleanup failure', async () => {
  const output = join(root, 'runtime')
  await fs.mkdir(output)
  await fs.writeFile(join(output, 'old'), 'old')
  const transaction = await beginRuntimeDirectory(output)
  await fs.writeFile(join(transaction.staging, 'new'), 'new')
  const remove = fs.rm
  vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
    if (basename(String(path)) === 'previous') throw new Error('injected cleanup failure')
    return remove(path, options)
  })
  await expect(transaction.commit()).rejects.toThrow('output committed')
  await transaction.dispose()
  expect(await fs.readFile(join(output, 'new'), 'utf8')).toBe('new')
  expect(await fs.readFile(join(`${output}.build-lock`, 'previous', 'old'), 'utf8')).toBe('old')
})

it.runIf(process.platform === 'win32')(
  'preserves the running executable and recovery lock after publishing a replacement',
  async () => {
    const output = join(root, 'runtime')
    await fs.mkdir(output)
    await fs.copyFile(process.execPath, join(output, 'node.exe'))
    await fs.writeFile(join(output, 'marker'), 'old')
    const child = spawn(
      join(output, 'node.exe'),
      ['-e', 'process.on("disconnect",()=>process.exit());process.send("ready");setInterval(()=>{},1000)'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    )
    try {
      expect(await once(child, 'message', { signal: AbortSignal.timeout(5000) })).toEqual([
        'ready',
        undefined,
      ])
      const transaction = await beginRuntimeDirectory(output)
      try {
        await fs.writeFile(join(transaction.staging, 'marker'), 'new')
        await expect(transaction.commit()).rejects.toThrow('output committed, but old-output cleanup failed')
      } finally {
        await transaction.dispose()
      }
      expect(await fs.readFile(join(output, 'marker'), 'utf8')).toBe('new')
      const backup = join(`${output}.build-lock`, 'previous', 'node.exe')
      const digest = async (path: string) =>
        createHash('sha256')
          .update(await fs.readFile(path))
          .digest('hex')
      expect(await digest(backup)).toBe(await digest(process.execPath))
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      await expect(beginRuntimeDirectory(output)).rejects.toThrow('locked')
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
  },
  15000,
)

it.runIf(process.platform === 'win32')(
  'bounds persistent sharing failures and restores old output',
  async () => {
    const output = join(root, 'runtime')
    await fs.mkdir(output)
    await fs.writeFile(join(output, 'old'), 'old')
    const transaction = await beginRuntimeDirectory(output)
    const rename = fs.rename
    let attempts = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === transaction.staging) {
        attempts++
        throw Object.assign(new Error('held'), { code: 'EPERM' })
      }
      return rename(from, to)
    })
    await expect(transaction.commit()).rejects.toThrow('held')
    await transaction.dispose()
    expect(attempts).toBeGreaterThan(1)
    expect(await fs.readFile(join(output, 'old'), 'utf8')).toBe('old')
    expect(await fs.readdir(root)).toEqual(['runtime'])
  },
)

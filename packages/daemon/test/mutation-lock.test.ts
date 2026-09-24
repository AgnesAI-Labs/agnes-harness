import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { acquireDaemonMutationLock } from '../src/supervisor/mutation-lock.js'

const roots: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-mutation-lock-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('excludes concurrent connections and releases without replacing the database inode', () => {
  const dir = tmp(),
    first = acquireDaemonMutationLock(dir)
  const file = join(dir, 'daemon', 'mutation-lock.db'),
    inode = statSync(file).ino
  try {
    expect(() => acquireDaemonMutationLock(dir)).toThrow('lock is held')
  } finally {
    first.release()
  }
  first.release()
  const second = acquireDaemonMutationLock(dir)
  try {
    expect(statSync(file).ino).toBe(inode)
  } finally {
    second.release()
  }
})
it('blocks a real second process until release and recovers after the holder exits', async () => {
  const dir = tmp()
  const moduleUrl = new URL('../src/supervisor/mutation-lock.ts', import.meta.url).href
  // Node's native TypeScript execution does not remap a relative `.js` specifier to its sibling
  // `.ts` file, and mutation-lock.ts pulls in system-node's index barrel, which re-exports one of
  // its own submodules by a `.js` specifier. A resolve hook that falls back to `.ts` when the
  // `.js` sibling is missing keeps this test independent of that gap; it must be registered before
  // the module graph is linked, so the actual import happens dynamically, after registration.
  const loaderSource = `export async function resolve(s, c, next) {
  try { return await next(s, c) } catch (e) {
    if (s.endsWith('.js') && c.parentURL) return await next(s.slice(0, -3) + '.ts', c)
    throw e
  }
}`
  const loaderUrl = `data:text/javascript,${encodeURIComponent(loaderSource)}`
  const script = [
    `import { register } from 'node:module'`,
    `register(${JSON.stringify(loaderUrl)}, import.meta.url)`,
    `const { acquireDaemonMutationLock } = await import(${JSON.stringify(moduleUrl)})`,
    `const held = acquireDaemonMutationLock(process.argv[1])`,
    `process.on('SIGTERM', () => { held.release(); process.exit(0) })`,
    `process.stdout.write('held\\n')`,
    `setInterval(() => {}, 1000)`,
  ].join('; ')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => {
        throw new Error('holder exited before acquiring lock')
      }),
    ])
    expect(String(ready[0])).toContain('held')
    expect(() => acquireDaemonMutationLock(dir)).toThrow('lock is held')
    child.kill('SIGKILL')
    await exited
    const next = acquireDaemonMutationLock(dir)
    next.release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
})
it('refuses a replaced database link without touching its target', () => {
  const dir = tmp(),
    held = acquireDaemonMutationLock(dir)
  held.release()
  const file = join(dir, 'daemon', 'mutation-lock.db'),
    target = join(dir, 'private')
  rmSync(file)
  writeFileSync(target, 'PRIVATE-MARKER')
  // Windows file symlinks require elevation or Developer Mode. A hard link exercises the native
  // single-link identity guard without weakening this attack test on ordinary Windows machines.
  if (process.platform === 'win32') linkSync(target, file)
  else symlinkSync(target, file)
  expect(() => acquireDaemonMutationLock(dir)).toThrow('daemon mutation lock unavailable')
  expect(readFileSync(target, 'utf8')).toBe('PRIVATE-MARKER')
})

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, expect, it } from 'vitest'
import { readSkillCache, writeSkillCache } from '../src/skill-lkg-storage.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-cache-permissions-'))
  roots.push(root)
  const directory = join(root, 'cache')
  return { directory, path: join(directory, 'state.json') }
}
function grantPublicRead(path: string) {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot unavailable')
  execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [path, '/grant', '*S-1-1-0:R'], {
    windowsHide: true,
    stdio: 'pipe',
  })
}
it('saves and replaces UTF-8 contents without leaving temporary files', async () => {
  const { directory, path } = await paths()
  await writeSkillCache(path, 'first')
  expect(await readSkillCache(path)).toBe('first')
  await writeSkillCache(path, '中文缓存')
  expect(await readSkillCache(path)).toBe('中文缓存')
  expect(await readdir(directory)).toEqual(['state.json'])
})
it.runIf(process.platform === 'win32')(
  'rejects an existing broad directory without changing its ACL or writing contents',
  async () => {
    const { directory, path } = await paths()
    await mkdir(directory)
    grantPublicRead(directory)
    expect(hasPrivateDaclSync(directory)).toBe(false)
    await expect(writeSkillCache(path, 'private body')).rejects.toMatchObject({ code: 'EACCES' })
    expect(hasPrivateDaclSync(directory)).toBe(false)
    expect(await readdir(directory)).toEqual([])
  },
)
it.runIf(process.platform === 'win32')('rejects a cache whose file permissions were widened', async () => {
  const { directory, path } = await paths()
  await writeSkillCache(path, 'private body')
  expect(hasPrivateDaclSync(directory)).toBe(true)
  expect(hasPrivateDaclSync(path)).toBe(true)
  grantPublicRead(path)
  await expect(readSkillCache(path)).rejects.toMatchObject({ code: 'EACCES' })
  expect(await readFile(path, 'utf8')).toBe('private body')
})
it.runIf(process.platform === 'win32')(
  'rejects a cache after its directory permissions were widened',
  async () => {
    const { directory, path } = await paths()
    await writeSkillCache(path, 'private body')
    grantPublicRead(directory)
    await expect(readSkillCache(path)).rejects.toMatchObject({ code: 'EACCES' })
  },
)

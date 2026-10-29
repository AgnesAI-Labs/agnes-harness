import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyJevLoopNotice } from '../tools/build-local.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('JevLoop attribution packaging', () => {
  it('copies the loop-jev NOTICE unchanged into THIRD-PARTY-NOTICES', async () => {
    const out = await mkdtemp(join(tmpdir(), 'agnes-jev-notice-'))
    dirs.push(out)
    await copyJevLoopNotice(out)
    const source = await readFile(new URL('../../loop-jev/NOTICE', import.meta.url), 'utf8')
    const packaged = await readFile(join(out, 'THIRD-PARTY-NOTICES', 'jevloop.txt'), 'utf8')
    expect(packaged).toBe(source)
    expect(packaged).toContain('commit 61e7994')
    expect(packaged).toContain('No affiliation or\nendorsement is implied.')
  })
  it('lists the notice in both npm file sets', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      files: string[]
    }
    expect(pkg.files).toContain('dist/local/THIRD-PARTY-NOTICES/jevloop.txt')
    expect(pkg.files).toContain('dist/sea/THIRD-PARTY-NOTICES/jevloop.txt')
  })
})

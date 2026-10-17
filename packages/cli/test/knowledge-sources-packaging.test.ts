import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { checkPackagedClientModules } from '../tools/client-module-check.js'
import { copyKnowledgeSources } from '../tools/knowledge-sources.js'

it('ships the optional connector backend, both READMEs and the complete shared-component client payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-knowledge-payload-'))
  try {
    const destination = join(root, 'relocated')
    await mkdir(destination)
    await copyKnowledgeSources(new URL('../../knowledge-sources', import.meta.url).pathname, destination)
    const pkg = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'))
    expect(pkg.exports).toBe('./index.mjs')
    expect(pkg.agnes.plugins[0]).toMatchObject({ default: false, id: 'ext:agnes/knowledge-sources' })
    expect(await readdir(destination)).toEqual(
      expect.arrayContaining(['LICENSE', 'README.md', 'README.zh-CN.md', 'index.mjs', 'client']),
    )
    expect(await readdir(destination)).not.toEqual(expect.arrayContaining(['src', 'test', 'node_modules']))
    expect(await readFile(join(destination, 'index.mjs'), 'utf8')).toContain('knowledge_query')
    await checkPackagedClientModules(destination)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

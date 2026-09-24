import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveLaunchResources } from './resources.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function packagedDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agnes-launch-resources-'))
  temporary.push(directory)
  await mkdir(join(directory, 'web'))
  await Promise.all([
    writeFile(join(directory, 'agnes.mjs'), ''),
    writeFile(join(directory, 'daemon.mjs'), ''),
    writeFile(join(directory, 'worker.mjs'), ''),
    ...[
      'index.html',
      'admin.html',
      'resources.html',
      'app.js',
      'admin.js',
      'resources.js',
      'style.css',
      'brand-mark.png',
    ].map((asset) => writeFile(join(directory, 'web', asset), '')),
  ])
  return directory
}

describe('local launch resources', () => {
  it('uses composed backend entries for Web development and fails before launch if they are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-web-development-'))
    temporary.push(root)
    const cli = join(root, 'cli')
    const web = join(root, 'web', 'dist', 'web')
    const backend = join(cli, 'dist', 'local')
    await mkdir(web, { recursive: true })
    await mkdir(join(cli, 'launch'), { recursive: true })
    await Promise.all([
      ...[
        'index.html',
        'admin.html',
        'resources.html',
        'app.js',
        'admin.js',
        'resources.js',
        'style.css',
        'brand-mark.png',
      ].map((asset) => writeFile(join(web, asset), '')),
      writeFile(join(cli, 'launch', 'daemon-entry.ts'), ''),
      writeFile(join(cli, 'launch', 'worker-entry.ts'), ''),
    ])
    const entry = pathToFileURL(join(cli, 'tools', 'web-local.ts')).href
    expect(() => resolveLaunchResources(entry, { allowSource: true })).toThrow(/build:local/)
    await mkdir(backend, { recursive: true })
    await writeFile(join(backend, 'daemon.mjs'), '')
    expect(() => resolveLaunchResources(entry, { allowSource: true })).toThrow(/build:local/)
    await writeFile(join(backend, 'worker.mjs'), '')
    expect(resolveLaunchResources(entry, { allowSource: true })).toMatchObject({
      mode: 'source',
      daemonEntry: join(backend, 'daemon.mjs'),
      workerEntry: join(backend, 'worker.mjs'),
      webRoot: web,
    })
  })

  it('finds a packaged output after its directory is renamed', async () => {
    const directory = await packagedDirectory()
    const resources = resolveLaunchResources(pathToFileURL(join(directory, 'agnes.mjs')).href)
    expect(resources).toMatchObject({ mode: 'package', root: directory })
    expect(resources.daemonEntry).toBe(join(directory, 'daemon.mjs'))
    expect(resources.workerEntry).toBe(join(directory, 'worker.mjs'))
    expect(resources.webRoot).toBe(join(directory, 'web'))
    await rm(join(directory, 'web', 'resources.html'))
    expect(() => resolveLaunchResources(pathToFileURL(join(directory, 'agnes.mjs')).href)).toThrow(
      /resources are unavailable/,
    )
  })

  it('fails production lookup when sibling resources are incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agnes-launch-resources-missing-'))
    temporary.push(directory)
    await writeFile(join(directory, 'agnes.mjs'), '')
    expect(() => resolveLaunchResources(pathToFileURL(join(directory, 'agnes.mjs')).href)).toThrow(
      /resources are unavailable/,
    )
  })

  it('refuses a packaged Web output that omits the plugin administration assets', async () => {
    const directory = await packagedDirectory()
    await rm(join(directory, 'web', 'admin.js'))

    expect(() => resolveLaunchResources(pathToFileURL(join(directory, 'agnes.mjs')).href)).toThrow(
      /resources are unavailable/,
    )
  })

  it('refuses a packaged Web output that omits the brand mark bitmap', async () => {
    // 缺这张图不会报错，只会让侧栏品牌位与过程行头像静默变空（CSS mask 取不到图），
    // 所以它必须在"必备资源"里被前置拦下，而不是等到页面上看出来。
    const directory = await packagedDirectory()
    await rm(join(directory, 'web', 'brand-mark.png'))

    expect(() => resolveLaunchResources(pathToFileURL(join(directory, 'agnes.mjs')).href)).toThrow(
      /resources are unavailable/,
    )
  })
})

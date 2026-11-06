import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ciRequest, prepareLocal, runQuality, verifyPreparation, writePreparation } from './ci.mjs'

const identity = {
  sha: 'checkout-sha',
  runId: '123',
  sourceHash: 'current-source',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
}
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agh-ci-web-'))
  temporary.push(root)
  const local = join(root, 'local')
  const proof = join(root, 'proof')
  await mkdir(local)
  await writeFile(join(local, 'agnes.mjs'), 'export {}')
  await writeFile(
    join(local, '.e2e-build.json'),
    JSON.stringify({
      hash: identity.sourceHash,
      node: identity.node,
      platform: identity.platform,
      arch: identity.arch,
    }),
  )
  await writePreparation(proof, identity)
  return { local, proof }
}

it('requires explicit preparation and refuses retry overrides even when listing', () => {
  expect(ciRequest(['quality'])).toEqual({ command: 'quality', args: [] })
  expect(ciRequest(['prepare', '--prepared-local', 'proof'])).toEqual({
    command: 'prepare',
    directory: 'proof',
    args: [],
  })
  expect(ciRequest(['test', '--prepared-local', 'proof', '--list', '--grep', 'OAuth'])).toEqual({
    command: 'test',
    directory: 'proof',
    args: ['--list', '--grep', 'OAuth'],
  })
  for (const args of [
    ['test', '--list'],
    ['test', '--prepared-local'],
    ['test', '--prepared-local', '--list'],
    ['test', '--prepared-local', 'proof', '--reuse-build'],
    ['quality', '--list'],
    ['test', '--prepared-local', 'proof', '--list', '--retries=1'],
    ['test', '--prepared-local', 'proof', '--list', '--retries', '0'],
  ])
    expect(() => ciRequest(args)).toThrow()
})

it('accepts current proof and stamp, but refuses stale or missing preparation without rebuilding', async () => {
  const { local, proof } = await fixture()
  await expect(verifyPreparation(proof, identity, local)).resolves.toBeUndefined()
  for (const key of ['sha', 'runId', 'sourceHash', 'node', 'platform', 'arch']) {
    await expect(verifyPreparation(proof, { ...identity, [key]: 'wrong' }, local)).rejects.toThrow(
      /preparation/,
    )
  }
  await writeFile(join(local, '.e2e-build.json'), JSON.stringify({ ...identity, hash: 'stale' }))
  await expect(verifyPreparation(proof, identity, local)).rejects.toThrow(/stamp/)
  expect(JSON.parse(await readFile(join(local, '.e2e-build.json'), 'utf8')).hash).toBe('stale')
  await rm(join(local, '.e2e-build.json'))
  await expect(verifyPreparation(proof, identity, local)).rejects.toThrow(/stamp/)
  await rm(proof, { recursive: true })
  await expect(verifyPreparation(proof, identity, local)).rejects.toThrow(/preparation/)
})

it('requires complete local output and a nonempty run identity', async () => {
  const { local, proof } = await fixture()
  await rm(join(local, 'agnes.mjs'))
  await expect(verifyPreparation(proof, identity, local)).rejects.toThrow(/agnes.mjs/)
  await expect(writePreparation(proof, { ...identity, runId: '' })).rejects.toThrow(/runId/)
})

it('runs only i18n then browser components and propagates the first quality failure', async () => {
  const commands: string[][] = []
  const run = async (_command: string, args: string[]) => {
    commands.push(args)
    return 0
  }
  await expect(runQuality(run)).resolves.toBe(0)
  expect(commands).toHaveLength(2)
  expect(commands[0].slice(-5)).toEqual([
    'exec',
    'vitest',
    'run',
    'tools/e2e-web/i18n.test.ts',
    '--maxWorkers=1',
  ])
  expect(commands[1].slice(-3)).toEqual([
    'test',
    '--config',
    'tools/e2e-web/playwright.components.config.mjs',
  ])
  const failed: string[][] = []
  await expect(
    runQuality(async (_command: string, args: string[]) => {
      failed.push(args)
      return 7
    }),
  ).resolves.toBe(7)
  expect(failed).toHaveLength(1)
})

it('invalidates previous proof before a failed explicit build and propagates its status', async () => {
  const { proof } = await fixture()
  const commands: string[][] = []
  await expect(
    prepareLocal(proof, identity, async (_command: string, args: string[]) => {
      commands.push(args)
      return 9
    }),
  ).resolves.toBe(9)
  expect(commands).toHaveLength(1)
  expect(commands[0].slice(-3)).toEqual(['--filter', '@agnes/cli', 'build:local'])
  await expect(readFile(join(proof, 'preparation.json'))).rejects.toThrow(/ENOENT/)
})

it('refuses malformed JSON objects and platform-stale stamps with actionable errors', async () => {
  const { proof, local } = await fixture()
  await writeFile(join(proof, 'preparation.json'), 'null')
  await expect(verifyPreparation(proof, identity, local)).rejects.toThrow(/preparation/)
  await writePreparation(proof, identity)
  await writeFile(join(local, '.e2e-build.json'), 'null')
  await expect(verifyPreparation(proof, identity, local)).rejects.toThrow(/stamp/)
  for (const key of ['node', 'platform', 'arch']) {
    await writeFile(
      join(local, '.e2e-build.json'),
      JSON.stringify({
        hash: identity.sourceHash,
        node: identity.node,
        platform: identity.platform,
        arch: identity.arch,
        [key]: 'wrong',
      }),
    )
    await expect(verifyPreparation(proof, identity, local)).rejects.toThrow(/stamp/)
  }
})

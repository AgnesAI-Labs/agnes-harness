import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readConfigurationProfileInputs } from '../src/profile/inputs.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('keeps all profile layers and merges configuration into user adapters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-profile-inputs-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  const profileDir = join(root, 'profiles', 'local-dev')
  await Promise.all([mkdir(profileDir, { recursive: true }), mkdir(join(cwd, '.agh'), { recursive: true })])
  await writeFile(
    join(profileDir, 'profile.yaml'),
    [
      'name: local-dev',
      'adapters:',
      '  storage: sqlite',
      '  fs: workspace-fs',
      '  exec: restricted-exec',
      'provider:',
      '  package: user-provider',
      '',
    ].join('\n'),
  )
  await writeFile(join(cwd, '.agh', 'profile.local.yaml'), 'limits:\n  test.limit: 1\n')

  const inputs = await readConfigurationProfileInputs({
    home: root,
    cwd,
    profile: 'local-dev',
    agnesVersion: '0.0.0',
    configuration: {
      adapters: { secrets: { kind: 'file', path: join(root, 'secrets') } },
      provider: { package: '@agnes/ai' },
    },
  })

  expect(inputs.user).toMatchObject({
    name: 'local-dev',
    provider: { package: '@agnes/ai' },
    adapters: {
      storage: 'sqlite',
      fs: 'workspace-fs',
      exec: 'restricted-exec',
      secrets: { kind: 'file', path: join(root, 'secrets') },
    },
  })
  expect(inputs.local).toEqual({ limits: { 'test.limit': 1 } })
})

// `.agnes` was the workspace directory's name before the `.agh` rename. A local override left there
// is not read: nothing falls back to the old name, because that directory may belong to another product.
it('reads the local override from <cwd>/.agh and never from <cwd>/.agnes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-profile-inputs-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await Promise.all([
    mkdir(join(cwd, '.agh'), { recursive: true }),
    mkdir(join(cwd, '.agnes'), { recursive: true }),
  ])
  await writeFile(join(cwd, '.agh', 'profile.local.yaml'), 'limits:\n  test.limit: 1\n')
  await writeFile(join(cwd, '.agnes', 'profile.local.yaml'), 'limits:\n  test.limit: 2\n')
  const read = () =>
    readConfigurationProfileInputs({ home: root, cwd, profile: 'local-dev', agnesVersion: '0.0.0' })

  expect((await read()).local).toEqual({ limits: { 'test.limit': 1 } })
  await rm(join(cwd, '.agh', 'profile.local.yaml'))
  expect((await read()).local).toBeUndefined()
})

it('keeps malformed YAML errors available for the CLI wrapper to translate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-profile-inputs-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  await mkdir(profileDir, { recursive: true })
  const file = join(profileDir, 'profile.yaml')
  await writeFile(file, 'name: [unterminated\n')

  await expect(
    readConfigurationProfileInputs({
      home: root,
      cwd: root,
      profile: 'local-dev',
      agnesVersion: '0.0.0',
    }),
  ).rejects.toMatchObject({ message: `${file} is not valid yaml`, cause: expect.any(Error) })
})

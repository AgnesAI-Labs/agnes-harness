import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { npmCommand, verificationEnvironment } from './check.mjs'

it('packs through the selected npm entry with literal paths and lifecycle scripts disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-npm-中文 & %NO_EXPANSION% '))
  const output = join(root, 'output space')
  try {
    await mkdir(output)
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'agh-npm-fixture',
        version: '1.0.0',
        scripts: { prepack: "node -e \"require('fs').writeFileSync('executed','unsafe')\"" },
      }),
    )
    const npm = npmCommand()
    const { stdout } = await promisify(execFile)(
      npm.bin,
      [...npm.args, 'pack', '--json', '--ignore-scripts', '--pack-destination', output],
      {
        cwd: root,
        windowsHide: true,
        timeout: 30_000,
        env: verificationEnvironment({
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          npm_config_cache: join(root, 'cache'),
          npm_config_userconfig: join(root, 'user.npmrc'),
          npm_config_globalconfig: join(root, 'global.npmrc'),
          npm_config_offline: 'true',
        }),
      },
    )
    const [packed] = JSON.parse(stdout) as { filename: string }[]
    expect(packed?.filename).toBe('agh-npm-fixture-1.0.0.tgz')
    expect(existsSync(join(output, 'agh-npm-fixture-1.0.0.tgz'))).toBe(true)
    expect(existsSync(join(root, 'executed'))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 45_000)

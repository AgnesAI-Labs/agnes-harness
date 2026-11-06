import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { checkToolchain, npmCommand, pnpmInvocation, verificationEnvironment } from './check.mjs'

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

// action-setup exports its node_modules/.bin as PNPM_HOME; exec does not set npm_execpath.
it('uses the provisioned pnpm JavaScript entry without a second Corepack installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-pnpm-中文 & %LITERAL% '))
  const home = join(directory, 'setup-pnpm', 'node_modules', '.bin')
  const cli = join(home, '..', 'pnpm', 'bin', 'pnpm.cjs')
  const packageManager = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    .packageManager as string
  try {
    mkdirSync(home, { recursive: true })
    mkdirSync(dirname(cli), { recursive: true })
    // The package-manager boundary is controlled, but its test-runner probe is a real Node child.
    writeFileSync(
      cli,
      `const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log(${JSON.stringify(packageManager.slice('pnpm@'.length))});
else if (args[0] === 'exec' && args[1] === 'node') {
  const result = spawnSync(process.execPath, args.slice(2), { env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else process.exitCode = 98;
`,
    )
    const env = verificationEnvironment({
      ...process.env,
      npm_execpath: '',
      PNPM_HOME: home,
      COREPACK_HOME: join(directory, 'empty-corepack'),
      COREPACK_ENABLE_NETWORK: '0',
    })
    expect(checkToolchain(env)).toMatchObject({
      packageManager,
      runtime: { version: process.version, execPath: process.execPath },
    })
    expect(pnpmInvocation(env)).toEqual([cli])
    const lifecycle = join(directory, 'pnpm.cjs')
    writeFileSync(lifecycle, "console.log('0.0.0')")
    expect(pnpmInvocation({ ...env, npm_execpath: lifecycle })).toEqual([lifecycle])
    expect(pnpmInvocation({ ...env, PNPM_HOME: join(directory, 'absent') })).toEqual(
      pnpmInvocation({ ...env, PNPM_HOME: '' }),
    )
    writeFileSync(cli, "console.log('0.0.0')")
    expect(() => checkToolchain(env)).toThrow(`expected ${packageManager}, actual pnpm@0.0.0`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([
  {
    name: 'nonzero exit',
    source: "console.error('PRIVATE_REGISTRY_SENTINEL'); process.exit(42)",
    fact: '"status":42',
  },
  {
    name: 'output buffer failure',
    source: "process.stdout.write('PRIVATE_REGISTRY_SENTINEL'.repeat(100000))",
    fact: '"code":"ENOBUFS"',
  },
])(
  'reports safe subprocess facts for $name without disclosing package-manager output',
  ({ source, fact }) => {
    const directory = mkdtempSync(join(tmpdir(), 'agh-toolchain-failure-'))
    const cli = join(directory, 'pnpm.cjs')
    try {
      writeFileSync(cli, source)
      let failure: unknown
      try {
        checkToolchain({ ...process.env, npm_execpath: cli })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain(fact)
      expect(message).toMatch(/"elapsedMs":\d+/)
      expect(message).toContain('--version')
      expect(message).not.toContain('PRIVATE_REGISTRY_SENTINEL')
      expect(failure).not.toHaveProperty('cause')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { buildCommit } from './web-parity.mjs'

it('builds the selected historical tree in isolation and removes scratch after success or failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-parity-中文 & space '))
  const repository = join(root, 'repository')
  const output = join(root, 'output')
  const observe = join(root, 'observed.json')
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'),
  }
  const git = (...args: string[]) =>
    promisify(execFile)('git', ['-c', 'core.hooksPath=', ...args], { cwd: repository, env })
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL, '')
    await mkdir(join(repository, 'packages/cli/tools'), { recursive: true })
    await writeFile(
      join(repository, 'package.json'),
      '{"name":"parity-fixture","type":"module","private":true}',
    )
    await writeFile(
      join(repository, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
    )
    await writeFile(join(repository, '.npmrc'), 'offline=true\n')
    await writeFile(join(repository, 'version.txt'), 'historical')
    await writeFile(
      join(repository, 'packages/cli/tools/build-local.ts'),
      `import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const version=readFileSync('version.txt','utf8');
writeFileSync(${JSON.stringify(observe)},JSON.stringify({cwd:process.cwd(),version}));
process.stdout.write('x'.repeat(256*1024));
if(version==='refuse')throw Error('fixture build refused');
const output=process.argv[process.argv.indexOf('--output-dir')+1];
mkdirSync(output,{recursive:true});writeFileSync(join(output,'version.txt'),version);
`,
    )
    await git('init')
    await git('add', '.')
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    )
    const sha = (await git('rev-parse', 'HEAD')).stdout.trim()
    await writeFile(join(repository, 'version.txt'), 'working tree')
    await buildCommit(sha, output, repository)
    expect(await readFile(join(output, 'version.txt'), 'utf8')).toBe('historical')
    const success = JSON.parse(await readFile(observe, 'utf8')) as { cwd: string }
    expect(existsSync(dirname(success.cwd))).toBe(false)
    expect(await readFile(join(repository, 'version.txt'), 'utf8')).toBe('working tree')
    await writeFile(join(repository, 'version.txt'), 'refuse')
    await git('add', 'version.txt')
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'failure',
    )
    await expect(buildCommit('HEAD', join(root, 'failed-output'), repository)).rejects.toThrow(
      'fixture build refused',
    )
    const failed = JSON.parse(await readFile(observe, 'utf8')) as { cwd: string }
    expect(existsSync(dirname(failed.cwd))).toBe(false)
    expect(existsSync(join(root, 'failed-output'))).toBe(false)
    expect(await readFile(join(output, 'version.txt'), 'utf8')).toBe('historical')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const previousRef = 'e32bf11a919e78f025ddc006f90c2ed102b0a9b0'
export const ledgerRef = 'bae7c42794dbb975330983d19020c68033895ad9'

// Keep compiler output in scratch logs; never inherit the operator's home or credentials.
export async function run(file, args, options = {}) {
  return execute(file, args, { timeout: 600_000, maxBuffer: 16 * 1024 * 1024, ...options })
}

export async function distributions(
  repository,
  scratch,
  ref = process.env.AGH_UPGRADE_PREVIOUS_REF ?? previousRef,
  currentDistribution,
) {
  const sha = (
    await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repository })
  ).stdout.trim()
  const oldSource = join(scratch, 'previous-source')
  await mkdir(oldSource)
  const archive = join(scratch, 'previous.tar')
  await run('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd: repository })
  await run('tar', ['-xf', archive, '-C', oldSource])
  const env = { PATH: process.env.PATH, HOME: join(scratch, 'build-home'), CI: 'true' }
  await mkdir(env.HOME, { mode: 0o700 })
  const install = await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: oldSource,
    env,
  })
  await writeFile(join(scratch, 'previous-install.log'), install.stdout + install.stderr)
  const build = async (source, name, supplied) => {
    if (supplied) {
      if (!isAbsolute(supplied)) throw new Error('Upgrade distributions must be absolute directories')
      return resolve(supplied)
    }
    const destination = join(scratch, name)
    const result = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        'packages/cli/tools/build-local.ts',
        '--output-dir',
        destination,
        '--version',
        source === oldSource ? '1.0.0' : '1.1.0',
      ],
      { cwd: source, env },
    )
    await writeFile(join(scratch, `${name}-build.log`), result.stdout + result.stderr)
    return destination
  }
  const previous = await build(
    oldSource,
    'previous',
    ref === ledgerRef ? process.env.AGH_UPGRADE_LEDGER_DIST : process.env.AGH_UPGRADE_PREVIOUS_DIST,
  )
  const current = await build(
    repository,
    'current',
    currentDistribution ?? process.env.AGH_UPGRADE_CURRENT_DIST,
  )
  console.info(`Upgrade distributions: ${sha} -> current working tree`)
  return { previous, current, oldSource, sha }
}

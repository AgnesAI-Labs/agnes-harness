import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { canReuse, recordBuild, sourceHash } from './build-cache.mjs'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const reuse = args.includes('--reuse-build')
if (args.some((arg) => /^--retries(?:=|$)/.test(arg)))
  throw new Error('The merge gate has zero retries. Use --repeat-each to expose flaky specs.')
const output = resolve(process.env.AGH_WEB_TEST_OUTPUT ?? '.agnes-tmp/e2e-web')
await mkdir(output, { recursive: true })
const run = (command, argv, env = process.env) =>
  new Promise((done, reject) => {
    const child = spawn(command, argv, { stdio: 'inherit', env })
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    child.once('error', reject)
    child.once('exit', (code) => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      done(code ?? 1)
    })
  })
if (!args.includes('--list')) {
  // Dependencies and Chromium are provisioned separately; this command downloads neither.
  const { chromium } = require('@playwright/test')
  await access(process.env.AGH_CHROMIUM_PATH ?? chromium.executablePath())
  const hash = await sourceHash()
  if (reuse && (await canReuse(hash))) await access('packages/cli/dist/local/agnes.mjs')
  else {
    if (reuse) console.log('Build inputs changed or the build has no E2E stamp; rebuilding build:local.')
    const status = await run('pnpm', ['--filter', '@agnes/cli', 'build:local'])
    if (status !== 0) process.exit(status)
    await recordBuild(hash)
  }
  const types = await run('pnpm', ['exec', 'tsc', '-b', 'tools/e2e-web'])
  if (types !== 0) process.exit(types)
  const quality = await run('pnpm', ['exec', 'vitest', 'run', 'tools/e2e-web/i18n.test.ts', '--maxWorkers=1'])
  if (quality !== 0) process.exit(quality)
  const components = await run(process.execPath, [
    require.resolve('@playwright/test/cli'),
    'test',
    '--config',
    'tools/e2e-web/playwright.components.config.mjs',
  ])
  if (components !== 0) process.exit(components)
}
process.exitCode = await run(
  process.execPath,
  [
    require.resolve('@playwright/test/cli'),
    'test',
    '--config',
    'tools/e2e-web/playwright.config.mjs',
    ...args.filter((arg) => arg !== '--reuse-build'),
  ],
  { ...process.env, AGH_WEB_TEST_OUTPUT: output },
)

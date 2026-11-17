import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpmInvocation } from '../toolchain/check.mjs'
import { recordBuild, sourceHash } from './build-cache.mjs'

const require = createRequire(import.meta.url)
const local = 'packages/cli/dist/local'
const fields = ['sha', 'runId', 'sourceHash', 'node', 'platform', 'arch']
const proofFile = (directory) => join(directory, 'preparation.json')

export function ciRequest(argv) {
  if (argv.some((arg) => /^--retries(?:=|$)/.test(arg)))
    throw new Error('The merge gate has zero retries. Use --repeat-each to expose flaky specs.')
  const [command, ...args] = argv
  if (command === 'quality' && args.length === 0) return { command, args }
  if (!['prepare', 'test'].includes(command)) throw new Error('Expected quality, prepare or test')
  if (args[0] !== '--prepared-local' || !args[1] || args[1].startsWith('-'))
    throw new Error('Explicit --prepared-local <directory> is required')
  const forwarded = args.slice(2)
  if (
    (command === 'prepare' && forwarded.length) ||
    forwarded.some((arg) => /^--(?:reuse-build|prepared-local)(?:=|$)/.test(arg))
  )
    throw new Error('Invalid CI preparation arguments')
  return { command, directory: args[1], args: forwarded }
}

function validateIdentity(identity) {
  for (const field of fields)
    if (typeof identity[field] !== 'string' || !identity[field])
      throw new Error(`CI preparation requires ${field}`)
}

export async function writePreparation(directory, identity) {
  validateIdentity(identity)
  await mkdir(directory, { recursive: true })
  await writeFile(proofFile(directory), JSON.stringify({ schema: 1, ...identity }))
}

export async function verifyPreparation(directory, identity, localDirectory = local) {
  validateIdentity(identity)
  let proof
  try {
    proof = JSON.parse(await readFile(proofFile(directory), 'utf8'))
  } catch {
    throw new Error('Missing or invalid CI local preparation proof; run the explicit prepare command')
  }
  if (proof?.schema !== 1 || fields.some((field) => proof[field] !== identity[field]))
    throw new Error('CI local preparation identity does not match this checkout and run')
  let stamp
  try {
    stamp = JSON.parse(await readFile(join(localDirectory, '.e2e-build.json'), 'utf8'))
  } catch {
    throw new Error('Missing or invalid local build stamp; run the explicit prepare command')
  }
  if (
    stamp?.hash !== identity.sourceHash ||
    ['node', 'platform', 'arch'].some((field) => stamp[field] !== identity[field])
  )
    throw new Error('Stale local build stamp; run the explicit prepare command')
  if (!(await stat(join(localDirectory, 'agnes.mjs'))).isFile())
    throw new Error('Local agnes.mjs is not a file')
}

export const runCommand = (command, args, env = process.env) =>
  new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    const cleanup = () => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code) => {
      cleanup()
      done(code ?? 1)
    })
  })

export async function runQuality(run = runCommand) {
  const i18n = await run(process.execPath, [
    ...pnpmInvocation(),
    'exec',
    'vitest',
    'run',
    'tools/e2e-web/i18n.test.ts',
    '--maxWorkers=1',
  ])
  if (i18n !== 0) return i18n
  return run(process.execPath, [
    require.resolve('@playwright/test/cli'),
    'test',
    '--config',
    'tools/e2e-web/playwright.components.config.mjs',
  ])
}

export async function prepareLocal(directory, identity, run = runCommand) {
  validateIdentity(identity)
  // Invalidate any previous success before starting a build that may fail.
  await rm(proofFile(directory), { force: true })
  const started = performance.now()
  const status = await run(process.execPath, [...pnpmInvocation(), '--filter', '@agnes/cli', 'build:local'])
  console.log(`CI local build duration: ${Math.round(performance.now() - started)}ms`)
  if (status !== 0) return status
  if ((await sourceHash()) !== identity.sourceHash)
    throw new Error('Build inputs changed during local preparation')
  await recordBuild(identity.sourceHash)
  await writePreparation(directory, identity)
  return 0
}

async function currentIdentity() {
  return {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runId: process.env.GITHUB_RUN_ID ?? '',
    sourceHash: await sourceHash(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }
}

async function checkRegistration() {
  const { default: config } = await import('./playwright.config.mjs')
  for (const spec of [
    'human-controls.spec.ts',
    'references.spec.ts',
    'intelligent-ui.spec.ts',
    'question-surfaces.spec.ts',
  ]) {
    if (!config.testMatch.includes(spec)) throw new Error(`Missing Web regression spec: ${spec}`)
    await access(new URL(spec, import.meta.url))
  }
}

async function checkChromium() {
  const { chromium } = require('@playwright/test')
  await access(process.env.AGH_CHROMIUM_PATH ?? chromium.executablePath())
}

async function main() {
  const request = ciRequest(process.argv.slice(2))
  // Registration remains mandatory for every command, including filtered --list calls.
  await checkRegistration()
  if (request.command === 'quality') {
    await checkChromium()
    return runQuality()
  }
  const identity = await currentIdentity()
  validateIdentity(identity)
  if (request.command === 'prepare') {
    return prepareLocal(request.directory, identity)
  }
  await verifyPreparation(request.directory, identity)
  if (!request.args.includes('--list')) await checkChromium()
  const output = resolve(process.env.AGH_WEB_TEST_OUTPUT ?? '.agnes-tmp/e2e-web')
  await mkdir(output, { recursive: true })
  return runCommand(
    process.execPath,
    [
      require.resolve('@playwright/test/cli'),
      'test',
      '--config',
      'tools/e2e-web/playwright.config.mjs',
      ...request.args,
    ],
    { ...process.env, AGH_WEB_TEST_OUTPUT: output },
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

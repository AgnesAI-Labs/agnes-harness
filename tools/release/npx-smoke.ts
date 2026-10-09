#!/usr/bin/env -S node --import tsx
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { localRegistry } from './local-registry.js'
import { PUBLIC_PACKAGE_NAME, PUBLIC_PACKAGE_VERSION } from './npx-package.js'
import { guardTarball } from './packed-tarball.js'
import { releasePack } from './release-pack.js'
import { command, freePort, stopWeb, treeBytes, waitFor } from './smoke-support.js'

const repo = resolve(import.meta.dirname, '../..')
// The smoke owns a POSIX process group; Windows needs a separate process-tree shutdown contract.
if (process.platform === 'win32')
  // guards-allow-platform: fail before starting an unverified process tree.
  throw new Error('Local-registry smoke requires macOS or Linux; Windows smoke is not implemented')
const args = process.argv.slice(2)
const options = new Map<string, string>()
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index]
  const value = args[index + 1]
  if (!flag || !['--tarball', '--report'].includes(flag) || !value || !isAbsolute(value) || options.has(flag))
    throw new Error('Expected --tarball and/or --report with absolute paths')
  options.set(flag, value)
}
const root = await mkdtemp(join(tmpdir(), 'agh-npx-smoke-'))
if (root === repo || root.startsWith(`${repo}${sep}`))
  throw new Error('Smoke home must be outside the checkout')
const home = join(root, 'home')
const aghHome = join(root, 'agh')
const work = join(root, 'work')
const cache = join(root, 'npm-cache')
const registryRoot = join(root, 'registry')
let registry: Awaited<ReturnType<typeof localRegistry>> | undefined
let web: ReturnType<typeof spawn> | undefined
let webLog = ''
let succeeded = false
let daemonStarted = false
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  USERPROFILE: home,
  AGH_HOME: aghHome,
  TMPDIR: root,
  TEMP: root,
  TMP: root,
  LANG: 'en_US.UTF-8',
  AGNES_PROFILE: 'local-dev',
  npm_config_cache: cache,
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_update_notifier: 'false',
  npm_config_ignore_scripts: 'true',
  npm_config_userconfig: join(root, 'user.npmrc'),
  npm_config_globalconfig: join(root, 'global.npmrc'),
  npm_config_fetch_retries: '0',
  npm_config_fetch_timeout: '15000',
}
const npm = 'npm'
const npx = 'npx'
const npxArgs = ['--yes', '--package', `${PUBLIC_PACKAGE_NAME}@${PUBLIC_PACKAGE_VERSION}`, 'agh']
const run = (args: string[], acceptedExitCodes?: readonly number[]) =>
  command(npx, [...npxArgs, ...args], work, env, acceptedExitCodes)

try {
  for (const path of [home, aghHome, work, registryRoot]) await mkdir(path, { mode: 0o700 })
  for (const file of ['user.npmrc', 'global.npmrc']) await writeFile(join(root, file), '')
  const prepared = options.get('--tarball') ?? (await releasePack(join(root, 'tarballs'))).tarball
  const tarball = join(root, 'candidate.tgz')
  await copyFile(prepared, tarball)
  if (options.has('--tarball')) {
    const triple = `${process.platform}-${process.arch}` // guards-allow-platform: supplied tarball must target this smoke host.
    await guardTarball(tarball, triple)
  }
  registry = await localRegistry(registryRoot, await readFile(tarball))
  env.npm_config_registry = registry.url
  // npm's client requires a credential even for this anonymous, local-only fixture.
  await writeFile(
    join(root, 'user.npmrc'),
    `//${new URL(registry.url).host}/:_authToken=local-smoke-fixture\n`,
  )
  // The registry address comes exclusively from the bound loopback listener, never arguments/config.
  await command(
    npm,
    [
      'publish',
      tarball,
      '--registry',
      registry.url,
      '--ignore-scripts',
      '--tag',
      'local-smoke',
      '--loglevel',
      'error',
    ],
    work,
    { ...env, npm_config_cache: join(root, 'publish-cache') },
  )
  process.stdout.write('Local publish complete; installing through npx with an empty cache\n')
  const installStart = performance.now()
  const version = await run(['--version'])
  const installAndVersionMs = performance.now() - installStart
  if (!version.includes(PUBLIC_PACKAGE_VERSION)) throw new Error(`Unexpected version: ${version}`)
  if (!registry.requests.includes('GET /candidate.tgz'))
    throw new Error('npx did not install through the local registry')
  const installs = await readdir(join(cache, '_npx'))
  const installId = installs[0]
  if (installs.length !== 1 || !installId) throw new Error('Expected exactly one isolated npx install')
  const modules = join(cache, '_npx', installId, 'node_modules')
  const installed = JSON.parse(await readFile(join(modules, PUBLIC_PACKAGE_NAME, 'package.json'), 'utf8'))
  if (installed.name !== PUBLIC_PACKAGE_NAME || installed.version !== PUBLIC_PACKAGE_VERSION)
    throw new Error('Installed manifest does not match the candidate')
  const installBytes = await treeBytes(modules)
  // A second phase proves every runtime invocation works without consulting even the registry.
  const installRegistryRequests = registry.requests.length
  env.npm_config_offline = 'true'
  const versionStart = performance.now()
  await run(['--version'])
  const cachedVersionMs = performance.now() - versionStart
  // Doctor intentionally does not initialize homes. Use the installed CLI's read-only status
  // command to create the supported fresh layout without starting a daemon or adding accounts.
  const before = JSON.parse(await run(['daemon', 'status', '--json'], [0, 1])) as { running?: boolean }
  if (before.running !== false) throw new Error('Unexpected daemon in the isolated home')
  await writeFile(
    join(aghHome, 'profiles', 'local-dev', 'profile.yaml'),
    'name: local-dev\ncomputerUse:\n  enabled: false\n',
    { mode: 0o600 },
  )
  process.stdout.write('npx version passed; checking fresh-home doctor\n')
  const doctorBefore = JSON.parse(await run(['doctor', '--json'])) as { name: string; status: string }[]
  if (!doctorBefore.length || doctorBefore.some((check) => check.status === 'fail'))
    throw new Error(`Fresh-home doctor failed: ${JSON.stringify(doctorBefore)}`)
  const capture = join(root, 'daemon-stderr-capture.mjs')
  await copyFile(join(repo, 'tools/release/daemon-stderr-capture.mjs'), capture)
  env.NODE_OPTIONS = `--import=${pathToFileURL(capture).href}`
  env.AGH_SMOKE_DAEMON_STDERR = join(root, 'daemon.stderr.log')
  const origin = `http://127.0.0.1:${await freePort()}`
  process.stdout.write('Starting Web without a browser or provider calls\n')
  const coldStart = performance.now()
  web = spawn(npx, [...npxArgs, 'web', '--port', new URL(origin).port], {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  web.on('error', (error) => {
    webLog += String(error)
  })
  web.stdout?.on('data', (chunk: Buffer) => {
    webLog += chunk.toString()
  })
  web.stderr?.on('data', (chunk: Buffer) => {
    webLog += chunk.toString()
  })
  daemonStarted = true
  await waitFor(
    'healthz',
    async () => {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2000) })
      return response.ok && ((await response.json()) as { status?: string }).status === 'ok'
    },
    web,
    () => webLog,
  )
  const coldStartMs = performance.now() - coldStart
  const html = await (await fetch(origin)).text()
  if (!html.includes('<html') || !html.includes('Agnes Harness')) throw new Error('Missing Web shell')
  const app = await fetch(`${origin}/app.js`)
  if (!app.ok || !(await app.text()).length) throw new Error('Missing prebuilt Web app')
  const doctorRunning = JSON.parse(await run(['doctor', '--json'])) as { name: string; status: string }[]
  if (!doctorRunning.length || doctorRunning.some((check) => check.status === 'fail'))
    throw new Error('Running doctor failed')
  await run(['daemon', 'stop'])
  daemonStarted = false
  await stopWeb(web)
  await waitFor('Web listener closed', async () => {
    try {
      await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })
      return false
    } catch {
      return true
    }
  })
  const status = JSON.parse(await run(['daemon', 'status', '--json'], [0, 1])) as { running?: boolean }
  if (status.running !== false) throw new Error('Daemon is still running after stop')
  if (registry.requests.length !== installRegistryRequests)
    throw new Error('Runtime contacted the registry in offline mode')
  const registryRequests = [...registry.requests]
  await registry.close()
  registry = undefined
  const result = {
    status: 'ok',
    package: `${PUBLIC_PACKAGE_NAME}@${PUBLIC_PACKAGE_VERSION}`,
    platform: `${process.platform}-${process.arch}`, // guards-allow-platform: smoke evidence identifies the tested host.
    node: process.version,
    npm: (await command(npm, ['--version'], work, env)).trim(),
    tarballBytes: (await readFile(tarball)).length,
    installBytes,
    installAndVersionMs: Math.round(installAndVersionMs),
    cachedVersionMs: Math.round(cachedVersionMs),
    coldStartMs: Math.round(coldStartMs),
    doctorBefore,
    doctorRunning,
    registryRequests,
    health: 'ok',
    webAssets: 'ok',
    shutdown: 'clean',
    registry: 'loopback-only, no uplinks',
  }
  const report = options.get('--report') ?? join(repo, 'dist/release/npx-smoke-result.json')
  await mkdir(dirname(report), { recursive: true })
  await writeFile(report, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  succeeded = true
} finally {
  const cleanupErrors: unknown[] = []
  // Try each cleanup even when another fails, and retain the exact isolated home for diagnosis.
  if (daemonStarted) await run(['daemon', 'stop']).catch((error: unknown) => cleanupErrors.push(error))
  if (web) await stopWeb(web).catch((error: unknown) => cleanupErrors.push(error))
  if (registry) await registry.close().catch((error: unknown) => cleanupErrors.push(error))
  if (succeeded && !cleanupErrors.length) await rm(root, { recursive: true, force: true })
  else process.stderr.write(`Smoke failed; isolated evidence retained at ${root}\n${webLog}\n`)
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Smoke cleanup failed')
}

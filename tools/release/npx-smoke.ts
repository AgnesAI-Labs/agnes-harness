#!/usr/bin/env -S node --import tsx
// Packs @agnes/harness, installs the tarball outside the repo, and checks agh web.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PUBLIC_PACKAGE_NAME, PUBLIC_PACKAGE_VERSION } from './npx-package.js'
import { packNpxPackage } from './pack-npx.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await mkdtemp(join(tmpdir(), 'agh-npx-smoke-'))
if (resolve(root).startsWith(repo)) throw new Error(`smoke directory must stay outside the repo: ${root}`)

const stage = join(root, 'stage')
const install = join(root, 'install')
const home = join(root, 'home')
const workspace = join(root, 'work')
const cache = join(root, 'npm-cache')
const daemonStderr = join(root, 'daemon.stderr.log')
let web: ReturnType<typeof spawn> | undefined
let webLog = ''
let succeeded = false
const agh = join(install, 'node_modules', '.bin', process.platform === 'win32' ? 'agh.cmd' : 'agh') // guards-allow-platform: npm executable suffix for the smoke platform

const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  USERPROFILE: home,
  AGH_HOME: home,
  TMPDIR: root,
  TEMP: root,
  TMP: root,
  LANG: process.env.LANG ?? 'C.UTF-8',
  AGNES_PROFILE: 'local-dev',
}

function npmEnv(): NodeJS.ProcessEnv {
  return {
    ...env,
    npm_config_cache: cache,
    npm_config_offline: 'true',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
  }
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  })
}

async function freePort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((done, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => done())
  })
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('no TCP port')
  const port = address.port
  await new Promise<void>((done) => listener.close(() => done()))
  return port
}

async function waitFor(label: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 90_000
  let last = 'not ready'
  while (Date.now() < deadline) {
    if (web && web.exitCode !== null) {
      const daemonLog = await readFile(daemonStderr, 'utf8').catch(() => '')
      throw new Error(`${label}: agh web exited ${web.exitCode}\n${webLog}\ndaemon stderr:\n${daemonLog}`)
    }
    try {
      if (await probe()) return
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  const daemonLog = await readFile(daemonStderr, 'utf8').catch(() => '')
  throw new Error(`${label}: timed out (${last})\n${webLog}\ndaemon stderr:\n${daemonLog}`)
}

try {
  process.stdout.write(`smoke root ${root}\n`)
  const packed = await packNpxPackage(stage)
  const packJson = execFileSync('npm', ['pack', '--json', '--pack-destination', root], {
    cwd: stage,
    env: npmEnv(),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const jsonStart = packJson.indexOf('[')
  const jsonEnd = packJson.lastIndexOf(']')
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error(`npm pack did not name a tarball: ${packJson}`)
  const [entry] = JSON.parse(packJson.slice(jsonStart, jsonEnd + 1)) as Array<{ filename?: string } | string>
  const filename = typeof entry === 'string' ? entry : entry?.filename
  if (!filename) throw new Error(`npm pack did not name a tarball: ${packJson}`)
  const tarball = join(root, filename)
  await mkdir(install, { recursive: true })
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(join(home, 'profiles', 'local-dev'), { recursive: true, mode: 0o700 })
  await mkdir(workspace, { recursive: true })
  await writeFile(
    join(home, 'profiles', 'local-dev', 'profile.yaml'),
    [
      'name: local-dev',
      'computerUse:',
      '  enabled: false',
      'policy:',
      '  capabilityCeiling: [tools, hooks, slots, events, resources, ui, services, network, network.publicRead, tools.invoke, artifacts, subagent]',
      '',
    ].join('\n'),
  )
  await writeFile(join(install, 'package.json'), '{"private":true}\n')
  execFileSync(
    'npm',
    ['install', '--offline', '--ignore-scripts', '--no-fund', '--no-audit', '--cache', cache, tarball],
    { cwd: install, env: npmEnv(), encoding: 'utf8', timeout: 120_000, stdio: 'inherit' },
  )
  const installed = JSON.parse(
    await readFile(join(install, 'node_modules', PUBLIC_PACKAGE_NAME, 'package.json'), 'utf8'),
  ) as { name?: string; dependencies?: unknown; version?: string }
  if (installed.name !== PUBLIC_PACKAGE_NAME) throw new Error(`installed name ${String(installed.name)}`)
  if (installed.version !== PUBLIC_PACKAGE_VERSION)
    throw new Error(`installed version ${String(installed.version)}`)
  if (installed.dependencies !== undefined) throw new Error('installed package must not declare dependencies')
  const versionText = run(agh, ['--version'], workspace)
  if (!versionText.includes(PUBLIC_PACKAGE_VERSION)) throw new Error(`version output: ${versionText}`)
  const help = run(agh, ['--help'], workspace)
  if (!help.includes('agh web') || !help.includes('agh start')) throw new Error(`help output: ${help}`)

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const capture = join(root, 'daemon-stderr-capture.mjs')
  await copyFile(join(repo, 'tools/release/daemon-stderr-capture.mjs'), capture)
  env.NODE_OPTIONS = `--import=${pathToFileURL(capture).href}`
  env.AGH_SMOKE_DAEMON_STDERR = daemonStderr
  web = spawn(agh, ['web', '--port', String(port)], {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  web.stdout?.on('data', (chunk: Buffer) => {
    webLog += chunk.toString()
  })
  web.stderr?.on('data', (chunk: Buffer) => {
    webLog += chunk.toString()
  })
  await waitFor('health', async () => {
    const response = await fetch(`${origin}/healthz`)
    if (!response.ok) return false
    const body = (await response.json()) as { status?: string }
    return body.status === 'ok'
  })
  await waitFor('web page', async () => {
    const response = await fetch(origin)
    if (!response.ok) return false
    const html = await response.text()
    return html.includes('<html') && html.includes('Agnes Harness')
  })
  process.stdout.write(`smoke ok ${packed.triple} ${origin}\n`)
  succeeded = true
} finally {
  if (existsSync(agh)) {
    try {
      run(agh, ['daemon', 'stop'], workspace)
    } catch {
      // The daemon may never have started.
    }
  }
  if (web && web.exitCode === null) {
    web.kill('SIGTERM')
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        web?.kill('SIGKILL')
        done()
      }, 10_000)
      web?.once('exit', () => {
        clearTimeout(timer)
        done()
      })
    })
  }
  if (succeeded) await rm(root, { recursive: true, force: true })
  else process.stderr.write(`smoke kept ${root}\n`)
}

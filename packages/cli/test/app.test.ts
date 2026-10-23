import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import * as daemon from '@agnes/daemon'
import { createConfigurationService } from '@agnes/host'
import * as sdk from '@agnes/sdk'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../src/bin.js'
import { FakeEndpoint } from './fake-endpoint.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('dispatches app clear before generic boot, ignores broken plugins, and only clears presentation using the configuration CAS', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'agh-app-clear-'))
  roots.push(scratch)
  const root = join(scratch, 'home')
  createPrivateDirectorySync(root)
  const config = createConfigurationService({ home: root, profile: 'local-dev' })
  await config.saveApplication({
    revision: 0,
    roleSelections: {
      deliverables: {
        packageId: 'broken-ui',
        clientId: 'ui',
        integrity: 'one',
        declarationDigest: 'a'.repeat(64),
        consentDigest: 'b'.repeat(64),
        bindingDigest: 'c'.repeat(64),
      },
    },
    selection: {
      packageId: 'broken',
      applicationId: 'broken',
      integrity: 'one',
      declarationDigest: 'a'.repeat(64),
      consentDigest: 'b'.repeat(64),
      bindingDigest: 'c'.repeat(64),
    },
  })
  await config.saveSessionDefaults({ revision: 1, defaults: { preset: 'standard' } })
  const directory = join(root, 'profiles', 'local-dev')
  const brokenLock = '{broken package lock'
  await writeFile(join(directory, 'agnes-lock.json'), brokenLock)
  await mkdir(join(root, '.agh', 'plugins'), { recursive: true })
  await writeFile(join(root, '.agh', 'plugins', 'throw.mjs'), 'throw new Error("must not import")')
  const stdout = new PassThrough(),
    stderr = new PassThrough()
  let output = '',
    errors = ''
  stdout.on('data', (bytes) => {
    output += String(bytes)
  })
  stderr.on('data', (bytes) => {
    errors += String(bytes)
  })
  const result = await main(['app', 'clear', '--json'], {
    cwd: root,
    env: { AGH_HOME: root, HOME: root },
    stdin: Readable.from([]),
    stdout,
    stderr,
    agnesVersion: '0.1.0',
  })
  expect({ result, output, errors }).toEqual({ result: 0, output: '{"cleared":true}\n', errors: '' })
  expect(await config.application()).toEqual({ revision: 3, selection: null })
  expect((await config.sessionDefaults()).defaults).toEqual({ preset: 'standard' })
  expect(await readFile(join(directory, 'agnes-lock.json'), 'utf8')).toBe(brokenLock)
})

it('clears an online application with platform-appropriate local transport admission', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'agh-app-online-'))
  roots.push(scratch)
  const root = join(scratch, 'home')
  createPrivateDirectorySync(root)
  const owner = {
    pid: 123,
    processStartId: 'synthetic',
    generation: 'generation',
    startedAt: '2026-10-18T00:00:00.000Z',
    socketPath: sep === '\\' ? '\\\\.\\pipe\\agh-app-recovery-fixture' : join(root, 'daemon.sock'),
  }
  vi.spyOn(daemon, 'daemonStatus').mockResolvedValue({ running: true, socketReachable: true, owner })
  const state = { revision: 7, selection: null, status: 'host', effective: null, assets: {}, candidates: [] }
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.1.0' } },
    }))
    .on('_agnes/v1/applications.get', () => state)
    .on('_agnes/v1/applications.clear', (params) => {
      expect(params).toMatchObject({ profile: 'local-dev', expectedRevision: 7 })
      state.revision++
      return state
    })
  const create = sdk.createClient
  vi.spyOn(sdk, 'createClient').mockImplementation((options) => {
    if (options.transport.kind !== 'unix') throw new Error('expected local transport')
    // Exercise the real SDK transport's admission before relaying the fixture in process.
    options.transportFactories?.unix?.(options.transport)
    return create({ ...options, transport: { kind: 'inproc', endpoint } })
  })
  const stdout = new PassThrough(),
    stderr = new PassThrough()
  let output = '',
    errors = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  stderr.on('data', (chunk) => {
    errors += String(chunk)
  })
  const result = await main(['app', 'clear', '--json'], {
    cwd: root,
    env: { AGH_HOME: root, HOME: root },
    stdin: Readable.from([]),
    stdout,
    stderr,
    agnesVersion: '0.1.0',
  })
  expect({ result, output, errors, revision: state.revision }).toEqual({
    result: 0,
    output: '{"cleared":true}\n',
    errors: '',
    revision: 8,
  })
})

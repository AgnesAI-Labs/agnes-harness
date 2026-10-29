import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as system from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeHome, initializeHomeLocked } from '../src/home-initialize.js'
import { homeLayout, inspectHome } from '../src/home-layout.js'

describe.runIf(process.platform === 'win32')('private Windows home initialization', () => {
  let parent: string
  const icacls = (...args: string[]) =>
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), args, {
      windowsHide: true,
    }).toString()
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-home-acl-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(parent, { recursive: true, force: true })
  })

  it('creates private objects under a broad parent without changing the parent, then restarts without ACL writes', async () => {
    icacls(parent, '/grant', '*S-1-1-0:(OI)(CI)R')
    const before = icacls(parent)
    const home = join(parent, 'home')
    const initial = await initializeHomeLocked(home)
    const objects = [
      home,
      join(home, 'home-layout.json'),
      join(parent, '.home.initialize.sqlite'),
      ...Object.values(initial.paths).filter((path) => path !== initial.paths.packages),
    ]
    const acls = objects.map((path) => icacls(path))
    for (const path of objects) expect(system.hasPrivateDaclSync(path), path).toBe(true)
    expect((await initializeHomeLocked(home)).instanceId).toBe(initial.instanceId)
    expect(objects.map((path) => icacls(path))).toEqual(acls)
    expect(icacls(parent)).toBe(before)
  })

  it('freezes known private inherited objects without replacing the old lock or rewriting memory and session bytes', async () => {
    const privateParent = join(parent, 'private')
    system.createPrivateDirectorySync(privateParent)
    const home = join(privateParent, 'home')
    mkdirSync(home)
    const marker = join(home, 'home-layout.json')
    const markerBytes = '{"version":1,"instanceId":"12345678-1234-1234-1234-123456789abc"}\n'
    writeFileSync(marker, markerBytes)
    const paths = homeLayout(home)
    for (const path of Object.values(paths).filter((path) => path !== paths.packages))
      mkdirSync(path, { recursive: true })
    const memory = join(home, 'memory.md'),
      session = join(paths.ledger, 'synthetic-session.txt')
    writeFileSync(memory, 'remember this synthetic preference')
    writeFileSync(session, 'synthetic historical session')
    const untouched = [memory, session].map((path) => ({ bytes: readFileSync(path), acl: icacls(path) }))
    const lock = join(privateParent, '.home.initialize.sqlite')
    const db = new DatabaseSync(lock)
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserved')")
    db.close()
    const inode = lstatSync(lock).ino,
      lockBytes = readFileSync(lock)
    expect(system.hasPrivateDaclSync(home)).toBe(false)
    expect(system.hasPrivateDaclSync(lock)).toBe(false)
    // Compare effective grants (only the inherited flag may change).
    const effectiveAcl = (path: string) => icacls(path).replaceAll('(I)', '')
    const objects = [
      home,
      marker,
      lock,
      ...new Set(Object.values(paths).filter((path) => path !== paths.packages)),
    ]
    const grants = objects.map(effectiveAcl)
    const owners = () =>
      execFileSync(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop';
          (ConvertFrom-Json $env:AGH_TEST_ACL_PATHS) | ForEach-Object {
            $acl = if ([IO.Directory]::Exists($_)) { [IO.Directory]::GetAccessControl($_) } else { [IO.File]::GetAccessControl($_) };
            $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
          } | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, env: { ...process.env, AGH_TEST_ACL_PATHS: JSON.stringify(objects) } },
      ).toString()
    const originalOwners = owners()
    expect(JSON.parse(originalOwners)).toHaveLength(objects.length)
    expect(JSON.parse(originalOwners).every((owner: string) => /^S-1-/.test(owner))).toBe(true)
    expect((await initializeHomeLocked(home)).instanceId).toBe('12345678-1234-1234-1234-123456789abc')
    expect(objects.map(effectiveAcl)).toEqual(grants)
    expect(owners()).toBe(originalOwners)
    for (const path of objects) expect(system.hasPrivateDaclSync(path), path).toBe(true)
    expect(lstatSync(lock).ino).toBe(inode)
    expect(readFileSync(lock)).toEqual(lockBytes)
    expect(readFileSync(marker, 'utf8')).toBe(markerBytes)
    expect([memory, session].map((path) => ({ bytes: readFileSync(path), acl: icacls(path) }))).toEqual(
      untouched,
    )
    await initializeHomeLocked(home)
    expect(lstatSync(lock).ino).toBe(inode)
  })

  it.each(['home', 'dataDir', 'child', 'marker', 'lock'])(
    'rejects broad %s before publishing new home state',
    async (kind) => {
      const home = join(parent, 'home'),
        dataDir = join(parent, 'external-data')
      let target: string
      if (kind === 'home' || kind === 'dataDir') {
        target = kind === 'home' ? home : dataDir
        system.createPrivateDirectorySync(target)
      } else if (kind === 'lock') {
        target = join(parent, '.home.initialize.sqlite')
        closeSync(system.createPrivateFileSync(target))
      } else {
        system.createPrivateDirectorySync(home)
        const marker = join(home, 'home-layout.json')
        const fd = system.createPrivateFileSync(marker)
        writeFileSync(fd, '{"version":1}')
        closeSync(fd)
        target = kind === 'marker' ? marker : join(home, 'tmp')
        if (kind === 'child') system.createPrivateDirectorySync(target)
      }
      icacls(target, '/grant', '*S-1-1-0:R')
      const acl = icacls(target),
        entries = existsSync(home) ? readdirSync(home) : undefined
      await expect(initializeHomeLocked(home, 'local-dev', { dataDir })).rejects.toThrow()
      expect(icacls(target)).toBe(acl)
      expect(existsSync(home) ? readdirSync(home) : undefined).toEqual(entries)
      expect(existsSync(join(home, 'profiles'))).toBe(false)
    },
  )

  it.each(['junction', 'hardlink', 'wrong-type'])(
    'refuses an initialization %s without touching its target',
    async (kind) => {
      const home = join(parent, 'home'),
        outside = join(parent, 'outside')
      system.createPrivateDirectorySync(outside)
      const source = join(outside, 'original')
      writeFileSync(source, '{"version":1}')
      if (kind === 'junction') symlinkSync(outside, home, 'junction')
      else {
        system.createPrivateDirectorySync(home)
        if (kind === 'hardlink') linkSync(source, join(home, 'home-layout.json'))
        else mkdirSync(join(home, 'home-layout.json'))
      }
      const before = readdirSync(outside),
        bytes = readFileSync(source)
      await expect(initializeHomeLocked(home)).rejects.toThrow('E_HOME_UNSAFE')
      expect(readdirSync(outside)).toEqual(before)
      expect(readFileSync(source)).toEqual(bytes)
    },
  )

  it('does not publish success when marker publication or native initialization fails', () => {
    const home = join(parent, 'home')
    const failure = new Error('injected publication failure')
    vi.spyOn(system, 'renameWriteThroughSync').mockImplementationOnce(() => {
      throw failure
    })
    expect(() => initializeHome(home)).toThrow(failure)
    expect(existsSync(join(home, 'home-layout.json'))).toBe(false)
    expect(readdirSync(home).some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(inspectHome(home).state).toBe('unsupported')
    expect(() => initializeHome(home)).toThrow('E_HOME_VERSION')
    const missing = join(parent, 'missing')
    vi.spyOn(system, 'createPrivateDirectorySync').mockImplementationOnce(() => {
      throw Object.assign(new Error('native unavailable'), { code: 'E_SYSTEM_NATIVE_UNAVAILABLE' })
    })
    expect(() => initializeHome(missing)).toThrow('native unavailable')
    expect(existsSync(missing)).toBe(false)
  })

  it.each(['private', 'broad'])(
    'revalidates a %s directory that appears during exclusive creation',
    (access) => {
      const home = join(parent, 'home')
      const create = system.createPrivateDirectorySync
      let raced = false
      vi.spyOn(system, 'createPrivateDirectorySync').mockImplementation((path) => {
        create(path)
        if (path === home && !raced) {
          raced = true
          if (access === 'broad') icacls(path, '/grant', '*S-1-1-0:R')
          throw Object.assign(new Error('concurrent creator'), { code: 'EEXIST' })
        }
      })
      if (access === 'private') {
        expect(initializeHome(home).state).toBe('current')
        expect(system.hasPrivateDaclSync(home)).toBe(true)
      } else {
        expect(() => initializeHome(home)).toThrow()
        expect(readdirSync(home)).toEqual([])
      }
      expect(raced).toBe(true)
    },
  )
})

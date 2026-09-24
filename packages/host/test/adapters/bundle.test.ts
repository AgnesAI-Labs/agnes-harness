import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  windowsProcessStartTimeSync,
} from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAdapters, sandboxHostServices, toSeamAdapters } from '../../src/adapters/index.js'
import { isHostError } from '../../src/errors.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { LockState, ResolveEnv } from '../../src/profile/types.js'
import { runTestNode } from './test-node.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin', enabled: true },
    '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin', enabled: true },
    '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin', enabled: true },
  },
}

describe('openAdapters', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it.runIf(process.platform === 'win32')(
    'requires a separate explicit Node runtime in a SEA host',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'agnes-sea-host-'))
      const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
      const sea = vi.spyOn(process.getBuiltinModule('node:sea'), 'isSea').mockReturnValue(true)
      try {
        for (const value of [undefined, '', 'node.exe', process.execPath]) {
          await expect(
            openAdapters(p, {
              dataDir: dir,
              workspaceRoot: dir,
              ...(value !== undefined ? { windowsNodeExecutable: value } : {}),
            }),
          ).rejects.toMatchObject({ code: 'E_DEP_MISSING' })
        }
        const runtime = join(dir, 'node.exe')
        copyFileSync(process.execPath, runtime)
        const bundled = await openAdapters(p, {
          dataDir: dir,
          workspaceRoot: dir,
          windowsNodeExecutable: runtime,
        })
        try {
          expect(await bundled.exec.run([runtime, '-p', 'process.execPath'], { cwd: dir })).toMatchObject({
            code: 0,
            stdout: `${runtime}\n`,
          })
        } finally {
          await bundled.close()
        }
      } finally {
        sea.mockRestore()
      }
      const b = await openAdapters(p, {
        dataDir: dir,
        workspaceRoot: dir,
        windowsNodeExecutable: join(dir, 'missing-node.exe'),
      })
      try {
        await expect(b.exec.run([process.execPath, '--version'], { cwd: dir })).rejects.toMatchObject({
          code: 'ENOENT',
        })
      } finally {
        await b.close()
      }
    },
  )

  it
    .runIf(process.platform === 'win32')
    .each(['5.1', ...(process.env.AGNES_TEST_PWSH ? [process.env.AGNES_TEST_PWSH] : [])])(
    'binds the selected PowerShell %s to execution and model metadata',
    async (request) => {
      dir = mkdtempSync(join(tmpdir(), 'agnes-shell-中文 space%-'))
      const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
      const b = await openAdapters(p, {
        dataDir: dir,
        workspaceRoot: dir,
        env: { AGNES_POWERSHELL: request },
      })
      try {
        expect(b.powerShell?.version).toMatch(request === '5.1' ? /^5\.1\./ : /^7\./)
        expect(toSeamAdapters(b, { owner: '@agnes/base' }).shell?.description).toContain(
          b.powerShell?.version,
        )
        const { services, revoke } = sandboxHostServices(b)
        revoke()
        const command = services.shellCommand?.('[Console]::Out.Write([Console]::In.ReadToEnd()); exit 2')
        if (!command) throw new Error('missing selected Shell command')
        const policy = b.fs.fence()
        b.bindFsPolicy(policy)
        const opts = {
          cwd: dir,
          stdin: '中文🙂',
          sandbox: { policyDigest: policy.digest, backend: 'none' as const },
        }
        await expect(b.policyExec(command, opts)).rejects.toThrow()
        b.declareExecGate({ backend: 'none', onUnavailable: 'allow' })
        expect(await b.policyExec(command, opts)).toMatchObject({ code: 2, stdout: '中文🙂', stderr: '' })
      } finally {
        await b.close()
      }
    },
  )

  it('opens sqlite under dataDir, probes platform, composes secrets, and closes cleanly', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, {
      dataDir: dir,
      workspaceRoot: dir,
      secretsDir: join(dir, 'secrets'),
    })
    expect(b.storage.file).toBe(join(dir, 'sessions.db'))
    expect(b.platform.capability('exec.kill-tree').reason).not.toBe('not probed')
    expect(b.secrets.kind).toBe('composite')
    const seams = toSeamAdapters(b, { owner: '@agnes/base' })
    expect(typeof seams.storage.table).toBe('function')
    expect(typeof seams.fs.realpath).toBe('function')
    expect(typeof seams.fs.mkdir).toBe('function')
    expect(seams.prompter).toBeUndefined()
    await b.close()
  })
  it('feeds a completed sandbox runtime probe back into platform capabilities', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
    expect(b.platform.capability('sandbox.l1').level).toBe('unavailable')
    b.reportSandboxBackend({
      name: 'bwrap',
      enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
    })
    const report = b.platform.os === 'win32' ? { level: 'unavailable' } : { level: 'full', value: 'bwrap' }
    expect(b.platform.capability('sandbox.l1')).toMatchObject(report)
    expect(b.platform.capability('sandbox.network')).toMatchObject(report)
    await b.close()
  })
  it('creates dataDir when it is not there yet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const nested = join(dir, 'a', 'b')
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: nested, workspaceRoot: dir })
    expect(existsSync(join(nested, 'sessions.db'))).toBe(true)
    await b.close()
  })
  it('projects the eight fs methods and the exec runner onto SeamAdapters', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
    const seams = toSeamAdapters(b, { owner: '@agnes/base' })
    for (const m of ['realpath', 'read', 'write', 'stat', 'list', 'mkdir', 'rm'])
      expect(typeof (seams.fs as unknown as Record<string, unknown>)[m], m).toBe('function')
    expect(typeof seams.exec).toBe('function')
    // The exec runner is policy-bound now: before a policy binds, or without an explicit degraded
    // allow, it refuses. Bind one and open the gate, as the assembly does after the seams fit.
    await expect(seams.exec(['node', '-e', 'process.stdout.write("unsafe")'], { cwd: dir })).rejects.toThrow(
      /SANDBOX_UNAVAILABLE/,
    )
    b.bindFsPolicy(b.fs.fence())
    b.declareExecGate({ backend: 'none', onUnavailable: 'allow' })
    const attested = { sandbox: { policyDigest: b.fs.fence().digest, backend: 'none' as const } }
    // Past the gate the spawn itself is environment-dependent; what matters is the refusal is gone.
    const result = await seams.exec(['node', '-e', ''], { cwd: dir, ...attested }).catch((e: unknown) => e)
    expect((result as { code?: unknown }).code).not.toBe('SANDBOX_UNAVAILABLE')
    expect(seams.platform).toBe(b.platform)
    await b.close()
  })
  it('carries a prompter through only when one is supplied', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
    const prompter = { ask: async () => 'allowed-once' as const }
    expect(toSeamAdapters(b, { owner: '@agnes/base', prompter }).prompter).toBe(prompter)
    expect(Object.hasOwn(toSeamAdapters(b, { owner: '@agnes/base' }), 'prompter')).toBe(false)
    await b.close()
  })
  it('scopes each package to its own table connection', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
    const base = toSeamAdapters(b, { owner: '@agnes/base' }).storage.table('t')
    base.exec('create table t (v integer)')
    base.run('insert into t (v) values (?)', [1])
    const other = toSeamAdapters(b, { owner: '@acme/other' }).storage.table('t')
    expect(() => other.all('select v from t')).toThrow(/no such table/)
    await b.close()
  })
  it('fences fs at workspaceRoot rather than at the process working directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const ws = mkdtempSync(join(tmpdir(), 'agnes-ws-'))
    try {
      const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
      const b = await openAdapters(p, { dataDir: dir, workspaceRoot: ws })
      await b.fs.write('inside', new Uint8Array([1]))
      expect(existsSync(join(ws, 'inside'))).toBe(true)
      await expect(b.fs.read(join(process.cwd(), 'package.json'))).rejects.toThrow(/E_FS_DENIED/)
      await b.close()
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
  // `.agnes/secrets` is the store's name from before the `.agh` rename: a workspace still holding
  // one must stay as unreadable as one that has moved.
  it('denies the secret store, under its current and its legacy name, and the git directory from inside the workspace', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
    mkdirSync(join(dir, '.git'), { recursive: true })
    for (const name of ['.agh', '.agnes']) {
      mkdirSync(join(dir, name, 'secrets'), { recursive: true })
      writeFileSync(join(dir, name, 'secrets', 'k'), 'v')
    }
    await expect(b.fs.read('.git/config')).rejects.toThrow(/E_FS_DENIED/)
    await expect(b.fs.read('.agh/secrets/k')).rejects.toThrow(/E_FS_DENIED/)
    await expect(b.fs.read('.agnes/secrets/k')).rejects.toThrow(/E_FS_DENIED/)
    await b.close()
  })
  it('still denies the git path when .git is a plain file, as in a worktree', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n')
    await expect(b.fs.read('.git/config')).rejects.toThrow(/E_FS_DENIED/)
    await b.close()
  })
  it('reads secrets out of the store the profile names, ahead of the fallback directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const store = join(dir, 'declared')
    createPrivateDirectorySync(store)
    createPrivateDirectorySync(join(store, 'agnes'))
    const fd = createPrivateFileSync(join(store, 'agnes', 'gateway'))
    try {
      writeFileSync(fd, 'v\n')
    } finally {
      closeSync(fd)
    }
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: { name: 'x', adapters: { secrets: { kind: 'file', path: store } } },
      },
      env,
    )
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir, secretsDir: join(dir, 'other') })
    try {
      expect(b.secrets.resolve('secret://agnes/gateway')).toBe('v')
    } finally {
      await b.close()
    }
  })
  it('uses env alone when the profile asks for env secrets', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'x', adapters: { secrets: { kind: 'env' } } } },
      env,
    )
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
    expect(b.secrets.kind).toBe('env')
    await b.close()
  })
  it('rejects vault secrets in v0.1 with E_SEAM_INIT and leaves no database open', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'v', adapters: { secrets: { kind: 'vault' } } } },
      env,
    )
    try {
      await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
      expect.unreachable('should have refused')
    } catch (e) {
      if (!isHostError(e)) throw e
      expect(e.code).toBe('E_SEAM_INIT')
      expect(e.detail).toEqual({ seam: 'secrets', reason: 'vault v0.x' })
    }
  })
  // Windows uses its owned Job; POSIX must still call the injected platform tree-kill route.
  it('uses the platform-specific termination route and waits for the command to exit', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const { createPlatform } = await import('../../src/adapters/platform.js')
    const real = createPlatform()
    const calls: number[] = []
    const instrumented = {
      ...real,
      killTree(pid: number) {
        calls.push(pid)
        real.killTree(pid)
      },
    }
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir, platform: instrumented })
    try {
      const r = await runTestNode(
        b.exec,
        ['-e', 'process.stdout.write(String(process.pid));setInterval(()=>{},1000)'],
        {
          cwd: dir,
          timeoutMs: 500,
        },
      )
      expect(r.timedOut).toBe(true)
      expect(calls).toHaveLength(real.os === 'win32' ? 0 : 1)
      expect(r.stdout).toMatch(/^[1-9][0-9]*$/)
      if (real.os === 'win32') expect(windowsProcessStartTimeSync(Number(r.stdout))).toBeNull()
      else expect(() => process.kill(Number(r.stdout), 0)).toThrow()
    } finally {
      await b.close()
    }
  })
  it('close ends the processes it started as well as the database', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir })
    const running = runTestNode(b.exec, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: dir,
      timeoutMs: 30_000,
    })
    await new Promise((res) => setTimeout(res, 150))
    await b.close()
    const result = await running
    if (b.platform.os === 'win32') expect(result.code).toBe(1)
    else expect(result.signal).toBe('SIGKILL')
    expect(result.timedOut).toBe(false)
  })
  it('accepts an injected platform instead of detecting one, and probes it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-'))
    const { createWin32Platform } = await import('../../src/adapters/platform-win32.js')
    const injected = createWin32Platform()
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await openAdapters(p, { dataDir: dir, workspaceRoot: dir, platform: injected })
    expect(b.platform).toBe(injected)
    expect(b.platform.capability('ipc').value).toBe('pipe')
    await b.close()
  })
})

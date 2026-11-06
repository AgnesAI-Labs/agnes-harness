// Windows write-restricted execution through the Host's own stack on real NTFS: the execution facade
// over the real authority and native ACL primitives, the built-in local sandbox provider, and the Host
// exec adapter that launches restricted processes in owned Jobs. Every directory is synthetic, under
// the system temporary directory, and LocalAppData points into it; the only credential is a fake one.
// Directories a business process must be able to write to prove it never ran ("open" ones) grant
// Everyone and carry a Low label, so a marker missing there means the process did not run.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import type { SandboxExecutionLease, SandboxProcess } from '@agnes/extension-api'
import { createExec } from '@agnes/host-infrastructure/adapters/exec'
import { resolveConfiguredPowerShell } from '@agnes/host-infrastructure/adapters/powershell'
import { createLocalSandboxProvider } from '@agnes/host-infrastructure/adapters/sandbox-local'
import {
  type WindowsAclNative,
  type WindowsAclPlatform,
  WindowsExecutionAuthority,
  windowsAclLocations,
} from '@agnes/host-infrastructure/windows-acl/authority'
import {
  WINDOWS_ACL_ENFORCEMENT,
  WindowsAclExecution,
  windowsPartialPolicy,
} from '@agnes/host-infrastructure/windows-acl/execution'
import {
  createWindowsAclExecution,
  createWindowsAclMaintenanceAuthority,
  windowsAclHostPlatform,
} from '@agnes/host-infrastructure/windows-acl/host-platform'
import { durableStateFiles, type WindowsAclStateFiles } from '@agnes/host-infrastructure/windows-acl/journal'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import { acquireOwnerFileLock } from '@agnes/system-node/owner-lock'
import {
  applyWindowsAclGrant,
  inspectWindowsAcl,
  readWindowsObjectIdentity,
  restoreWindowsAclGrant,
} from '@agnes/system-node/windows-acl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const DIGEST = 'a'.repeat(64)
const DENIED = ['EPERM', 'EACCES']
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const icacls = join(systemRoot, 'System32', 'icacls.exe')
const cmd = join(systemRoot, 'System32', 'cmd.exe')
const realNative: WindowsAclNative = {
  inspect: inspectWindowsAcl,
  apply: applyWindowsAclGrant,
  restore: restoreWindowsAclGrant,
}

/** Each step is [name, operation, path, argument?]; prints {name: 'ok' | value | error code}. */
const PROBE = `const fs = require('node:fs');
const attempt = (fn) => { try { const value = fn(); return value === undefined ? 'ok' : value } catch (error) { return error.code ?? String(error) } };
const out = {};
for (const [name, op, a, b] of JSON.parse(process.argv[1])) out[name] = attempt(() => {
  if (op === 'mkdir') { fs.mkdirSync(a, { recursive: true }); return }
  if (op === 'write') { fs.writeFileSync(a, b); return }
  if (op === 'append') { fs.appendFileSync(a, b); return }
  if (op === 'read') return fs.readFileSync(a, 'utf8');
  if (op === 'rename') { fs.renameSync(a, b); return }
  if (op === 'unlink') { fs.unlinkSync(a); return }
  if (op === 'rmtree') { fs.rmSync(a, { recursive: true }); return }
  if (op === 'env') return process.env[a] ?? 'unset';
  throw new Error('unknown step ' + op);
});
process.stdout.write(JSON.stringify(out));`
type ProbeStep = readonly [name: string, operation: string, path: string, argument?: string]

type World = Readonly<{
  base: string
  localAppData: string
  home: string
  workspace: string
  outside: string
  open: string
}>
let world: World
const cleanups: Array<() => unknown> = []
const children: Array<{ kill(): boolean }> = []

beforeEach(() => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-acl-host-')))
  const at = (name: string) => {
    mkdirSync(join(base, name))
    return join(base, name)
  }
  const open = at('open')
  execFileSync(icacls, [open, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'pipe' })
  execFileSync(icacls, [open, '/setintegritylevel', '(OI)(CI)L'], { stdio: 'pipe' })
  world = {
    base,
    localAppData: join(base, 'local-app-data'),
    home: at('home'),
    workspace: at('work'),
    outside: at('outside'),
    open,
  }
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
  for (const child of children.splice(0)) child.kill()
  try {
    execFileSync(icacls, [world.base, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' })
  } catch {}
  rmSync(world.base, { recursive: true, force: true, maxRetries: 5 })
})

const sddl = (path: string) => inspectWindowsAcl(path).securityDescriptor
const capabilitySids = (path: string) => [...new Set(sddl(path).match(/S-1-4-[\d-]+/g) ?? [])]
const settle = () => new Promise((resolve) => setTimeout(resolve, 500))
const code = (expected: string) => expect.objectContaining({ code: expected })

type Stack = Readonly<{
  execution: WindowsAclExecution
  provider: ReturnType<typeof createLocalSandboxProvider>
}>

/** The Host's Windows execution facade, exec adapter and local provider, as one Host builds them. */
async function hostStack(authority?: WindowsExecutionAuthority): Promise<Stack> {
  const localProviderId = RELEASE_DEFAULTS.sandboxProvider
  const execution = authority
    ? new WindowsAclExecution({
        authority,
        rootIdentity: async (path) => readWindowsObjectIdentity(path),
        localProviderId,
      })
    : await createWindowsAclExecution({
        localAppData: world.localAppData,
        privateRoots: [world.home],
        localProviderId,
        pid: process.pid,
      })
  const shell = await resolveConfiguredPowerShell({ ...process.env, AGNES_POWERSHELL: '5.1' })
  const exec = createExec({ windowsNodeExecutable: process.execPath, windowsPowerShell: shell })
  cleanups.push(async () => {
    await exec.killAll().catch(() => undefined)
    await execution.dispose()
  })
  return { execution, provider: createLocalSandboxProvider(exec, 'win32', { windowsAcl: execution }) }
}

type Session = Awaited<ReturnType<typeof session>>

/** One session's lease and provider instance; closing it is what releasing the session runtime does. */
async function session(
  stack: Stack,
  root: string,
  mode: 'read-only' | 'workspace-write',
  sessionExecutionId: string = randomUUID(),
) {
  const lease: SandboxExecutionLease = await stack.execution.acquire({
    sessionExecutionId,
    canonicalRoot: root,
    policyDigest: DIGEST,
    mode,
  })
  const instance = await stack.provider.create({ workspaceRoot: root, executionLease: lease })
  const policy = windowsPartialPolicy(root, DIGEST, lease)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await instance.dispose()
  }
  cleanups.push(close)
  const request = (argv: readonly string[], cwd = root) => ({
    argv,
    cwd,
    policy,
    enforcement: WINDOWS_ACL_ENFORCEMENT,
  })
  return {
    lease,
    close,
    run: (argv: readonly string[], cwd?: string) => instance.exec(request(argv, cwd)),
    open: (argv: readonly string[], cwd?: string) => {
      if (!instance.openProcess) throw new Error('the local provider has no process entry')
      return instance.openProcess(request(argv, cwd))
    },
    probe: async (steps: readonly ProbeStep[]): Promise<Record<string, string>> => {
      const result = await instance.exec(request([process.execPath, '-e', PROBE, JSON.stringify(steps)]))
      expect(result.code, result.stderr).toBe(0)
      expect(result.enforcement).toEqual(WINDOWS_ACL_ENFORCEMENT)
      return JSON.parse(result.stdout)
    },
  }
}

/** Runs a marker writer through a new write session; the marker can only exist if it really ran. */
async function businessRuns(stack: Stack, root: string): Promise<{ error: unknown; ran: boolean }> {
  const marker = join(world.open, randomUUID())
  let error: unknown
  try {
    const opened = await session(stack, root, 'workspace-write')
    await opened.run([
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ])
  } catch (refused) {
    error = refused
  }
  await settle()
  return { error, ran: existsSync(marker) }
}

async function maintenance() {
  const { authority } = await createWindowsAclMaintenanceAuthority({
    localAppData: world.localAppData,
    pid: process.pid,
  })
  cleanups.push(() => authority.dispose())
  return authority
}

async function repairFully(root: string) {
  const authority = await maintenance()
  const report = await authority.inspect(root)
  return authority.repair({
    root,
    grantId: report.grantId ?? '',
    expectedRecordDigest: report.recordDigest ?? '',
  })
}

const wait = (handle: SandboxProcess, text: string) =>
  new Promise<string>((resolve) => {
    let output = ''
    const off = handle.onOutput((chunk) => {
      output += chunk.text
      const line = output.split('\n').find((candidate) => candidate.startsWith(text))
      if (line === undefined) return
      off()
      resolve(line.trim())
    })
  })

describe.skipIf(process.platform !== 'win32')(
  'Windows write restriction through the Host',
  { timeout: 120_000 },
  () => {
    it('creates, changes, renames and deletes in the workspace and its private temp, and nowhere else', async () => {
      const s = await session(await hostStack(), world.workspace, 'workspace-write')
      const temp = s.lease.tempRoot ?? ''
      expect(temp.startsWith(windowsAclLocations(world.localAppData, win32).tempRoot)).toBe(true)
      writeFileSync(join(world.outside, 'kept.txt'), 'outside original')
      const ws = (...parts: string[]) => join(world.workspace, ...parts)
      const out = (name: string) => join(world.outside, name)
      const facts = await s.probe([
        ['mkdir', 'mkdir', ws('子目录 a', 'nested')],
        ['create', 'write', ws('子目录 a', 'nested', '新 文件.txt'), 'one'],
        ['modify', 'append', ws('子目录 a', 'nested', '新 文件.txt'), 'two'],
        ['read', 'read', ws('子目录 a', 'nested', '新 文件.txt')],
        ['rename', 'rename', ws('子目录 a', 'nested', '新 文件.txt'), ws('子目录 a', 'renamed.txt')],
        ['renameDirectory', 'rename', ws('子目录 a'), ws('子目录 b')],
        ['delete', 'unlink', ws('子目录 b', 'renamed.txt')],
        ['deleteTree', 'rmtree', ws('子目录 b')],
        ['temp', 'env', 'TEMP'],
        ['tmp', 'env', 'TMP'],
        ['tempCreate', 'write', join(temp, 'scratch.txt'), 't'],
        ['tempRename', 'rename', join(temp, 'scratch.txt'), join(temp, 'moved.txt')],
        ['tempDelete', 'unlink', join(temp, 'moved.txt')],
        ['outsideCreate', 'write', out('new.txt'), 'x'],
        ['outsideModify', 'append', out('kept.txt'), 'x'],
        ['outsideRename', 'rename', out('kept.txt'), out('renamed.txt')],
        ['outsideDelete', 'unlink', out('kept.txt')],
        ['outsideDirectory', 'mkdir', out('made')],
      ])
      expect(facts).toMatchObject({
        mkdir: 'ok',
        create: 'ok',
        modify: 'ok',
        read: 'onetwo',
        rename: 'ok',
        renameDirectory: 'ok',
        delete: 'ok',
        deleteTree: 'ok',
        temp,
        tmp: temp,
        tempCreate: 'ok',
        tempRename: 'ok',
        tempDelete: 'ok',
      })
      for (const name of [
        'outsideCreate',
        'outsideModify',
        'outsideRename',
        'outsideDelete',
        'outsideDirectory',
      ])
        expect(DENIED, name).toContain(facts[name])
      expect(readdirSync(world.workspace)).toEqual([])
      expect(readdirSync(world.outside)).toEqual(['kept.txt'])
      expect(readFileSync(out('kept.txt'), 'utf8')).toBe('outside original')

      // An ordinary program in the session, here Windows PowerShell, gets the same boundary.
      const quoted = (path: string) => `'${path.replaceAll("'", "''")}'`
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$results = @()',
        "function Step($name, [scriptblock]$body) { try { & $body | Out-Null; $script:results += $name + '=ok' } catch { $script:results += $name + '=denied' } }",
        `Step 'create' { Set-Content -LiteralPath ${quoted(ws('ps 文件.txt'))} -Value 'a' }`,
        `Step 'rename' { Rename-Item -LiteralPath ${quoted(ws('ps 文件.txt'))} -NewName 'ps-renamed.txt' }`,
        `Step 'remove' { Remove-Item -LiteralPath ${quoted(ws('ps-renamed.txt'))} }`,
        `Step 'outsideCreate' { Set-Content -LiteralPath ${quoted(out('ps.txt'))} -Value 'x' }`,
        `Step 'outsideRemove' { Remove-Item -LiteralPath ${quoted(out('kept.txt'))} }`,
        "[Console]::Out.Write($results -join ';')",
      ].join('\n')
      const shell = await resolveConfiguredPowerShell({ ...process.env, AGNES_POWERSHELL: '5.1' })
      const ps = await s.run([shell.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script])
      expect(ps.code, ps.stderr).toBe(0)
      expect(ps.stdout).toBe('create=ok;rename=ok;remove=ok;outsideCreate=denied;outsideRemove=denied')
      expect(readdirSync(world.outside)).toEqual(['kept.txt'])
    })

    it.each(['workspace-write', 'read-only'] as const)(
      'leaves reads and the network unrestricted in a %s session, as the contract states',
      async (mode) => {
        const fakeCredential = ['synthetic', 'credential', 'value'].join('-')
        writeFileSync(join(world.outside, 'fake-credential.txt'), fakeCredential)
        const server = createServer((_request, response) => response.end('loopback reply'))
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        cleanups.push(() => new Promise((resolve) => server.close(resolve)))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('no loopback address')
        const s = await session(await hostStack(), world.workspace, mode)
        const result = await s.run([
          process.execPath,
          '-e',
          `const read = require('node:fs').readFileSync(process.argv[1], 'utf8');
        require('node:http').get(process.argv[2], (response) => {
          let body = ''; response.setEncoding('utf8');
          response.on('data', (chunk) => body += chunk);
          response.on('end', () => process.stdout.write(JSON.stringify({ read, body })));
        }).on('error', (error) => process.stdout.write(JSON.stringify({ read, body: error.code })));`,
          join(world.outside, 'fake-credential.txt'),
          `http://127.0.0.1:${address.port}/`,
        ])
        expect(result.code, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({ read: fakeCredential, body: 'loopback reply' })
        expect(result.enforcement.boundary).toMatchObject({
          fileRead: 'unrestricted',
          network: 'unrestricted',
        })
      },
    )

    it('gives a read-only session no write grant and no temp', async () => {
      const before = inspectWindowsAcl(world.workspace).fingerprint
      const s = await session(await hostStack(), world.workspace, 'read-only')
      expect(s.lease.tempRoot).toBeUndefined()
      const facts = await s.probe([
        ['create', 'write', join(world.workspace, 'denied.txt'), 'x'],
        ['mkdir', 'mkdir', join(world.workspace, 'denied')],
        ['outside', 'write', join(world.outside, 'denied.txt'), 'x'],
      ])
      for (const name of ['create', 'mkdir', 'outside']) expect(DENIED, name).toContain(facts[name])
      expect(readdirSync(world.workspace)).toEqual([])
      expect(inspectWindowsAcl(world.workspace).fingerprint).toBe(before)
      expect(capabilitySids(world.workspace)).toEqual([])
      expect(await (await maintenance()).inspect(world.workspace)).toMatchObject({ state: 'unavailable' })
    })

    it.each(['A', 'B'])(
      'two sessions on one root keep working while the other is released, %s first',
      async (first) => {
        const original = inspectWindowsAcl(world.workspace).fingerprint
        const stack = await hostStack()
        const a = await session(stack, world.workspace, 'workspace-write', 'session-a')
        const b = await session(stack, world.workspace, 'workspace-write', 'session-b')
        expect(a.lease.tempRoot).not.toBe(b.lease.tempRoot)
        const writes = (s: Session, name: string) =>
          s.probe([
            ['workspace', 'write', join(world.workspace, `${name}.txt`), name],
            ['temp', 'write', join(s.lease.tempRoot ?? '', `${name}.txt`), name],
          ])
        expect(await writes(a, 'a')).toEqual({ workspace: 'ok', temp: 'ok' })
        expect(await writes(b, 'b')).toEqual({ workspace: 'ok', temp: 'ok' })
        expect(capabilitySids(world.workspace)).toHaveLength(1)
        const [released, kept] = first === 'A' ? [a, b] : [b, a]
        await released.close()
        expect(existsSync(released.lease.tempRoot ?? '')).toBe(false)
        expect(existsSync(kept.lease.tempRoot ?? '')).toBe(true)
        expect(
          await kept.probe([
            ['workspace', 'write', join(world.workspace, 'after.txt'), 'after'],
            ['temp', 'write', join(kept.lease.tempRoot ?? '', 'after.txt'), 'after'],
            ['other', 'unlink', join(world.workspace, first === 'A' ? 'a.txt' : 'b.txt')],
          ]),
        ).toEqual({ workspace: 'ok', temp: 'ok', other: 'ok' })
        await kept.close()
        expect(existsSync(kept.lease.tempRoot ?? '')).toBe(false)
        // The workspace grant stands after both sessions, until an explicit repair removes it.
        expect(await (await maintenance()).inspect(world.workspace)).toMatchObject({ state: 'active' })
        expect((await repairFully(world.workspace)).state).toBe('revoked')
        expect(inspectWindowsAcl(world.workspace).fingerprint).toBe(original)
      },
    )

    it.each(['outer', 'inner'])(
      'nested roots keep their own boundaries while the other is released, %s first',
      async (first) => {
        const inner = join(world.workspace, 'inner')
        mkdirSync(inner)
        const originals = [
          inspectWindowsAcl(world.workspace).fingerprint,
          inspectWindowsAcl(inner).fingerprint,
        ]
        const stack = await hostStack()
        const outerSession = await session(stack, world.workspace, 'workspace-write')
        const innerSession = await session(stack, inner, 'workspace-write')
        const fromInner = await innerSession.probe([
          ['inner', 'write', join(inner, 'from-inner.txt'), 'x'],
          ['outer', 'write', join(world.workspace, 'from-inner.txt'), 'x'],
        ])
        expect(fromInner.inner).toBe('ok')
        // The inner root's grant does not reach up to the outer root.
        expect(DENIED).toContain(fromInner.outer)
        expect(existsSync(join(world.workspace, 'from-inner.txt'))).toBe(false)
        expect(
          await outerSession.probe([
            ['outer', 'write', join(world.workspace, 'from-outer.txt'), 'x'],
            ['inner', 'write', join(inner, 'from-outer.txt'), 'x'],
          ]),
        ).toEqual({ outer: 'ok', inner: 'ok' })
        const [released, kept, keptRoot] =
          first === 'outer'
            ? [outerSession, innerSession, inner]
            : [innerSession, outerSession, world.workspace]
        await released.close()
        expect(await kept.probe([['write', 'write', join(keptRoot, 'after-release.txt'), 'x']])).toEqual({
          write: 'ok',
        })
        await kept.close()
        expect((await repairFully(inner)).state).toBe('revoked')
        expect((await repairFully(world.workspace)).state).toBe('revoked')
        expect([
          inspectWindowsAcl(world.workspace).fingerprint,
          inspectWindowsAcl(inner).fingerprint,
        ]).toEqual(originals)
      },
    )

    it.each(['renamed away', 'deleted'])(
      'a workspace %s and recreated at the same path never borrows the old grant',
      async (how) => {
        const stack = await hostStack()
        const a = await session(stack, world.workspace, 'workspace-write')
        expect(await a.probe([['write', 'write', join(world.workspace, 'before.txt'), 'x']])).toEqual({
          write: 'ok',
        })
        const [old] = capabilitySids(world.workspace)
        expect(old).toBeDefined()
        // A background process of the session, started outside the root so it does not hold the root open.
        const background = await a.open([process.execPath, '-e', 'setInterval(() => {}, 1000)'], world.base)
        const moved = `${world.workspace}-moved`
        if (how === 'renamed away') renameSync(world.workspace, moved)
        else rmSync(world.workspace, { recursive: true, force: true })
        await expect(a.run([process.execPath, '-e', 'process.exit(0)'])).rejects.toThrow(code('ENOENT'))
        // The refused launch stops what the session still ran under the vanished root.
        await expect(background.exited).resolves.toBeDefined()
        mkdirSync(world.workspace)
        const marker = join(world.workspace, 'borrowed.txt')
        await expect(
          a.run([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]),
        ).rejects.toThrow(code('E_ACL_IDENTITY_MISMATCH'))
        expect(existsSync(marker)).toBe(false)
        expect(capabilitySids(world.workspace)).toEqual([])
        // A new session on the new directory gets a grant of its own.
        const b = await session(stack, world.workspace, 'workspace-write')
        expect(await b.probe([['write', 'write', marker, 'x']])).toEqual({ write: 'ok' })
        const [fresh] = capabilitySids(world.workspace)
        expect(fresh).toBeDefined()
        expect(fresh).not.toBe(old)
        // The old directory keeps the old grant: nothing follows a directory once it is moved away.
        if (how === 'renamed away') expect(capabilitySids(moved)).toContain(old)
      },
    )

    it('records what a subdirectory moved out of the workspace and an already open handle still allow', async () => {
      const s = await session(await hostStack(), world.workspace, 'workspace-write')
      const sub = join(world.workspace, 'sub')
      mkdirSync(sub)
      const [sid] = capabilitySids(world.workspace)
      // The first input opens the file and keeps the handle; every later input is written through it.
      const holder = await s.open(
        [
          process.execPath,
          '-e',
          `const fs = require('node:fs'); let fd;
        process.stdin.setEncoding('utf8').on('data', (text) => {
          if (fd === undefined) { fd = fs.openSync(process.argv[1], 'a'); process.stdout.write('open\\n'); return }
          try { fs.writeSync(fd, text); process.stdout.write('handle=ok\\n') }
          catch (error) { process.stdout.write('handle=' + error.code + '\\n') }
        });`,
          join(sub, 'held.txt'),
        ],
        world.base,
      )
      cleanups.push(() => holder.close())
      const opened = wait(holder, 'open')
      await holder.write('open\n')
      expect(await opened).toBe('open')
      const target = join(world.outside, 'sub')
      let move = 'ok'
      try {
        renameSync(sub, target)
      } catch (error) {
        move = (error as NodeJS.ErrnoException).code ?? String(error)
      }
      const written = wait(holder, 'handle=')
      await holder.write('after the move\n')
      const handle = (await written).slice('handle='.length)
      const where = move === 'ok' ? target : sub
      const inherited = sid !== undefined && sddl(where).includes(sid)
      const fresh = await s.probe([['open', 'write', join(where, 'fresh.txt'), 'x']])
      console.info(
        'windows-acl boundary record',
        JSON.stringify({ move, handle, grantInheritedAfterMove: inherited, newOpenAfterMove: fresh.open }),
      )
      // A handle keeps the access it was opened with; it is not re-checked when its directory moves.
      expect(handle).toBe('ok')
      expect(readFileSync(join(where, 'held.txt'), 'utf8')).toBe('after the move\n')
      // A new open follows the permissions the object carries, wherever it now is; no move is claimed
      // to revoke them at once. The reported boundary says so: ACL write restriction, not path isolation.
      expect(fresh.open === 'ok').toBe(inherited)
      expect(WINDOWS_ACL_ENFORCEMENT.boundary).toMatchObject({ fileWrite: 'acl-partial' })
    })
  },
)

/** Real durable journal files whose writes all fail from a chosen point, as a process dead there leaves them. */
class CrashingFiles implements WindowsAclStateFiles {
  writes = 0
  failFrom = Number.POSITIVE_INFINITY
  failWhen?: (text: string) => boolean
  read(path: string) {
    return durableStateFiles.read(path)
  }
  list(directory: string) {
    return durableStateFiles.list(directory)
  }
  writeDurable(path: string, text: string) {
    this.writes++
    if (this.writes >= this.failFrom || this.failWhen?.(text)) {
      this.failFrom = Math.min(this.failFrom, this.writes)
      throw Object.assign(new Error('flush failed'), { code: 'EIO' })
    }
    durableStateFiles.writeDurable(path, text)
  }
  removeDurable(path: string) {
    if (this.writes >= this.failFrom) throw Object.assign(new Error('flush failed'), { code: 'EIO' })
    durableStateFiles.removeDurable(path)
  }
  /** The process dies now: this and every later journal write fails. */
  die() {
    this.failFrom = this.writes + 1
    return Object.assign(new Error('simulated process death'), { code: 'E_TEST_CRASH' })
  }
}

async function authorityWith(
  options: { files?: WindowsAclStateFiles; native?: WindowsAclNative; platform?: WindowsAclPlatform } = {},
) {
  return new WindowsExecutionAuthority({
    ...windowsAclLocations(world.localAppData, win32),
    privateRoots: [world.home],
    native: options.native ?? realNative,
    platform: options.platform ?? (await windowsAclHostPlatform(process.pid)),
    ...(options.files ? { files: options.files } : {}),
    lockWaitMs: 2_000,
  })
}

/** The journal lock a Host that died while holding it leaves behind. */
function leaveLock() {
  const pid = spawnSync(process.execPath, ['-e', '']).pid
  acquireOwnerFileLock(join(windowsAclLocations(world.localAppData, win32).stateRoot, 'lock'), {
    pid,
    startId: `exited:${pid}`,
    token: `token-${pid}`,
  })
}

/** A live process standing in for another Host, until it is stopped. */
async function otherHost() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  await once(child, 'spawn')
  const pid = child.pid
  if (pid === undefined) throw new Error('the stand-in Host did not start')
  return {
    pid,
    stop: async () => {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    },
  }
}

describe.skipIf(process.platform !== 'win32')(
  'Windows write restriction refusals',
  { timeout: 120_000 },
  () => {
    type Arm = (files: CrashingFiles) => Partial<WindowsAclNative> & { failWhen?: (text: string) => boolean }
    const grantCrashes: Array<[string, Arm]> = [
      [
        'after the prepared record, before the native change',
        (files) => ({
          apply: () => {
            throw files.die()
          },
        }),
      ],
      [
        'after the native change, before its result was recorded',
        (files) => ({
          apply: (input) => {
            applyWindowsAclGrant(input)
            throw files.die()
          },
        }),
      ],
      [
        'after the result was recorded, before it was verified',
        () => ({ failWhen: (text) => text.includes('"state":"active"') }),
      ],
    ]

    it.each(grantCrashes)(
      'a grant interrupted %s runs no business process until repaired',
      async (_point, arm) => {
        const original = inspectWindowsAcl(world.workspace).fingerprint
        const files = new CrashingFiles()
        const { failWhen, ...native } = arm(files)
        if (failWhen) files.failWhen = failWhen
        const dying = await authorityWith({ files, native: { ...realNative, ...native } })
        await expect(businessRuns(await hostStack(dying), world.workspace)).resolves.toMatchObject({
          ran: false,
        })
        leaveLock()
        const restarted = await hostStack()
        const attempt = await businessRuns(restarted, world.workspace)
        expect(attempt.error).toMatchObject({ code: 'E_ACL_NEEDS_ATTENTION' })
        expect(attempt.ran).toBe(false)
        expect(await (await maintenance()).inspect(world.workspace)).toMatchObject({
          state: 'needs-attention',
        })
        const repaired = await repairFully(world.workspace)
        expect(capabilitySids(world.workspace)).toEqual([])
        // Without a recorded result the deny and label cannot be proven AGH's; they stay for the user.
        if (repaired.state !== 'revoked') expect(repaired.steps.join('\n')).toMatch(/Low integrity label/)
        else expect(inspectWindowsAcl(world.workspace).fingerprint).toBe(original)
        expect((await businessRuns(restarted, world.workspace)).ran).toBe(repaired.state === 'revoked')
      },
    )

    it.each([
      [
        'before the native change',
        (files: CrashingFiles): Partial<WindowsAclNative> => ({
          restore: () => {
            throw files.die()
          },
        }),
      ],
      [
        'after the native change, before it was recorded',
        (files: CrashingFiles): Partial<WindowsAclNative> => ({
          restore: (input) => {
            restoreWindowsAclGrant(input)
            throw files.die()
          },
        }),
      ],
    ])('a repair interrupted %s never reads as active or revoked', async (_point, arm) => {
      const original = inspectWindowsAcl(world.workspace).fingerprint
      const files = new CrashingFiles()
      const native = { ...realNative }
      const authority = await authorityWith({ files, native })
      const s = await session(await hostStack(authority), world.workspace, 'workspace-write')
      expect(await s.probe([['write', 'write', join(world.workspace, 'x.txt'), 'x']])).toEqual({
        write: 'ok',
      })
      await s.close()
      const report = await authority.inspect(world.workspace)
      Object.assign(native, arm(files))
      await expect(
        authority.repair({
          root: world.workspace,
          grantId: report.grantId ?? '',
          expectedRecordDigest: report.recordDigest ?? '',
        }),
      ).rejects.toThrow()
      leaveLock()
      expect(await (await maintenance()).inspect(world.workspace)).toMatchObject({ state: 'needs-attention' })
      const attempt = await businessRuns(await hostStack(), world.workspace)
      expect(attempt.error).toMatchObject({ code: 'E_ACL_NEEDS_ATTENTION' })
      expect(attempt.ran).toBe(false)
      expect((await repairFully(world.workspace)).state).toBe('revoked')
      expect(inspectWindowsAcl(world.workspace).fingerprint).toBe(original)
    })

    it('refuses on a damaged journal record and keeps it as found', async () => {
      const stack = await hostStack()
      const s = await session(stack, world.workspace, 'workspace-write')
      await s.close()
      const grants = join(windowsAclLocations(world.localAppData, win32).stateRoot, 'grants')
      // Records are `<sha256>\n<json>`; the workspace grant is the one damaged here.
      const record = readdirSync(grants)
        .filter((name) => !name.endsWith('.tmp'))
        .find((name) => JSON.parse(readFileSync(join(grants, name), 'utf8').slice(65)).kind === 'workspace')
      if (!record) throw new Error('no workspace grant record')
      const file = join(grants, record)
      const damaged = `${readFileSync(file, 'utf8').slice(0, -10)}damaged`
      writeFileSync(file, damaged)
      const attempt = await businessRuns(await hostStack(), world.workspace)
      expect(attempt.error).toMatchObject({ code: 'E_ACL_JOURNAL_CORRUPT' })
      expect(attempt.ran).toBe(false)
      const authority = await maintenance()
      const report = await authority.inspect(world.workspace)
      expect(report).toMatchObject({ state: 'needs-attention', repairable: false })
      expect(
        await authority.repair({ root: world.workspace, grantId: record, expectedRecordDigest: 'x' }),
      ).toMatchObject({ state: 'needs-attention', repairable: false })
      expect(readFileSync(file, 'utf8')).toBe(damaged)
    })

    it('stops launching after a third-party permission change and repairs only its own entries', async () => {
      const stack = await hostStack()
      const a = await session(stack, world.workspace, 'workspace-write')
      expect(await a.probe([['write', 'write', join(world.workspace, 'x.txt'), 'x']])).toEqual({
        write: 'ok',
      })
      const thirdParty = 'S-1-5-21-1000000001-1000000002-1000000003-4242'
      execFileSync(icacls, [world.workspace, '/grant', `*${thirdParty}:(OI)(CI)RX`], { stdio: 'pipe' })
      const other = await businessRuns(stack, world.workspace)
      expect(other.error).toMatchObject({ code: 'E_ACL_CHANGED' })
      expect(other.ran).toBe(false)
      const marker = join(world.open, 'after-change')
      await expect(
        a.run([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
      ).rejects.toThrow(code('E_ACL_GRANT_CHANGED'))
      await settle()
      expect(existsSync(marker)).toBe(false)
      await a.close()
      const repaired = await repairFully(world.workspace)
      expect(repaired.state).toBe('revoked')
      expect(repaired.issues.map((issue) => issue.reason)).toContainEqual(expect.stringMatching(/^changed/))
      expect(sddl(world.workspace)).toContain(thirdParty)
      expect(capabilitySids(world.workspace)).toEqual([])
    })

    it('refuses without changing anything when the native ACL primitives are unavailable', async () => {
      const before = sddl(world.workspace)
      // Stands in for a native artifact that predates the ACL primitives, which the loader reports so.
      const unavailable = () => {
        throw Object.assign(new Error('the native ACL primitives are unavailable'), {
          code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
        })
      }
      const authority = await authorityWith({
        native: { inspect: unavailable, apply: unavailable, restore: unavailable },
      })
      const attempt = await businessRuns(await hostStack(authority), world.workspace)
      expect(attempt.error).toMatchObject({ code: 'E_SYSTEM_NATIVE_UNAVAILABLE' })
      expect(attempt.ran).toBe(false)
      expect(sddl(world.workspace)).toBe(before)
    })

    it('keeps a grant and a temp whose owning Host cannot be identified', async () => {
      const host = await otherHost()
      const theirs = await authorityWith({ platform: await windowsAclHostPlatform(host.pid) })
      const lease = await theirs.acquire({
        sessionExecutionId: 'other-host',
        canonicalRoot: world.workspace,
        policyDigest: DIGEST,
        mode: 'workspace-write',
      })
      const theirTemp = lease.tempRoot ?? ''
      await host.stop()
      const real = await windowsAclHostPlatform(process.pid)
      const unknown: WindowsAclPlatform = {
        ...real,
        processIdentity: async (pid) =>
          pid === host.pid ? { state: 'unknown', reason: 'access denied' } : real.processIdentity(pid),
      }
      const ours = await authorityWith({ platform: unknown })
      const report = await ours.inspect(world.workspace)
      const refused = await ours.repair({
        root: world.workspace,
        grantId: report.grantId ?? '',
        expectedRecordDigest: report.recordDigest ?? '',
      })
      expect(refused.issues.map((issue) => issue.reason)).toContainEqual(
        expect.stringMatching(/^usage-unknown/),
      )
      expect(capabilitySids(world.workspace)).toHaveLength(1)
      // A new lease of this Host neither sweeps nor reuses the temp of a Host it cannot prove gone.
      const s = await session(await hostStack(ours), world.workspace, 'workspace-write')
      expect(s.lease.tempRoot).not.toBe(theirTemp)
      expect(existsSync(theirTemp)).toBe(true)
    })

    it('leaves ordinary programs of the user working in a granted workspace', async () => {
      const s = await session(await hostStack(), world.workspace, 'workspace-write')
      const agent = join(world.workspace, 'agent')
      expect(
        await s.probe([
          ['mkdir', 'mkdir', join(agent, 'deep')],
          ['file', 'write', join(agent, 'deep', 'made-by-agent.txt'), 'agent'],
        ]),
      ).toEqual({ mkdir: 'ok', file: 'ok' })
      const root = sddl(world.workspace)
      expect(root).toContain('(D;CI;DC;;;WD)')
      expect(root).toContain('(ML;OICI;NW;;;LW)')
      await s.close()

      // Node as the user, at its normal integrity: every ordinary change, on its own files and the agent's.
      const ws = (...parts: string[]) => join(world.workspace, ...parts)
      const node = spawnSync(
        process.execPath,
        [
          '-e',
          PROBE,
          JSON.stringify([
            ['mkdir', 'mkdir', ws('user', 'nested')],
            ['create', 'write', ws('user', 'nested', 'index'), 'one'],
            ['lock', 'write', ws('user', 'nested', 'index.lock'), 'two'],
            ['replace', 'rename', ws('user', 'nested', 'index.lock'), ws('user', 'nested', 'index')],
            ['read', 'read', ws('user', 'nested', 'index')],
            ['agentModify', 'append', ws('agent', 'deep', 'made-by-agent.txt'), ' user'],
            ['agentRename', 'rename', ws('agent', 'deep', 'made-by-agent.txt'), ws('agent', 'renamed.txt')],
            ['agentDelete', 'unlink', ws('agent', 'renamed.txt')],
            ['agentTree', 'rmtree', ws('agent')],
          ]),
        ],
        { encoding: 'utf8' },
      )
      expect(node.status, node.stderr).toBe(0)
      expect(JSON.parse(node.stdout)).toEqual({
        mkdir: 'ok',
        create: 'ok',
        lock: 'ok',
        replace: 'ok',
        read: 'two',
        agentModify: 'ok',
        agentRename: 'ok',
        agentDelete: 'ok',
        agentTree: 'ok',
      })

      // cmd.exe built-ins, one command each.
      for (const command of [
        'mkdir cmd\\a\\b',
        'echo text> cmd\\a\\b\\f.txt',
        'ren cmd\\a\\b\\f.txt g.txt',
        'move cmd\\a\\b\\g.txt cmd\\a\\h.txt',
        'copy cmd\\a\\h.txt cmd\\a\\i.txt',
        'del cmd\\a\\h.txt',
        'rd /s /q cmd',
      ]) {
        const result = spawnSync(cmd, ['/d', '/c', command], { cwd: world.workspace, encoding: 'utf8' })
        expect(result.status, `${command}: ${result.stdout}${result.stderr}`).toBe(0)
      }
      expect(existsSync(ws('cmd'))).toBe(false)

      // Windows PowerShell and PowerShell 7 as the user. PowerShell 7 must be on PATH (pwsh.exe).
      const systemPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      for (const shell of [systemPowerShell, 'pwsh.exe']) {
        const script = [
          "$ErrorActionPreference = 'Stop'",
          "New-Item -ItemType Directory -Path 'ps\\a\\b' | Out-Null",
          "Set-Content -LiteralPath 'ps\\a\\b\\f.txt' -Value 'text'",
          "Add-Content -LiteralPath 'ps\\a\\b\\f.txt' -Value 'more'",
          "Copy-Item -LiteralPath 'ps\\a\\b\\f.txt' -Destination 'ps\\a\\copy.txt'",
          "Move-Item -LiteralPath 'ps\\a\\copy.txt' -Destination 'ps\\moved.txt'",
          "Rename-Item -LiteralPath 'ps\\moved.txt' -NewName 'renamed.txt'",
          "Remove-Item -LiteralPath 'ps' -Recurse -Force",
        ].join('; ')
        const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
          cwd: world.workspace,
          encoding: 'utf8',
        })
        expect(result.error, `${shell} must be runnable`).toBeUndefined()
        expect(result.status, `${shell}: ${result.stdout}${result.stderr}`).toBe(0)
        expect(existsSync(ws('ps'))).toBe(false)
      }

      // The user can still remove the whole workspace, grant and all.
      rmSync(world.workspace, { recursive: true })
      expect(existsSync(world.workspace)).toBe(false)
    })
  },
)

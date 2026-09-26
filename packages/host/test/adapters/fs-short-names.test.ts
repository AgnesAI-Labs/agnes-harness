import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testFsPolicy } from '@agnes/core/testkit'
import { describe, expect, it, vi } from 'vitest'
import type { ExecAdapter } from '../../src/adapters/exec.js'
import { createFs } from '../../src/adapters/fs.js'
import type { FsIo } from '../../src/adapters/fs-io.js'
import { createLocalFsIo, localFsIo } from '../../src/adapters/fs-io-local.js'
import { createPlatform } from '../../src/adapters/platform.js'
import { createSessionWorkspaceAdapterFactory } from '../../src/adapters/session-workspace.js'
import { CliWorkspaceAuthority } from '../../src/workspace-authority.js'
import { memoryFsIo } from '../../testkit/fs-io-memory.js'

/**
 * A volume where some directory entries also answer to a second, short name, the way NTFS gives
 * `longdirectoryname` the alias `LONGDI~1`. lstat and every other primitive accept either spelling, and
 * `finalPath` answers the long one, as the Windows native resolver does.
 */
function shortNameVolume(aliases: Readonly<Record<string, string>>) {
  const mem = memoryFsIo()
  const expand = (abs: string): string => {
    for (const [short, long] of Object.entries(aliases)) {
      if (abs === short) return long
      if (abs.startsWith(`${short}/`)) return expand(long + abs.slice(short.length))
    }
    return abs
  }
  const volume: FsIo = {
    lstat: (abs) => mem.lstat(expand(abs)),
    readlink: (abs) => mem.readlink(expand(abs)),
    readFile: (abs) => mem.readFile(expand(abs)),
    writeFile: (abs, data) => mem.writeFile(expand(abs), data),
    mkdir: (abs) => mem.mkdir(expand(abs)),
    readdir: (abs) => mem.readdir(expand(abs)),
    rm: (abs, opts) => mem.rm(expand(abs), opts),
    async finalPath(abs) {
      if ((await mem.lstat(expand(abs))) === undefined)
        throw Object.assign(new Error(`ENOENT: ${abs}`), { code: 'ENOENT' })
      return expand(abs)
    },
  }
  return { mem, volume }
}

const LONG = '/vol/longdirectoryname/tmp/ws'
const SHORT = '/vol/LONGDI~1/tmp/ws'

function fixture() {
  const { mem, volume } = shortNameVolume({
    '/vol/LONGDI~1': '/vol/longdirectoryname',
    [`${LONG}/GIT~1`]: `${LONG}/.git`,
  })
  mem.seedFile(`${LONG}/src/a.ts`, 'a')
  mem.seedFile(`${LONG}/.git/config`, 'secret')
  const policy = testFsPolicy(LONG)
  const fs = createFs(() => ({ policy, caseSensitive: true }), volume)
  return { mem, volume, fs }
}

// The memory tree speaks posix paths only; on win32 the fence joins with `\` and the two never meet.
describe.skipIf(process.platform === 'win32')('a volume with short-name aliases', () => {
  it('canonicalizes a short spelling to the one the root was pinned in', async () => {
    const { fs } = fixture()
    await expect(fs.canonicalize(SHORT)).resolves.toBe(LONG)
    await expect(fs.canonicalize(`${SHORT}/src/a.ts`)).resolves.toBe(`${LONG}/src/a.ts`)
    // A leaf that does not exist yet keeps its spelling below the deepest real, expanded prefix.
    await expect(fs.canonicalize(`${SHORT}/src/new.ts`)).resolves.toBe(`${LONG}/src/new.ts`)
  })

  it('admits a short spelling of a path inside the workspace', async () => {
    const { fs } = fixture()
    await expect(fs.read(`${SHORT}/src/a.ts`)).resolves.toEqual(new TextEncoder().encode('a'))
    await expect(fs.resolveInside(SHORT)).resolves.toBe(LONG)
  })

  it('applies a deny to every name of the entry it protects', async () => {
    const { fs } = fixture()
    await expect(fs.read(`${LONG}/.git/config`)).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.read(`${SHORT}/.git/config`)).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.read(`${LONG}/GIT~1/config`)).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.read('GIT~1/config')).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.write('GIT~1/hooks/post-checkout', new Uint8Array())).rejects.toThrow(/E_FS_DENIED/)
  })

  it('opens a Skill read root named by its short spelling', async () => {
    const { mem, volume } = shortNameVolume({ '/vol/LONGDI~1': '/vol/longdirectoryname' })
    mem.seedDir(LONG)
    mem.seedFile('/vol/longdirectoryname/.agh/skills/demo/SKILL.md', 'demo')
    const policy = testFsPolicy(LONG)
    const fs = createFs(
      () => ({ policy, caseSensitive: true }),
      volume,
      () => ['/vol/LONGDI~1/.agh/skills/demo'],
    )
    await expect(fs.read('/vol/longdirectoryname/.agh/skills/demo/SKILL.md')).resolves.toEqual(
      new TextEncoder().encode('demo'),
    )
    await expect(fs.read('/vol/LONGDI~1/.agh/skills/demo/SKILL.md')).resolves.toEqual(
      new TextEncoder().encode('demo'),
    )
    await expect(fs.read('/vol/longdirectoryname/.agh/other.md')).rejects.toThrow(/E_FS_DENIED/)
  })
})

describe('the local io', () => {
  it('resolves final paths natively only on Windows', () => {
    expect(createLocalFsIo(true).finalPath).toBeTypeOf('function')
    expect(createLocalFsIo(false).finalPath).toBeUndefined()
    expect(localFsIo.finalPath !== undefined).toBe(process.platform === 'win32')
  })
})

// The temp directory of a Windows account whose name is longer than eight characters is reached
// through the 8.3 short name of that account's profile directory. Where it is not, these cases still
// hold, with both spellings the same.
describe.runIf(process.platform === 'win32')('the local io on this Windows disk', () => {
  it('canonicalizes a temp directory to the spelling the native resolver gives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-short-name-'))
    try {
      const native = realpathSync.native(dir)
      const fs = createFs(() => ({ policy: testFsPolicy(native), caseSensitive: false }), localFsIo)
      await expect(fs.canonicalize(dir)).resolves.toBe(native)
      await expect(fs.resolveInside(dir)).resolves.toBe(native)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens a session workspace whose root the fence canonicalized from the short spelling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-short-name-'))
    try {
      const native = realpathSync.native(dir)
      const fs = createFs(() => ({ policy: testFsPolicy(native), caseSensitive: false }), localFsIo)
      const factory = createSessionWorkspaceAdapterFactory({
        platform: createPlatform(),
        exec: { run: vi.fn<ExecAdapter['run']>(), killAll: async () => undefined },
      })
      const authority = new CliWorkspaceAuthority(await fs.canonicalize(dir))
      const handle = await factory.openWorkspace(authority.bind('short-name'))
      expect(handle.root).toBe(native)
      const fence = await factory.openFence(handle)
      await expect(fence.fs.resolveInside(dir)).resolves.toBe(native)
      await fence.close()
      await handle.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

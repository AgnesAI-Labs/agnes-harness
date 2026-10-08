import type { FsOps } from '@agnes/core'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceHookLoader } from '../src/workspace-hook-loader.js'

const path = '.agh/hooks.json'
const encoder = new TextEncoder()

function encoded(value: unknown): Uint8Array {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value))
}

function hookDocument(command = 'pnpm test') {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'shell',
          hooks: [{ type: 'command', command, timeout: 30 }],
        },
      ],
    },
  }
}

function fixture(initial: Uint8Array = encoded(hookDocument())) {
  let bytes = initial
  let kind: Awaited<ReturnType<FsOps['stat']>>['kind'] = 'file'
  let mtimeMs = 1
  let missing = false
  const stat = vi.fn(async (requested: string) => {
    expect(requested).toBe(path)
    if (missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return { kind, size: bytes.byteLength, mtimeMs }
  })
  const read = vi.fn(async (requested: string) => {
    expect(requested).toBe(path)
    return Uint8Array.from(bytes)
  })
  return {
    fs: { stat, read },
    stat,
    read,
    setBytes(value: Uint8Array) {
      bytes = value
    },
    setKind(value: typeof kind) {
      kind = value
    },
    setMtime(value: number) {
      mtimeMs = value
    },
    setMissing(value: boolean) {
      missing = value
    },
  }
}

describe('WorkspaceHookLoader', () => {
  it('reads only the exact workspace path and returns one immutable normalized snapshot', async () => {
    const io = fixture()
    const loader = new WorkspaceHookLoader(io.fs, () => 'policy-7')
    const snapshot = await loader.snapshot()

    expect(io.stat).toHaveBeenNthCalledWith(1, path)
    expect(io.read).toHaveBeenCalledWith(path)
    expect(io.stat).toHaveBeenNthCalledWith(2, path)
    expect(snapshot.workspaceDigest).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(snapshot.policyRevision).toBe('policy-7')
    expect(snapshot.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'shell',
        hooks: [{ type: 'command', command: 'pnpm test', timeout: 30 }],
      },
    ])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.hooks)).toBe(true)
    expect(Object.isFrozen((snapshot.hooks[0] as { hooks: unknown[] }).hooks)).toBe(true)
  })

  it('returns an empty snapshot only when the initial exact-path stat reports missing', async () => {
    const io = fixture()
    io.setMissing(true)
    const snapshot = await new WorkspaceHookLoader(io.fs, () => 'policy-1').snapshot()

    expect(snapshot.hooks).toEqual([])
    expect(snapshot.workspaceDigest).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(io.read).not.toHaveBeenCalled()
  })

  // `.agnes` was the workspace directory's name before the `.agh` rename. A hooks file left there is
  // not read, and nothing falls back to it when `.agh/hooks.json` is missing.
  it('reads <ws>/.agh/hooks.json and ignores a legacy <ws>/.agnes/hooks.json', async () => {
    const files = new Map([
      ['.agh/hooks.json', encoded(hookDocument('from agh'))],
      ['.agnes/hooks.json', encoded(hookDocument('from agnes'))],
    ])
    const get = (requested: string): Uint8Array => {
      const bytes = files.get(requested)
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return bytes
    }
    const fs = {
      stat: async (requested: string) => ({
        kind: 'file' as const,
        size: get(requested).byteLength,
        mtimeMs: 1,
      }),
      read: async (requested: string) => Uint8Array.from(get(requested)),
    }
    const snapshot = () => new WorkspaceHookLoader(fs, () => 'policy-1').snapshot()

    expect((await snapshot()).hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'shell',
        hooks: [{ type: 'command', command: 'from agh', timeout: 30 }],
      },
    ])
    files.delete('.agh/hooks.json')
    expect((await snapshot()).hooks).toEqual([])
  })

  it('reuses parsed immutable data by content digest while sampling policy revision per snapshot', async () => {
    const io = fixture()
    let revision = 'policy-1'
    const loader = new WorkspaceHookLoader(io.fs, () => revision)
    const first = await loader.snapshot()
    revision = 'policy-2'
    const second = await loader.snapshot()

    expect(second.hooks).toBe(first.hooks)
    expect(second.workspaceDigest).toBe(first.workspaceDigest)
    expect(second.policyRevision).toBe('policy-2')
  })

  it('samples the policy revision once before starting the asynchronous file read', async () => {
    const io = fixture()
    const order: string[] = []
    io.stat.mockImplementation(async () => {
      order.push('stat')
      const bytes = encoded(hookDocument())
      return { kind: 'file', size: bytes.byteLength, mtimeMs: 1 }
    })
    const loader = new WorkspaceHookLoader(io.fs, () => {
      order.push('policy')
      return 'policy-1'
    })

    await loader.snapshot()
    expect(order).toEqual(['policy', 'stat', 'stat'])
  })

  it.each(['symlink', 'dir', 'other'] as const)('rejects a %s in place of the regular file', async (kind) => {
    const io = fixture()
    io.setKind(kind)
    await expect(new WorkspaceHookLoader(io.fs, () => 'policy-1').snapshot()).rejects.toMatchObject({
      code: 'E_WORKSPACE_UNTRUSTED',
      detail: { reason: 'hooks-not-regular' },
    })
    expect(io.read).not.toHaveBeenCalled()
  })

  it('rejects an oversized file before reading it', async () => {
    const io = fixture(new Uint8Array(256 * 1024 + 1))
    await expect(new WorkspaceHookLoader(io.fs, () => 'policy-1').snapshot()).rejects.toMatchObject({
      code: 'E_WORKSPACE_UNTRUSTED',
      detail: { reason: 'hooks-too-large' },
    })
    expect(io.read).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and never falls back to the prior valid cached snapshot', async () => {
    const io = fixture()
    const loader = new WorkspaceHookLoader(io.fs, () => 'policy-1')
    await expect(loader.snapshot()).resolves.toBeDefined()
    io.setBytes(encoded('{broken'))
    io.setMtime(2)

    await expect(loader.snapshot()).rejects.toMatchObject({
      code: 'E_WORKSPACE_UNTRUSTED',
      detail: { reason: 'hooks-json-invalid' },
    })
  })

  it('rejects malformed hook shapes instead of keeping valid siblings', async () => {
    const io = fixture(
      encoded({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'ok' }] },
            { hooks: [{ type: 'command', command: 42 }] },
          ],
        },
      }),
    )
    await expect(new WorkspaceHookLoader(io.fs, () => 'policy-1').snapshot()).rejects.toMatchObject({
      detail: { reason: 'hooks-shape-invalid' },
    })
  })

  it('rejects a read race when identity changes between the two stats', async () => {
    const io = fixture()
    io.stat
      .mockResolvedValueOnce({ kind: 'file', size: encoded(hookDocument()).byteLength, mtimeMs: 1 })
      .mockResolvedValueOnce({ kind: 'file', size: encoded(hookDocument()).byteLength, mtimeMs: 2 })

    await expect(new WorkspaceHookLoader(io.fs, () => 'policy-1').snapshot()).rejects.toMatchObject({
      code: 'E_WORKSPACE_UNTRUSTED',
      detail: { reason: 'hooks-read-race' },
    })
  })

  it('treats disappearance after the initial stat as a race rather than an empty snapshot', async () => {
    const io = fixture()
    io.read.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(new WorkspaceHookLoader(io.fs, () => 'policy-1').snapshot()).rejects.toMatchObject({
      detail: { reason: 'hooks-read-race' },
    })
  })
})

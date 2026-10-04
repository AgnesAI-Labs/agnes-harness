import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionImpl, WorkspaceInvocationPort } from '@agnes/core'
import { testFsPolicy } from '@agnes/core/testkit'
import type { EnvironmentEpoch } from '@agnes/jev-runtime'
import { expect, it } from 'vitest'
import { createFs } from '../src/adapters/fs.js'
import { observeJevWorkspace } from '../src/runtime/jev-workspace-observation.js'

it('records policy-filtered direct roots with truthful bounded coverage and stat changes using real fenced files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-workspace-'))
  const outside = await mkdtemp(join(tmpdir(), 'agnes-jev-outside-'))
  try {
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await mkdir(join(root, 'child'))
    await writeFile(join(root, 'child', 'nested.txt'), 'never enumerated')
    await mkdir(join(root, '.git'))
    await symlink(outside, join(root, 'escape'))
    const canonicalRoot = await realpath(root)
    const fs = createFs(() => ({
      policy: testFsPolicy(canonicalRoot, { deny: ['.git'] }),
      caseSensitive: true,
    }))
    const calls: string[] = []
    const session = {
      d: {
        cwd: root,
        workspaceInvocation: {
          async run(handler) {
            return handler({
              ready: async () => ({}),
              fs: () => ({
                ...fs,
                list: async (path: string) => {
                  calls.push(path)
                  return fs.list(path)
                },
              }),
            } as never)
          },
        } satisfies WorkspaceInvocationPort,
      },
    } as unknown as SessionImpl
    const epoch = 'epoch' as EnvironmentEpoch
    const observed = await observeJevWorkspace(session, epoch, 10, new AbortController().signal)
    expect(observed).toMatchObject({
      status: 'observed',
      complete: false,
      omitted: 2,
      deniedEntries: 2,
      entries: [
        { path: 'a.txt', kind: 'file', size: 1 },
        { path: 'b.txt', kind: 'file' },
        { path: 'child', kind: 'directory' },
      ],
    })
    expect(JSON.stringify(observed)).not.toContain('nested.txt')
    expect(JSON.stringify(observed)).not.toContain('.git')
    expect(JSON.stringify(observed)).not.toContain('escape')
    expect(calls).toEqual([root])
    const bounded = await observeJevWorkspace(session, epoch, 1, new AbortController().signal)
    expect(bounded).toMatchObject({ complete: false, omitted: 4, entries: [{ path: 'a.txt' }] })
    await writeFile(join(root, 'a.txt'), 'changed bytes')
    const refreshed = await observeJevWorkspace(session, epoch, 10, new AbortController().signal)
    expect(refreshed).not.toEqual(observed)
    await rm(join(root, '.git'), { recursive: true })
    await rm(join(root, 'escape'))
    expect(await observeJevWorkspace(session, epoch, 10, new AbortController().signal)).toMatchObject({
      complete: true,
      omitted: 0,
      deniedEntries: 0,
    })
    const cancelled = new AbortController()
    cancelled.abort(new Error('stop observation'))
    await expect(observeJevWorkspace(session, epoch, 10, cancelled.signal)).rejects.toThrow(
      'stop observation',
    )
    const unavailable = { d: { cwd: root } } as unknown as SessionImpl
    expect(await observeJevWorkspace(unavailable, epoch, 10, new AbortController().signal)).toMatchObject({
      status: 'unavailable',
      complete: false,
      entries: [],
      omitted: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

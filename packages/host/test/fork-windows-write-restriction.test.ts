// A forked session is a session of its own: under the Windows write restriction it opens its own
// workspace runtime, so it gets its own gate, lease, private temporary directory and SID, instead of
// running on its parent's until the last of them closes.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Enforcement, SandboxSeam, SeamWorkspace } from '@agnes/core'
import { afterEach, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

const boundary = {
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
} as const

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A sandbox shell that records every workspace it is fitted to and reports `enforcement` for it. */
function recordingSeam(enforcement: Enforcement) {
  const fitted: SeamWorkspace[] = []
  const seam: SandboxSeam = {
    async forWorkspace(workspace) {
      fitted.push(workspace)
      const backend = await workspace.readiness.ready(workspace.signal)
      return Object.freeze<SandboxSeam>({
        forWorkspace: seam.forWorkspace,
        exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
        confine: async (argv) => [...(await backend.confine({ argv, cwd: workspace.root }))],
        fsPolicy: () => workspace.policy,
        enforcement: () => enforcement,
      })
    },
    exec: async () => {
      throw new Error('unbound')
    },
    confine: async () => {
      throw new Error('unbound')
    },
    fsPolicy: () => {
      throw new Error('unbound')
    },
    enforcement: () => ({ level: 'none', scope: [] }),
  }
  return { seam, fitted }
}

async function forkOnce(enforcement: Enforcement, roleParent = false) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-fork-runtime-')))
  dirs.push(dataDir)
  const { seam, fitted } = recordingSeam(enforcement)
  const h = await createTestHost({
    dataDir,
    allowed: ['standard'],
    sandboxSeam: seam,
    disableSessionTitle: true,
    script: [
      () => [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  try {
    const parent = await h.host.createSession({ key: 'fork-parent', cwd: dataDir, preset: 'standard' })
    await parent.enqueue('next-turn', {
      content: [{ type: 'text', text: 'establish boundary' }],
      actor: parent.d.actor,
    })
    await parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15_000) })
    const [end] = await parent.scan({ type: 'turn/end', order: 'desc', limit: 1 })
    if (!end) throw new Error('No parent turn boundary')
    if (roleParent) {
      // A role session: its fence comes from a captured delegation its fork would not carry.
      await parent.append([
        parent.ev(
          'x/core/role-delegation',
          { role: { ref: 'fixture#role' } },
          {
            register: 'x/core/role-delegation',
            ignorable: true,
          },
        ),
      ])
      await expect(
        h.host.createSession({
          key: 'fork-child',
          cwd: dataDir,
          parent: { key: parent.key, boundarySeq: end.seq },
        }),
      ).rejects.toMatchObject({
        code: 'E_WORKSPACE_UNTRUSTED',
        detail: { reason: 'fork-windows-role-session' },
      })
      await parent.close()
      return { opened: fitted.slice(1), parentFit: fitted[0] }
    }
    const before = fitted.length
    const fork = await h.host.createSession({
      key: 'fork-child',
      cwd: dataDir,
      parent: { key: parent.key, boundarySeq: end.seq },
    })
    const opened = fitted.slice(before)
    // The fork still continues its parent's conversation.
    expect(fork.d.log.parent).toMatchObject({ key: parent.key, boundarySeq: end.seq })
    await parent.close()
    // Closing the parent leaves the fork usable.
    expect(fork.d.runtime.enforcement()).toEqual(enforcement)
    await fork.close()
    return { opened, parentFit: fitted[0] }
  } finally {
    await h.host.close()
  }
}

it('opens its own runtime for a fork of a session under the Windows write restriction', async () => {
  const { opened, parentFit } = await forkOnce({ level: 'partial', scope: ['file'], boundary })
  expect(opened).toHaveLength(1)
  const [own] = opened
  // Its own fitted workspace, bound for the fork's own key, with the same root and policy.
  expect(own).not.toBe(parentFit)
  expect(own?.root).toBe(parentFit?.root)
  expect(own?.policy.digest).toBe(parentFit?.policy.digest)
})

it('keeps sharing the parent runtime everywhere else', async () => {
  for (const enforcement of [
    { level: 'full', scope: ['file', 'network', 'process'] },
    { level: 'partial', scope: ['file'] },
  ] as Enforcement[]) {
    const { opened } = await forkOnce(enforcement)
    expect(opened).toEqual([])
  }
})

it('refuses, rather than shares, a fork of a role session under the Windows write restriction', async () => {
  const { opened } = await forkOnce({ level: 'partial', scope: ['file'], boundary }, true)
  expect(opened).toEqual([])
})

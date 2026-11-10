import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { afterEach, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('announces sessions opened on a generation built after the listener subscribed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-generation-opened-'))
  roots.push(root)
  const delivered = buildCompleteRuntimeTarget({ rows: [], resources: { mcp: [], skills: {} } }).target
  const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    const boot = host.runtimeTargetSnapshot?.()
    if (!boot) throw new Error('test host has no runtime target')
    const opened: string[] = []
    const off = host.kernel.onSessionOpened((session) => void opened.push(session.key))
    await host.applyRuntimeTarget(delivered)
    const first = await host.createSession({ key: 'first', cwd: root })
    // A code change with a bound session forks a container; the next session opens on the new one.
    await host.applyRuntimeTarget(boot)
    expect(host.lastChange?.()).toMatchObject({ outcome: 'forked' })
    const second = await host.createSession({ key: 'second', cwd: root })
    expect(second.pluginGenerationId).not.toBe(first.pluginGenerationId)
    expect(opened).toEqual(['first', 'second'])
    off()
    await host.createSession({ key: 'third', cwd: root })
    expect(opened).toEqual(['first', 'second'])
    await first.close()
    await second.close()
  } finally {
    await host.close()
  }
})

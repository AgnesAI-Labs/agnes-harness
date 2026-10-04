import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { fakeProvider, textTurn } from '@agnes/core/testkit'
import type { ComparisonRecord } from '@agnes/runtime-comparison'
import { afterEach, expect, it, vi } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
import { createComparisonRetirement } from '../src/runtime/comparison-retirement.js'
import { createComparisonStore } from '../src/runtime/comparison-store.js'
import { createComparisonWorkspaces } from '../src/runtime/comparison-workspaces.js'
import { CliWorkspaceAuthority } from '../src/workspace-authority.js'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing evidence')
  return value
}

it.each(['spawn', 'fork'] as const)(
  'releases a real Host %s subtree with complete history, retries after purge, then explicitly removes only history',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-retirement-owner-'))
    dirs.push(root)
    const source = join(root, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'user.txt'), 'preserve source')
    const dataDir = join(root, 'data')
    const snapshots = createComparisonWorkspaces({
      directory: join(root, 'snapshots'),
      authorizeRead: async () => undefined,
    })
    const baseline = await snapshots.prepare({ comparisonId: 'pair', cwd: source })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      disableSessionTitle: true,
      provider: {
        models: () => [fakeModel({ route: 'gw', id: 'm1' })],
        async *infer(request, options) {
          yield* fakeProvider([textTurn('DONE')], '2').infer(request, options)
        },
      },
      presets: {
        children: {
          name: 'children',
          extends: 'base',
          model: { route: { primary: 'gw' }, id: { primary: 'm1' } },
          subagent: {
            max_depth: 2,
            max_fan_out: 4,
            isolation: 'shared',
            budget_inherit: 'aggregate',
            tree_budget_credits: 'unlimited',
          },
        },
      },
      allowed: ['base', 'standard', 'children'],
    })
    let ledger = createSqliteStorage({ file: join(dataDir, 'sessions.db') })
    const index = join(dataDir, 'comparisons', 'index.sqlite')
    let comparisons = createComparisonStore(index)
    let scoped = comparisons.scoped('owner')
    try {
      const left = await host.createSession({
        key: 'left-root',
        binding: new CliWorkspaceAuthority(baseline.roots.left).bind('left-root'),
        cwd: baseline.roots.left,
        preset: 'children',
      })
      const right = await host.createSession({
        key: 'right-root',
        binding: new CliWorkspaceAuthority(baseline.roots.right).bind('right-root'),
        cwd: baseline.roots.right,
        preset: 'children',
      })
      if (kind === 'fork') {
        await left.enqueue('next-turn', {
          actor: left.d.actor,
          content: [{ type: 'text', text: 'PARENT BEFORE FORK' }],
        })
        await left.run({ until: 'turn-end', signal: new AbortController().signal })
      }
      const child = required(
        await left.d.children.createWithKind?.(kind, {
          parent: left.key,
          cwd: baseline.roots.left,
          input: 'CHILD',
          isolation: 'shared',
        }),
      )
      await child.run('CHILD')
      await vi.waitFor(() => expect(host.kernel.get(child.key)).toBeUndefined())
      await vi.waitFor(async () => {
        expect(left.executionActive).toBe(false)
        expect((left.latest('inbox') as { items?: unknown[] } | undefined)?.items ?? []).toEqual([])
      })
      const originalChild = await ledger.scanIntegrity(child.key, { fromSeq: 1, toSeq: 100_000, limit: 500 })
      expect(originalChild.length).toBeGreaterThan(1)
      const liveTreeCut = await ledger.captureComparisonTree(left.key)
      expect(liveTreeCut).toMatchObject({ complete: true, issues: [] })
      expect(liveTreeCut.members).toHaveLength(2)
      expect(liveTreeCut.members.find((member) => member.sessionId === child.key)).toMatchObject({
        parentSessionId: left.key,
        inheritedThroughSeq: (originalChild.find((row) => row.sessionKey === child.key)?.event.seq ?? 1) - 1,
        throughSeq: originalChild.length,
        runtime: left.runtimeIdentity,
      })
      const initial: ComparisonRecord = {
        id: 'pair',
        revision: 0,
        createPayload: 'private prompt',
        creation: 'ready',
        baseline,
        lanes: {
          left: {
            side: 'left',
            sessionId: left.key,
            runtime: left.runtimeIdentity,
            workspaceLabel: 'left',
            phase: 'idle',
            lastSeq: left.lastSeq,
          },
          right: {
            side: 'right',
            sessionId: right.key,
            runtime: right.runtimeIdentity,
            workspaceLabel: 'right',
            phase: 'idle',
            lastSeq: right.lastSeq,
          },
        },
        rounds: [],
        cancellation: {},
        cleanup: { exited: [], released: false },
      }
      await scoped.compareAndSwap('pair', null, initial)
      let failSnapshot = true
      const ports = {
        store: scoped,
        ledger,
        async closeOwner(owner: { sessionKey: string; writerRunId: string; ownerEpoch: number }) {
          const session = host.kernel.get(owner.sessionKey)
          if (
            !session ||
            session.writerRunId !== owner.writerRunId ||
            session.d.log.ownerEpoch !== owner.ownerEpoch
          )
            throw new Error('exact owner unavailable')
          await session.close()
        },
        async releaseSnapshots() {
          if (failSnapshot) throw new Error('snapshot boundary interrupted')
          await snapshots.release('pair')
        },
      }
      const driver = createComparisonRetirement(ports)
      expect((await driver.readiness('pair')).trees[0]?.members).toHaveLength(2)
      expect((await scoped.read('pair'))?.retirement).toBeUndefined()
      await expect(driver.release('pair')).rejects.toMatchObject({ code: 'COMPARISON_RETIREMENT_REQUIRED' })
      await scoped.compareAndSwap('pair', 0, {
        ...initial,
        revision: 1,
        retirement: { state: 'releasing', epoch: 1 },
      })
      await expect(driver.release('pair')).rejects.toMatchObject({ code: 'COMPARISON_IDLE_SEAL_REQUIRED' })
      const ready = await driver.readiness('pair')
      const members = ready.trees.flatMap((tree) => tree.ownerEvidence.map((row) => required(row.evidence)))
      const idle = await host.sessionIdleGates.acquire({ members: members.map((row) => row.owner) })
      try {
        await host.sessionIdleGates.check(idle.token)
        await ledger.sealIdleSessionTrees(
          ready.trees.map((tree, index) => ({
            rootSessionKey: tree.rootSessionKey,
            retirementId: `comparison:pair:${index === 0 ? 'left' : 'right'}`,
            epoch: 1,
            expectedOwners: tree.ownerEvidence.map((row) => required(row.evidence)),
          })),
        )
      } finally {
        await host.sessionIdleGates.release(idle.token)
      }
      await expect(driver.release('pair')).rejects.toThrow('snapshot boundary interrupted')
      expect(await ledger.scan(child.key, { limit: 10 })).toEqual([])
      const archived = required(scoped.treeArchive.read('pair', 'left'))
      expect(archived.members.find((member) => member.sessionKey === child.key)?.rows).toEqual(originalChild)
      const cut = required(await scoped.journal.head('pair'))
      expect(scoped.archive.read('pair', 'left')?.rows.length).toBe(cut.cuts.left)
      expect(existsSync(baseline.roots.left)).toBe(true)
      expect((await scoped.read('pair'))?.retirement?.state).toBe('releasing')
      await host.close()
      await ledger.close()
      comparisons.close()
      ledger = createSqliteStorage({ file: join(dataDir, 'sessions.db') })
      comparisons = createComparisonStore(index)
      scoped = comparisons.scoped('owner')
      failSnapshot = false
      const recovered = createComparisonRetirement({
        ...ports,
        store: scoped,
        ledger,
        closeOwner: async () => {
          throw new Error('must not reopen owners')
        },
      })
      expect((await recovered.release('pair')).retirement?.state).toBe('released')
      expect(await scoped.journal.cutsAt('pair', cut.seq)).toEqual(cut.cuts)
      expect(scoped.treeArchive.read('pair', 'left')).toEqual(archived)
      expect(existsSync(baseline.roots.left)).toBe(false)
      expect(existsSync(join(source, 'user.txt'))).toBe(true)
      expect((await recovered.remove('pair')).retirement?.state).toBe('removed')
      expect(scoped.archive.read('pair', 'left')).toBeUndefined()
      expect(scoped.treeArchive.read('pair', 'left')).toBeUndefined()
      expect((await scoped.list()).items).toEqual([])
      expect((await scoped.read('pair'))?.createPayload).toBe('')
      expect(comparisons.comparisonSessionIds().sort()).toEqual([left.key, right.key].sort())
      await expect(ledger.open(left.key, { writerRunId: 'late', ttlMs: 1000 })).rejects.toMatchObject({
        code: 'E_CLOSED',
      })
      comparisons.close()
      comparisons = createComparisonStore(index)
      expect(comparisons.comparisonSessionIds().sort()).toEqual([left.key, right.key].sort())
      expect((await comparisons.scoped('owner').list()).items).toEqual([])
      expect(await comparisons.scoped('owner').compareAndSwap('pair', null, initial)).toBe(false)
    } finally {
      await host.close()
      await ledger.close()
      comparisons.close()
    }
  },
)

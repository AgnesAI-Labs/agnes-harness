import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityCheckpoint,
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityRoute,
  DataRef,
  JsonValue,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConformanceHarness, SCENARIOS } from '../../../../packages/extension-api/testkit/index.js'
import { inlineData } from '../../../../packages/host/src/runtime/maintenance/authority-publication.js'
import * as buildIdentity from '../../../../tools/acceptance/runtime/build-identity.js'
import { bindAuthorityDirectoryContracts } from '../../../../tools/acceptance/runtime/platform/authority-directory-conformance.js'
import {
  createReferenceAnchor,
  createReferenceAuthorityDirectory,
  readReferenceAnchor,
} from './authority-directory.ts'

const probe = vi.hoisted(() => ({ platform: null as string | null }))
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>()
  return { ...os, platform: () => probe.platform ?? os.platform() }
})
vi.mock('@agnes/system-node', async (original) => {
  const system = await original<typeof import('@agnes/system-node')>()
  return {
    ...system,
    windowsVolumeInfoSync: (path: string) =>
      probe.platform === 'win32'
        ? { filesystem: 'NTFS', driveType: 3, readOnly: false }
        : system.windowsVolumeInfoSync(path),
    windowsReplaceFileSync: (from: string, to: string) => {
      if (probe.platform !== 'win32') return system.windowsReplaceFileSync(from, to)
      renameSync(from, to)
      system.syncFileSync(to)
    },
    syncDirectorySync: (path: string) => {
      if (probe.platform === 'win32') throw new Error('Windows directory flush unavailable')
      return system.syncDirectorySync(path)
    },
  }
})
afterEach(() => {
  probe.platform = null
  vi.restoreAllMocks()
})

const fixture = fileURLToPath(
  new URL('../../../../tools/acceptance/runtime/fixtures/authority-directory-process.ts', import.meta.url),
)
const repo = fileURLToPath(new URL('../../../..', import.meta.url))
const PRINCIPAL = 'maintainer'
const AUTHORITY = { authorityId: 'directory-authority', tenantId: 'tenant-a', authorityEpoch: 1 }
const STATE_BINDING = {
  bindingId: 'state-binding',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'agh.default/state',
}
const COHORT = '11'.repeat(32)

function context(): CallContext {
  return {
    principalRef: PRINCIPAL,
    scope: { kind: 'installation', installationId: 'install-1' },
    bindingId: 'binding-1',
    invocationId: 'invoke-1',
    deadline: '2099-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'authz-1',
    signal: new AbortController().signal,
  }
}

function detail(outcome: Outcome<unknown>): string {
  return outcome.ok ? 'ok' : `${outcome.error.code}/${outcome.error.detailCode}`
}

function checkpoint(authorityId: string, epoch: number): AuthorityCheckpoint {
  return {
    authorityId,
    authorityEpoch: epoch,
    checkpointId: `checkpoint-${authorityId}-${String(epoch)}`,
    snapshotDigest: '33'.repeat(32),
    recordCount: 1,
    bridgeWatermarks: [],
  }
}

function makeRoute(): AuthorityRoute {
  return {
    logicalAuthorityId: 'state-auth',
    tenantId: 'tenant-a',
    authorityEpoch: 1,
    providerBinding: STATE_BINDING,
    locationRef: 'loc-state-auth-1',
    cohortDigest: COHORT,
    cutoverId: 'seed-state-auth',
    checkpoint: checkpoint('state-auth', 1),
    previous: null,
  }
}

function validation(): DataRef {
  return inlineData({ accepted: true } as JsonValue, 'agh.maintenance/validation@1')
}

function lockRef(): DataRef {
  return inlineData({ lock: 'directory' } as JsonValue, 'agh.maintenance/provider-lock@1')
}

function requestFor(
  route: AuthorityRoute,
  cutoverId = 'cutover-1',
  cohort = COHORT,
  proof: DataRef = validation(),
): AuthorityDirectoryCompareAndSwapRequest {
  return {
    transactionId: cutoverId,
    authority: AUTHORITY,
    expectedWriterEpoch: 1,
    publication: {
      upgradeId: 'upgrade-1',
      cutoverId,
      changes: [
        {
          expectedRevision: 1,
          previous: route,
          next: {
            ...route,
            authorityEpoch: 2,
            locationRef: 'loc-state-auth-2',
            cohortDigest: cohort,
            cutoverId,
            checkpoint: checkpoint('state-auth', 2),
            previous: { authorityEpoch: 1, locationRef: route.locationRef, cutoverId: route.cutoverId },
          },
        },
      ],
      sourceFences: [
        {
          upgradeId: 'upgrade-1',
          source: { authorityId: 'state-auth', tenantId: 'tenant-a', authorityEpoch: 1 },
          fenceId: `fence-${cutoverId}-state-auth`,
          fenceEpoch: 1,
          checkpoint: route.checkpoint,
          writerCredentialsRevoked: true,
        },
      ],
      validationRef: proof,
      jointDispatchMappings: [],
    },
  }
}

async function prepared(): Promise<{
  root: string
  directory: string
  anchor: string
  route: AuthorityRoute
  proof: DataRef
  request: AuthorityDirectoryCompareAndSwapRequest
}> {
  const tree = mkdtempSync(join(tmpdir(), 'authority-directory-ref-e2e-'))
  const directory = join(tree, 'dir')
  const anchor = join(tree, 'anchor')
  const created = createReferenceAnchor(
    anchor,
    {
      directoryId: 'directory-1',
      providerLockRef: lockRef(),
      endpointRef: directory,
      epoch: 1,
      revision: 1,
      cutoverId: 'locator-1',
    },
    PRINCIPAL,
  )
  expect(detail(created)).toBe('ok')
  const provider = createReferenceAuthorityDirectory({ directory, anchor, authority: AUTHORITY })
  const route = makeRoute()
  const proof = validation()
  expect(detail(await provider.seedRoute(route, context()))).toBe('ok')
  expect(
    detail(
      await provider.approveUpgrade(
        { upgradeId: 'upgrade-1', validationRef: proof, authorityIds: ['state-auth'] },
        context(),
      ),
    ),
  ).toBe('ok')
  await provider.dispose()
  return {
    root: tree,
    directory,
    anchor,
    route,
    proof,
    request: requestFor(route, 'cutover-1', COHORT, proof),
  }
}

function runChild(
  args: readonly string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, ...args], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (!settled) {
        settled = true
        reject(new Error(`reference directory child timed out\n${stderr}\n${stdout}`))
      }
    }, 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => finish({ code, signal }))
  })
}

function startChild(args: readonly string[]): {
  ready: Promise<void>
  done: Promise<{ stdout: string; stderr: string }>
  child: ChildProcess
} {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, ...args], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`reference racer timed out\n${stderr}\n${stdout}`))
    }, 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('READY\n')) markReady()
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve({ stdout, stderr })
    })
  })
  return { ready, done, child }
}

async function revisionAt(directory: string, anchor: string): Promise<number> {
  const provider = createReferenceAuthorityDirectory({ directory, anchor, authority: AUTHORITY })
  const read = await provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())
  await provider.dispose()
  expect(detail(read)).toBe('ok')
  if (!read.ok || read.value.kind !== 'authority') return 0
  return read.value.revision
}

describe('reference authority directory process durability', () => {
  it('keeps a committed route when killed after the sqlite commit and the old route before it', async () => {
    for (const phase of ['transaction', 'commit', 'notify'] as const) {
      const opened = await prepared()
      const payload = join(opened.root, 'payload.json')
      try {
        writeFileSync(
          payload,
          JSON.stringify({
            implementation: 'reference',
            authority: AUTHORITY,
            principalRef: PRINCIPAL,
            phase,
            request: opened.request,
          }),
        )
        const killed = await runChild(['kill', opened.directory, opened.anchor, payload])
        expect(killed.signal, `${phase}\n${killed.stderr}\n${killed.stdout}`).toBe('SIGKILL')
        expect(await revisionAt(opened.directory, opened.anchor)).toBe(phase === 'transaction' ? 1 : 2)
        if (phase === 'transaction') continue
        const provider = createReferenceAuthorityDirectory({
          directory: opened.directory,
          anchor: opened.anchor,
          authority: AUTHORITY,
        })
        const replay = await provider.compareAndSwap(opened.request, context())
        await provider.dispose()
        expect(detail(replay)).toBe('ok')
        expect(replay.ok && replay.value.routes[0]?.revision).toBe(2)
      } finally {
        rmSync(opened.root, { recursive: true, force: true })
      }
    }
  }, 90_000)

  it.each(['route', 'locator'] as const)(
    'lets exactly one of two processes publish the same %s revision',
    async (kind) => {
      const opened = await prepared()
      const leftPayload = join(opened.root, 'left.json')
      const rightPayload = join(opened.root, 'right.json')
      const go = join(opened.root, 'go')
      const children: ChildProcess[] = []
      try {
        const view = readReferenceAnchor(opened.anchor)
        expect(view.ok && view.value).toBeTruthy()
        if (!view.ok || !view.value) throw new Error('Reference anchor missing')
        const locator = view.value.locator
        const locatorPublication = (cutoverId: string) =>
          kind === 'route'
            ? {}
            : {
                locatorPublication: {
                  expectedRevision: 1,
                  next: { ...locator, epoch: 2, revision: 2, cutoverId },
                },
              }
        const shared = {
          implementation: 'reference' as const,
          authority: AUTHORITY,
          principalRef: PRINCIPAL,
          phase: null,
        }
        writeFileSync(
          leftPayload,
          JSON.stringify({
            ...shared,
            ...locatorPublication('cutover-a'),
            request: requestFor(opened.route, 'cutover-a', COHORT, opened.proof),
          }),
        )
        writeFileSync(
          rightPayload,
          JSON.stringify({
            ...shared,
            ...locatorPublication('cutover-b'),
            request: requestFor(opened.route, 'cutover-b', '22'.repeat(32), opened.proof),
          }),
        )
        const left = startChild(['race', opened.directory, opened.anchor, leftPayload, go])
        const right = startChild(['race', opened.directory, opened.anchor, rightPayload, go])
        children.push(left.child, right.child)
        await Promise.all([left.ready, right.ready])
        writeFileSync(go, 'go')
        const finished = await Promise.all([left.done, right.done])
        const endings = finished
          .map((item) =>
            item.stdout
              .split('\n')
              .filter((line) => line !== '')
              .at(-1),
          )
          .sort()
        expect(endings, finished.map((item) => item.stderr).join('\n')).toEqual([
          kind === 'route' ? 'LOSE conflict/revision_mismatch' : 'LOSE conflict/locator_revision',
          'WIN',
        ])
        if (kind === 'route') expect(await revisionAt(opened.directory, opened.anchor)).toBe(2)
        else {
          const current = readReferenceAnchor(opened.anchor)
          expect(current.ok && current.value?.locator).toMatchObject({ revision: 2, epoch: 2 })
          expect(current.ok && current.value?.locator.cutoverId).toMatch(/^cutover-(a|b)$/)
        }
      } finally {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }
        rmSync(opened.root, { recursive: true, force: true })
      }
    },
    60_000,
  )
  it('executes all six Windows scenarios for each provider and reports the durability limit', async () => {
    probe.platform = 'win32'
    const build = buildIdentity.getConformanceBuildIdentity()
    vi.spyOn(buildIdentity, 'getConformanceBuildIdentity').mockReturnValue({
      ...build,
      platform: 'win32-test',
    })
    const harness = createConformanceHarness()
    await bindAuthorityDirectoryContracts(harness, 'windows-injected', ['default', 'reference'])
    const report = await harness.run({
      contracts: ['agh.authority-directory'],
      providers: ['default', 'reference'],
      command: 'windows-injected',
      clock: { startedAt: '2026-10-03T00:00:00.000Z', finishedAt: '2026-10-03T00:00:01.000Z' },
    })
    expect(report.assertions).toHaveLength(12)
    for (const providerId of ['default', 'reference']) {
      const rows = report.assertions.filter((row) => row.providerId === providerId)
      expect(rows.map((row) => row.scenario)).toEqual([...SCENARIOS])
      expect(
        rows.every(
          (row) =>
            row.status === 'passed' &&
            row.diagnostic?.includes('no POSIX parent-directory fsync equivalence'),
        ),
      ).toBe(true)
    }
    expect(report.failures).toEqual([])
  })
})

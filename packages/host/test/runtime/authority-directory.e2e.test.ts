import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityCheckpoint,
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityFence,
  AuthorityRoute,
  DataRef,
  JsonValue,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { readStageZero } from '../../src/runtime/maintenance/bootstrap-locator.js'
import {
  type AuthorityDirectoryProvider,
  createAuthorityDirectoryProvider,
  createDirectoryAnchor,
  type DurabilityPhase,
} from '../../src/runtime/providers/authority-directory.js'

const fixture = fileURLToPath(
  new URL('../../../../tools/acceptance/runtime/fixtures/authority-directory-process.ts', import.meta.url),
)
const root = fileURLToPath(new URL('../../../..', import.meta.url))
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

function makeRoute(
  id: string,
  epoch: number,
  cutoverId: string,
  previous: AuthorityRoute['previous'],
  cohort = COHORT,
): AuthorityRoute {
  return {
    logicalAuthorityId: id,
    tenantId: 'tenant-a',
    authorityEpoch: epoch,
    providerBinding: STATE_BINDING,
    locationRef: `loc-${id}-${String(epoch)}`,
    cohortDigest: cohort,
    cutoverId,
    checkpoint: checkpoint(id, epoch),
    previous,
  }
}

function validation(): DataRef {
  return inlineData({ accepted: true } as JsonValue, 'agh.maintenance/validation@1')
}

function lockRef(): DataRef {
  return inlineData({ lock: 'directory' } as JsonValue, 'agh.maintenance/provider-lock@1')
}

function fenceFor(route: AuthorityRoute, cutoverId: string): AuthorityFence {
  return {
    upgradeId: 'upgrade-1',
    source: {
      authorityId: route.logicalAuthorityId,
      tenantId: route.tenantId,
      authorityEpoch: route.authorityEpoch,
    },
    fenceId: `fence-${cutoverId}-${route.logicalAuthorityId}`,
    fenceEpoch: route.authorityEpoch,
    checkpoint: route.checkpoint,
    writerCredentialsRevoked: true,
  }
}

function requestFor(
  route: AuthorityRoute,
  cutoverId: string,
  cohort: string,
  proof: DataRef,
): AuthorityDirectoryCompareAndSwapRequest {
  const next = makeRoute(
    'state-auth',
    2,
    cutoverId,
    {
      authorityEpoch: route.authorityEpoch,
      locationRef: route.locationRef,
      cutoverId: route.cutoverId,
    },
    cohort,
  )
  return {
    transactionId: cutoverId,
    authority: AUTHORITY,
    expectedWriterEpoch: 1,
    publication: {
      upgradeId: 'upgrade-1',
      cutoverId,
      changes: [{ expectedRevision: 1, previous: route, next }],
      sourceFences: [fenceFor(route, cutoverId)],
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
  const tree = mkdtempSync(join(tmpdir(), 'authority-directory-e2e-'))
  const directory = join(tree, 'dir')
  const anchor = join(tree, 'anchor')
  const created = createDirectoryAnchor(
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
  const provider: AuthorityDirectoryProvider = createAuthorityDirectoryProvider({
    directory,
    anchor,
    authority: AUTHORITY,
  })
  const route = makeRoute('state-auth', 1, 'seed-state-auth', null)
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
  phase: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let killRequested = false
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
        reject(new Error(`authority directory child timed out\n${stderr}\n${stdout}`))
      }
    }, 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!killRequested && stdout.includes(`PHASE ${phase}\n`)) {
        killRequested = child.kill('SIGKILL')
      }
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
    child.on('close', (code, signal) => finish({ code, signal }))
  })
}

function startChild(args: readonly string[]): {
  ready: Promise<void>
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>
  child: ChildProcess
} {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let markReady: () => void = () => {}
  let failReady: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve
    failReady = reject
  })
  const done = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`authority directory racer timed out\n${stderr}\n${stdout}`))
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
      failReady(error)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!stdout.includes('READY\n')) failReady(new Error(`racer exited before READY\n${stderr}\n${stdout}`))
      resolve({ code, signal, stdout, stderr })
    })
  })
  return { ready, done, child }
}

async function revisionAt(directory: string, anchor: string): Promise<number> {
  const provider = createAuthorityDirectoryProvider({ directory, anchor, authority: AUTHORITY })
  const read = await provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())
  await provider.dispose()
  expect(detail(read)).toBe('ok')
  if (!read.ok || read.value.kind !== 'authority') return 0
  return read.value.revision
}

describe('authority directory process durability', () => {
  it('keeps the old route when killed before the pointer rename and the new route after it', async () => {
    for (const phase of [
      'temp',
      'fsync',
      'rename',
      'commit',
      'notify',
    ] as const satisfies readonly DurabilityPhase[]) {
      const opened = await prepared()
      const payload = join(opened.root, 'payload.json')
      try {
        writeFileSync(
          payload,
          JSON.stringify({
            implementation: 'default',
            authority: AUTHORITY,
            principalRef: PRINCIPAL,
            phase,
            request: opened.request,
          }),
        )
        const killed = await runChild(['kill', opened.directory, opened.anchor, payload], phase)
        expect(killed.stdout.trim(), killed.stderr).toBe(`PHASE ${phase}`)
        expect(killed.signal, `${phase}\n${killed.stderr}\n${killed.stdout}`).toBe('SIGKILL')
        const revision = await revisionAt(opened.directory, opened.anchor)
        const durable = phase === 'commit' || phase === 'notify'
        expect(revision).toBe(durable ? 2 : 1)
        if (!durable) continue
        const provider = createAuthorityDirectoryProvider({
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
  }, 120_000)

  it('lets exactly one deployment publisher replace the same external locator revision', async () => {
    const opened = await prepared()
    const go = join(opened.root, 'locator-go')
    const children: ChildProcess[] = []
    try {
      const view = readStageZero(opened.anchor)
      expect(view.ok && view.value).toBeTruthy()
      if (!view.ok || !view.value) return
      const racers = ['locator-left', 'locator-right'].map((cutoverId) => {
        const payload = join(opened.root, `${cutoverId}.json`)
        writeFileSync(
          payload,
          JSON.stringify({
            implementation: 'default',
            authority: AUTHORITY,
            principalRef: PRINCIPAL,
            phase: null,
            request: opened.request,
            locatorPublication: {
              expectedRevision: 1,
              next: { ...view.value?.locator, epoch: 2, revision: 2, cutoverId },
            },
          }),
        )
        const racer = startChild(['race', opened.directory, opened.anchor, payload, go])
        children.push(racer.child)
        return racer
      })
      await Promise.all(racers.map((racer) => racer.ready))
      writeFileSync(go, 'go')
      const results = await Promise.all(racers.map((racer) => racer.done))
      expect(
        results.flatMap((result) => result.stdout.split('\n').filter((line) => line === 'WIN')),
      ).toHaveLength(1)
      expect(
        results.flatMap((result) =>
          result.stdout.split('\n').filter((line) => line === 'LOSE conflict/locator_revision'),
        ),
      ).toHaveLength(1)
      const current = readStageZero(opened.anchor)
      expect(current.ok && current.value?.locator.revision).toBe(2)
      expect(current.ok && current.value?.locator.cutoverId).toMatch(/^locator-(left|right)$/)
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(opened.root, { recursive: true, force: true })
    }
  }, 30_000)

  it('lets exactly one of two processes publish a different cutover of the same revision', async () => {
    const opened = await prepared()
    const leftPayload = join(opened.root, 'left.json')
    const rightPayload = join(opened.root, 'right.json')
    const go = join(opened.root, 'go')
    const children: ChildProcess[] = []
    try {
      const shared = {
        implementation: 'default' as const,
        authority: AUTHORITY,
        principalRef: PRINCIPAL,
        phase: null,
      }
      writeFileSync(
        leftPayload,
        JSON.stringify({
          ...shared,
          request: requestFor(opened.route, 'cutover-a', COHORT, opened.proof),
        }),
      )
      writeFileSync(
        rightPayload,
        JSON.stringify({
          ...shared,
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
        'LOSE conflict/revision_mismatch',
        'WIN',
      ])
      expect(await revisionAt(opened.directory, opened.anchor)).toBe(2)
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      rmSync(opened.root, { recursive: true, force: true })
    }
  }, 60_000)
})

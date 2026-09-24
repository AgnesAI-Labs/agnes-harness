import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serviceFixture } from '@agnes/extension-api/testkit'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginRowSource } from '../../src/ext-host/row-extension-host.js'
import { isServicePreDispatchFailure } from '../../src/ext-host/service-invocation.js'
import { PublicationGate } from '../../src/publication-gate.js'
import { createTestHost, type TestHost } from '../../testkit/index.js'

const held: { root: string; host: TestHost['host'] }[] = []
const packageId = '@agnes-test/service'
const rowId = 'ext:fixture/service'
const owner = pluginRowSource(rowId)
const snapshotId = `sha256-${'8'.repeat(64)}`
afterEach(async () => {
  for (const h of held.splice(0)) {
    await h.host.close()
    rmSync(h.root, { recursive: true, force: true })
  }
})

async function fixture(authorized = true) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-services-'))
  const pkg = join(root, 'package')
  mkdirSync(pkg, { recursive: true })
  const { handler: _, ...cap } = serviceFixture()
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: packageId,
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
      agnes: { plugins: [{ id: rowId, export: 'main', services: [cap.name] }] },
    }),
  )
  writeFileSync(
    join(pkg, 'index.mjs'),
    `export const main = { apply(ctx) { ctx.services.register({ ...${JSON.stringify(cap)}, async handler(input, serviceCtx) {
    if (input.value === 2) await serviceCtx.fs.write('forbidden-write', 'no');
    if (input.value === 3) return {value: (await serviceCtx.fs.read('read.txt')).length};
    if (input.value === 4) await serviceCtx.fs.read('../outside');
    if (input.value === 5) await serviceCtx.exec(['touch', 'forbidden-exec']);
    if (input.value === 6) await new Promise((resolve) => setTimeout(resolve, 40));
    return {value: input.value};
  } }); } };`,
  )
  writeFileSync(join(root, 'read.txt'), 'test')
  const source: RuntimePluginSnapshot = {
    snapshot: {
      snapshotId,
      profile: 'local-dev',
      packageId,
      version: '1.0.0',
      integrity: snapshotId,
      treeIntegrity: hashDirectory(pkg, { exclude: [] }),
      capabilityHash: 'fixture',
      directory: pkg,
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const result = await createTestHost({
    dataDir: root,
    script: [],
    runtimePluginCatalogue: [source],
    extensionLoader: {
      import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
    },
    ...(authorized
      ? {
          serviceAuthority: {
            async resolve() {
              return {
                source: 'surface',
                subjectCredential: 'trusted',
                grants: [{ extension: owner, name: cap.name, range: '^1.0' }],
              }
            },
          },
        }
      : {}),
  })
  await result.host.applyRuntimeTarget(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id: rowId,
          plugin: `${packageId}@${snapshotId}/main`,
          snapshotDigest: snapshotId,
          exportName: 'main',
          entryRevision: snapshotId,
          extrasRevision: 'none',
          mountRevision: 'service-assembly:v1',
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    }),
  )
  const serviceSession = await result.host.createSession({ cwd: root, key: 'service-session' })
  held.push({ root, host: result.host })
  return {
    ...result,
    root,
    serviceSession,
    call: (value: number) =>
      result.host.callService(
        { sessionId: serviceSession.key, extension: owner, service: cap.name, input: { value } },
        'opaque',
      ),
  }
}

it('loads a real bundled factory and enforces the selected session workspace/query I/O', async () => {
  const h = await fixture()
  expect(h.host.extensions()).toEqual([])
  expect(h.host.kernel.sessions.size).toBe(1)
  await expect(h.call(1)).resolves.toEqual({ output: { value: 1 } })
  await expect(h.call(3)).resolves.toEqual({ output: { value: 4 } })
  for (const value of [2, 4, 5])
    await expect(h.call(value)).rejects.toMatchObject({ data: { code: 'INTERNAL_ERROR' } })
  await h.host.close()
  let closedFailure: unknown
  try {
    h.call(1)
  } catch (error) {
    closedFailure = error
  }
  expect(closedFailure).toMatchObject({ code: 'E_HOST_CLOSED' })
  expect(isServicePreDispatchFailure(closedFailure)).toBe(true)
})

it('refuses the production Host call when no source authority is assembled', async () => {
  const h = await fixture(false)
  await expect(h.call(1)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
})

it('rejects a stale session before service context or author code can run', async () => {
  const h = await fixture()
  let error: unknown
  try {
    await h.host.callService(
      {
        sessionId: 'stale-session',
        extension: owner,
        service: 'fixture.echo',
        input: { value: 1 },
      },
      'opaque',
    )
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
  expect(isServicePreDispatchFailure(error)).toBe(true)
})

it('holds the workspace lease through handler settlement and releases it before session close returns', async () => {
  const h = await fixture()
  const running = h.call(6)
  let closed = false
  const closing = h.serviceSession.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(closed).toBe(false)
  await expect(running).resolves.toEqual({ output: { value: 6 } })
  await closing
  expect(closed).toBe(true)
  let error: unknown
  try {
    await h.call(1)
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
})

it('hands service dispatch into the workspace before releasing publication during async author work', async () => {
  const h = await fixture()
  const events: string[] = []
  let observeRelease!: () => void
  const released = new Promise<void>((resolve) => {
    observeRelease = resolve
  })
  const enterDispatch = PublicationGate.prototype.enterDispatch
  const gate = vi.spyOn(PublicationGate.prototype, 'enterDispatch').mockImplementation(async function (
    this: PublicationGate,
  ) {
    events.push('ticket:enter')
    const ticket = await enterDispatch.call(this)
    events.push('ticket:admitted')
    return {
      release: () => {
        events.push('ticket:release')
        ticket.release()
        observeRelease()
      },
    }
  })
  try {
    let serviceSettled = false
    const running = h.call(6).then(
      (result) => {
        serviceSettled = true
        events.push('service')
        return result
      },
      (error: unknown) => {
        serviceSettled = true
        throw error
      },
    )

    await released
    expect(serviceSettled).toBe(false)

    // PublicationDispatch can release only after WorkspaceInvocationPort.run() returns. That run()
    // acquires synchronously, so session close must now wait for the async handler even though the
    // publication ticket is already free.
    let sessionClosed = false
    const closing = h.serviceSession.close().then(() => {
      sessionClosed = true
      events.push('session-close')
    })
    await Promise.resolve()
    expect(sessionClosed).toBe(false)

    await expect(running).resolves.toEqual({ output: { value: 6 } })
    await closing
    expect(events.slice(0, 3)).toEqual(['ticket:enter', 'ticket:admitted', 'ticket:release'])
    expect(events.indexOf('ticket:release')).toBeLessThan(events.indexOf('service'))
    expect(events.indexOf('service')).toBeLessThan(events.indexOf('session-close'))
  } finally {
    gate.mockRestore()
  }
})

it('does not poison publication admission when an ordinary service call fails', async () => {
  const h = await fixture()
  await expect(h.call(2)).rejects.toMatchObject({ data: { code: 'INTERNAL_ERROR' } })

  // A failed service call must not poison publication of the same Cordis service row.
  await expect(
    h.host.applyRuntimeTarget(
      buildRuntimeTarget({
        rows: [
          createPluginRow({
            id: rowId,
            plugin: `${packageId}@${snapshotId}/main`,
            snapshotDigest: snapshotId,
            exportName: 'main',
            entryRevision: snapshotId,
            extrasRevision: 'none',
            mountRevision: 'service-assembly:v2',
          }),
        ],
        resources: { mcp: [], skills: {} },
        resourceRevision: '0'.repeat(64),
        compositeRevision: '1'.repeat(64),
      }),
    ),
  ).resolves.toMatchObject({ ok: true })
  await expect(h.call(1)).resolves.toEqual({ output: { value: 1 } })
})

it('rejects a service after its Cordis row is removed', async () => {
  const h = await fixture()
  await h.host.applyRuntimeTarget(
    buildRuntimeTarget({
      rows: [],
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    }),
  )
  await expect(h.call(1)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
})

it('holds activation cutover until a real service invocation finishes', async () => {
  const h = await fixture()
  let startService!: () => void
  const start = new Promise<void>((resolve) => {
    startService = resolve
  })
  const turn = h.host.activationBarrier.admit('turn')
  const call = turn.run(async () => {
    await start
    return h.call(6)
  })
  let switched = false
  const activation = h.host.activationBarrier.quiesce('service-activation', async () => {
    switched = true
  })

  startService()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(switched).toBe(false)
  await expect(call).resolves.toEqual({ output: { value: 6 } })
  await activation
  expect(switched).toBe(true)
})

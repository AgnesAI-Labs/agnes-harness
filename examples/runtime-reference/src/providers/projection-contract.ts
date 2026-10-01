import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  createProjectionFixture,
  type ProjectionContractPort,
  type ProjectionFixture,
  projectionContractPort,
  registerProjectionContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import { openProjectionStore, PROJECTION_PROVIDER, type ProjectionStore } from './projection.js'

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')

const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

const CHECKPOINT_EVERY = 4

/** Opens the reference store wired to a fixture, with a clock whose ids never repeat across reopens. */
export function openReferenceProjection(
  databasePath: string,
  fixture: ProjectionFixture,
  providerId: string = PROJECTION_PROVIDER.id,
) {
  const binding: Wire.BindingRef = {
    bindingId: `reference-projection-${providerId}`,
    contract: 'agh.projection',
    logicalName: 'tasks',
    providerId,
  }
  let ids = 0
  const open = () =>
    openProjectionStore(databasePath, {
      binding,
      authorityId: 'reference-projection-authority',
      domain: fixture.domain,
      access: fixture.gate,
      native: fixture.native,
      turnOf: fixture.turnOf,
      checkpointEvery: CHECKPOINT_EVERY,
      clock: { now: () => '2026-10-01T00:00:00.000Z', newId: () => `reference-${++ids}` },
    })
  let current: ProjectionStore = open()
  return {
    binding,
    current: () => current,
    reopen() {
      current.close()
      current = open()
    },
  }
}

/** Drives the reference store through the six scenarios; the contract module judges what it reports. */
export function referenceProjectionPort(
  databasePath: string,
  providerId: string = PROJECTION_PROVIDER.id,
): { port: ProjectionContractPort; close(): void } {
  const fixture = createProjectionFixture()
  const store = openReferenceProjection(databasePath, fixture, providerId)
  const port = projectionContractPort({
    binding: {
      requirement: {
        contract: 'agh.projection',
        major: 1,
        logicalName: 'tasks',
        features: [],
        scope: 'workspace',
        optional: false,
      },
      binding: store.binding,
      query: (request, context) => store.current().query(request, context),
    },
    fixture,
    service: () => store.current(),
    append: async (events) => store.current().append(events),
    reopen: async () => store.reopen(),
    close: async () => store.current().close(),
    remains: () => existsSync(databasePath),
  })
  return { port, close: () => store.current().close() }
}

/**
 * Registers the six projection cases for the reference provider on a fresh database, reported under
 * `providerId` (the runner passes the name it was asked for, such as `reference`). `change` lets a
 * test break one scenario to prove the contract notices. Call `close` after the harness has run.
 */
export function bindProjectionContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{
    providerId?: string
    change?: (port: ProjectionContractPort) => ProjectionContractPort
  }> = {},
): { close(): void } {
  const providerId = options.providerId ?? PROJECTION_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-projection-contract-'))
  const reference = referenceProjectionPort(join(directory, 'projection.sqlite'), providerId)
  registerProjectionContract(harness, {
    providerId,
    recipe: providerFileForContract('agh.projection'),
    command,
    build,
    providerDigest: sha256(new URL('./projection.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({ checkpointEvery: CHECKPOINT_EVERY }),
    releaseSetDigest: sha256(new URL('../../package.json', import.meta.url)),
    port: options.change ? options.change(reference.port) : reference.port,
  })
  return {
    close() {
      reference.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

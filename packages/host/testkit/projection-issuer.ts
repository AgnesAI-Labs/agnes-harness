import { closeSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ScopeRef, StateAuthorityRef } from '@agnes/protocol/runtime'
import { createPrivateFileSync } from '@agnes/system-node'
import { createLocalDeploymentIdentity } from '../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../src/runtime/maintenance/bootstrap-locator.js'
import type { HostProjectionInstallation } from '../src/runtime/projection-owner.js'

/** Original local maintenance issuance for isolated tests; this is not an HTTP C14 installer. */
export function createProjectionIssuerFixture(
  input: Readonly<{
    directory: string
    scope: ScopeRef
    authority: StateAuthorityRef
  }>,
): Readonly<{
  issuer: Pick<HostProjectionInstallation, 'issue' | 'disposeContextIssuer'>
  activeConnections(): number
  close(): void
}> {
  const directory = join(realpathSync(dirname(input.directory)), basename(input.directory))
  const anchor = createBootstrapAnchor(directory, {
    principalRef: 'fixture-not-an-authentication-proof',
    locator: {
      directoryId: 'fixture-directory',
      providerLockRef: inlineData({ fixture: true }, 'agh.maintenance/provider-lock@1'),
      endpointRef: directory,
      epoch: 1,
      revision: 1,
      cutoverId: 'fixture-cutover',
    },
  })
  if (!anchor.ok) throw new Error(anchor.error.detailCode)
  const file = join(directory, 'identity.sqlite')
  closeSync(createPrivateFileSync(file))
  const database = new DatabaseSync(file)
  const identity = createLocalDeploymentIdentity({
    database,
    deploymentDirectory: directory,
    owner: captureLocalDeploymentOwner({ database, deploymentDirectory: directory }),
    authority: input.authority,
    scope: input.scope,
    now: () => Date.parse('2026-10-05T00:00:00Z'),
  })
  let connection: Awaited<ReturnType<typeof identity.connect>> | undefined
  const issuer: Pick<HostProjectionInstallation, 'issue' | 'disposeContextIssuer'> = {
    async issue(_caller, _request, signal) {
      connection ??= await identity.connect(signal)
      return { ok: true, value: connection.issue('2026-10-05T00:01:00Z', 'projection-fixture') }
    },
    disposeContextIssuer() {
      connection?.close()
    },
  }
  return {
    issuer,
    activeConnections: () =>
      Number(
        database.prepare('SELECT count(*) AS n FROM runtime_local_identity_connections WHERE closed=0').get()
          ?.n,
      ),
    close() {
      connection?.close()
      identity.close()
      database.close()
    },
  }
}

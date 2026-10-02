import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { CallContext } from '@agnes/extension-api/runtime'
import { inlineData } from '../../../../packages/host/src/runtime/maintenance/authority-publication.ts'
import {
  createAuthorityDirectoryProvider,
  createDirectoryAnchor,
} from '../../../../packages/host/src/runtime/providers/authority-directory.ts'
import type { AuthorityRoute } from '../../../../packages/protocol/src/runtime/index.ts'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.ts'

/** Test deployment owns routing; workspace only receives the selected directory's read port. */
export async function workspaceDirectory(root: string) {
  const directory = join(root, 'authority-directory')
  const anchor = join(root, 'directory-anchor')
  const context: CallContext = {
    principalRef: 'deployer',
    scope: { kind: 'installation', installationId: 'install-1' },
    bindingId: 'directory-binding',
    invocationId: 'directory-deployment',
    authorizationRef: 'maintenance',
    deadline: '2099-01-01T00:00:00.000Z',
    traceRef: 'deployment-trace',
    signal: new AbortController().signal,
  }
  const authority = { authorityId: 'directory-1', tenantId: 'tenant-1', authorityEpoch: 1 }
  const created = createDirectoryAnchor(
    anchor,
    {
      directoryId: authority.authorityId,
      providerLockRef: inlineData({}, 'agh.directory/provider-lock@1'),
      endpointRef: directory,
      epoch: 1,
      revision: 1,
      cutoverId: 'directory-bootstrap',
    },
    context.principalRef,
  )
  assert.equal(created.ok, true)
  let provider = createAuthorityDirectoryProvider({ directory, anchor, authority })
  const route: AuthorityRoute = {
    logicalAuthorityId: 'ws-1',
    tenantId: 'tenant-1',
    authorityEpoch: 1,
    providerBinding: {
      bindingId: 'workspace-binding',
      contract: 'agh.workspace',
      logicalName: 'workspace',
      providerId: 'agh.default/workspace',
    },
    locationRef: 'ws-1',
    cohortDigest: canonicalJsonDigest({ deployment: 'workspace' }),
    cutoverId: 'workspace-bootstrap',
    previous: null,
    checkpoint: {
      authorityId: 'ws-1',
      authorityEpoch: 1,
      checkpointId: 'workspace-checkpoint',
      snapshotDigest: canonicalJsonDigest({ workspaceId: 'ws-1' }),
      recordCount: 1,
      bridgeWatermarks: [],
    },
  }
  assert.equal((await provider.seedRoute(route, context)).ok, true)
  return {
    reader: { read: (request: Parameters<typeof provider.read>[0]) => provider.read(request, context) },
    async reopen() {
      await provider.dispose()
      provider = createAuthorityDirectoryProvider({ directory, anchor, authority })
      const read = await provider.read({ kind: 'authority', logicalAuthorityId: 'ws-1' }, context)
      assert.equal(read.ok, true)
      if (read.ok && read.value.kind === 'authority') assert.deepEqual(read.value.route, route)
    },
    close: () => provider.dispose(),
  }
}

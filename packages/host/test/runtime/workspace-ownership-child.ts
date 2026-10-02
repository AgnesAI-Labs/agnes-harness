import { mkdirSync } from 'node:fs'
import type { CallContext } from '@agnes/extension-api/runtime'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { createFilesService } from '../../src/runtime/providers/files.js'
import { createWorkspaceService } from '../../src/runtime/providers/workspace.js'

const directory = process.argv[2]
const work = process.argv[3]
if (!directory || !work) {
  process.stderr.write('usage: workspace-ownership-child <store> <work>\n')
  process.exit(2)
}

function policy(): Wire.FsPolicySnapshot {
  const [aghSecrets, agnesSecrets] = WORKSPACE_SECRET_DIRS
  const body = {
    compilerVersion: 'floor-1',
    policyId: 'policy-1',
    scope: {
      kind: 'workspace' as const,
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'ws-1',
    },
    roots: [{ kind: 'workspace' as const, mount: { workspaceId: 'ws-1', mountId: 'mount-workspace' } }],
    rules: [
      {
        root: 'workspace' as const,
        path: '',
        effect: 'allow' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'workspace' as const,
        path: '.git',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'workspace' as const,
        path: aghSecrets,
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'workspace' as const,
        path: agnesSecrets,
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'home' as const,
        path: '.ssh',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'data' as const,
        path: 'secrets',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
    ],
  }
  return { ...body, digest: canonicalJsonDigest(body) }
}

const context: CallContext = {
  principalRef: 'actor',
  scope: { kind: 'workspace', installationId: 'install-1', runtimeId: 'runtime-1', workspaceId: 'ws-1' },
  bindingId: 'binding-1',
  invocationId: 'child-hold',
  deadline: '2030-01-01T00:00:00.000Z',
  traceRef: 'trace-1',
  authorizationRef: 'auth-1',
  signal: new AbortController().signal,
}

mkdirSync(work, { recursive: true })
const workspace = createWorkspaceService({
  directory,
  authorityId: 'authority-1',
  tenantId: 'tenant-1',
  leaseMs: 60_000,
})
const bound = await workspace.bind('ws-1', work)
if (!bound.ok) {
  process.stderr.write(`${bound.error.detailCode}\n`)
  process.exit(1)
}
const acquired = await workspace.acquire(
  { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
  context,
)
if (!acquired.ok) {
  process.stderr.write(`${acquired.error.detailCode}\n`)
  process.exit(1)
}
const files = createFilesService({
  store: workspace.store,
  authorityId: 'authority-1',
  policy: policy(),
  places: {
    home: { absolute: work, workspaceId: 'home-ws', mountId: 'mount-home' },
    data: { absolute: work, workspaceId: 'data-ws', mountId: 'mount-data' },
  },
})
const staged = await files.stageBytes(Buffer.from('kept'))
if (!staged.ok) {
  process.stderr.write(`${staged.error.detailCode}\n`)
  process.exit(1)
}
const wrote = await files.write(
  {
    mountRef: acquired.value.mountRef,
    path: 'notes.txt',
    bytesRef: staged.value,
    expectedVersion: { kind: 'absent' },
  },
  { ...context, invocationId: 'child-write' },
)
if (!wrote.ok) {
  process.stderr.write(`${wrote.error.detailCode}\n`)
  process.exit(1)
}
const expiresAt = acquired.value.leaseRef.expiresAt
files.close()
workspace.close()
process.stdout.write(`LEASE ${expiresAt}\nREADY\n`)
setInterval(() => undefined, 1_000)

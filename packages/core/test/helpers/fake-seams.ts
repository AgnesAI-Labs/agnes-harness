import type { SeamImplementations } from '../../src/effects/seams.js'
import { testFsPolicy } from '../../testkit/fenced-fs.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

/** Test doubles for all ten seams. Every one answers; a test overrides only the one it is about. */
export function fakeSeams(
  over: Partial<{ [K in keyof SeamImplementations]: Partial<SeamImplementations[K]> }> = {},
): SeamImplementations {
  let sandbox!: SeamImplementations['sandbox']
  sandbox = {
    forWorkspace: async () => sandbox,
    exec: async (cmd) => ({ code: 0, stdout: cmd.join(' '), stderr: '', truncated: false }),
    confine: async (argv) => ['sandbox-exec', ...argv],
    fsPolicy: () => testFsPolicy('/w'),
    enforcement: () => ({ level: 'full', scope: ['file', 'network', 'process'] }),
  }
  let approval!: SeamImplementations['approval']
  approval = {
    forWorkspace: async () => approval,
    ask: async () => 'allowed-once',
    resume: async () => null,
    guard: async () => ({ decision: 'escalate', ruleVersion: 'fake-v1', reasons: ['human-test'] }),
    listGrants: async () => [],
    putGrant: async () => undefined,
    revokeGrant: async () => null,
    onGrantRevoked: () => () => undefined,
  }
  let checkpoint!: SeamImplementations['checkpoint']
  checkpoint = {
    forWorkspace: async () => checkpoint,
    snapshot: async () => ({ id: 'cp' }),
    rewind: async () => undefined,
    list: async () => [],
  }
  const base: SeamImplementations = {
    approval,
    checkpoint,
    ledger: {
      record: async () => undefined,
      projected: async () => ({ credits: 1, creditSource: 'estimated' }),
    },
    sandbox,
    verifier: { verify: async () => ({ verdict: 'pass', reasons: [] }) },
    repair: { decide: async () => 'repair' },
    artifacts: {
      put: async (b) => ({ sha256: 'x'.repeat(64), size: b.length, mime: 'application/octet-stream' }),
      get: async () => new Uint8Array(),
      submitJob: async () => 'job-1',
      poll: async () => ({ jobId: 'job-1', status: 'done' }),
      cancel: async () => undefined,
    },
    principals: {
      resolve: async () => actor,
      authorize: async () => ({ decisionId: 'n/a', effect: 'allow', reason: 'local-owner' }),
    },
    platform: {
      shell: () => 'posix',
      fs: () => ({ caseSensitive: true, pathSep: '/' }),
      terminal: () => ({ color: false }),
      capability: () => ({ level: 'full', scope: [] }),
    },
    harness: { propose: async () => 'queued' },
  }
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(over))
    out[k] = { ...(base as unknown as Record<string, object>)[k], ...(v as object) }
  const seams = out as unknown as SeamImplementations
  if (!over.approval?.forWorkspace) seams.approval.forWorkspace = async () => seams.approval
  if (!over.checkpoint?.forWorkspace) seams.checkpoint.forWorkspace = async () => seams.checkpoint
  return seams
}

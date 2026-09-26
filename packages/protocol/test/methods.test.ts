import { describe, expect, it } from 'vitest'
import { canAccessResourceControl, METHODS, type ValidationError, validateMethod } from '../src/index.js'

// One ledger row shaped exactly as EventEnvelope demands. `_agnes/v1/session.event` carries a whole
// row inside its params, so the row has to be spelled out here rather than reduced to a stub.
const ledgerRow = {
  seq: 5,
  ts: '2026-09-07T00:00:00Z',
  id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
  type: 'user/message',
  data: { content: [{ type: 'text', text: 'hi' }] },
  actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  origin: 'principal',
  trust: 'trusted',
}
const harnessMeta = {
  promptTurnId: '5',
  eventSequence: 5,
  generation: 1,
  lane: 'main',
  phase: 'event',
}

// Every rejection below is asserted on *which* check fired, not merely on `ok === false`. A negative
// that only pins "something went wrong" stays green when the schema starts refusing for an unrelated
// reason — a dropped constraint elsewhere in the same object reads exactly the same from the outside.
function errorsOf(r: ReturnType<typeof validateMethod>): ValidationError[] {
  if (r.ok) throw new Error('expected the payload to be rejected, but it validated')
  return r.errors
}

describe('methods (I1 set)', () => {
  it('lists the I1 methods with kind and direction', () => {
    expect(Object.keys(METHODS).sort()).toEqual([
      '_agnes/v1/apis.list',
      '_agnes/v1/approval.decide',
      '_agnes/v1/approvalGrants.list',
      '_agnes/v1/approvalGrants.revoke',
      '_agnes/v1/artifact.job.status',
      '_agnes/v1/artifact.read',
      '_agnes/v1/auth.claim',
      '_agnes/v1/clientModules.callEffect',
      '_agnes/v1/clientModules.callService',
      '_agnes/v1/clientModules.list',
      '_agnes/v1/clientModules.read',
      '_agnes/v1/computerUse.doctor',
      '_agnes/v1/computerUse.operation.cancel',
      '_agnes/v1/computerUse.operation.start',
      '_agnes/v1/computerUse.operation.status',
      '_agnes/v1/computerUse.permissions.grant',
      '_agnes/v1/computerUse.permissions.status',
      '_agnes/v1/computerUse.status',
      '_agnes/v1/config.account',
      '_agnes/v1/config.get',
      '_agnes/v1/config.oauth',
      '_agnes/v1/config.providers',
      '_agnes/v1/config.save',
      '_agnes/v1/config.test',
      '_agnes/v1/daemon.notice',
      '_agnes/v1/diagnostics.collect',
      '_agnes/v1/diagnostics.events',
      '_agnes/v1/directory.upsert',
      '_agnes/v1/ext.ui.response',
      '_agnes/v1/extension.ack',
      '_agnes/v1/extension.call',
      '_agnes/v1/jobs.cancel',
      '_agnes/v1/jobs.enqueue',
      '_agnes/v1/jobs.poll',
      '_agnes/v1/mcp.servers.create',
      '_agnes/v1/mcp.servers.disable',
      '_agnes/v1/mcp.servers.enable',
      '_agnes/v1/mcp.servers.get',
      '_agnes/v1/mcp.servers.list',
      '_agnes/v1/mcp.servers.oauth.status',
      '_agnes/v1/mcp.servers.oauth.status.set',
      '_agnes/v1/mcp.servers.reconnect',
      '_agnes/v1/mcp.servers.remove',
      '_agnes/v1/mcp.servers.status',
      '_agnes/v1/mcp.servers.test',
      '_agnes/v1/mcp.servers.tools.list',
      '_agnes/v1/mcp.servers.trust.set',
      '_agnes/v1/mcp.servers.update',
      '_agnes/v1/packages.catalog.get',
      '_agnes/v1/packages.catalog.list',
      '_agnes/v1/packages.disable',
      '_agnes/v1/packages.enable',
      '_agnes/v1/packages.inspect',
      '_agnes/v1/packages.install',
      '_agnes/v1/packages.list',
      '_agnes/v1/packages.operation.cancel',
      '_agnes/v1/packages.operation.get',
      '_agnes/v1/packages.pins.inspect',
      '_agnes/v1/packages.pins.release',
      '_agnes/v1/packages.remove',
      '_agnes/v1/packages.rollback',
      '_agnes/v1/packages.trust',
      '_agnes/v1/packages.trustWorkspace',
      '_agnes/v1/packages.untrust',
      '_agnes/v1/packages.update',
      '_agnes/v1/participant.join',
      '_agnes/v1/participant.leave',
      '_agnes/v1/participant.list',
      '_agnes/v1/plugins.tree.apply',
      '_agnes/v1/plugins.tree.get',
      '_agnes/v1/plugins.tree.list',
      '_agnes/v1/plugins.tree.rollback',
      '_agnes/v1/resources.desired.set',
      '_agnes/v1/resources.get',
      '_agnes/v1/resources.list',
      '_agnes/v1/resources.operation.cancel',
      '_agnes/v1/resources.operation.get',
      '_agnes/v1/session.archive',
      '_agnes/v1/session.attach',
      '_agnes/v1/session.budget',
      '_agnes/v1/session.detach',
      '_agnes/v1/session.event',
      '_agnes/v1/session.followUp',
      '_agnes/v1/session.fork',
      '_agnes/v1/session.list',
      '_agnes/v1/session.preview',
      '_agnes/v1/session.projectUI',
      '_agnes/v1/session.projectUIHistory',
      '_agnes/v1/session.projectUIOpening',
      '_agnes/v1/session.projectUIPatch',
      '_agnes/v1/session.readToolDetail',
      '_agnes/v1/session.rename',
      '_agnes/v1/session.setModel',
      '_agnes/v1/session.setPreset',
      '_agnes/v1/session.setYolo',
      '_agnes/v1/session.steer',
      '_agnes/v1/skills.priority.set',
      '_agnes/v1/skills.refresh',
      '_agnes/v1/skills.remove',
      '_agnes/v1/skills.trust.set',
      '_agnes/v1/skins.list',
      '_agnes/v1/skins.read',
      '_agnes/v1/submit',
      '_agnes/v1/submit.ack',
      '_agnes/v1/surfaces.mounts',
      '_agnes/v1/workspace.add',
      '_agnes/v1/workspace.list',
      'authenticate',
      'initialize',
      'session/cancel',
      'session/load',
      'session/new',
      'session/prompt',
      'session/request_permission',
      'session/set_mode',
      'session/update',
    ])
    expect(Object.keys(METHODS)).toHaveLength(116)
    expect(METHODS['session/cancel']).toMatchObject({ kind: 'notification', direction: 'c2s' })
    expect(METHODS['session/request_permission']).toMatchObject({ kind: 'request', direction: 's2c' })
  })

  it('keeps unknown method names outside the closed method table', () => {
    expect(Object.hasOwn(METHODS, '_agnes/v1/not-a-method')).toBe(false)
  })

  it('bounds on-demand tool detail reads and validates base64 chunks', () => {
    const method = '_agnes/v1/session.readToolDetail'
    expect(
      validateMethod(method, 'params', {
        sessionId: 'session-a',
        callSeq: 3,
        resultSeq: 7,
        offset: 262144,
        maxBytes: 262144,
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(validateMethod(method, 'params', { sessionId: 'session-a', callSeq: 3, maxBytes: 262145 })),
    ).toContainEqual(expect.objectContaining({ path: '/maxBytes', code: 'RANGE' }))
    expect(
      errorsOf(validateMethod(method, 'params', { sessionId: 'session-a', callSeq: 3, path: '/secret' })),
    ).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_KEY' }))
    expect(
      validateMethod(method, 'result', {
        sessionId: 'session-a',
        callSeq: 3,
        resultSeq: 7,
        offset: 0,
        totalBytes: 2,
        data: 'e30=',
        nextOffset: null,
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod(method, 'result', {
          sessionId: 'session-a',
          callSeq: 3,
          offset: 0,
          totalBytes: 2,
          data: 'invalid!',
          nextOffset: null,
        }),
      ),
    ).toContainEqual(expect.objectContaining({ path: '/data', code: 'PATTERN' }))
  })

  it('binds artifact reads to a complete ref and one bounded range without path or owner authority', () => {
    const artifact = {
      sha256: 'a'.repeat(64),
      size: 2_000_000,
      mime: 'image/png',
    }
    expect(
      validateMethod('_agnes/v1/artifact.read', 'params', {
        sessionId: 'session-a',
        laneId: 'lane-a',
        artifact,
        range: 'bytes=0-1048575',
      }).ok,
    ).toBe(true)
    for (const extra of [{ ownerId: 'attacker' }, { path: '/tmp/secret' }, { timeoutMs: 0 }])
      expect(
        errorsOf(
          validateMethod('_agnes/v1/artifact.read', 'params', {
            sessionId: 'session-a',
            laneId: 'lane-a',
            artifact,
            ...extra,
          }),
        ),
      ).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_KEY' }))
    expect(
      errorsOf(
        validateMethod('_agnes/v1/artifact.read', 'params', {
          sessionId: 'session-a',
          laneId: 'lane-a',
          artifact,
          range: 'bytes=0-1,4-5',
        }),
      ),
    ).toContainEqual(expect.objectContaining({ path: '/range', code: 'PATTERN' }))
    expect(
      errorsOf(
        validateMethod('_agnes/v1/artifact.read', 'params', {
          sessionId: 'session-a',
          laneId: 'lane-a',
          artifact,
          range: 'bytes=-',
        }),
      ),
    ).toContainEqual(expect.objectContaining({ path: '/range', code: 'PATTERN' }))

    expect(
      validateMethod('_agnes/v1/artifact.read', 'result', {
        ok: true,
        status: 206,
        artifact,
        acceptRanges: 'bytes',
        contentLength: 3,
        etag: `"${artifact.sha256}"`,
        contentRange: 'bytes 0-2/2000000',
        base64: 'AQID',
      }).ok,
    ).toBe(true)
    for (const mismatched of [
      {
        ok: true,
        status: 200,
        artifact,
        acceptRanges: 'bytes',
        contentLength: 3,
        etag: `"${artifact.sha256}"`,
        contentRange: 'bytes 0-2/2000000',
        base64: 'AQID',
      },
      {
        ok: true,
        status: 206,
        artifact,
        acceptRanges: 'bytes',
        contentLength: 3,
        etag: `"${artifact.sha256}"`,
        base64: 'AQID',
      },
    ])
      expect(validateMethod('_agnes/v1/artifact.read', 'result', mismatched).ok).toBe(false)
    expect(
      validateMethod('_agnes/v1/artifact.read', 'result', {
        ok: false,
        status: 403,
        code: 'artifact_forbidden',
      }).ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/artifact.read', 'result', {
        ok: false,
        status: 404,
        code: 'artifact_forbidden',
      }).ok,
    ).toBe(false)
    const leaked = validateMethod('_agnes/v1/artifact.read', 'result', {
      ok: false,
      status: 500,
      code: 'artifact_unavailable',
      message: 'Bearer secret',
    })
    expect(leaked.ok).toBe(false)
    expect(JSON.stringify(errorsOf(leaked))).not.toContain('secret')
  })

  it('keeps computer-use status read-only, closed, and explicitly P0-blocked', () => {
    expect(METHODS['_agnes/v1/computerUse.status']).toMatchObject({
      kind: 'request',
      direction: 'c2s',
    })
    expect(validateMethod('_agnes/v1/computerUse.status', 'params', {}).ok).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/computerUse.status', 'params', { start: true })),
    ).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_KEY', key: 'start' }))
    const blocked = {
      schemaVersion: 1,
      status: 'blocked',
      admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
      runtime: { state: 'not-started', startAttempted: false },
      blockers: [
        'release-provenance-incomplete',
        'compatibility-evidence-incomplete',
        'platform-acceptance-incomplete',
      ],
    }
    expect(validateMethod('_agnes/v1/computerUse.status', 'result', blocked).ok).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/computerUse.status', 'result', {
          ...blocked,
          runtime: { state: 'running', startAttempted: true },
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM' }))
    expect(
      errorsOf(validateMethod('_agnes/v1/computerUse.status', 'result', { ...blocked, platform: 'darwin' })),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM' }))
    expect(
      validateMethod('_agnes/v1/computerUse.status', 'result', {
        schemaVersion: 1,
        status: 'ready',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        runtime: { state: 'idle', startAttempted: false, activeSessions: 0 },
        blockers: [],
        driver: { platform: 'win32', version: '0.28.1', publisher: 'Cua AI, Inc.' },
      }).ok,
    ).toBe(true)
  })

  it('keeps computer-use permissions and doctor authenticated but driver-dormant while P0 is blocked', () => {
    const admission = { state: 'blocked', reason: 'p0-evidence-incomplete' }
    const notRun = { state: 'not-run', reason: 'production-driver-admission-disabled' }
    expect(validateMethod('_agnes/v1/computerUse.permissions.status', 'params', {}).ok).toBe(true)
    expect(
      validateMethod('_agnes/v1/computerUse.permissions.status', 'result', {
        schemaVersion: 1,
        status: 'unavailable',
        admission,
        probe: notRun,
      }).ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/computerUse.doctor', 'params', {
        include: ['binary', 'display'],
        skip: ['display'],
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/computerUse.doctor', 'params', {
          include: ['binary=credential'],
        }),
      ),
    ).toContainEqual(expect.objectContaining({ path: '/include/0', code: 'PATTERN' }))
    expect(
      validateMethod('_agnes/v1/computerUse.doctor', 'result', {
        schemaVersion: 1,
        status: 'blocked',
        admission,
        checks: notRun,
      }).ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/computerUse.doctor', 'result', {
        schemaVersion: 1,
        status: 'failed',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        checks: { state: 'failed', reason: 'windows-driver-health-or-identity-failed' },
      }).ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/computerUse.doctor', 'result', {
        schemaVersion: 1,
        status: 'unreachable',
        admission: { state: 'ready', reason: 'macos-verified-driver' },
        checks: { state: 'unavailable', reason: 'live-driver-doctor-unavailable' },
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/computerUse.doctor', 'result', {
          schemaVersion: 1,
          status: 'failed',
          admission: { state: 'ready', reason: 'windows-verified-driver' },
          checks: { state: 'failed', reason: 'driver-health-or-identity-failed' },
        }),
      ),
    ).not.toHaveLength(0)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/computerUse.doctor', 'result', {
          schemaVersion: 1,
          status: 'failed',
          admission: { state: 'ready', reason: 'windows-verified-driver' },
          checks: { state: 'failed', reason: 'macos-driver-health-or-identity-failed' },
        }),
      ),
    ).not.toHaveLength(0)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/computerUse.doctor', 'result', {
          schemaVersion: 1,
          status: 'unreachable',
          admission: { state: 'ready', reason: 'macos-verified-driver' },
          checks: { state: 'failed', reason: 'live-driver-doctor-unavailable' },
        }),
      ),
    ).not.toHaveLength(0)
  })

  it('binds computer-use operation kind, phase, and terminal outcome on the wire', () => {
    const method = '_agnes/v1/computerUse.operation.status' as const
    expect(validateMethod('_agnes/v1/computerUse.operation.start', 'params', { kind: 'update' }).ok).toBe(
      true,
    )
    expect(validateMethod(method, 'params', {}).ok).toBe(true)
    expect(validateMethod(method, 'params', { operationId: 'cu-update-1' }).ok).toBe(true)
    expect(
      validateMethod(method, 'result', {
        schemaVersion: 1,
        status: 'found',
        operationId: 'cu-update-1',
        kind: 'update',
        state: 'succeeded',
        phase: 'complete',
        startedAtMs: 1,
        updatedAtMs: 2,
        outcome: 'repaired',
      }).ok,
    ).toBe(true)
    for (const contradictory of [
      { kind: 'restart', state: 'running', phase: 'installing' },
      { kind: 'restart', state: 'succeeded', phase: 'complete', outcome: 'installed' },
      { kind: 'install', state: 'succeeded', phase: 'complete', outcome: 'restarted' },
      { kind: 'update', state: 'cancelled', phase: 'complete', failure: 'operation-failed' },
    ])
      expect(
        validateMethod(method, 'result', {
          schemaVersion: 1,
          status: 'found',
          operationId: 'cu-invalid-1',
          startedAtMs: 1,
          updatedAtMs: 2,
          ...contradictory,
        }).ok,
      ).toBe(false)
  })

  it('records only the primary MCP permission; SecretRef use remains a daemon payload check', () => {
    // `mcp.manage` admits the method table's primary capability. The Daemon must inspect a submitted
    // definition and require `secrets.use` when it carries a SecretRef; that conditional cannot be
    // inferred from this method-only helper and must not be mistaken for an authorization grant.
    expect(
      canAccessResourceControl('_agnes/v1/mcp.servers.create', {
        audience: 'admin',
        permissions: ['mcp.manage'],
      }),
    ).toBe(true)
    expect(
      canAccessResourceControl('_agnes/v1/mcp.servers.create', {
        audience: 'admin',
        permissions: ['secrets.use'],
      }),
    ).toBe(false)
  })

  it('validates attach params and rejects seams', () => {
    expect(
      validateMethod('_agnes/v1/session.attach', 'params', {
        sessionId: 's',
        cursor: { fromSeq: 0, generation: 1 },
      }).ok,
    ).toBe(true)
    const r = validateMethod('_agnes/v1/session.attach', 'params', { sessionId: 's', seams: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'UNKNOWN_KEY', key: 'seams' })
  })

  it('validates steer result and Ack', () => {
    expect(validateMethod('_agnes/v1/session.steer', 'result', { seq: 3 }).ok).toBe(true)
    expect(
      validateMethod('_agnes/v1/session.steer', 'params', {
        sessionId: 'agnes:local:test',
        content: [{ type: 'text', text: 'next' }],
        commandId: 'command-1',
        generation: 2,
      }).ok,
    ).toBe(true)
    expect(validateMethod('_agnes/v1/submit', 'result', { replayed: true, seq: 3 }).ok).toBe(true)
    expect(
      validateMethod('_agnes/v1/submit', 'result', {
        replayed: true,
        seq: 3,
        compact: { state: 'completed', endSeq: 3 },
      }).ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/submit', 'result', {
        replayed: true,
        seq: 3,
        compact: { state: 'completed' },
      }).ok,
    ).toBe(false)
    expect(validateMethod('_agnes/v1/submit', 'result', { replayed: true, status: 'maybe' }).ok).toBe(false)
  })

  it('validates incremental UI patches and rejects ambiguous changes', () => {
    expect(
      validateMethod('_agnes/v1/session.projectUIPatch', 'params', {
        sessionId: 's',
        after: 7,
        upto: 9,
        surface: 'tui',
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/session.projectUIPatch', 'params', { sessionId: 's', after: -1 })),
    ).toContainEqual(expect.objectContaining({ code: 'RANGE', key: 'after' }))
    expect(
      validateMethod('_agnes/v1/session.projectUIPatch', 'result', {
        kind: 'patch',
        patch: {
          sessionId: 's',
          generation: 1,
          from: 7,
          upto: 9,
          opState: null,
          changes: [{ op: 'upsert', index: 0, node: { ...ledgerRow, kind: 'user', content: [] } }],
          turnChanges: [],
        },
      }).ok,
    ).toBe(false)
    expect(
      validateMethod('_agnes/v1/session.projectUIPatch', 'result', {
        kind: 'patch',
        patch: {
          sessionId: 's',
          generation: 1,
          from: 7,
          upto: 9,
          opState: null,
          changes: [{ op: 'remove', id: 'node-1' }],
          turnChanges: [],
        },
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/session.projectUIPatch', 'result', {
          kind: 'patch',
          patch: {
            sessionId: 's',
            generation: 1,
            from: 7,
            upto: 9,
            opState: null,
            changes: [{ op: 'upsert', index: -1, node: { kind: 'user', id: 'u', seq: 8, content: [] } }],
            turnChanges: [],
          },
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM' }))
  })

  it('validates bounded UI opening and opaque history page contracts', () => {
    expect(
      validateMethod('_agnes/v1/session.projectUIOpening', 'params', {
        sessionId: 's',
        surface: 'tui',
        maxNodes: 200,
        maxBytes: 262_144,
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/session.projectUIOpening', 'params', {
          sessionId: 's',
          maxNodes: 501,
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'RANGE', key: 'maxNodes' }))
    expect(
      validateMethod('_agnes/v1/session.projectUIOpening', 'result', {
        timeline: {
          sessionId: 's',
          upto: 9,
          generation: 2,
          opState: null,
          nodes: [{ kind: 'user', id: 'u9', seq: 9, content: [] }],
          turns: [],
        },
        history: { hasEarlier: true, cursor: 'opaque-page-1', startIndex: 8, totalNodes: 9 },
      }).ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/session.projectUIOpening', 'result', {
        timeline: { sessionId: 's', upto: 0, generation: 1, opState: null, nodes: [], turns: [] },
        history: { hasEarlier: true, startIndex: 0, totalNodes: 0 },
      }).ok,
    ).toBe(false)

    expect(
      validateMethod('_agnes/v1/session.projectUIHistory', 'params', {
        sessionId: 's',
        cursor: 'opaque-page-1',
        limit: 100,
        maxBytes: 262_144,
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/session.projectUIHistory', 'params', {
          sessionId: 's',
          cursor: '',
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'RANGE', key: 'cursor' }))
    expect(
      validateMethod('_agnes/v1/session.projectUIHistory', 'result', {
        sessionId: 's',
        generation: 2,
        cut: 9,
        nodes: [{ kind: 'user', id: 'u1', seq: 1, content: [] }],
        turns: [],
        hasEarlier: false,
        startIndex: 0,
        totalNodes: 9,
      }).ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/session.projectUIHistory', 'result', {
        sessionId: 's',
        generation: 2,
        cut: 9,
        nodes: [],
        turns: [],
        hasEarlier: false,
        cursor: 'must-not-be-present',
        startIndex: 0,
        totalNodes: 9,
      }).ok,
    ).toBe(false)
  })

  it('validates ACP initialize params through the vendored schema', () => {
    expect(
      validateMethod('initialize', 'params', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }).ok,
    ).toBe(true)
  })

  // Ack.result? carries the {sessionId} returned by submit{kind:'fork'} and the {jobId} returned by
  // kind:'jobs.enqueue'; steer/followUp return only seq and no result. JsonValue is an open shape, so
  // both {sessionId:...} and {jobId:...} payloads pass legitimately.
  it('Ack.result carries fork/jobs.enqueue payloads', () => {
    expect(
      validateMethod('_agnes/v1/submit', 'result', { replayed: false, seq: 1, result: { sessionId: 's-1' } })
        .ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/submit', 'result', { replayed: false, seq: 1, result: { jobId: 'j-1' } }).ok,
    ).toBe(true)
  })

  it('followUp shares the steer shape', () => {
    expect(
      validateMethod('_agnes/v1/session.followUp', 'params', {
        sessionId: 's',
        content: [{ type: 'text', text: 'x' }],
        commandId: 'c',
      }).ok,
    ).toBe(true)
  })

  // The two outbound notifications daemon sends. They have params and no result; asserting the shape
  // here is what makes the daemon side validated rather than merely spelled the same way.
  it('session.event and daemon.notice are s2c notifications', () => {
    expect(METHODS['_agnes/v1/session.event']).toMatchObject({ kind: 'notification', direction: 's2c' })
    expect(METHODS['_agnes/v1/daemon.notice']).toMatchObject({ kind: 'notification', direction: 's2c' })
    expect(
      validateMethod('_agnes/v1/session.event', 'params', {
        sessionId: 's',
        event: ledgerRow,
        _meta: { 'ai.agnes.harness': harnessMeta },
      }).ok,
    ).toBe(true)
    // A row cut down to its seq: the envelope's other seven required fields are what should be
    // reported, starting with `ts`.
    expect(
      errorsOf(validateMethod('_agnes/v1/session.event', 'params', { sessionId: 's', event: { seq: 5 } })),
    ).toContainEqual(expect.objectContaining({ path: '/event', code: 'MISSING', key: 'ts' }))
  })

  it('a session.event row missing its actor is rejected as a missing key, not waved through', () => {
    const { actor: _actor, ...noActor } = ledgerRow
    expect(
      errorsOf(validateMethod('_agnes/v1/session.event', 'params', { sessionId: 's', event: noActor })),
    ).toContainEqual(expect.objectContaining({ path: '/event', code: 'MISSING', key: 'actor' }))
  })

  it('daemon.notice.kind is a closed set and is required', () => {
    expect(
      validateMethod('_agnes/v1/daemon.notice', 'params', {
        kind: 'overloaded',
        sessionId: 's',
        detail: { code: 'OVERLOADED', retryAfterMs: 500 },
        at: '2026-09-07T00:00:00Z',
      }).ok,
    ).toBe(true)
    // `rebooted` is not one of the seven, and the consumer of this notification (sdk's
    // `Client.on('notice')`) declares its payload as `unknown`, so `kind` is the only thing telling it
    // what arrived. An open `kind` would make that consumer unable to tell anything at all.
    expect(
      errorsOf(
        validateMethod('_agnes/v1/daemon.notice', 'params', { kind: 'rebooted', detail: {}, at: 't' }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM' }))
    expect(
      errorsOf(validateMethod('_agnes/v1/daemon.notice', 'params', { detail: {}, at: 't' })),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM' }))
  })

  it('validates the packages_changed profile invalidation payload as a closed contract', () => {
    expect(
      validateMethod('_agnes/v1/daemon.notice', 'params', {
        kind: 'packages_changed',
        detail: {
          profile: 'local-dev',
          revision: `sha256-${'a'.repeat(64)}`,
          reason: 'activation',
          packageId: '@agnes/example',
        },
        at: '2026-09-18T00:00:00.000Z',
      }).ok,
    ).toBe(true)
    expect(
      validateMethod('_agnes/v1/daemon.notice', 'params', {
        kind: 'packages_changed',
        detail: { profile: 'local-dev', reason: 'activation' },
        at: '2026-09-18T00:00:00.000Z',
      }).ok,
    ).toBe(false)
    expect(
      validateMethod('_agnes/v1/daemon.notice', 'params', {
        kind: 'packages_changed',
        detail: { profile: 'local-dev', revision: 'r1', reason: 'unknown' },
        at: '2026-09-18T00:00:00.000Z',
      }).ok,
    ).toBe(false)
  })

  it('validates auth.claim in both of its two shapes and rejects a mixture', () => {
    expect(validateMethod('_agnes/v1/auth.claim', 'params', { kind: 'channel-event', value: 'm1' }).ok).toBe(
      true,
    )
    expect(
      validateMethod('_agnes/v1/auth.claim', 'params', {
        kind: 'send',
        value: 'u1',
        limit: 2,
        windowMs: 1000,
      }).ok,
    ).toBe(true)
    // A window-shaped claim missing `windowMs`: the once-only branch refuses `limit` as an undeclared
    // key and the windowed branch refuses the missing `windowMs`, so neither branch of the oneOf is
    // satisfied and the union itself is what reports.
    expect(
      errorsOf(validateMethod('_agnes/v1/auth.claim', 'params', { kind: 'send', value: 'u1', limit: 2 })),
    ).toContainEqual(expect.objectContaining({ path: '', code: 'ENUM' }))
    expect(validateMethod('_agnes/v1/auth.claim', 'result', { granted: true, slot: 1 }).ok).toBe(true)
    expect(errorsOf(validateMethod('_agnes/v1/auth.claim', 'result', { slot: 1 }))).toContainEqual(
      expect.objectContaining({ code: 'MISSING', key: 'granted' }),
    )
  })

  it('detach takes a session id and returns an empty object', () => {
    expect(validateMethod('_agnes/v1/session.detach', 'params', { sessionId: 's' }).ok).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/session.detach', 'params', { sessionId: 's', extra: 1 })),
    ).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_KEY', key: 'extra' }))
    expect(validateMethod('_agnes/v1/session.detach', 'result', {}).ok).toBe(true)
    // Empty really is empty: a result carrying anything at all is a different shape.
    expect(errorsOf(validateMethod('_agnes/v1/session.detach', 'result', { ok: true }))).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_KEY', key: 'ok' }),
    )
  })

  it('validates the three ACP methods pulled forward with it', () => {
    expect(validateMethod('authenticate', 'params', { methodId: 'oauth' }).ok).toBe(true)
    expect(errorsOf(validateMethod('authenticate', 'params', {}))).toContainEqual(
      expect.objectContaining({ code: 'MISSING', key: 'methodId' }),
    )
    expect(validateMethod('authenticate', 'result', {}).ok).toBe(true)

    expect(
      validateMethod('session/load', 'params', { sessionId: 's1', cwd: '/work', mcpServers: [] }).ok,
    ).toBe(true)
    expect(errorsOf(validateMethod('session/load', 'params', { sessionId: 's1' }))).toContainEqual(
      expect.objectContaining({ code: 'MISSING', key: 'mcpServers' }),
    )
    expect(validateMethod('session/load', 'result', {}).ok).toBe(true)

    expect(validateMethod('session/set_mode', 'params', { sessionId: 's1', modeId: 'ask' }).ok).toBe(true)
    expect(errorsOf(validateMethod('session/set_mode', 'params', { sessionId: 's1' }))).toContainEqual(
      expect.objectContaining({ code: 'MISSING', key: 'modeId' }),
    )
    expect(validateMethod('session/set_mode', 'result', {}).ok).toBe(true)
  })

  // The four methods daemon's Task 10 needs and could not reach: they had no entry anywhere in this
  // table until now, so daemon's set_mode/budget/projectUI handlers registered but list/fork/
  // setPreset/setModel could not.
  it('fork takes a sessionId and a seq to fork from, and returns a new session id', () => {
    expect(validateMethod('_agnes/v1/session.fork', 'params', { sessionId: 's', at: 12 }).ok).toBe(true)
    expect(
      validateMethod('_agnes/v1/session.fork', 'params', { sessionId: 's', at: 12, childKey: 'k' }).ok,
    ).toBe(true)
    expect(errorsOf(validateMethod('_agnes/v1/session.fork', 'params', { sessionId: 's' }))).toContainEqual(
      expect.objectContaining({ code: 'MISSING', key: 'at' }),
    )
    expect(validateMethod('_agnes/v1/session.fork', 'result', { sessionId: 's-2' }).ok).toBe(true)
  })

  it('list pages SessionMeta and accepts an optional query', () => {
    expect(validateMethod('_agnes/v1/session.list', 'params', {}).ok).toBe(true)
    expect(
      validateMethod('_agnes/v1/session.list', 'params', {
        q: { cwd: '/work', prefix: 'x', text: 'hello' },
        cursor: 'c1',
        limit: 20,
      }).ok,
    ).toBe(true)
    expect(errorsOf(validateMethod('_agnes/v1/session.list', 'params', { limit: 0 }))).toContainEqual(
      expect.objectContaining({ code: 'RANGE', key: 'limit' }),
    )
    const meta = {
      sessionId: 's',
      createdAt: '2026-09-10T00:00:00Z',
      lastSeq: 3,
      generation: 1,
      preset: 'code',
    }
    expect(validateMethod('_agnes/v1/session.list', 'result', { items: [meta] }).ok).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/session.list', 'result', { items: [{ sessionId: 's' }] })),
    ).toContainEqual(expect.objectContaining({ path: '/items/0', code: 'MISSING', key: 'createdAt' }))
  })

  it('setPreset takes a sessionId and a preset name and returns the seq it takes effect from', () => {
    expect(
      validateMethod('_agnes/v1/session.setPreset', 'params', { sessionId: 's', preset: 'code' }).ok,
    ).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/session.setPreset', 'params', { sessionId: 's' })),
    ).toContainEqual(expect.objectContaining({ code: 'MISSING', key: 'preset' }))
    expect(validateMethod('_agnes/v1/session.setPreset', 'result', { effectiveFromSeq: 9 }).ok).toBe(true)
  })

  // slot is the same closed seven-value SlotName enum model.json already declares; retyping it here
  // would risk the two copies drifting apart, so this schema $refs model.json's definition instead.
  it('setModel.slot is the closed SlotName set', () => {
    expect(
      validateMethod('_agnes/v1/session.setModel', 'params', {
        sessionId: 's',
        slot: 'primary',
        route: 'r1',
        model: 'claude-sonnet-5',
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/session.setModel', 'params', {
          sessionId: 's',
          slot: 'primary2',
          route: 'r1',
          model: 'claude-sonnet-5',
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM', key: 'slot' }))
    expect(validateMethod('_agnes/v1/session.setModel', 'result', { effectiveFromSeq: 1 }).ok).toBe(true)
  })

  it('setYolo takes a sessionId and a boolean and returns the seq it takes effect from', () => {
    expect(validateMethod('_agnes/v1/session.setYolo', 'params', { sessionId: 's', enabled: true }).ok).toBe(
      true,
    )
    expect(
      errorsOf(validateMethod('_agnes/v1/session.setYolo', 'params', { sessionId: 's' })),
    ).toContainEqual(expect.objectContaining({ code: 'MISSING', key: 'enabled' }))
    expect(validateMethod('_agnes/v1/session.setYolo', 'result', { effectiveFromSeq: 9 }).ok).toBe(true)
  })
})

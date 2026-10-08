import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Event, ProjectionRegistry } from '@agnes/core'
import { expect, it } from 'vitest'
import { adaptProjection } from '../../src/ext-host/projections.js'
import { connectExtensionRunner } from '../../src/ext-host/runner-transport.js'

it('measures existing IPC and rejects its changed-reference unchanged-state result in the real registry', async () => {
  const runtime = process.env.AGNES_TEST_RUNTIME_DIRECTORY
  const executable = runtime
    ? join(runtime, `node/${process.platform}-${process.arch}/bin/node`)
    : process.execPath
  const testNodeEnvironment = !runtime && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  const started = performance.now()
  const child = spawn(
    executable,
    [
      '-e',
      `
    const send=m=>{const b=Buffer.from(JSON.stringify({protocol:1,...m})),h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]))};
    let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);while(b.length>=4&&b.length>=4+b.readUInt32BE(0)){const n=b.readUInt32BE(0),m=JSON.parse(b.subarray(4,n+4));b=b.subarray(n+4);if(m.kind==='prepare')send({kind:'ready',events:[],nodeVersion:process.version});if(m.kind==='invoke')send({kind:'result',requestId:m.requestId,value:m.payload});if(m.kind==='close')process.exit(0)}});
    send({kind:'hello',nonce:'projection',pid:process.pid});
  `,
    ],
    { env: testNodeEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const runner = await connectExtensionRunner(
    child,
    {
      nonce: 'projection',
      extensionId: 'acme/projection',
      packageDigest: 'probe',
      manifestDigest: 'probe',
      data: {},
    },
    async () => {
      throw Error('no capabilities')
    },
  )
  const startupMs = performance.now() - started
  try {
    const state = { value: 'x'.repeat(250000) },
      signal = new AbortController().signal
    const local: number[] = [],
      remote: number[] = []
    let returned: unknown
    const unchanged = (value: typeof state) => value
    for (let i = 0; i < 65; i++) {
      const a = performance.now()
      unchanged(state)
      const dt = performance.now() - a
      const b = performance.now()
      returned = await runner.invoke('apply', state, {}, signal)
      const rt = performance.now() - b
      if (i >= 15) {
        local.push(dt)
        remote.push(rt)
      }
    }
    const p95 = (v: number[]) => v.sort((a, b) => a - b)[47] ?? Number.NaN
    const report = JSON.stringify({
      experiment: 'R4 existing JSON transport',
      nodeVersion: runner.proposal.nodeVersion,
      executable,
      platform: process.platform,
      arch: process.arch,
      stateBytes: Buffer.byteLength(JSON.stringify(state)),
      warmup: 15,
      samples: 50,
      startupMs,
      inProcessP95Ms: p95(local),
      ipcP95Ms: p95(remote),
      sameReference: Object.is(returned, state),
    })
    if (process.env.AGNES_R4_REPORT) writeFileSync(process.env.AGNES_R4_REPORT, `${report}\n`)
    expect(returned).toEqual(state)
    expect(returned).not.toBe(state)
    const cap = { name: 'state', inputEventTypes: ['x/acme/projection/unchanged'], maxStateBytes: 262144 }
    const definition = {
      name: 'state',
      stateVersion: 1,
      stateSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      init: () => state,
      apply: unchanged,
    }
    const event = {
      seq: 1,
      ts: '2026-09-13T00:00:00.000Z',
      id: 'one',
      type: cap.inputEventTypes[0],
      data: {},
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'principal',
      trust: 'trusted',
      lane: 'main',
      v: 1,
    } as Event
    const oracle = new ProjectionRegistry(),
      wire = new ProjectionRegistry()
    oracle.register(adaptProjection('acme/projection', definition, cap), { owner: 'acme/projection' })
    wire.register(
      adaptProjection('acme/projection', { ...definition, apply: () => returned as typeof state }, cap),
      { owner: 'acme/projection' },
    )
    expect(oracle.snapshotOne('session', 'acme/projection/state', [event])).toMatchObject({
      state,
      stateVersion: 1,
    })
    expect(wire.snapshotOne('session', 'acme/projection/state', [event])).toEqual({ error: 'unavailable' })
    expect(wire.failures()).toEqual([{ key: 'acme/projection/state', seq: 1, message: 'unavailable' }])
    wire.purgeOwner('acme/projection')
    oracle.purgeOwner('acme/projection')
    expect(wire.failures()).toEqual([])
    expect(wire.cacheLine('session', 'acme/projection/state')).toBeUndefined()
    expect(oracle.registrations('acme/projection')).toEqual([])
  } finally {
    await runner.close()
  }
  expect(() => process.kill(runner.pid, 0)).toThrow()
})

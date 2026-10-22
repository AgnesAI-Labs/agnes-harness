import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { operations, runtimes } from '@agnes/code'
import { createTestHost } from '@agnes/host/testkit'
import type { Actor, InferenceEvent } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { parseArgs } from '../src/args.js'
import { bootLocal } from '../src/boot/local.js'
import { runPrint } from '../src/modes/print.js'
import { testDeps } from './boot-host.js'

const presetDirs = ['../../base/presets/', '../../code/presets/'].map((p) => new URL(p, import.meta.url))
const docs: Record<string, { name: string; extends?: string }> = Object.fromEntries(
  presetDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => {
        const doc = parse(readFileSync(new URL(name, dir), 'utf8')) as { name: string; extends?: string }
        return [doc.name, doc] as const
      }),
  ),
)
docs.default = { name: 'default', extends: 'standard' }
const { base, ...product } = docs
const recipes = Object.keys(docs).filter((name) => !name.startsWith('permission-'))

const REQUESTER: Actor = { id: 'requester', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const APPROVER: Actor = { id: 'approver', org: 'local', role: 'admin', deptPath: [], attrs: {} }

function printIo(cwd: string) {
  const stdout = new PassThrough()
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  let out = ''
  stdout.on('data', (chunk: Buffer) => {
    out += String(chunk)
  })
  return {
    stdout,
    stderr,
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    cwd,
    out: () => out,
  }
}

const shellCall = (command: string): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    via: 'native',
    call: { toolUseId: '', name: 'shell', args: { command }, ordinal: 0 },
  },
  { type: 'done', reason: 'toolUse' },
]
const done = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]

/** A real Host/daemon/SDK/core stack in an isolated home, scripted by a loopback provider. */
function stack(home: string, script: (open: number) => InferenceEvent[][]) {
  let opens = 0
  return async () =>
    (
      await createTestHost({
        dataDir: home,
        packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
        allowed: recipes,
        packages: {
          '@agnes/base': { presets: { base: base as never } },
          '@agnes/code': { presets: product as never, runtimes, operations },
        },
        seams: {
          approval: { ask: async () => 'unavailable' },
          principals: {
            resolve: async (_credential, surface) => (surface === 'approval' ? APPROVER : REQUESTER),
          },
        },
        script: script(opens++),
      })
    ).host
}

const toolNodes = async (booted: Awaited<ReturnType<typeof bootLocal>>, sessionId: string) => {
  const session = await booted.client.session.load(sessionId, { cwd: '.' })
  return (await session.projectUI(undefined, { surface: 'tui' })).nodes
}

describe('shell approvals through the real stack', () => {
  it('refuses a hard-blocked command under full access without asking anyone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-hard-block-'))
    const createHostImpl = stack(home, () => [
      // A nonexistent device: were the block ever to regress, the command would still do no harm.
      shellCall('dd if=/dev/zero of=/dev/disk99 bs=1m count=1'),
      done('refused'),
    ])
    let booted: Awaited<ReturnType<typeof bootLocal>> | undefined
    try {
      booted = await bootLocal(parseArgs(['-p', 'clean']), testDeps(home, { createHostImpl }))
      const session = await booted.client.session.new({ cwd: home })
      await session.setYolo(true)
      expect((await session.prompt([{ type: 'text', text: 'clean up' }])).reason).toBe('completed')
      const nodes = (await session.projectUI(undefined, { surface: 'tui' })).nodes
      expect(nodes.filter((node) => node.kind === 'approval')).toEqual([])
      expect(JSON.stringify(nodes)).toContain('hard-blocked')
    } finally {
      await booted?.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  // The loopback provider would happily take a second step; the cap is what ends the turn.
  it.each([
    [['--max-turns', '1'], 5],
    [[], 0],
  ])(
    'agh -p %j ends a two-step turn with exit %d',
    async (extra, exit) => {
      const home = mkdtempSync(join(tmpdir(), 'agnes-max-turns-'))
      const createHostImpl = stack(home, () => [shellCall('echo hi'), done('finished')])
      let booted: Awaited<ReturnType<typeof bootLocal>> | undefined
      try {
        const argv = ['-p', 'go', '--preset', 'standard', '--permission', 'full-access', ...extra]
        booted = await bootLocal(parseArgs(argv), testDeps(home, { createHostImpl }))
        expect(await runPrint(booted, parseArgs(argv), printIo(home))).toBe(exit)
      } finally {
        await booted?.close()
        rmSync(home, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it('stops asking for commands that start with an approved prefix', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-prefix-'))
    const createHostImpl = stack(home, (open) =>
      open === 0
        ? [shellCall('git status')]
        : [done('first done'), shellCall('git status -s'), done('second done')],
    )
    let first: Awaited<ReturnType<typeof bootLocal>> | undefined
    let second: Awaited<ReturnType<typeof bootLocal>> | undefined
    try {
      first = await bootLocal(parseArgs(['-p', 'status']), testDeps(home, { createHostImpl }))
      const output = printIo(home)
      expect(await runPrint(first, parseArgs(['-p', 'status']), output)).toBe(3)
      const sessionId = /session=(\S+)/.exec(output.out())?.[1] as string
      const pending = (await first.client.approval.list(sessionId)).decisions.find(
        (value) => value.request.owner === 'core/tool-permission' && !value.result,
      )
      expect(pending?.request.spec.options).not.toContain('allow_prefix_session')
      expect(pending?.request.spec.subject).toMatchObject({ prefixGrant: { tokens: ['git', 'status'] } })
      await first.close()
      first = undefined

      second = await bootLocal(parseArgs(['--resume', sessionId]), testDeps(home, { createHostImpl }))
      const session = await second.client.session.load(sessionId, { cwd: home })
      await second.client.approval.decide({
        sessionId,
        id: pending?.handle.id as string,
        revision: pending?.revision as number,
        commandId: 'prefix-1',
        response: { option: 'allow_prefix_session', value: null },
      })
      await vi.waitFor(async () =>
        expect(JSON.stringify((await session.projectUI(undefined, { surface: 'tui' })).nodes)).toContain(
          'first done',
        ),
      )
      // The second command begins with the approved prefix: it runs and nothing is left pending.
      // The continuation may still be finishing its turn; a busy session is retried until idle.
      const next = await vi.waitFor(() => session.prompt([{ type: 'text', text: 'again' }]), {
        timeout: 15_000,
        interval: 100,
      })
      expect(next.reason).toBe('completed')
      const decisions = (await second.client.approval.list(sessionId)).decisions
      expect(JSON.stringify((await session.projectUI(undefined, { surface: 'tui' })).nodes)).toContain(
        'second done',
      )
      expect(decisions.filter((value) => !value.result && !value.invalidation)).toEqual([])
      const grants = await second.client.approval.sessionGrants(sessionId)
      expect(grants.grants.map((grant) => grant.scope)).toEqual(['shell:prefix:["git","status"]'])
    } finally {
      await second?.close()
      await first?.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})

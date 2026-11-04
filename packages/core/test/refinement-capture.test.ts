import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ToolDef } from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { afterEach, describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { REFINEMENT_SESSION, REFINEMENT_TOOLS } from '../src/refinement/capture.js'
import { refinementFacade } from '../src/refinement/facade.js'
import { onCompactionCommitted, type RefinementTriggerSink } from '../src/refinement/triggers.js'
import { EXPERIENCE_OFF_NOTICE } from '../src/request/experience.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { type FakeProvider, fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps, testWorkspaceInvocation } from './helpers/open-session.js'

/**
 * Task experience is decided per session as it opens: turning the switch on reaches the sessions
 * opened after it, turning it off stops every session at once.
 */

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const options = (writerRunId = 'r1') => ({
  actor,
  resolvedProfileHash: 'h1',
  cwd: '/w',
  writerRunId,
  workspaceInvocation: testWorkspaceInvocation(),
})
const tool = (name: string) =>
  ({
    name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe' as const,
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: undefined,
    },
    execute: async () => ({ content: [{ type: 'text', text: name }] }),
  }) as unknown as ToolDef

/** The profile switch, as the host reads it: live. */
const sw = { on: false }
afterEach(() => {
  sw.on = false
})

function kernel(storage = new MemoryStorage(), provider: FakeProvider = fakeProvider([textTurn('ok')])) {
  const offered: string[] = []
  const triggers: RefinementTriggerSink = { offer: (c) => offered.push(c.sessionKey), accepts: () => true }
  const k = Kernel.create({
    loops: defaultLoops(),
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
    refinementEnabled: () => sw.on,
    refinementTriggers: triggers,
    refinement: {
      settings: () => ({ enabled: sw.on, mode: 'auto', revision: 'r' }),
      planner: () => undefined,
    },
  })
  const own = { source: 'agnes/test', trust: 'builtin' as const }
  for (const name of ['read', ...REFINEMENT_TOOLS]) k.tools.add(tool(name), own)
  return { k, provider, offered }
}

const names = (s: SessionImpl) =>
  s
    .currentTools()
    .list()
    .map((t) => t.name)
    .sort()
const catalog = (s: SessionImpl) => s.toolCatalog().tools.map((t) => t.name)
async function turn(s: SessionImpl, text = 'go') {
  await s.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
  const result = await s.run({ until: 'turn-end', signal: new AbortController().signal })
  expect(result.reason).toBe('completed')
}
const last = (p: FakeProvider): RequestBody => {
  const request = p.requests.at(-1)
  if (!request) throw new Error('no request sent')
  return request
}
const toolsOf = (request: RequestBody) => (request.kind === 'inference' ? request.tools : [])
const sectionsOf = (request: RequestBody) => (request.kind === 'inference' ? request.sections : [])
const hasExperience = (request: RequestBody) => JSON.stringify(request).includes('[task-experience]')
const markers = async (s: SessionImpl) => (await s.scan({ type: REFINEMENT_SESSION, limit: 10 })).length

describe('turning task experience on reaches the sessions opened after it', () => {
  it('a session open before the switch went on keeps its tools, notes and triggers as they were', async () => {
    const { k, provider, offered } = kernel()
    const before = await k.session('before', options())
    await turn(before)
    const first = last(provider)
    sw.on = true
    const after = await k.session('after', options())
    await turn(after)
    const fresh = last(provider)
    await turn(before, 'again')
    const second = last(provider)

    // The session opened while it was off: no refinement tool in any listing, no note, the same prefix.
    expect(names(before)).toEqual(['read'])
    expect(catalog(before)).toEqual(['read'])
    expect(toolsOf(second)).toEqual(toolsOf(first))
    expect(sectionsOf(second)).toEqual(sectionsOf(first))
    expect(hasExperience(first) || hasExperience(second)).toBe(false)
    expect(JSON.stringify(second)).not.toContain('harness_')
    expect(before.d.refinementEnabled?.()).toBe(false)
    expect(await refinementFacade(before).request({ kind: 'manual', seq: before.lastSeq })).toEqual({
      refused: 'refinement-off',
    })

    // The session opened after it: the tools, the experience note and the triggers.
    expect(names(after)).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    expect(
      toolsOf(fresh)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    expect(hasExperience(fresh)).toBe(true)
    for (const s of [before, after]) onCompactionCommitted(s, { replaceSeq: s.lastSeq, mode: 'summary' })
    expect(offered).toEqual(['after'])
    // The decision is recorded once, with the first request, only by the session that runs it.
    await turn(after, 'again')
    expect(await markers(before)).toBe(0)
    expect(await markers(after)).toBe(1)
    await k.close()
  })

  it('turning it off stops a session that runs it at once, and its tool list stays', async () => {
    sw.on = true
    const { k, provider, offered } = kernel()
    const s = await k.session('k1', options())
    await turn(s)
    const on = last(provider)
    sw.on = false
    expect(s.d.refinementEnabled?.()).toBe(false)
    expect(s.d.refinement?.settings().enabled).toBe(false)
    onCompactionCommitted(s, { replaceSeq: s.lastSeq, mode: 'summary' })
    expect(offered).toEqual([])
    await turn(s, 'again')
    const off = last(provider)
    expect(toolsOf(off)).toEqual(toolsOf(on))
    // The model is told once that what it was given no longer applies.
    expect(JSON.stringify(off)).toContain(EXPERIENCE_OFF_NOTICE)
    expect(names(s)).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    await k.close()
  })

  it('a child follows its parent, whatever the switch says when it opens', async () => {
    const { k } = kernel()
    const off = await k.session('off', options())
    sw.on = true
    const on = await k.session('on', options())
    const childOfOff = await k.session('off-child', {
      ...options(),
      parent: { key: 'off', boundarySeq: off.lastSeq },
    })
    expect(names(childOfOff)).toEqual(['read'])
    expect(childOfOff.d.refinementEnabled?.()).toBe(false)
    sw.on = false
    const childOfOn = await k.session('on-child', {
      ...options(),
      parent: { key: 'on', boundarySeq: on.lastSeq },
    })
    expect(names(childOfOn)).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    await k.close()
  })
})

describe('a reopened session', () => {
  /** Closes the kernel and opens the session again in a new one over the same ledger. */
  async function reopen(storage: MemoryStorage, key: string, run = 'r2') {
    const { k } = kernel(storage)
    const s = await k.session(key, options(run))
    return { k, s }
  }

  it('that sent requests without task experience stays without it after the switch went on', async () => {
    const storage = new MemoryStorage()
    const first = kernel(storage)
    await turn(await first.k.session('k1', options()))
    await first.k.close()
    sw.on = true
    const { k, s } = await reopen(storage, 'k1')
    expect(names(s)).toEqual(['read'])
    expect(s.d.refinementEnabled?.()).toBe(false)
    await k.close()
  })

  it('that opened with it and sent its requests after the switch went off keeps its tools', async () => {
    sw.on = true
    const storage = new MemoryStorage()
    const first = kernel(storage)
    const s = await first.k.session('k1', options())
    sw.on = false
    await turn(s)
    // Its requests carried the tools, with no experience note: the open-time decision is what is recorded.
    expect(toolsOf(last(first.provider)).map((t) => t.name)).toContain('harness_refine')
    expect(hasExperience(last(first.provider))).toBe(false)
    await first.k.close()
    sw.on = true
    const { k, s: again } = await reopen(storage, 'k1')
    expect(names(again)).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    expect(again.d.refinementEnabled?.()).toBe(true)
    await turn(again)
    expect(await markers(again)).toBe(1)
    await k.close()
  })

  it('from before the marker, with experience rows only, counts as having run with it', async () => {
    const storage = new MemoryStorage()
    const first = kernel(storage)
    const s = await first.k.session('k1', options())
    await turn(s)
    // What an older ledger of a session that ran with task experience holds: its experience rows.
    await s.d.log.append([
      s.ev('x/core/refinement-prefix-change', { reason: 'experience-snapshot' }, { ignorable: true }),
    ])
    await first.k.close()
    sw.on = true
    const { k, s: again } = await reopen(storage, 'k1')
    expect(names(again)).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    await k.close()
  })

  it('that never sent a request decides from the switch, like a new one', async () => {
    const storage = new MemoryStorage()
    const first = kernel(storage)
    await first.k.session('k1', options())
    await first.k.close()
    sw.on = true
    const { k, s } = await reopen(storage, 'k1')
    expect(names(s)).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    expect(s.d.refinementEnabled?.()).toBe(true)
    await k.close()
  })

  it('that ran with task experience follows the switch as it is when it reopens', async () => {
    sw.on = true
    const storage = new MemoryStorage()
    const first = kernel(storage)
    await turn(await first.k.session('k1', options()))
    await first.k.close()
    const again = await reopen(storage, 'k1')
    expect(names(again.s)).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    await again.k.close()
    sw.on = false
    const off = await reopen(storage, 'k1', 'r3')
    expect(names(off.s)).toEqual(['read'])
    await off.k.close()
    sw.on = true
    const back = await reopen(storage, 'k1', 'r4')
    expect(back.s.d.refinementEnabled?.()).toBe(true)
    expect(names(back.s)).toEqual(['read', ...REFINEMENT_TOOLS].sort())
    await back.k.close()
  })
})

describe('a kernel without refinement', () => {
  it('hides nothing: tools of the same names are listed as before', async () => {
    const k = Kernel.create({
      loops: defaultLoops(),
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: fakeProvider([textTurn('ok')]),
      contract: { contract_id: null, parser_version: '1' },
      preset: presetDefaults(),
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger,
      timers: noTimers,
    })
    for (const name of REFINEMENT_TOOLS) k.tools.add(tool(name), { source: 'agnes/test', trust: 'builtin' })
    const s = await k.session('k1', options())
    expect(names(s)).toEqual([...REFINEMENT_TOOLS].sort())
    await k.close()
  })
})

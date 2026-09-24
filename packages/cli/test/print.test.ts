import { PassThrough, Readable } from 'node:stream'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runPrint } from '../src/modes/print.js'
import { cliResultLine, findParkedTicket, lastAssistantText } from '../src/modes/result-line.js'
import type { Booted } from '../src/types.js'
import { FAKE_SESSION_ID, type FakeEndpoint, scriptedEndpoint } from './fake-endpoint.js'

async function booted(ep: FakeEndpoint = scriptedEndpoint()): Promise<Booted> {
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep }, journal: memoryJournal() })
  return {
    client,
    profileName: 'local-dev',
    resolvedProfileHash: 'h',
    bootMs: 1,
    form: 'local',
    close: () => client.close(),
  }
}

function io(o: { stderrTTY?: boolean; stdin?: string } = {}) {
  const stdout = new PassThrough()
  const stderr = Object.assign(new PassThrough(), { isTTY: o.stderrTTY ?? false })
  let out = ''
  let err = ''
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  stderr.on('data', (b: Buffer) => {
    err += String(b)
  })
  const stdin =
    o.stdin === undefined
      ? Object.assign(Readable.from([]), { isTTY: true })
      : Object.assign(Readable.from([Buffer.from(o.stdin)]), { isTTY: false })
  return { stdout, stderr, stdin, cwd: '/w', out: () => out, err: () => err }
}

describe('runPrint in text mode', () => {
  it('prints the last assistant text and exits 0, with nothing on stderr', async () => {
    const o = io()
    const code = await runPrint(
      await booted(scriptedEndpoint({ reply: 'answer 42' })),
      parseArgs(['-p', 'q']),
      o,
    )
    expect(code).toBe(0)
    expect(o.out()).toBe('answer 42\n')
    expect(o.err()).toBe('')
  })

  it('joins a multi-word prompt rather than sending only the first word', async () => {
    const ep = scriptedEndpoint()
    await runPrint(await booted(ep), parseArgs(['-p', 'what', 'is', 'six', 'times', 'seven']), io())
    const prompt = ep.calls.find((c) => c.method === 'session/prompt')?.params as {
      prompt: Array<{ text: string }>
    }
    expect(prompt.prompt).toEqual([{ type: 'text', text: 'what is six times seven' }])
  })

  it('takes the prompt off a pipe when there is no positional', async () => {
    const ep = scriptedEndpoint()
    await runPrint(await booted(ep), parseArgs(['-p']), io({ stdin: 'from the pipe' }))
    const prompt = ep.calls.find((c) => c.method === 'session/prompt')?.params as {
      prompt: Array<{ text: string }>
    }
    expect(prompt.prompt).toEqual([{ type: 'text', text: 'from the pipe' }])
  })

  // The correctness requirement, asserted on the endpoint's own record: a cursorless attach that
  // lands after the prompt subscribes from wherever the session already got to, so every row of the
  // turn in between is lost -- which presents as a run that never prints and never exits.
  it('attaches before it prompts, so no row of the turn can fall between the two', async () => {
    const ep = scriptedEndpoint()
    await runPrint(await booted(ep), parseArgs(['-p', 'q']), io())
    const methods = ep.calls.map((c) => c.method)
    expect(methods.indexOf('_agnes/v1/session.attach')).toBeGreaterThan(methods.indexOf('session/new'))
    expect(methods.indexOf('_agnes/v1/session.attach')).toBeLessThan(methods.indexOf('session/prompt'))
  })

  it('a parked turn exits 3, prints the ticket, and names the reason on stderr', async () => {
    const o = io()
    const ep = scriptedEndpoint({ reason: 'parked', parkedTicket: 'tk-123' })
    // No `--park` on the command line: that flag is refused by name below, because host cannot
    // apply the profile layer it would have travelled in. A turn parks because the profile says to.
    const code = await runPrint(await booted(ep), parseArgs(['-p', 'rm tmp']), o)
    expect(code).toBe(3)
    expect(o.out()).toBe(`parked ticket=tk-123 session=${FAKE_SESSION_ID}\n`)
    expect(o.err()).toBe('agnes: turn ended: parked (exit 3)\n')
  })

  // The whole table, under both arrival orders. The second one matters more than it looks: with the
  // rows behind the reply, sdk has no terminal notification to read when it answers and falls back
  // to the ACP stop reason -- which is `end_turn` for every one of these -- so anything reading the
  // reason off the reply reports `completed` and exit 0 for a turn that was blocked or out of
  // budget. runPrint waits for the row and takes the reason from it, which is why both columns
  // agree. The ruling behind the stderr word: blocked and budget share exit 4 and want opposite
  // remediations, and the integer cannot tell them apart.
  describe.each([
    ['rows before the reply', false],
    ['rows after the reply', true],
  ])('%s', (_name, rowsAfterReply) => {
    it.each([
      ['budget', 4],
      ['blocked', 4],
      ['max_steps', 5],
      ['aborted', 130],
      ['interrupted', 1],
      ['error', 1],
    ])('a turn ending in %s exits %d and prints the reason word on stderr', async (reason, code) => {
      const o = io()
      const ep = scriptedEndpoint({ reason, rowsAfterReply })
      const got = await runPrint(await booted(ep), parseArgs(['-p', 'q']), o)
      expect(got).toBe(code)
      expect(o.err()).toBe(`agnes: turn ended: ${reason} (exit ${code})\n`)
    })

    it('a completed turn exits 0 and prints no reason word', async () => {
      const o = io()
      const ep = scriptedEndpoint({ reason: 'completed', reply: 'done', rowsAfterReply })
      expect(await runPrint(await booted(ep), parseArgs(['-p', 'q']), o)).toBe(0)
      expect(o.out()).toBe('done\n')
      expect(o.err()).toBe('')
    })

    it('a parked turn exits 3 with its ticket', async () => {
      const o = io()
      const ep = scriptedEndpoint({ reason: 'parked', parkedTicket: 'tk-7', rowsAfterReply })
      expect(await runPrint(await booted(ep), parseArgs(['-p', 'q']), o)).toBe(3)
      expect(o.out()).toBe(`parked ticket=tk-7 session=${FAKE_SESSION_ID}\n`)
    })

    it('the json result line carries the same reason, exit code and position', async () => {
      const o = io()
      const ep = scriptedEndpoint({ reason: 'blocked', reply: 'nope', rowsAfterReply })
      const code = await runPrint(await booted(ep), parseArgs(['-p', 'q', '--mode', 'json']), o)
      expect(code).toBe(4)
      expect(JSON.parse(o.out())).toMatchObject({ reason: 'blocked', exitCode: 4, lastSeq: 3 })
    })
  })

  // daemon raises TURN_ERROR rather than answering with an ACP stop reason it has no member for, so
  // the reason arrives as a thrown error's data. Read there, `error` reaches the exit table like any
  // other reason instead of escaping as a stack trace.
  it('a turn that ended in error comes back as a thrown rpc error and still exits 1', async () => {
    const ep = scriptedEndpoint().on('session/prompt', () => {
      throw Object.assign(new Error('INTERNAL_ERROR'), {
        code: -32603,
        data: { code: 'TURN_ERROR', turnEnd: { reason: 'error' } },
      })
    })
    const o = io()
    const t0 = performance.now()
    expect(await runPrint(await booted(ep), parseArgs(['-p', 'q']), o)).toBe(1)
    expect(o.err()).toBe('agnes: turn ended: error (exit 1)\n')
    // And it comes back at once. daemon raises TURN_ERROR *instead of* a turn outcome, so no
    // turn/end is coming and waiting the full drain out would be a second of silence before the
    // same exit code -- on the one path where the caller already knows something went wrong.
    expect(performance.now() - t0).toBeLessThan(500)
  })

  // Real-machine: a provider 400 printed only "turn ended: error (exit 1)" while the row said why.
  it.each([false, true])(
    'an error turn names the cause its turn/end row carries (rowsAfterReply=%s)',
    async (late) => {
      const o = io()
      const ep = scriptedEndpoint({
        reason: 'error',
        rowsAfterReply: late,
        turnEndError: { code: 'TRANSPORT', message: 'status=400\u001b[2J' },
      })
      expect(await runPrint(await booted(ep), parseArgs(['-p', 'q']), o)).toBe(1)
      expect(o.err()).toBe('agnes: turn ended: error (exit 1): TRANSPORT status=400 [2J\n')
    },
  )

  it('a thrown TURN_ERROR without a row still names the cause from its data', async () => {
    const ep = scriptedEndpoint().on('session/prompt', () => {
      throw Object.assign(new Error('INTERNAL_ERROR'), {
        code: -32603,
        data: {
          code: 'TURN_ERROR',
          turnEnd: { reason: 'error' },
          error: { code: 'AUTH', message: 'status=401' },
        },
      })
    })
    const o = io()
    expect(await runPrint(await booted(ep), parseArgs(['-p', 'q']), o)).toBe(1)
    expect(o.err()).toBe('agnes: turn ended: error (exit 1): AUTH status=401\n')
  })

  it('an rpc error that is not a turn outcome is not dressed up as one', async () => {
    const ep = scriptedEndpoint().on('session/prompt', () => {
      throw Object.assign(new Error('SESSION_BUSY'), { code: -32004, data: { code: 'SESSION_BUSY' } })
    })
    await expect(runPrint(await booted(ep), parseArgs(['-p', 'q']), io())).rejects.toThrow(/SESSION_BUSY/)
  })

  // A resumed session replays its whole transcript through the attach. Without the sequence
  // watermark the collector would stop on a turn/end from a turn that ended before this process
  // started, and print that turn's answer as though it were this one's.
  it('a resumed session prints this turn, not the one already in the transcript', async () => {
    // slowRows puts the arrivals in the order a resume actually meets: the transcript first, this
    // turn's rows after it. Without it the new rows land first and sdk's own de-duplication hides
    // the history, so the watermark below would never be the thing doing the work.
    const ep = scriptedEndpoint({ history: 'yesterday', reply: 'today', slowRows: true })
    const o = io()
    const code = await runPrint(await booted(ep), parseArgs(['-p', 'q', '--resume', FAKE_SESSION_ID]), o)
    expect(code).toBe(0)
    expect(o.out()).toBe('today\n')
    expect(ep.calls.map((c) => c.method)).toContain('session/load')
    expect(ep.calls.map((c) => c.method)).not.toContain('session/new')
  })

  // A load also opens a session the daemon has never seen, and the cwd it is given becomes that
  // session's own. sdk defaults it to the empty string, which put every relative path a tool was
  // handed outside the workspace root -- visible only on a real resumed run, because each side's
  // own tests agreed with themselves.
  it('a resume carries the working directory, rather than leaving it empty', async () => {
    const ep = scriptedEndpoint({ history: 'yesterday' })
    await runPrint(await booted(ep), parseArgs(['-p', 'q', '--resume', FAKE_SESSION_ID]), io())
    expect(ep.calls.find((c) => c.method === 'session/load')?.params).toMatchObject({
      sessionId: FAKE_SESSION_ID,
      cwd: '/w',
    })
  })

  it('emits no progress lines when the turn calls no tools', async () => {
    const quiet = io({ stderrTTY: false })
    await runPrint(await booted(scriptedEndpoint()), parseArgs(['-p', 'q']), quiet)
    expect(quiet.err()).toBe('')
  })

  it('reports each tool call and its outcome to stderr, on a TTY or not', async () => {
    const toolCall = { toolUseId: 'c1', name: 'read', durationMs: 124, outcome: 'ok' as const }

    const nonTty = io({ stderrTTY: false })
    await runPrint(await booted(scriptedEndpoint({ toolCall })), parseArgs(['-p', 'q']), nonTty)
    expect(nonTty.err()).toBe('- tool read\n- tool read · ok · 124ms\n')

    const tty = io({ stderrTTY: true })
    await runPrint(await booted(scriptedEndpoint({ toolCall })), parseArgs(['-p', 'q']), tty)
    expect(tty.err()).toBe('- tool read\n- tool read · ok · 124ms\n')
  })

  it('omits the tool call marker entirely in --mode json, start and end alike', async () => {
    const toolCall = { toolUseId: 'c1', name: 'read', durationMs: 124, outcome: 'ok' as const }
    const nonTty = io({ stderrTTY: false })
    await runPrint(
      await booted(scriptedEndpoint({ toolCall })),
      parseArgs(['-p', 'q', '--mode', 'json']),
      nonTty,
    )
    expect(nonTty.err()).toBe('')
  })

  // Each refusal names the flag the user typed and what is missing. `--park` and `--preset --resume`
  // used to reach host instead and come back as the same string for both -- `E_DEP_MISSING:
  // resolveProfile cannot apply the flags layer yet` -- which names an internal layer, tells the two
  // cases apart not at all, and leaves nothing to act on.
  it.each([
    [['-p', 'q', '--park'], '--park'],
    [['-p', 'q', '--preset', 'standard', '--continue'], '--preset'],
    [['-p', 'q', '--preset', 'standard', '--resume', FAKE_SESSION_ID], '--preset'],
  ])('%j is refused by the flag it names, with exit 2', async (argv, flag) => {
    const e = await runPrint(await booted(), parseArgs(argv as string[]), io()).catch((x: unknown) => x)
    expect(e).toMatchObject({ name: 'UsageError', code: 2 })
    expect((e as Error).message.startsWith(flag as string)).toBe(true)
  })

  it('the two remaining refusals say two different things', async () => {
    const said: string[] = []
    for (const argv of [
      ['-p', 'q', '--park'],
      ['-p', 'q', '--preset', 'standard', '--resume', FAKE_SESSION_ID],
    ]) {
      const e = await runPrint(await booted(), parseArgs(argv), io()).catch((x: unknown) => x)
      said.push((e as Error).message)
    }
    expect(new Set(said).size).toBe(2)
  })

  // The list is ordered by recent activity and filtered to this working directory by daemon; an
  // archived session is one the user put away, so --continue skips it the way the Web sidebar does.
  it('--continue resumes the most recently active session in this directory', async () => {
    const ep = scriptedEndpoint({ history: 'yesterday', reply: 'today', slowRows: true })
    ep.on('_agnes/v1/session.list', () => ({
      items: [
        {
          sessionId: 'archived',
          createdAt: 't',
          lastSeq: 9,
          generation: 1,
          preset: 'standard',
          archived: true,
        },
        { sessionId: FAKE_SESSION_ID, createdAt: 't', lastSeq: 3, generation: 1, preset: 'standard' },
        { sessionId: 'older', createdAt: 't', lastSeq: 3, generation: 1, preset: 'standard' },
      ],
    }))
    const o = io()
    expect(await runPrint(await booted(ep), parseArgs(['-p', 'q', '--continue']), o)).toBe(0)
    expect(o.out()).toBe('today\n')
    expect(ep.calls.find((c) => c.method === '_agnes/v1/session.list')?.params).toMatchObject({
      q: { cwd: '/w' },
    })
    expect(ep.calls.find((c) => c.method === 'session/load')?.params).toMatchObject({
      sessionId: FAKE_SESSION_ID,
      cwd: '/w',
    })
    expect(ep.calls.map((c) => c.method)).not.toContain('session/new')
  })

  it('--continue with no session in this directory says so instead of starting a new one', async () => {
    const ep = scriptedEndpoint()
    ep.on('_agnes/v1/session.list', () => ({ items: [] }))
    const e = await runPrint(await booted(ep), parseArgs(['-p', 'q', '--continue']), io()).catch(
      (x: unknown) => x,
    )
    expect(e).toMatchObject({ name: 'CommandError', code: 1 })
    expect((e as Error).message).toContain('/w')
    expect(ep.calls.map((c) => c.method)).not.toContain('session/new')
  })

  // --model used to be refused here too (R1's sdk.Session.setModel did not exist yet). Now it is
  // applied before the prompt is sent, not refused -- see openSession's call to it in print.ts.
  it('--model calls session.setModel before the prompt, not after', async () => {
    const ep = scriptedEndpoint()
    ep.on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 5 }))
    expect(await runPrint(await booted(ep), parseArgs(['-p', 'q', '--model', 'primary=r/m']), io())).toBe(0)
    const setModelCall = ep.calls.find((c) => c.method === '_agnes/v1/session.setModel')
    expect(setModelCall?.params).toMatchObject({ slot: 'primary', route: 'r', model: 'm' })
    const setModelIndex = ep.calls.findIndex((c) => c.method === '_agnes/v1/session.setModel')
    const promptIndex = ep.calls.findIndex((c) => c.method === 'session/prompt')
    expect(setModelIndex).toBeGreaterThanOrEqual(0)
    expect(setModelIndex).toBeLessThan(promptIndex)
  })

  // Not refused: on a new session a preset travels on session/new, where daemon checks it against
  // presets.allowed. Only a resume cannot take one.
  it('--preset on a new session is passed through rather than refused', async () => {
    const ep = scriptedEndpoint()
    expect(await runPrint(await booted(ep), parseArgs(['-p', 'q', '--preset', 'standard']), io())).toBe(0)
    expect(ep.calls.find((c) => c.method === 'session/new')?.params).toMatchObject({
      _meta: { 'ai.agnes.harness': { preset: 'standard' } },
    })
  })
})

describe('runPrint in json mode', () => {
  it('writes one result line and nothing else', async () => {
    const o = io()
    const code = await runPrint(
      await booted(scriptedEndpoint({ reply: 'answer 42' })),
      parseArgs(['-p', 'q', '--mode', 'json']),
      o,
    )
    expect(code).toBe(0)
    expect(JSON.parse(o.out())).toEqual({
      v: 'agnes-cli-result/v1',
      sessionId: FAKE_SESSION_ID,
      reason: 'completed',
      exitCode: 0,
      lastSeq: 3,
      text: 'answer 42',
    })
    expect(o.out().endsWith('\n')).toBe(true)
    // The reason already rides in the line; repeating it on stderr would corrupt a caller that reads
    // both streams into one.
    expect(o.err()).toBe('')
  })

  it('carries the ticket in the line when the turn parked', async () => {
    const o = io()
    const ep = scriptedEndpoint({ reason: 'parked', parkedTicket: 'tk-9' })
    const code = await runPrint(await booted(ep), parseArgs(['-p', 'q', '--mode', 'json']), o)
    expect(code).toBe(3)
    expect(JSON.parse(o.out())).toMatchObject({ reason: 'parked', exitCode: 3, ticket: 'tk-9' })
  })
})

describe('result line helpers', () => {
  it('the result line is one json object under the versioned key, newline terminated', () => {
    const line = cliResultLine({ sessionId: 's', reason: 'completed', exitCode: 0, lastSeq: 3, text: 'x' })
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({
      v: 'agnes-cli-result/v1',
      sessionId: 's',
      reason: 'completed',
      exitCode: 0,
      lastSeq: 3,
      text: 'x',
    })
  })

  const asked = (seq: number, pending?: { ticket: string }) =>
    ({
      seq,
      ts: 't',
      id: `01J6ZM2Q3R4S5T6V7W8X9Y0${String(seq).padStart(3, '0')}`,
      type: 'approval/asked',
      data: { kind: 'tool', ...(pending ? { pending: { ...pending, expiresAt: 'x' } } : {}) },
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
    }) as never

  it('takes the last ask that actually parked, skipping asks that were answered', () => {
    expect(findParkedTicket([asked(1, { ticket: 'old' }), asked(2, { ticket: 'new' })])).toBe('new')
    expect(findParkedTicket([asked(1, { ticket: 'old' }), asked(2)])).toBe('old')
    expect(findParkedTicket([asked(1)])).toBeUndefined()
    expect(findParkedTicket([])).toBeUndefined()
  })

  const message = (seq: number, content: unknown) =>
    ({
      seq,
      ts: 't',
      id: `01J6ZM2Q3R4S5T6V7W8X9Y0${String(seq).padStart(3, '0')}`,
      type: 'assistant/message',
      data: { content, stopReason: 'end_turn' },
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'model',
      trust: 'trusted',
    }) as never

  it('reads the last message, joins its text blocks, and leaves thinking out', () => {
    expect(lastAssistantText([message(1, [{ type: 'text', text: 'first' }])])).toBe('first')
    expect(
      lastAssistantText([
        message(1, [{ type: 'text', text: 'first' }]),
        message(2, [
          { type: 'text', text: 'sec' },
          { type: 'text', text: 'ond' },
        ]),
      ]),
    ).toBe('second')
    expect(
      lastAssistantText([
        message(1, [
          { type: 'thinking', text: 'do not print me' },
          { type: 'text', text: 'the answer' },
        ]),
      ]),
    ).toBe('the answer')
    expect(lastAssistantText([])).toBe('')
    expect(lastAssistantText([message(1, [])])).toBe('')
  })
})

import type { EffectIntent, EffectSettled, EventEnvelope, ToolCall, TurnEndReason } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { CommandError, exitCodeForReason, SIGNAL_EXIT_CODES, type SignalName, UsageError } from '../errors.js'
import type { Booted, ParsedArgs } from '../types.js'
import { readPromptInput } from './prompt-input.js'
import { cliResultLine, findParkedTicket, lastAssistantText } from './result-line.js'

export type PrintIO = {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream & { isTTY?: boolean }
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  cwd: string
  /** How the signal ladder reaches the turn in flight. Absent in tests that send no signals. */
  registerCancel?: (cancel: () => Promise<void>) => void
  /** Which signal, if any, has arrived. Read after the turn: an abort's exit code is the signal's. */
  signal?: () => SignalName | undefined
}

/**
 * How long the event stream is given to catch up after the prompt response has already arrived.
 *
 * They are two arrivals, not one: the response comes back from `handle()` directly while every row
 * travels the notification queue, so a turn is over on one path while its last rows are still in
 * flight on the other. Waiting is what makes the printed answer the turn's own; waiting *without a
 * bound* is how a `-p` run turns a lost row into a hang, which is the failure mode with no output
 * and no exit code.
 *
 * A second, not five. daemon has already waited for quiescence before it answers, so what is left is
 * transport latency and a macrotask, not a turn. The old five outlasted the signal ladder's own
 * grace, so a turn whose terminal row never arrives -- which is what an aborted turn is today, since
 * core writes no turn/end for one -- held a Ctrl-C for five seconds and made the ladder exit twice.
 */
const DRAIN_MS = 1_000

/**
 * The same wait when the prompt threw instead of answering. It is short because there is nothing to
 * wait for: daemon raises TURN_ERROR *instead of* a turn outcome, so no turn/end is coming and the
 * long wait would only be five seconds of silence before the same exit code.
 */
const ERROR_DRAIN_MS = 50

type Outcome = { reason: TurnEndReason; lastSeq: number; credits?: unknown }

/** The session a run resumes, `--resume <id>` or `agnes resume <id>`. Opening a session and refusing what a
 * resume cannot take both read it here, so the two cannot disagree. */
export function resumedSessionId(p: ParsedArgs): string | undefined {
  return p.resume ?? (p.command === 'resume' ? p.positional[0] : undefined)
}

/**
 * The session a run opens instead of a new one: the one `resumedSessionId` names, or for `--continue`
 * the most recently active session in `cwd`. daemon filters the listing to that workspace exactly and
 * orders it by recent activity; an archived session is one the user put away, so it is skipped the way
 * the Web sidebar skips it.
 */
export async function sessionToOpen(booted: Booted, p: ParsedArgs, cwd: string): Promise<string | undefined> {
  const named = resumedSessionId(p)
  if (named !== undefined || !p.continue) return named
  const page = await booted.client.session.list({ q: { cwd }, limit: 50 })
  const latest = page.items.find((item) => item.archived !== true)
  if (!latest) throw new CommandError(`--continue found no session in ${cwd}; run without it to start one`)
  return latest.sessionId
}

/**
 * Every flag this build cannot carry out, refused by the name the user typed and by what is missing.
 * They are named here rather than left to fail somewhere downstream because each of them fails in a
 * way nobody could act on: `--park` and `--preset --resume` used to surface as host's
 * `E_DEP_MISSING: resolveProfile cannot apply the flags layer yet` -- one string for two different
 * flags, naming an internal layer rather than either of them.
 *
 * `--model` and `--continue` used to be refused here too: `sdk`'s `Session.setModel` did not exist,
 * and neither did a session listing to continue from. Both do now: `--model` is applied in
 * `openSession` (see the call to `session.setModel(p.model)` below), `--continue` in `sessionToOpen`.
 *
 * `--preset` on its own is not here: it travels on session/new, where daemon checks it against
 * presets.allowed. It is only a resume that cannot take it, because session/load has no preset.
 */
export function refuseWhatCannotBeHonoured(p: ParsedArgs): void {
  if (p.park)
    throw new UsageError(
      '--park needs the profile flags layer, which this build does not have: run without it, or set limits."approval.park" to 1 in the profile',
    )
  if (p.preset !== undefined && (p.continue || resumedSessionId(p) !== undefined))
    throw new UsageError('--preset cannot be applied to a resumed session: session/load takes no preset')
}

async function openSession(booted: Booted, p: ParsedArgs, cwd: string): Promise<Session> {
  // `session/load` rather than attach: a session this daemon has not opened yet is not in its
  // registry, and attach requires one. Load opens it from the ledger and replays it, which is what
  // makes `agnes --resume <id> -p` pick up a session the previous process left behind.
  //
  // The working directory goes with it. A load also opens a session nobody has seen before, and
  // there the cwd becomes that session's own -- sdk's default empty string put every relative path
  // a tool was handed outside the workspace root, which only a resumed run against a real model
  // showed, because a unit test on either side agreed with itself.
  const resume = await sessionToOpen(booted, p, cwd)
  if (resume !== undefined) return booted.client.session.load(resume, { cwd })
  await booted.client.workspace.add(cwd)
  return booted.client.session.new({ cwd, ...(p.preset ? { preset: p.preset } : {}) })
}

/** Resolves to true if `p` settled within `ms`, false if the deadline came first. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms)
    p.then(
      () => {
        clearTimeout(t)
        resolve(true)
      },
      () => {
        clearTimeout(t)
        resolve(true)
      },
    )
  })
}

// A turn that ended in `error` comes back as a thrown JSON-RPC error carrying the reason in its
// data, not as a resolved result: daemon raises TURN_ERROR rather than answering with a stop reason
// ACP has no member for. Read here so `error` reaches the exit-code table like every other reason
// instead of escaping as an unhandled stack.
function reasonFromThrow(e: unknown): TurnEndReason | null {
  const data = (e as { data?: { turnEnd?: { reason?: unknown } } } | null)?.data
  const reason = data?.turnEnd?.reason
  return typeof reason === 'string' ? (reason as TurnEndReason) : null
}

// `error{code,message}` as the turn/end row (or daemon's TURN_ERROR data) carries it. The message is
// already redacted upstream; this only keeps it to one printable line.
function errorCause(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null | undefined
  return [e?.code, e?.message]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .replace(/\p{Cc}+/gu, ' ')
    .slice(0, 200)
}

/**
 * `-p`: one prompt, one answer, one exit code.
 *
 * The order below is the whole of it and none of it is interchangeable. The session is attached
 * *before* the prompt is sent, because `events()` attaches lazily and a cursorless attach that lands
 * after the prompt subscribes from wherever the session has already got to -- every row in between
 * is gone, and a run missing its own turn/end waits forever for one. The collector is started before
 * the prompt for the same reason one rung down: the listener is registered synchronously when the
 * `for await` begins, so starting it afterwards has the same hole inside this process.
 */
export async function runPrint(booted: Booted, p: ParsedArgs, io: PrintIO): Promise<number> {
  refuseWhatCannotBeHonoured(p)

  const blocks = await readPromptInput({
    positional: (p.command === 'resume' ? p.positional.slice(1) : p.positional).join(' '),
    stdin: io.stdin,
    stdinIsTTY: io.stdin.isTTY === true,
  })
  // The ladder can only cancel a turn that exists. A signal that lands before the prompt is sent --
  // while stdin is still being read, or while the session opens -- is honoured by never sending it.
  const signalledBeforePrompt = (): number | undefined => {
    const signal = io.signal?.()
    if (!signal) return undefined
    if (p.mode !== 'json')
      io.stderr.write(`agnes: ${signal}; prompt not sent (exit ${SIGNAL_EXIT_CODES[signal]})\n`)
    return SIGNAL_EXIT_CODES[signal]
  }
  const early = signalledBeforePrompt()
  if (early !== undefined) return early

  // Heterogeneous by design: a row this client dropped arrives as `kind: 'invalid-event'` from sdk
  // itself, a daemon notice arrives with the daemon's own kind. Discriminating on `kind` is the only
  // way to tell them apart, and the first of them is exactly the explanation for an answer that
  // never printed -- so it goes to stderr whether or not anyone is watching a terminal.
  const offNotice = booted.client.on('notice', (payload) => {
    const kind = (payload as { kind?: unknown } | null)?.kind
    io.stderr.write(`agnes: notice ${typeof kind === 'string' ? kind : 'unknown'}\n`)
  })

  try {
    const session = await openSession(booted, p, io.cwd)
    // Before attach/prompt, not after: setModel takes effect for the next request onward, so it has
    // to land before the one prompt this invocation is about to send, not race it.
    if (p.model) await session.setModel(p.model)
    io.registerCancel?.(() => session.cancel())
    await session.attach({ filter: { acpUpdates: false } })
    // Everything at or below this is history: a fresh session has its session/start row, and a
    // resumed one replays its whole transcript through the same attach. Without the watermark the
    // collector would stop on a turn/end from a turn that ended yesterday.
    const startSeq = session.lastServerSeq
    // runPrint does not await again before session.prompt: a signal from here on goes to the cancel
    // registered above rather than to this check.
    const opening = signalledBeforePrompt()
    if (opening !== undefined) return opening

    // toolUseId -> name (from tool/call), and effectId -> toolUseId (from effect/intent, only
    // when it names a tool effect) -- effect/settled carries duration but only effectId, so this
    // is the join that gets a name and a duration onto the same printed line.
    const toolNames = new Map<string, string>()
    const toolEffects = new Map<string, string>()
    const events: EventEnvelope[] = []
    const collector = (async () => {
      for await (const e of session.events()) {
        if (e.seq <= startSeq) continue
        events.push(e)
        if (p.mode !== 'json') {
          if (e.type === 'tool/call') {
            const call = e.data as ToolCall
            toolNames.set(call.toolUseId, call.name)
            io.stderr.write(`- tool ${call.name}\n`)
          } else if (e.type === 'effect/intent') {
            const intent = e.data as EffectIntent
            if (intent.kind === 'tool' && intent.tool) toolEffects.set(intent.effectId, intent.tool.toolUseId)
          } else if (e.type === 'effect/settled') {
            const settled = e.data as EffectSettled
            const toolUseId = toolEffects.get(settled.effectId)
            const name = toolUseId !== undefined ? toolNames.get(toolUseId) : undefined
            if (name !== undefined) {
              const duration = settled.durationMs !== undefined ? ` · ${settled.durationMs}ms` : ''
              io.stderr.write(`- tool ${name} · ${settled.outcome}${duration}\n`)
            }
          }
        }
        if (e.type === 'turn/end') break
      }
    })()

    let outcome: Outcome
    let threw = false
    let thrownError: unknown
    try {
      const r = await session.prompt(blocks)
      outcome = { reason: r.reason, lastSeq: r.lastSeq, ...(r.credits ? { credits: r.credits } : {}) }
    } catch (e) {
      const reason = reasonFromThrow(e)
      if (!reason) throw e
      threw = true
      thrownError = (e as { data?: { error?: unknown } }).data?.error
      outcome = { reason, lastSeq: session.lastSeq }
    }
    const drained = await settleWithin(collector, threw ? ERROR_DRAIN_MS : DRAIN_MS)
    if (!drained && !threw)
      io.stderr.write(
        `agnes: no turn/end row arrived within ${DRAIN_MS} ms; the reason below is the one the reply carried\n`,
      )

    // The ledger row wins over what the response implied. sdk derives the reason from the terminal
    // notification if it has already arrived and otherwise falls back to the ACP stop reason, which
    // is coarser: end_turn reads as `completed` for a turn that actually parked, was blocked, or ran
    // out of budget. Whether the notification beat the reply is a property of the transport, so the
    // exit code is taken from the row itself once the drain above has waited for it.
    const ended = events.find((e) => e.type === 'turn/end')
    const rowReason = (ended?.data as { reason?: unknown } | null)?.reason
    const reason = typeof rowReason === 'string' ? (rowReason as TurnEndReason) : outcome.reason
    // Same reading for the position: sdk reports the session's own `seq`, which is behind whenever
    // the row had not landed by the time the reply did.
    const lastSeq = ended ? Math.max(ended.seq, outcome.lastSeq) : outcome.lastSeq
    // A signal decides the code, whatever the turn reported. Not only when the turn came back
    // `aborted`: a cancel is a request, so the turn can finish first and report `completed`, and a
    // caller that sent SIGTERM being told 0 is the one answer that hides what happened. The ladder
    // leaves with this same number by its own route, so the two cannot disagree -- which they did
    // while `aborted` was pinned to 130 and a SIGTERM raced it.
    const signal = io.signal?.()
    const exitCode = signal ? SIGNAL_EXIT_CODES[signal] : exitCodeForReason(reason)
    const ticket = reason === 'parked' ? findParkedTicket(events) : undefined
    const text = lastAssistantText(events)
    if (p.mode === 'json') {
      // I1 writes the result line and nothing else; the per-event JSONL stream is Task 9.
      io.stdout.write(
        cliResultLine({
          sessionId: session.id,
          reason,
          exitCode,
          lastSeq,
          ...(outcome.credits ? { credits: outcome.credits } : {}),
          ...(ticket ? { ticket } : {}),
          text,
        }),
      )
    } else if (reason === 'parked') {
      io.stdout.write(`parked ticket=${ticket ?? '?'} session=${session.id}\n`)
    } else if (text) {
      io.stdout.write(`${text}\n`)
    }
    // The reason word on every non-zero exit, in text mode as well as json. `blocked` and `budget`
    // share exit 4 by design and want opposite remediations -- raise the budget and retry, or never
    // retry at all -- so a wrapper reading the integer alone either retries forever or gives up on a
    // turn that would have succeeded. The word is what tells them apart. An `error` turn also names
    // its cause: without it the caller cannot tell a bad key from an unknown model from an outage.
    if (exitCode !== 0 && p.mode !== 'json') {
      const cause = errorCause((ended?.data as { error?: unknown } | null)?.error ?? thrownError)
      io.stderr.write(
        `agnes: ${signal ? `${signal}; ` : ''}turn ended: ${reason} (exit ${exitCode})${cause ? `: ${cause}` : ''}\n`,
      )
    }
    return exitCode
  } finally {
    offNotice()
  }
}

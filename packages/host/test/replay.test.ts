import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProvider, type WireEvent } from '@agnes/ai'
import { FakeAdapter, fakeModel, ScriptedProvider, stampFor } from '@agnes/ai/testkit'
import { presets as basePresets, seams as baseSeams } from '@agnes/base'
import { operations as codeOperations, presets as codePresets, PRESET_NAMES } from '@agnes/code'
import type { Operation, Verdict } from '@agnes/core'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlatform } from '../src/adapters/platform.js'
import type { ProviderBuildOptions } from '../src/assemble/provider.js'
import type { ResolvedProfile } from '../src/profile/types.js'
import {
  createTestHost,
  type RunOnceResult,
  reopenSession,
  resumeTurn,
  runOnce,
  startTurn,
  type TestHostOptions,
} from '../testkit/index.js'

/**
 * The replay corpus, run against a host that is really assembled. Every delivered capability is on
 * at once and only the model is replaced, because the model is the only nondeterministic part.
 *
 * That is the whole point. Two features can each pass their own demo and still be broken together -
 * which is what happened: one runner handed the host an empty operations table, so the tools arrived
 * and the prompt did not, and neither feature's own check could see it. A fixture here fails when
 * any one of the four capabilities it names is off.
 *
 * The corpus lives under @agnes/base because it is base's fixture set and base's future count gate
 * reads it; the runner lives here because host is the only package that already dev-depends on both
 * @agnes/base and @agnes/code, and a runner in base would make the lower package depend on a higher
 * one.
 */
const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
/**
 * Two directories, read as one corpus. base's cases are base's - what its tools and seams do. The
 * recovery cases are the kernel's: they need a runner that kills the host between two model calls
 * and brings a second one up on the same ledger, which is the runner's business rather than any one
 * package's fixtures.
 */
const fixtureDirs = [
  join(baseDir, 'fixtures', 'replay'),
  fileURLToPath(new URL('./fixtures/replay', import.meta.url)),
]

/**
 * The capabilities a case may claim to exercise. A fixture names its own, so a reader can tell from
 * the file alone what a case is for, and an unknown name is refused rather than silently ignored -
 * a tag nobody checks is a label, not a claim.
 */
const CAPABILITIES = [
  // The extension host reading @agnes/base's manifest off disk and calling its entry, which is the
  // only way read and shell reach the kernel registry.
  'extension-host/tools-core',
  // @agnes/code's operations table contributing prompt sections to the request.
  'prompt/code-operations',
  // core's tools phase dispatching a call and feeding the result back as a message.
  'scheduler/tool-calls',
  // The approval seam deciding a destructive call before it runs.
  'seam/approval',
  // The sandbox seam actually running a command line.
  'seam/sandbox-exec',
  // The sandbox seam's workspace fence, which every tool path is resolved against.
  'seam/fs-policy',
  // The delivered file system refusing a path the deny list names. It is the only place that
  // comparison is made - the kernel used to make it too, on the raw string, and let three spellings
  // of the same path through - so a case here reads a denied file the way a model would spell it.
  'fs/deny-paths',
  // A second process picking up a turn the first one died inside. Everything above has to survive
  // that: the prompt is contributed again, the tools are offered again, and the request the resumed
  // turn sends has to be one the model can answer - which is what the `needs` of the step after the
  // kill hold it to. Nothing in the driver asks for the recovery: the second process opens the
  // session and that is all, so this case also holds the wiring that makes opening one recover it.
  'recovery/resume-after-kill',
  // The other half of that wiring. Opening a session now runs the recovery path on every ledger,
  // including the overwhelming majority that ended cleanly, and this is the case that holds an
  // ordinary open to appending nothing and reporting nothing.
  'recovery/clean-open-writes-nothing',
  // @agnes/base's own approval seam, deciding a command line against the preset's policy table
  // instead of a fake that answers the same way whatever it is asked.
  'seam/approval-policy',
  // The model layer's decode chain recovering a call the model wrote into its prose instead of into
  // the protocol's tool-call field. Only a wire-level case can exercise it: a fixture scripted at
  // the Provider boundary hands the kernel a finished call and the chain never runs.
  'decode/tool-call-in-text',
  // A usage event turning into a cost row with a credit figure on it. The estimate is made in the
  // model layer, from the catalogue price and the deployment's credit rate, and the kernel writes
  // what it is given - so a case here holds both halves at once.
  'usage/cost-row',
  // A deny entry the sandbox seam declared - not one the adapter hard-codes - refused by the file
  // system the assembly handed the kernel. It is the half of the path check a deployment configures,
  // and until the two lists were joined the seam's entries reached nothing.
  'seam/fs-deny-paths',
  // The recipes @agnes/code and @agnes/base actually ship, read off disk and resolved by the real
  // resolver, rather than a preset object written by hand for the case at hand. It is the one
  // document a real installation loads and was the only one nothing ran: two defects lived in it at
  // once, and both of them stopped a session opening at all.
  'preset/shipped-recipe',
  // The credit rate the deployment declared, read off the profile by host and handed to the model
  // layer, ending as the credits on a cost row. Every other case runs on the corpus's standing rate;
  // a case here states a different one and holds the ledger to it, which is the only way the number
  // is shown to be a function of the profile rather than of a constant in this file.
  'deployment/credit-rate',
  // A session's model switched mid-turn (core's real setModel, Task 32a) and the very next
  // inference request actually went to the new route/model - not the one the preset started on.
  // Exercised through the before-inference Operation slot, not a special driver path: the switch
  // is indistinguishable, from the step machine's point of view, from a daemon-driven one.
  'model/mid-turn-switch',
  // `walk()`'s (tools-search/src/tools/walk.ts) `DEFAULT_SKIP` set actually keeping `find`/`grep`
  // from descending into `node_modules`/`.git`/`dist`/`.agnes-tmp`, and the skip note it leaves on
  // the result (`walkNotes()`) reaching the model rather than the directory silently reading as
  // empty. `ls` does not go through `walk()` at all, so this is exercised through `find`/`grep`.
  // The truncation half of `walkNotes()` is not exercised here: `find`'s and `grep`'s `maxEntries`
  // (100_000 and 50_000) are too large to hit with a fixture-sized workspace.
  'tool/walk-skip-and-truncate',
] as const

/**
 * What the scripted model insists on finding in the request before it behaves as scripted. This is
 * how a capability becomes load-bearing instead of merely present: a model that was not told its
 * situation, or was not offered the tool, answers differently - exactly the failure this corpus
 * exists to catch, rather than a separate assertion bolted on beside it.
 */
type Needs = {
  /** Substrings the assembled system prompt must contain. */
  systemIncludes?: string[]
  /** Substrings anywhere in the conversation so far, which is where tool results appear. */
  messagesInclude?: string[]
  /** Tool names the request must offer. */
  toolsOffered?: string[]
}
type Step = {
  needs?: Needs
  toolCall?: { name: string; args: unknown }
  text?: string
  /**
   * Raw model output, for a `wire` case: it goes out as a text delta and whatever the decode chain
   * makes of it is what the kernel sees. This is how a call written in a model's own prose syntax
   * gets into the corpus.
   */
  wireText?: string
}
/**
 * A case carrying `policy` runs against @agnes/base's real approval seam, with these rules in the
 * preset it resolves. Without it the assembly keeps the faked approval that allows everything, which
 * is what every other case wants: a policy table is not what they are about.
 */
type PolicyRule = { tool: string; argv: string; action: 'allow' | 'ask' | 'require_approval' | 'deny' }
type Fixture = {
  id: string
  exercises: string[]
  /** Select the actual builtin profile template. */
  template?: string
  lock?: TestHostOptions['lock']
  profileInputs?: TestHostOptions['profileInputs']
  /** Artifact directory is resolved relative to the JSONL file containing this fixture. */
  contract?: TestHostOptions['contract']
  /**
   * Run against the recipes that ship, loaded from disk: @agnes/base's `base` and every recipe
   * @agnes/code registers, with base's real approval seam behind them. A case saying this asserts
   * what a deployment gets, so it states no policy table of its own - the shipped one is the thing
   * under test.
   */
  shipped?: true
  /**
   * What this case's deployment declares as `limits['cost.credits_per_usd']`. Omitted, the case runs
   * on the corpus's standing rate; stated, host resolves it and the ledger has to show it.
   */
  creditsPerUsd?: number
  workspace?: Record<string, string>
  /**
   * What this case's sandbox seam declares, workspace-relative. It is the deployment's half of the
   * deny list; the adapter's own pair is a floor underneath it and is not restated here.
   */
  denyPaths?: string[]
  policy?: PolicyRule[]
  /**
   * What the connected operator answers, for a case that reaches one. It is what makes a policy
   * verdict distinguishable from a refusal by default: with nobody connected, an unmatched call and
   * a denied one both come back refused, so a case asserting a deny would stay green with its own
   * rule deleted.
   */
  prompterSays?: 'allowed-once' | 'allowed-session' | 'rejected'
  prompt: string
  /**
   * Script the model one layer lower, at the wire, so the whole model layer runs: the decode chain,
   * the sequence guard and the credit estimate. Without it the fixture is scripted at the Provider
   * boundary, which is everything above the model layer and nothing inside it.
   */
  wire?: boolean
  script: Step[]
  /**
   * Kill the process while the model call for `script[atStep]` is outstanding. The first host serves
   * every step before it and then never answers; a second host is assembled on the same data
   * directory and has to finish the turn, starting from that same step - because a resumed request
   * is re-sent, not resumed mid-stream.
   */
  kill?: { atStep: number }
  /**
   * Run the turn to its end, close the host, and open a second one on the same ledger. Nothing asks
   * that second process to recover anything and there is nothing to recover: the case is about what
   * opening a sound session costs, now that opening one is what triggers recovery.
   */
  reopen?: true
  /**
   * Switches the session's model right before the Nth inference request is minted (1-indexed —
   * the first request a session ever sends is request 1, matching how `script[0]` is "what the
   * first request gets back", not how many requests preceded it). Exercises R1's real setModel
   * mechanism through the full assembly: the switch must survive into the very next request's
   * route/model and show up correctly on that request's cost/ledger row.
   */
  setModelAt?: { atRequest: number; slot: string; route: string; model: string }
  expect: {
    toolCalls: string[]
    finalTextIncludes?: string
    /**
     * What the second process reported doing to the ledger the first one left open, read from the
     * report `createSession` handed back rather than from a call anything made to `resume()`. The
     * empty string is a real expectation and the one a `reopen` case states: it says the open
     * recovered nothing.
     */
    resumed?: string
    /** Rows opening that second session added to a ledger that needed none. */
    appendedOnOpen?: number
    /** Ledger event types the turn must have written. */
    eventTypes?: string[]
    /** The credits on the turn's cost rows must add up to more than this. */
    creditsAbove?: number
    /**
     * And to less than this. A lower bound alone is satisfied by any rate at or above the one the
     * case declared, so on its own it cannot tell "the declared rate arrived" from "some larger
     * number did"; the band can.
     */
    creditsBelow?: number
  }
}

/** Keep fixture profile selection identical across normal, recovery and rejection cases. */
function profileOptions(
  f: Pick<Fixture, 'template' | 'lock' | 'profileInputs' | 'contract'>,
): Pick<TestHostOptions, 'template' | 'lock' | 'profileInputs' | 'contract'> {
  return {
    ...(f.template !== undefined ? { template: f.template } : {}),
    ...(f.lock !== undefined ? { lock: f.lock } : {}),
    ...(f.profileInputs !== undefined ? { profileInputs: f.profileInputs } : {}),
    ...(f.contract !== undefined ? { contract: f.contract } : {}),
  }
}

/**
 * Switches the session's model via core's real `setModel`, so that the `cfg.atRequest`-th inference
 * request is the first one minted on the new route. `before-inference` runs once per request, but
 * `runInference` (inference.ts) resolves that request's own route/model and freezes it into `ctx`
 * *before* running the slot - "an Operation here sees exactly what is about to go out" is about the
 * prompt and tool list, not the routing, which is why calling `setModel` during request N's own
 * before-inference phase is one request too late: the call only lands in time for request N+1.
 * Firing on `cfg.atRequest - 1` is what makes `cfg.atRequest` itself the first request to see it -
 * note this is a property of `before-inference`'s place in that ordering, not something a fixture
 * author needs to account for; `atRequest` in the fixture still names the request that carries the
 * switch.
 *
 * Bypasses host's `validatePresetSwitch`/`validateModelSwitch` on purpose: this knob exercises
 * core's mechanism in a real assembly, not host's policy gate above it - that gate is host27a's own
 * test range already, and a daemon is expected to go through it before ever calling this.
 */
function setModelAtOperation(cfg: {
  atRequest: number
  slot: string
  route: string
  model: string
}): Operation {
  let seen = 0
  return {
    name: 'test-set-model-at',
    slot: 'before-inference',
    replay: 'safe',
    applicable: async () => (++seen === cfg.atRequest - 1 ? 'applied' : 'not-applicable'),
    run: async (ctx) => {
      await ctx.session.setModel({ slot: cfg.slot, route: cfg.route, model: cfg.model })
      return {}
    },
  }
}

/** The first requirement this request does not meet, named the way it is written in the fixture. */
function unmet(needs: Needs | undefined, req: RequestBody): string | null {
  for (const s of needs?.systemIncludes ?? []) if (!req.system.includes(s)) return `systemIncludes ${s}`
  const conversation = JSON.stringify(req.messages)
  for (const s of needs?.messagesInclude ?? []) if (!conversation.includes(s)) return `messagesInclude ${s}`
  const offered = new Set(req.tools.map((t) => t.name))
  for (const n of needs?.toolsOffered ?? []) if (!offered.has(n)) return `toolsOffered ${n}`
  return null
}

/**
 * What an unmet step says instead of what it was scripted to say. It carries none of the fixture's
 * own words: an answer that quoted the missing requirement back would satisfy a finalTextIncludes
 * looking for that same string, and the fixture would stay green with the capability switched off.
 * The readable reason goes to the runner out of band, for the failure message.
 */
const UNMET_REPLY = 'the-scripted-model-found-its-request-incomplete'

/**
 * One scripted step as a function of the request, so the unmet check runs against what was really
 * sent. A step whose needs are not met refuses to play its part and stops, which turns a missing
 * capability into a failing expectation, and `reasons` says which one.
 */
function stepScript(step: Step, reasons: string[]): (req: RequestBody) => InferenceEvent[] {
  return (req) => {
    const missing = unmet(step.needs, req)
    if (missing) {
      reasons.push(missing)
      return [
        { type: 'text_delta', delta: UNMET_REPLY },
        { type: 'done', reason: 'stop' },
      ]
    }
    if (step.toolCall)
      return [
        {
          type: 'toolcall_end',
          call: { toolUseId: '', name: step.toolCall.name, args: step.toolCall.args as never, ordinal: 0 },
          via: 'native',
        },
        { type: 'done', reason: 'toolUse' },
      ]
    return [
      { type: 'text_delta', delta: step.text ?? '' },
      { type: 'done', reason: 'stop' },
    ]
  }
}

/**
 * The rate the corpus's own deployment declares, unless a case states its own. It is stated rather
 * than defaulted, because a fallback nobody chose denominates the ledger in dollars - and it now
 * reaches the model layer the way a delivery's does, through the profile and host, rather than being
 * written into the provider this file builds.
 */
const CORPUS_CREDITS_PER_USD = 100

/**
 * The catalogue a wire-level case runs against. It is priced, because a cost row with no credits on
 * it would satisfy a fixture asking only that the row exists.
 */
const WIRE_ROUTE = { route: 'gw', api: 'openai', baseUrl: 'https://gw.example/v1' }
const WIRE_MODEL = fakeModel({
  id: 'm1',
  route: 'gw',
  api: 'openai',
  baseUrl: 'https://gw.example/v1',
  cost: { input: 3000, output: 15000, cacheRead: 0, cacheWrite: 0 },
})
const WIRE_USAGE: WireEvent = {
  type: 'usage',
  tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
  creditSource: 'estimated',
}

/** One scripted turn as the wire would have carried it. */
function wireStep(step: Step, req: RequestBody, reasons: string[]): WireEvent[] {
  const missing = unmet(step.needs, req)
  if (missing) {
    reasons.push(missing)
    return [{ type: 'text_delta', delta: UNMET_REPLY }, WIRE_USAGE, { type: 'done', reason: 'stop' }]
  }
  if (step.wireText !== undefined)
    return [{ type: 'text_delta', delta: step.wireText }, WIRE_USAGE, { type: 'done', reason: 'stop' }]
  if (step.toolCall)
    return [
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: step.toolCall.name, args: step.toolCall.args as never, ordinal: 0 },
      },
      WIRE_USAGE,
      { type: 'done', reason: 'toolUse' },
    ]
  return [{ type: 'text_delta', delta: step.text ?? '' }, WIRE_USAGE, { type: 'done', reason: 'stop' }]
}

/**
 * The real model layer over a scripted wire: same assembly, one layer further down. `built` is what
 * host resolved for the model layer from the profile - its logger and the deployment's credit rate -
 * so a wire case prices at the rate the deployment declared rather than at one this file chose.
 */
function wireProvider(
  f: Fixture,
  reasons: string[],
  built: ProviderBuildOptions,
  profile: ResolvedProfile,
): Provider {
  if (f.setModelAt) return midTurnSwitchProvider(f.setModelAt, f.script, reasons, built)
  let turn = 0
  const declared = f.contract ? (profile.provider.routes ?? []) : [{ ...WIRE_ROUTE, models: [WIRE_MODEL] }]
  const primary = declared[0]?.models?.[0]
  if (!primary) throw new Error('wire fixture requires a declared primary model')
  const adapter = new FakeAdapter({
    id: 'wire',
    routes: declared,
    models: Object.fromEntries(declared.map((r) => [r.route, r.models ?? []])),
    script: (req) => wireStep(f.script[Math.min(turn++, f.script.length - 1)] ?? {}, req, reasons),
  })
  return createProvider({
    adapters: [adapter],
    routes: { primary: { route: primary.route, model: primary.id } },
    contract: built.contractStore,
    secrets: () => 'unused: this route declares no credentialRef',
    clock: () => Date.now(),
    ...built,
  })
}

/**
 * What the pre-switch adapter says if it is asked a request it was not scripted to answer. Only
 * `setModelAt`'s own malfunction can cause that - a request that should have moved to the new route
 * stayed on the old one instead - so this is the fixture's actual failure signal, not a repeat of
 * the adapter's last real line. Repeating the last line would either pass by accident (if that line
 * happens to contain what `expect` looks for) or send the step machine an unplanned extra tool call
 * that loops rather than fails cleanly; a fixed, unmistakable sentinel does neither.
 */
const WRONG_ROUTE_REPLY = 'answered-by-the-route-that-was-active-before-the-switch'

/**
 * Two independently-scripted adapters, one per route - `session-switch.test.ts`'s
 * `twoIndependentWireAdapters` technique, reused here because it is exactly what makes a mid-turn
 * `setModel` observable: one adapter answering for both routes could not tell "the switch moved the
 * request" from "it didn't, and nobody can tell the difference." The pre-switch route serves every
 * request up to `cfg.atRequest - 1`; the post-switch route serves the rest. Which one a given
 * request actually reaches is decided by `createProvider`'s own route dispatch, not by anything
 * here - so the fixture is exercising `session.setModel`'s effect on that dispatch, and nothing else.
 */
function midTurnSwitchProvider(
  cfg: { atRequest: number; slot: string; route: string; model: string },
  script: Step[],
  reasons: string[],
  built: ProviderBuildOptions,
): Provider {
  const before = script.slice(0, cfg.atRequest - 1)
  const after = script.slice(cfg.atRequest - 1)
  let beforeTurn = 0
  let afterTurn = 0
  const beforeAdapter = new FakeAdapter({
    id: 'wire-before-switch',
    routes: [{ ...WIRE_ROUTE, models: [WIRE_MODEL] }],
    models: { [WIRE_ROUTE.route]: [WIRE_MODEL] },
    script: (req) => {
      if (beforeTurn < before.length) return wireStep(before[beforeTurn++] ?? {}, req, reasons)
      beforeTurn++
      return [{ type: 'text_delta', delta: WRONG_ROUTE_REPLY }, WIRE_USAGE, { type: 'done', reason: 'stop' }]
    },
  })
  const afterModel = fakeModel({
    id: cfg.model,
    route: cfg.route,
    api: WIRE_ROUTE.api,
    baseUrl: WIRE_ROUTE.baseUrl,
  })
  const afterAdapter = new FakeAdapter({
    id: 'wire-after-switch',
    routes: [{ route: cfg.route, api: WIRE_ROUTE.api, baseUrl: WIRE_ROUTE.baseUrl, models: [afterModel] }],
    models: { [cfg.route]: [afterModel] },
    script: (req) => wireStep(after[Math.min(afterTurn++, after.length - 1)] ?? {}, req, reasons),
  })
  return createProvider({
    adapters: [beforeAdapter, afterAdapter],
    routes: { primary: { route: WIRE_ROUTE.route, model: WIRE_MODEL.id } },
    contract: built.contractStore,
    secrets: () => 'unused: neither route declares a credentialRef',
    clock: () => Date.now(),
    ...built,
  })
}

/**
 * Placeholders a case may use for facts that belong to the machine rather than to the case: the
 * shell dialect the prompt names is the platform's own, so a case asserts it without restating it.
 */
const MACHINE_FACTS: Readonly<Record<string, string>> = { '{{shell}}': createPlatform().shell() }
const withMachineFacts = (line: string): string =>
  Object.entries(MACHINE_FACTS).reduce((text, [token, value]) => text.replaceAll(token, value), line)

const fixtures: Fixture[] = fixtureDirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => {
          const f = JSON.parse(withMachineFacts(l)) as Fixture
          return f.contract ? { ...f, contract: { ...f.contract, dir: resolve(dir, f.contract.dir) } } : f
        }),
    ),
)

/**
 * A model that plays the given scripts and then stops answering for good. It is how the kill is
 * staged: the request is announced - the ledger gets its `step/start`, its `effect/intent` and its
 * header - and no answer ever arrives, which is exactly what the tail of a SIGKILLed session holds.
 */
type KillableProvider = Provider & { kill: () => void }

function killedAfter(scripts: ReturnType<typeof stepScript>[]): KillableProvider {
  const inner = new ScriptedProvider({ scripts })
  let calls = 0
  let release!: () => void
  const killed = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    models: () => inner.models(),
    async *infer(req, opts): AsyncIterable<InferenceEvent> {
      if (calls++ < scripts.length) {
        yield* inner.infer(req, opts)
        return
      }
      yield { type: 'sent', stamp: stampFor(req) }
      await killed
    },
    kill: () => release(),
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (files: Record<string, string> | undefined): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-replay-'))
  dirs.push(d)
  // A workspace key may name a nested path (e.g. `node_modules/pkg/README.md`) to stage a
  // subdirectory a fixture wants to exist; writeFileSync does not create the parents on its own.
  for (const [name, text] of Object.entries(files ?? {})) {
    const full = join(d, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text, 'utf8')
  }
  return d
}

/**
 * The floor the corpus must clear, which rises as the corpus grows. Read strictly: `Number('')` is
 * 0, which turns the gate off, and `Number('abc')` is NaN, which fails every comparison. A gate that
 * an empty environment variable silently disables is worse than no gate, so anything that is not a
 * positive integer is the default rather than the value.
 */
function replayMin(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : fallback
}

// Raised from 2 to 8 as the eight core tools landed, one fixture each, then to 10 for the two
// approval-policy cases, to 13 with the two wire-level cases and the three-line qwen file, to 15
// with the resume case, to 17 with the two shipped-recipe cases, to 18 with the seam-declared deny
// path, to 19 with the declared credit rate, to 20 with the clean reopen and to 21 with the
// mid-turn model switch, then to 31 (I3's D02 gap-fill) with: a same-turn write-then-edit, `find`
// skipping `node_modules` under `walk()`'s `DEFAULT_SKIP`, a `shell` deny rule matching past its own
// trailing content, a deny rule beating an allow rule for the same command regardless of table
// order, `grep` with context lines, `grep` with `literal: true` over a pattern that is not valid
// regex, a `todo` status transition across two calls, `write`'s truncation guard refusing an
// unbalanced-delimiter rewrite that is not a size shrink, two `edit` calls landing on the same file
// across two turns, and `read`'s offset/limit paging past the end of the file; then to 36 for
// ambiguous edit refusal, invalid-regex reporting, explicit grep/find result limits, and a missing
// read. The floor is what
// stops a case being deleted rather than fixed, so it is worth nothing if it stays below the corpus
// - and it is the total of every lane's cases, never one lane's count, which is how a merge that
// dropped half the corpus would still have passed it.
const REPLAY_FLOOR = 36

/**
 * What the test host's own `standard` recipe says, restated here because a case that overrides the
 * recipe replaces it whole. Dropping `disclosure` or the route would change the assembled request
 * for reasons that have nothing to do with the policy table the override is about.
 */
const STANDARD = {
  name: 'standard',
  extends: 'base',
  disclosure: 'standard',
  model: { route: { primary: 'default' } },
}

describe('L1 replay corpus', () => {
  it('threads a verified contract through the fixture driver, real core and scripted wire', async () => {
    const id = 'agnes-model-contract@0'
    const dir = fileURLToPath(new URL('../../ai/fixtures/contract/', import.meta.url))
    const cwd = scratch({ 'note.txt': 'contract-tool-result' })
    const f: Fixture = {
      id: 'contract-entry-check',
      exercises: [],
      prompt: 'read note.txt',
      wire: true,
      contract: { dir, contractIds: [id] },
      profileInputs: {
        user: {
          name: 'contract-wire',
          provider: {
            package: '@agnes/ai',
            routes: [{ ...WIRE_ROUTE, models: [{ ...WIRE_MODEL, contract_id: id }] }],
          },
        },
      },
      script: [
        {
          needs: { systemIncludes: ['You are Agnes.'], toolsOffered: ['read'] },
          toolCall: { name: 'read', args: { path: 'note.txt' } },
        },
        {
          needs: { systemIncludes: ['You are Agnes.'], messagesInclude: ['contract-tool-result'] },
          text: 'contract complete',
        },
      ],
      expect: { toolCalls: ['read'] },
    }
    const reasons: string[] = []
    const t = await createTestHost({
      dataDir: cwd,
      ...profileOptions(f),
      packageDirs: { '@agnes/base': baseDir },
      packages: { '@agnes/code': { operations: codeOperations } },
      provider: (p, built) => wireProvider(f, reasons, built, p),
      disableSessionTitle: true,
    })
    try {
      const result = await runOnce(t.host, { cwd, prompt: f.prompt })
      expect(result.reason).toBe('completed')
      expect(result.toolCalls).toEqual(['read'])
      expect(result.finalText).toBe('contract complete')
      expect(reasons).toEqual([])
      const headers = result.events.filter((e) => e.type === 'request/header')
      expect(headers).toHaveLength(2)
      for (const row of headers) expect(row.data).toMatchObject({ contract_id: id })
      const receipts = result.events.filter((e) => e.type === 'request/sent')
      expect(receipts).toHaveLength(2)
      const manifest = JSON.parse(readFileSync(join(dir, id, 'manifest.json'), 'utf8'))
      for (const row of receipts)
        expect(row.data).toMatchObject({ contract_id: id, prompt_prefix_hash: manifest.sha256.prefix })
    } finally {
      await t.host.close()
    }
    await expect(
      createTestHost({
        dataDir: scratch(undefined),
        ...profileOptions({ contract: { dir: join(cwd, 'missing'), contractIds: [id] } }),
        script: [],
      }),
    ).rejects.toMatchObject({ code: 'E_SEAM_INIT', message: expect.stringContaining('CONTRACT_MISMATCH') })
  })

  it('refuses a profile naming a package with no lock entry, selected through the fixture driver', async () => {
    // enterprise's own packages are all builtin, so the refusal case now needs a package the build
    // does not ship.
    await expect(
      createTestHost({
        dataDir: scratch(undefined),
        ...profileOptions({
          template: 'enterprise',
          profileInputs: { user: { name: 'x', packages: [{ id: '@acme/x', source: 'npm' }] } },
        }),
      }),
    ).rejects.toMatchObject({ code: 'E_DEP_MISSING', detail: { id: '@acme/x' } })
  })

  it('resolves an explicit empty lock to the builtin set through the fixture driver', async () => {
    const { host, profile } = await createTestHost({
      dataDir: scratch(undefined),
      ...profileOptions({ lock: { packages: {} } }),
      script: [],
    })
    try {
      expect(profile.packages.map((p) => [p.id, p.integrity, p.trust])).toEqual([
        ['@agnes/ai', 'builtin:0.1.0', 'builtin'],
        ['@agnes/base', 'builtin:0.1.0', 'builtin'],
        ['@agnes/code', 'builtin:0.1.0', 'builtin'],
      ])
    } finally {
      await host.close()
    }
  })

  it('passes profile layers from fixtures to the real resolver without hiding unsupported layers', async () => {
    await expect(
      createTestHost({
        dataDir: scratch(undefined),
        ...profileOptions({ profileInputs: { managed: { version: 1, policy: {} } } }),
      }),
    ).rejects.toMatchObject({ code: 'E_DEP_MISSING', detail: { layer: 'managed', reason: 'unimplemented' } })
  })

  it('found the corpus and it meets the current floor', () => {
    // Vacuous otherwise: a runner over an empty directory reports every capability working.
    expect(fixtures.length).toBeGreaterThanOrEqual(replayMin(process.env.AGNES_REPLAY_MIN, REPLAY_FLOOR))
    expect(replayMin('', REPLAY_FLOOR)).toBe(REPLAY_FLOOR)
    expect(replayMin('abc', REPLAY_FLOOR)).toBe(REPLAY_FLOOR)
    expect(replayMin('30', REPLAY_FLOOR)).toBe(30)
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length)
  })

  it('every case names the capabilities it exercises, from the known set', () => {
    for (const f of fixtures) {
      expect(f.exercises.length, f.id).toBeGreaterThan(0)
      for (const tag of f.exercises) expect(CAPABILITIES, `${f.id}: ${tag}`).toContain(tag)
    }
  })

  // `kill` stages its two hosts from Provider-level scripts and `wire` replaces the model below
  // that, so one case cannot ask for both today. Refused here rather than resolved silently in the
  // runner, where whichever branch was written first would win and the other option would look
  // honoured while doing nothing.
  it('no case asks for both a kill and a wire-level model', () => {
    expect(fixtures.filter((f) => f.kill && f.wire).map((f) => f.id)).toEqual([])
  })

  // One case cannot be both the ledger a kill left open and the ledger a clean turn sealed, and the
  // two drivers stage different second processes. Refused rather than resolved by whichever branch
  // the runner tests first.
  it('no case asks for both a kill and a reopen', () => {
    expect(fixtures.filter((f) => f.kill && f.reopen).map((f) => f.id)).toEqual([])
  })

  // The same shape of refusal, one field over. A shipped case brings the table that ships; a case
  // that also wrote a `policy` would be asserting against a table nobody delivers, and whichever
  // spread the runner applied last would decide silently which of the two it actually ran.
  it('no shipped case restates a policy table', () => {
    expect(fixtures.filter((f) => f.shipped && f.policy).map((f) => f.id)).toEqual([])
  })

  // Only a wire case reaches the model layer, so only a wire case can show a rate arriving there. A
  // rate on any other case would be resolved by host, passed to a provider that ignores it, and read
  // as honoured.
  it('no case declares a credit rate it cannot exercise', () => {
    expect(fixtures.filter((f) => f.creditsPerUsd !== undefined && !f.wire).map((f) => f.id)).toEqual([])
  })

  // A wire case pins the provider's route table to `primary` alone, and a shipped recipe names five
  // slots. Nothing combines them today and nothing silently would: this is the refusal that says so.
  it('no shipped case asks for a wire-level model', () => {
    expect(fixtures.filter((f) => f.shipped && f.wire).map((f) => f.id)).toEqual([])
  })

  for (const f of fixtures) {
    it(f.id, async () => {
      const cwd = scratch(f.workspace)
      const denyPaths = f.denyPaths
      const reasons: string[] = []
      const scripts = f.script.map((step) => stepScript(step, reasons))
      // A shipped case runs the delivered recipes and a `policy` case an inline table, so one flag
      // decides whether base's real approval seam is fitted at all.
      const realApproval = f.policy || f.shipped
      const setModelAt = f.setModelAt
      // Everything a case gets whichever driver runs it. The model is deliberately not in here:
      // which one a case gets is the one thing the drivers below disagree about, and a `provider`
      // set here would be overridden by the kill path and would silently override the wire path.
      const common: Omit<TestHostOptions, 'script' | 'provider'> = {
        dataDir: cwd,
        ...profileOptions(f),
        // The delivery path, not a shortcut: host reads @agnes/base's own package.json off disk,
        // finds the extension it declares, reads that manifest and calls its entry.
        packageDirs: { '@agnes/base': baseDir },
        // The other half. Without the real table the host contributes no prompt sections and the
        // model is sent a bare request, which is the defect this corpus was written for.
        packages: {
          // `setModelAt`'s Operation rides in on '@agnes/code''s own entry rather than a fourth
          // package id: createTestHost's `modules`/`packageDirs` are built from a hardcoded
          // three-package `ids` list (testkit/index.ts), and its overlay merge refuses an id that
          // list does not already carry - "packages overlay names X, which this test host does not
          // load". Adding a real operation table entry here reaches the same registry a dedicated
          // package would (assemble.ts flattens every loaded package's `operations` into one list;
          // nothing downstream cares which package an Operation's `name` came from).
          '@agnes/code': {
            operations: setModelAt
              ? { ...codeOperations, switch: () => setModelAtOperation(setModelAt) }
              : codeOperations,
          },
          // Merged by seam name, so the other eight stay the faked ones every case runs against.
          ...(realApproval
            ? {
                '@agnes/base': {
                  seams: { approval: baseSeams.approval },
                  ...(f.shipped ? { presets: basePresets } : {}),
                },
              }
            : {}),
        },
        // The rules reach the seam the way a deployment's do: through the resolved preset, not
        // through a constructor argument the delivered assembly has no way to pass.
        ...(f.shipped
          ? {
              profileInputs: {
                ...f.profileInputs,
                user: {
                  name: f.template ?? 'local-dev',
                  ...f.profileInputs?.user,
                  presets: {
                    // Explicit allowed presets suppress the local-dev platform default selection.
                    // guards-allow-platform: exercise the shipped recipe for the actual filesystem.
                    default: process.platform === 'win32' ? 'standard-windows' : 'standard',
                    allowed: [...PRESET_NAMES],
                  },
                },
              },
            }
          : {}),
        ...(f.shipped || f.policy || denyPaths
          ? {
              presets: f.shipped
                ? codePresets
                : {
                    standard: {
                      ...STANDARD,
                      ...(f.policy ? { approval: { command_policy: f.policy } } : {}),
                      ...(denyPaths ? { sandbox: { deny_paths: denyPaths } } : {}),
                    },
                  },
            }
          : {}),
        ...(f.prompterSays ? { prompter: async () => f.prompterSays as Verdict } : {}),
        // A wire case's rate reaches the model layer through the profile, which is the path a
        // deployment's takes. Without it the runner would state the rate itself and no case could
        // tell a rate host read from one this file wrote.
        ...(f.wire ? { limits: { 'cost.credits_per_usd': f.creditsPerUsd ?? CORPUS_CREDITS_PER_USD } } : {}),
      }
      // Named first and on every assertion: when a capability is off, what the model did is the
      // symptom and the unmet requirement is the cause, and only the cause identifies which one.
      const why = (): string => `${f.id}${reasons.length ? ` | unmet: ${reasons.join('; ')}` : ''}`
      /**
       * What the fixture asked for, checked once for both drivers. Written as one function rather
       * than repeated per path because three lanes each added an `expect` option: kept apart, an
       * option would hold only on whichever path its author happened to use, and a case moved to the
       * other driver would quietly stop checking half of what it claims.
       */
      const check = (r: RunOnceResult & { resumed?: string; appendedOnOpen?: number }): void => {
        expect(r.reason, why()).toBe('completed')
        expect(r.toolCalls, why()).toEqual(f.expect.toolCalls)
        if (f.expect.resumed !== undefined) expect(r.resumed, why()).toBe(f.expect.resumed)
        if (f.expect.appendedOnOpen !== undefined)
          expect(r.appendedOnOpen, why()).toBe(f.expect.appendedOnOpen)
        if (f.expect.finalTextIncludes) expect(r.finalText, why()).toContain(f.expect.finalTextIncludes)
        for (const type of f.expect.eventTypes ?? [])
          expect(
            r.events.map((e) => e.type),
            why(),
          ).toContain(type)
        if (f.expect.creditsAbove !== undefined) {
          const credits = r.events
            .filter((e) => e.type === 'cost/ledger')
            .reduce((n, e) => n + ((e.data as { credits?: number } | null)?.credits ?? 0), 0)
          expect(credits, `${why()} | credits`).toBeGreaterThan(f.expect.creditsAbove)
          if (f.expect.creditsBelow !== undefined)
            expect(credits, `${why()} | credits`).toBeLessThan(f.expect.creditsBelow)
        }
      }
      if (f.kill) {
        const at = f.kill.atStep
        const deadProvider = killedAfter(scripts.slice(0, at))
        const dead = await createTestHost({ ...common, provider: deadProvider })
        // Started and abandoned: the host is torn down with the model call still outstanding, so the
        // ledger keeps an announced step nothing ever settled. The test drains its parked provider
        // only after closing this durable snapshot; a real killed process would disappear.
        const staged = await startTurn(dead.host, { prompt: f.prompt, cwd })
        await vi.waitFor(async () => {
          expect(await staged.session.scan({ type: 'request/sent', limit: 1 })).toHaveLength(1)
        })
        const crashPrefix = await staged.session.scan({ toSeq: staged.session.lastSeq })
        expect(crashPrefix.some((event) => event.type === 'effect/intent')).toBe(true)
        expect(crashPrefix.some((event) => event.type === 'turn/end')).toBe(false)
        // A process kill does not run core's graceful session.close(), which now correctly records
        // an aborted inference when its provider can be woken. Detach the in-flight controller for
        // this crash snapshot so close still releases the writer lease and durable adapters without
        // settling the open step that a second process has to recover.
        staged.session.ac = new AbortController()
        await dead.host.close()
        // The test process must drain its parked provider after the durable crash snapshot is closed;
        // this is an in-process simulation of a child that would otherwise have disappeared.
        deadProvider.kill()
        await staged.running
        const t = await createTestHost({ ...common, script: scripts.slice(at) })
        try {
          check(await resumeTurn(t.host, { cwd }))
        } finally {
          await t.host.close()
        }
        return
      }
      if (f.reopen) {
        const first = await createTestHost({ ...common, script: scripts })
        let sealedAt: number
        try {
          const done = runOnce(first.host, { prompt: f.prompt, cwd })
          sealedAt = (await done).events.at(-1)?.seq ?? 0
        } finally {
          await first.host.close()
        }
        // No script: this host is here to open the session, not to answer anything. A model it
        // never calls is the point.
        const t = await createTestHost({ ...common, script: [] })
        try {
          check(await reopenSession(t.host, { cwd, sealedAt }))
        } finally {
          await t.host.close()
        }
        return
      }
      const t = await createTestHost({
        // A wire case replaces the model one layer lower, so the decode chain, the sequence guard
        // and the credit estimate are all in the loop rather than bypassed.
        ...common,
        ...(f.wire ? { provider: (p, built) => wireProvider(f, reasons, built, p) } : { script: scripts }),
      })
      try {
        check(await runOnce(t.host, { prompt: f.prompt, cwd }))
      } finally {
        await t.host.close()
      }
    })
  }
})

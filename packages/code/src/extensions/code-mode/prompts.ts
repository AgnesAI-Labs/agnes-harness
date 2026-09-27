import type { OpContext, Operation, PromptSection } from '@agnes/core'
import { loadPrompt, renderPersona, sectionOrder } from '../../prompts/sections.js'
import {
  type EnvironmentFacts,
  type RuntimeSnapshotFacts,
  renderEnvironment,
  renderTools,
} from './environment.js'
import { createSdkRenderer } from './sdk/memo.js'

/**
 * The slice of the assembly's dependency bundle this operation reads, declared structurally. The
 * bundle itself is the host's type and this package sits below the host, so naming the fields it
 * uses is the only way to take them; a host bundle satisfies this shape without knowing it exists.
 *
 * Only the platform is taken. Everything else the section states is per-session or per-request and
 * is read off the operation context at the moment the request is assembled, so it cannot be a value
 * captured once at startup and then reported for the rest of the process's life.
 */
export type PromptDeps = {
  adapters: {
    shell?: Readonly<{ description: string }>
    platform: {
      shell(): string
      snapshot(): { os: string; arch: string }
      capability(id: string): { level: string }
    }
  }
}

const SOURCE = '@agnes/code'
/** The one capability the environment section quotes: whether this OS can enforce a sandbox. */
const SANDBOX = 'sandbox.l1'

/** Orders come from the frozen table, so a section this package invented has no order and throws. */
function section(id: string, text: string): PromptSection {
  return { id, order: sectionOrder(id), text, source: SOURCE }
}

export function environmentFacts(ctx: OpContext, deps: PromptDeps): EnvironmentFacts {
  const platform = deps.adapters.platform
  const os = platform.snapshot()
  return {
    agnesVersion: ctx.session.d.agnesVersion ?? '0.0.0',
    platform: `${os.os}-${os.arch}`,
    shell: deps.adapters.shell?.description ?? platform.shell(),
  }
}

/** The counterpart request-scoped facts, built off the same ctx — see RuntimeSnapshotFacts. */
export function runtimeSnapshotFacts(ctx: OpContext, deps: PromptDeps): RuntimeSnapshotFacts {
  const platform = deps.adapters.platform
  return {
    // Use the session clock so replay and a fixed-clock test retain their original UTC date.
    date: new Date(ctx.session.d.clock()).toISOString().slice(0, 10),
    sessionKey: ctx.session.key,
    model: ctx.model.model,
    route: ctx.model.route,
    slot: ctx.model.slot,
    preset: ctx.preset.name,
    disclosure: ctx.preset.disclosure,
    enforcement: platform.capability(SANDBOX).level,
    cwd: ctx.session.d.cwd,
  }
}

/**
 * Builds the before-inference operation that puts this package's prompt into the request. The
 * operation itself claims no work of its own — applicable() and run() below are a fixed no-op pair
 * — so everything it does happens through contribute(), documented at its own declaration.
 */
export function createPromptOperation(deps: PromptDeps): Operation {
  const sdk = createSdkRenderer({})
  return {
    name: 'code:prompts',
    slot: 'before-inference',
    order: 10,
    replay: 'safe',
    // This operation exists for contribute(). It claims no work of its own, so it reports itself
    // applicable and does nothing when run.
    applicable: async () => 'applied',
    run: async () => ({}),
    /**
     * Splits what this package tells the model into two channels, not one: text that stays the same
     * for the whole session goes into promptSections, and the facts that can differ from one request
     * to the next request or another session — date, session key, model, preset, disclosure, cwd,
     * enforcement, and whether the tool list is complete — go into runtimeContext, rendered as a tail message rather
     * than folding into system. Disclosure decides which sections apply, and the rule throughout is
     * that a section is contributed only where what it describes is actually present — a prompt
     * naming a tool the model was not offered is worse than a prompt that is short.
     */
    contribute(ctx: OpContext) {
      const declared = ctx.preset.model?.promptSections
      if (declared?.length === 0) return { promptSections: [] }
      const sections = [
        section('persona', renderPersona()),
        section('environment', renderEnvironment(environmentFacts(ctx, deps))),
      ]
      // The code preset offers run_code alone, and the general working rules are written for an
      // agent that edits and runs things directly.
      if (ctx.preset.disclosure !== 'code')
        sections.push(section('coding-doctrine', loadPrompt('coding-doctrine')))
      // Keyed on the tool actually being offered rather than on the preset asking for it: the whole
      // section is instructions for calling run_code, and a session assembled without that tool
      // would be told how to use something it does not have.
      if (ctx.disclosed.includes('run_code'))
        sections.push(section('code-doctrine', loadPrompt('code-doctrine')))
      if (ctx.preset.disclosure !== 'standard' && ctx.disclosed.includes('run_code'))
        sections.push(section('tools:sdk', sdk.render(ctx.snapshot)))
      if (declared?.includes('channel-style'))
        sections.push(section('channel-style', loadPrompt('channel-style')))
      return {
        promptSections: declared
          ? sections.filter((s) => declared.includes(s.id) || s.id === 'tools:sdk')
          : sections,
        runtimeContext: {
          environment: runtimeSnapshotFacts(ctx, deps),
          tools: { complete: renderTools(ctx.disclosed) },
        },
      }
    },
  }
}

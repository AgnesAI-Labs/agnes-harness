import { readFileSync } from 'node:fs'
import {
  ChildEnginesSaveParams,
  describeValidationErrors,
  ModelSlotsSnapshot,
  validateAgainst,
} from '@agnes/protocol'
import { AutoReviewConfig, SessionDefaultsState, SystemPromptSaveParams } from '@agnes/protocol/gen/agnes-v1'
import {
  AdminMemoryParams,
  AdminObservabilityParams,
  AdminSearchSave,
  AdminSearchTest,
} from '@agnes/protocol/gen/app-server'
import type { NodeClient } from '@agnes/sdk'
import type { TSchema } from '@sinclair/typebox'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }
type Params = Record<string, unknown>

/** One row per settings section; every verb below reads this table and nothing else. */
type Section = {
  summary: string
  /** The read RPC and the params it takes (memory needs the workspace it inspects). */
  get: { method: string; params?: (p: ParsedArgs) => Params }
  save: {
    method: string
    /** `set --file` input is checked against this protocol schema before any request. */
    schema: TSchema
    /** Result-only keys that a `get --json` document carries and the save schema refuses. */
    drop?: string[]
    /** Fills keys the file left out. */
    defaults?: (p: ParsedArgs) => Params
    /** admin.memory / admin.observability read and write with one method: a write names one of these. */
    needs?: string[]
  }
  /** `set --text <text>` shortcut: builds the save params from the stored value. */
  text?: (p: ParsedArgs, stored: Params, text: string) => Params
  test?: { method: string; schema: TSchema }
}

const SECTIONS: Record<string, Section> = {
  'model-slots': {
    summary: 'auxiliary model slots (fast, verifier, ...)',
    get: { method: '_agnes/v1/config.modelSlots.get' },
    save: { method: '_agnes/v1/config.modelSlots.save', schema: ModelSlotsSnapshot },
  },
  'child-engines': {
    summary: 'which engines sub-agents may use',
    get: { method: '_agnes/v1/config.childEngines.get' },
    save: { method: '_agnes/v1/config.childEngines.save', schema: ChildEnginesSaveParams, drop: ['effect'] },
  },
  'auto-review': {
    summary: 'automatic review of tool calls',
    get: { method: '_agnes/v1/autoReview.get' },
    save: { method: '_agnes/v1/autoReview.save', schema: AutoReviewConfig },
  },
  'system-prompt': {
    summary: 'persona and full system prompt override (--text replaces the whole prompt)',
    get: { method: '_agnes/v1/systemPrompt.get' },
    save: { method: '_agnes/v1/systemPrompt.save', schema: SystemPromptSaveParams },
    text: (_p, stored, text) => {
      const { fullOverride: _old, ...rest } = (stored.config ?? {}) as Params
      return {
        config: text ? { ...rest, fullOverride: text } : rest,
        confirmFullOverride: Boolean(text),
        ...(stored.revision === undefined ? {} : { expectedRevision: stored.revision }),
      }
    },
  },
  memory: {
    summary: 'memory mode and files of one workspace (--cwd, default: current directory)',
    get: { method: '_agnes/v1/admin.memory', params: (p) => ({ cwd: p.cwd ?? process.cwd() }) },
    save: {
      method: '_agnes/v1/admin.memory',
      schema: AdminMemoryParams,
      defaults: (p) => ({ cwd: p.cwd ?? process.cwd() }),
      needs: ['settings', 'content'],
    },
  },
  observability: {
    summary: 'telemetry exporter settings',
    get: { method: '_agnes/v1/admin.observability' },
    save: { method: '_agnes/v1/admin.observability', schema: AdminObservabilityParams, needs: ['settings'] },
  },
  search: {
    summary: 'web search providers; test runs one query (--text <query> [<provider>])',
    get: { method: '_agnes/v1/admin.search.get' },
    save: { method: '_agnes/v1/admin.search.save', schema: AdminSearchSave },
    test: { method: '_agnes/v1/admin.search.test', schema: AdminSearchTest },
  },
  'session-defaults': {
    summary: 'defaults for new sessions (preset, permission, model, providers)',
    get: { method: '_agnes/v1/sessionSelection.defaults.get' },
    save: { method: '_agnes/v1/sessionSelection.defaults.save', schema: SessionDefaultsState },
  },
}

function readJson(source: string): unknown {
  let text: string
  try {
    text = readFileSync(source === '-' ? 0 : source, 'utf8')
  } catch {
    throw new UsageError(`cannot read the settings from ${oneLine(source)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new UsageError('the settings are not valid JSON')
  }
}

/** Every leaf on its own escaped line: `a.b[0]: value`. */
function flatten(value: unknown, path = ''): string[] {
  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, unknown]> = Array.isArray(value)
      ? value.map((v, i) => [`[${i}]`, v])
      : Object.entries(value).map(([k, v]) => [path && !k.startsWith('[') ? `.${k}` : k, v])
    if (entries.length) return entries.flatMap(([k, v]) => flatten(v, `${path}${k}`))
  }
  return [
    `${oneLine(path || '(value)')}: ${oneLine(typeof value === 'string' ? value : JSON.stringify(value))}`,
  ]
}

export const settingsList = (): string =>
  `${Object.entries(SECTIONS)
    .map(([name, s]) => `${name.padEnd(17)}${s.summary}`)
    .join('\n')}\n`

/**
 * `agh settings [<section> [get | set (--file <f|->) | test]]`: the Web settings pages through their
 * admin-tier RPCs, all driven by SECTIONS. Input JSON is checked against the protocol schema before any
 * request; a daemon refusal propagates as it comes.
 */
export async function settingsCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const [name, verb = 'get', ...extra] = p.positional
  const out = (value: unknown, text: string) => io.stdout.write(p.json ? `${JSON.stringify(value)}\n` : text)
  if (name === undefined) {
    io.stdout.write(settingsList())
    return ExitCode.OK
  }
  const section = Object.hasOwn(SECTIONS, name) ? SECTIONS[name] : undefined
  if (!section)
    throw new UsageError(`settings: unknown section ${oneLine(name)}; run agh settings to list them`)
  const read = (): Promise<Params> => client.call(section.get.method, section.get.params?.(p) ?? {})

  if (verb === 'get') {
    if (extra.length || p.file !== undefined || p.text !== undefined)
      throw new UsageError(`settings ${name} get takes no arguments`)
    const result = await read()
    out(result, `${flatten(result).join('\n')}\n`)
    return ExitCode.OK
  }
  if (verb === 'set') {
    if (extra.length) throw new UsageError(`settings ${name} set takes --file <file|-> only`)
    if (p.file !== undefined && p.text !== undefined)
      throw new UsageError('use either --file or --text, not both')
    let params: Params
    if (p.text !== undefined) {
      if (!section.text)
        throw new UsageError(`settings ${name} set does not take --text; use --file <file|->`)
      if (p.text && !p.yes)
        throw new UsageError(`settings ${name} set --text replaces the whole prompt; add --yes to confirm`)
      params = section.text(p, await read(), p.text)
    } else {
      if (p.file === undefined)
        throw new UsageError(
          `settings ${name} set needs --file <file|->${section.text ? ' or --text <text>' : ''}`,
        )
      const doc = readJson(p.file)
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc))
        throw new UsageError('the settings must be a JSON object')
      params = { ...section.save.defaults?.(p), ...doc }
      for (const key of section.save.drop ?? []) delete params[key]
      if (section.save.needs && !section.save.needs.some((k) => k in params))
        throw new UsageError(`settings ${name} set needs one of: ${section.save.needs.join(', ')}`)
    }
    const checked = validateAgainst<Params>(section.save.schema, params)
    if (!checked.ok)
      throw new UsageError(
        `the settings do not match the schema: ${describeValidationErrors(checked.errors)}`,
      )
    out(await client.call(section.save.method, checked.value), `saved ${name}\n`)
    return ExitCode.OK
  }
  if (verb === 'test') {
    if (!section.test) throw new UsageError(`settings ${name} has no test`)
    if (extra.length > 1 || p.text === undefined)
      throw new UsageError(`settings ${name} test expects --text <query> [<provider>]`)
    const provider = extra[0] ?? ((await read()).defaultProvider as string | null | undefined)
    const input = { provider: provider ?? '', query: p.text }
    const checked = validateAgainst<Params>(section.test.schema, input)
    if (!provider || !checked.ok)
      throw new UsageError(
        `the test input is invalid${checked.ok ? ': no provider given and no default provider' : `: ${describeValidationErrors(checked.errors)}`}`,
      )
    const result = await client.call<Params>(section.test.method, checked.value)
    out(result, `${flatten(result).join('\n')}\n`)
    if (result.ok === false) {
      if (!p.json) io.stderr.write(`refused: ${oneLine(String(result.message ?? 'test failed'))}\n`)
      return ExitCode.ERROR
    }
    return ExitCode.OK
  }
  throw new UsageError(`settings ${name} expects get, set${section.test ? ', test' : ''}`)
}

import { readFileSync } from 'node:fs'
import { loadConformanceFixtures, type Protocol, runConformance } from '@agnes/ai'
import { createPrompterBridge } from '@agnes/daemon/local'
import type { Host } from '@agnes/host'
import { profileNameFrom } from '../boot/inputs.js'
import { assembleLocalHost, type LocalBootDeps } from '../boot/local.js'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { resolveDoctorProfile } from './doctor-profile.js'

const PROTOCOLS = new Set<string>(['openai-completions', 'openai-responses', 'anthropic-messages'])

/** Replaced with the reviewed AI fixture assets by build:sea. */
declare const AGNES_CONFORMANCE_FIXTURE_TEXTS: Readonly<Record<string, string>> | undefined

const failed = (text: string): { text: string; exitCode: number } => ({
  text,
  exitCode: ExitCode.ERROR,
})

function fixtureText(protocol: Protocol): string {
  if (typeof AGNES_CONFORMANCE_FIXTURE_TEXTS !== 'undefined') {
    const text = AGNES_CONFORMANCE_FIXTURE_TEXTS[protocol]
    if (text === undefined) throw new Error(`missing bundled conformance fixture ${protocol}`)
    return text
  }
  // The fixtures are versioned with the runner. Loading a mutable copy from the profile directory
  // would let a local file silently weaken the daily gateway gate it is meant to enforce.
  const aiEntry = import.meta.resolve('@agnes/ai')
  return readFileSync(new URL(`../fixtures/conformance/${protocol}.jsonl`, aiEntry), 'utf8')
}

function render(report: Awaited<ReturnType<typeof runConformance>>, json: boolean): string {
  if (json) return JSON.stringify(report, null, 2)
  const rows = report.results.map(
    (result) =>
      `${result.pass ? '✓' : '✗'} ${result.protocol} ${result.scenario}${result.detail ? ` — ${result.detail}` : ''}`,
  )
  rows.push(`${report.passed}/${report.total} passed`)
  for (const missing of report.missingScenarios)
    rows.push(`✗ ${missing.protocol} ${missing.scenario} — fixture missing`)
  return rows.join('\n')
}

/** Runs the immutable eight-scenario fixture set against the assembled gateway wire adapter. */
export async function conformanceGateway(
  parsed: ParsedArgs,
  deps: LocalBootDeps,
): Promise<{ text: string; exitCode: number }> {
  if (parsed.positional.length !== 1 || parsed.positional[0] !== 'gateway')
    throw new UsageError('conformance gateway [--model <slot>=<route>/<model>] [--json]')
  if (parsed.connect !== undefined || deps.env.AGNES_CONNECT !== undefined)
    throw new UsageError('conformance only runs in one-shot form (no --connect)')

  const commandDeps: LocalBootDeps = { ...deps, cwd: parsed.cwd ?? deps.cwd }
  const profile = await resolveDoctorProfile(commandDeps, parsed)
  const bridge = createPrompterBridge()
  let host: Host | undefined
  try {
    host = await assembleLocalHost(
      profile,
      profileNameFrom(parsed, commandDeps.env),
      commandDeps.cwd,
      commandDeps,
      bridge.prompter,
    )
    const registry = host.provider.registry
    if (registry === undefined)
      return failed('gateway conformance unavailable: provider has no wire registry')

    const route = parsed.model?.route ?? 'agnes-gateway'
    const target = registry.lookup(route)
    if (target === undefined)
      return failed(`gateway conformance unavailable: route ${route} is not assembled`)
    if (!PROTOCOLS.has(target.decl.api))
      return failed(`gateway conformance unavailable: unsupported protocol ${target.decl.api}`)

    const models = target.adapter.models(route)
    const modelId = parsed.model?.model ?? (models.length === 1 ? models[0]?.id : undefined)
    if (modelId === undefined)
      return failed(`gateway conformance unavailable: route ${route} requires an explicit --model`)

    const protocol = target.decl.api as Protocol
    const fixtures = loadConformanceFixtures(fixtureText(protocol))
    const report = await runConformance(target.adapter, route, modelId, fixtures, {
      signal: commandDeps.signal ?? new AbortController().signal,
    })
    const complete = report.total === 8 && report.missingScenarios.length === 0
    return {
      text: render(report, parsed.json),
      exitCode: complete && report.passed === report.total ? ExitCode.OK : ExitCode.ERROR,
    }
  } finally {
    await host?.close()
  }
}

import { runDoctor } from '@agnes/ai'
import type { Host } from '@agnes/host'
import type { ConfigAccount } from '@agnes/protocol'
import type { Section } from './doctor-local.js'

const MAX_IDENTIFIERS = 3
const MAX_IDENTIFIER_CHARS = 96

function summary(label: string, values: readonly string[]): string {
  const safe = values.map(safeIdentifier)
  const shown = safe.slice(0, MAX_IDENTIFIERS)
  return `${label} (${values.length}): ${shown.join(', ')}${values.length > shown.length ? ` (+${values.length - shown.length} omitted)` : ''}`
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '?').slice(0, MAX_IDENTIFIER_CHARS)
}

function safeReport(report: Awaited<ReturnType<typeof runDoctor>>): Awaited<ReturnType<typeof runDoctor>> {
  return {
    at: report.at,
    ok: report.ok,
    routes: report.routes.map((route) => ({
      route: safeIdentifier(route.route),
      ok: route.ok,
      latencyMs: route.latencyMs,
      adapter: 'provider',
      checks: route.checks.map((check) => ({
        name: check.name,
        ok: check.ok,
        detail: check.ok ? 'E_PROVIDER_PROBE_OK' : 'E_PROVIDER_PROBE_FAILED',
      })),
    })),
    models: report.models.map((model) => ({
      route: safeIdentifier(model.route),
      id: safeIdentifier(model.id),
      observed: model.observed,
      mismatches: model.mismatches.length ? ['E_PROVIDER_MODEL_MISMATCH'] : [],
    })),
  }
}

/** The caller owns the Host and closes it after all diagnostic sections finish. */
export async function doctorProvider(
  host: Pick<Host, 'provider' | 'profile'> | undefined,
  options: Parameters<typeof runDoctor>[1] & {
    probe?: boolean
    json?: boolean
    accounts?: readonly ConfigAccount[]
  },
): Promise<Section> {
  const missingCredentials = (options.accounts ?? []).filter(
    (account) => account.enabled && !account.credentialConfigured,
  )
  if (missingCredentials.length)
    return {
      name: 'provider',
      status: 'fail',
      detail: [
        summary(
          'enabled accounts missing usable credentials',
          missingCredentials.map((account) => account.accountId),
        ),
      ],
    }
  if (!host)
    return {
      name: 'provider',
      status: 'warn',
      detail: ['no configured provider route selected; no credential or inference probe was run'],
    }
  const selected = new Set((host.profile.provider.routes ?? []).map((route) => route.route))
  if (selected.size === 0)
    return {
      name: 'provider',
      status: 'warn',
      detail: ['no configured provider route selected; no credential or inference probe was run'],
    }
  const registry = host.provider.registry
  if (!registry)
    return {
      name: 'provider',
      status: 'fail',
      detail: ['configured provider route has no diagnostic registry'],
    }
  const unknown = [...selected].filter((route) => registry.lookup(route) === undefined)
  if (unknown.length)
    return {
      name: 'provider',
      status: 'fail',
      detail: [summary('configured routes absent from registry', unknown)],
    }
  if (!options.probe)
    return {
      name: 'provider',
      status: 'warn',
      detail: [
        summary('configured routes', [...selected].sort()),
        'credentials and selected-model inference not checked; rerun with --probe to opt in',
      ],
    }
  try {
    const selectedModels = new Map(
      (options.accounts ?? [])
        .filter((account) => account.enabled)
        .map((account) => [account.route, account.model]),
    )
    const scoped = {
      lookup: (route: string) => registry.lookup(route),
      routes: () => registry.routes().filter((route) => selected.has(route.route)),
      models: () =>
        registry
          .models()
          .filter(
            (model) =>
              selected.has(model.route) && (selectedModels.get(model.route) ?? model.id) === model.id,
          ),
      seal: () => registry.seal(),
      fingerprint: () => registry.fingerprint(),
    }
    const report = await runDoctor(scoped, options)
    if (options.json)
      return {
        name: 'provider',
        status: report.ok ? 'ok' : 'fail',
        detail: [JSON.stringify(safeReport(report))],
      }
    const failedRoutes = report.routes.filter((route) => !route.ok).map((route) => route.route)
    const missingModels = report.models
      .filter((model) => !model.observed || model.mismatches.length)
      .map((model) => model.id)
    return {
      name: 'provider',
      status: report.ok ? 'ok' : 'fail',
      detail: report.ok
        ? ['selected provider route and model inference verified']
        : [
            ...(failedRoutes.length ? [summary('route probe failed', failedRoutes)] : []),
            ...(missingModels.length
              ? [summary('selected-model inference not verified', missingModels)]
              : []),
            'rerun with --probe --json for structured diagnostic detail',
          ],
    }
  } catch {
    return { name: 'provider', status: 'fail', detail: ['provider diagnostic failed'] }
  }
}

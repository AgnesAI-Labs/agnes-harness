import type { AiErrorCode, RequestBody, ToolSchema } from '@agnes/protocol'
import type { WireAdapter, WireEvent } from '../adapter.js'

export type Protocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'
export type Scenario =
  | 'tool_call'
  | 'parallel_tools'
  | 'six_tools_degrade'
  | 'thinking'
  | 'vision'
  | 'overflow'
  | 'cache_fields'
  | 'cancel'
export type Predicate =
  | { kind: 'toolcall_count_at_least'; n: number }
  | { kind: 'usage_has'; field: 'cacheRead' | 'cacheWrite' | 'reasoning' }
  | { kind: 'error_code'; code: AiErrorCode }
  | { kind: 'done_reason'; reason: 'stop' | 'toolUse' | 'length' }
export type ConformanceFixture = {
  id: string
  protocol: Protocol
  scenario: Scenario
  request: Partial<RequestBody> & { tools?: ToolSchema[] }
  expect: { types: string[]; predicates?: Predicate[] }
}
export type ConformanceResult = {
  id: string
  protocol: Protocol
  scenario: Scenario
  pass: boolean
  detail?: string
  types: string[]
}
export type ConformanceReport = {
  results: ConformanceResult[]
  passed: number
  total: number
  missingScenarios: Array<{ protocol: Protocol; scenario: Scenario }>
}
export type ConformanceOptions = {
  signal: AbortSignal
  timeoutMs?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const PROTOCOLS: readonly Protocol[] = ['openai-completions', 'openai-responses', 'anthropic-messages']
const SCENARIOS: readonly Scenario[] = [
  'tool_call',
  'parallel_tools',
  'six_tools_degrade',
  'thinking',
  'vision',
  'overflow',
  'cache_fields',
  'cancel',
]

export function scenarioMatrix(): Array<{ protocol: Protocol; scenario: Scenario }> {
  return PROTOCOLS.flatMap((protocol) => SCENARIOS.map((scenario) => ({ protocol, scenario })))
}

export function loadConformanceFixtures(text: string): ConformanceFixture[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ConformanceFixture)
}

/** Matches an exact event sequence except for `type*`, which consumes zero or more of that type. */
export function matchTypes(pattern: string[], actual: string[]): boolean {
  const matchFrom = (patternIndex: number, actualIndex: number): boolean => {
    if (patternIndex === pattern.length) return actualIndex === actual.length
    const token = pattern[patternIndex] as string
    if (token.endsWith('*')) {
      const repeated = token.slice(0, -1)
      return (
        matchFrom(patternIndex + 1, actualIndex) ||
        (actualIndex < actual.length &&
          actual[actualIndex] === repeated &&
          matchFrom(patternIndex, actualIndex + 1))
      )
    }
    return (
      actualIndex < actual.length &&
      actual[actualIndex] === token &&
      matchFrom(patternIndex + 1, actualIndex + 1)
    )
  }
  return matchFrom(0, 0)
}

const expand = (text: string): string =>
  text.replace(/<FILL:(\d+)>/g, (_marker, length: string) => 'a'.repeat(Number(length)))

function materialize(fixture: ConformanceFixture, route: string, model: string): RequestBody {
  const request = fixture.request
  return {
    kind: 'inference',
    sessionKey: 'agnes:conformance',
    slot: 'primary',
    route,
    model,
    contractId: null,
    derivedHash: '0'.repeat(64),
    system: expand(request.system ?? ''),
    messages: (request.messages ?? []).map((message) =>
      message.role === 'user'
        ? {
            ...message,
            content: message.content.map((content) =>
              content.type === 'text' ? { ...content, text: expand(content.text) } : content,
            ),
          }
        : message,
    ),
    tools: request.tools ?? [],
    ...(request.sampling ? { sampling: request.sampling } : {}),
  }
}

function predicatePass(predicate: Predicate, events: WireEvent[]): boolean {
  switch (predicate.kind) {
    case 'toolcall_count_at_least':
      return events.filter((event) => event.type === 'toolcall_end').length >= predicate.n
    case 'usage_has': {
      const usage = events.find(
        (event): event is Extract<WireEvent, { type: 'usage' }> => event.type === 'usage',
      )
      const value = usage?.tokens[predicate.field]
      return typeof value === 'number' && value > 0
    }
    case 'error_code':
      return events.some((event) => event.type === 'error' && event.code === predicate.code)
    case 'done_reason':
      return events.some((event) => event.type === 'done' && event.reason === predicate.reason)
  }
}

function missingScenarios(fixtures: ConformanceFixture[]): ConformanceReport['missingScenarios'] {
  const represented = new Set(fixtures.map((fixture) => fixture.protocol))
  const present = new Set(fixtures.map((fixture) => `${fixture.protocol}/${fixture.scenario}`))
  return scenarioMatrix().filter(
    ({ protocol, scenario }) => represented.has(protocol) && !present.has(`${protocol}/${scenario}`),
  )
}

function failure(fixture: ConformanceFixture, detail: string, types: string[] = []): ConformanceResult {
  return {
    id: fixture.id,
    protocol: fixture.protocol,
    scenario: fixture.scenario,
    pass: false,
    detail,
    types,
  }
}

function scheduleTimeout(
  controller: AbortController,
  ms: number,
  sleep?: ConformanceOptions['sleep'],
): () => void {
  if (!sleep) {
    const timer = setTimeout(() => controller.abort(), ms)
    return () => clearTimeout(timer)
  }
  const cancel = new AbortController()
  void sleep(ms, cancel.signal).then(
    () => {
      if (!cancel.signal.aborted) controller.abort()
    },
    () => undefined,
  )
  return () => cancel.abort()
}

/**
 * Runs language-neutral fixtures directly against one protocol route. A failed or unavailable
 * gateway becomes a failed report row; exception messages are deliberately not copied into output.
 */
export async function runConformance(
  adapter: WireAdapter,
  route: string,
  modelId: string,
  fixtures: ConformanceFixture[],
  opts: ConformanceOptions,
): Promise<ConformanceReport> {
  const results: ConformanceResult[] = []
  let declaredProtocol: string | undefined
  try {
    const declaration = adapter.routes().find((candidate) => candidate.route === route)
    if (!declaration) {
      results.push(...fixtures.map((fixture) => failure(fixture, `route unavailable: ${route}`)))
    } else if (!adapter.models(route).some((model) => model.id === modelId)) {
      results.push(...fixtures.map((fixture) => failure(fixture, `model unavailable: ${modelId}`)))
    } else declaredProtocol = declaration.api
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown error'
    results.push(...fixtures.map((fixture) => failure(fixture, `adapter unavailable: ${name}`)))
  }

  if (declaredProtocol !== undefined) {
    for (const fixture of fixtures) {
      if (fixture.protocol !== declaredProtocol) {
        results.push(
          failure(fixture, `protocol mismatch: route=${declaredProtocol} fixture=${fixture.protocol}`),
        )
        continue
      }

      const controller = new AbortController()
      const abort = () => controller.abort()
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', abort, { once: true })
      const stopTimeout = scheduleTimeout(controller, opts.timeoutMs ?? 30_000, opts.sleep)
      const events: WireEvent[] = []
      try {
        const request = materialize(fixture, route, modelId)
        for await (const event of adapter.stream(route, request, {
          signal: controller.signal,
          toolNames: request.tools.map((tool) => tool.name),
          sessionKey: request.sessionKey,
          timeoutMs: { firstToken: 30_000, total: opts.timeoutMs ?? 30_000 },
          reportSent: () => undefined,
        })) {
          events.push(event)
          if (
            fixture.scenario === 'cancel' &&
            (event.type === 'text_delta' || event.type === 'thinking_delta')
          )
            controller.abort()
        }
      } catch (error) {
        results.push(
          failure(
            fixture,
            `threw ${error instanceof Error ? error.name : 'unknown error'}`,
            events.map((event) => event.type),
          ),
        )
        continue
      } finally {
        stopTimeout()
        opts.signal.removeEventListener('abort', abort)
      }

      const types = events.map((event) => event.type)
      const typesPass = matchTypes(fixture.expect.types, types)
      const failedPredicates = (fixture.expect.predicates ?? []).filter(
        (predicate) => !predicatePass(predicate, events),
      )
      const pass = typesPass && failedPredicates.length === 0
      results.push({
        id: fixture.id,
        protocol: fixture.protocol,
        scenario: fixture.scenario,
        pass,
        types,
        ...(!pass
          ? {
              detail: [
                ...(typesPass
                  ? []
                  : [`types expected=${fixture.expect.types.join(',')} actual=${types.join(',')}`]),
                ...failedPredicates.map((predicate) => `predicate ${predicate.kind}`),
              ].join('; '),
            }
          : {}),
      })
    }
  }

  return {
    results,
    passed: results.filter((result) => result.pass).length,
    total: results.length,
    missingScenarios: missingScenarios(fixtures),
  }
}

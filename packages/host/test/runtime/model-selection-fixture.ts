import { fakeModel } from '@agnes/ai/testkit'
import { type Outcome, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type { ModelRecord, RouteDecl, SlotName, ThinkingLevel } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  captureModelCatalog,
  type SelectedModelCatalog,
} from '../../src/runtime/model/model-catalog-capture.js'
import type { SelectionRoutes } from '../../src/runtime/model/model-selection.js'

export const SCHEMA = runtimeAuthorSchemas.StandardToolOutput.ref
export const PARAMETER_RECORD = 'session-parameters'

export const MODEL_A = fakeModel({
  id: 'model-a',
  route: 'route-1',
  reasoning: true,
  thinkingLevelMap: { high: 'high', low: 'low' },
  defaultSettings: { thinking: 'low' },
})
export const MODEL_B = fakeModel({ id: 'model-b', route: 'route-1' })
export const PAIR_A = { route: 'route-1', model: 'model-a' }
export const PAIR_B = { route: 'route-1', model: 'model-b' }

export const NEEDS: Wire.ModelFeatures = {
  input: ['text'],
  output: ['text'],
  tools: true,
  structuredOutput: false,
  streaming: true,
}

export function catalogOf(...models: ModelRecord[]): SelectedModelCatalog {
  return captureModelCatalog({
    routes: () => [
      { route: 'route-1', api: 'openai-completions', baseUrl: 'https://fake.invalid' } as RouteDecl,
    ],
    models: () => models,
    seal: () => {},
  })
}

type Pair = { route: string; model: string; fallbacks?: { route: string; model: string }[] }

/** A revision in its real shape: the session fields are a ConfigValue, so they sit under parameters.value. */
export function revision(
  n: number,
  route: Partial<Record<SlotName, Pair>>,
  thinking: Partial<Record<SlotName, ThinkingLevel>> = {},
): Wire.SessionParameterRevision {
  return {
    sessionId: 'session-1',
    revision: n,
    previousRevision: n === 0 ? null : n - 1,
    sourceRequestId: `request-${n}`,
    presetId: 'preset',
    presetDigest: 'c'.repeat(64),
    parameters: { schema: SCHEMA, value: { model: { route, thinking } } },
    effective: {
      kind: n === 0 ? 'immediate' : 'next-request',
      revision: n,
      runId: 'run-1',
      afterRequestId: null,
    },
    committedAt: '2026-10-05T00:00:00Z',
  } as unknown as Wire.SessionParameterRevision
}

/** The record's own revision is one ahead of the parameter revision number, as a stored record starts at 1. */
export function referenceOf(rev: Wire.SessionParameterRevision): Wire.DomainReference {
  return {
    authorityId: 'fixture-state',
    recordId: PARAMETER_RECORD,
    recordRevision: rev.revision + 1,
    schema: SCHEMA,
    digest: canonicalJsonDigest(rev as unknown as Wire.JsonValue),
  }
}

export function frameOf(rev: Wire.SessionParameterRevision): Wire.RunFrame {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    sessionParameters: { value: rev, reference: referenceOf(rev) },
  } as unknown as Wire.RunFrame
}

export function routesFor(
  allowed: readonly string[] = ['route-1'],
  features: Partial<Wire.ModelFeatures> = {},
  credentialBinding: Wire.SecretConsumerBinding | null = null,
): SelectionRoutes {
  return {
    declared: (route) => allowed.includes(route),
    snapshot: ({ route, model, catalogDigest }) => ({
      routeId: route.route,
      routeRevision: 1,
      adapter: {
        bindingId: 'adapter',
        providerId: 'agh.default/model-adapter',
        contract: 'agh.model-adapter',
        logicalName: 'default',
      },
      model: model.id,
      endpointRef: 'endpoint',
      catalogRevision: 7,
      features: { ...NEEDS, ...features },
      priceVersion: `price-${catalogDigest.slice(0, 8)}`,
      credentialAudience: 'endpoint',
      credentialBinding,
    }),
  }
}

/** Stands in for the State's effective-parameter record: same rule as its read-guard check. */
export class ParameterPointer {
  readonly #revisions: Wire.SessionParameterRevision[]
  constructor(first: Wire.SessionParameterRevision) {
    this.#revisions = [first]
  }
  get head(): Wire.SessionParameterRevision {
    const head = this.#revisions.at(-1)
    if (!head) throw new Error('pointer has no revision')
    return head
  }
  frame(): Wire.RunFrame {
    return frameOf(this.head)
  }
  commit(next: Wire.SessionParameterRevision): void {
    this.#revisions.push(next)
  }
  check(guards: readonly Wire.ReadGuard[]): Outcome<void> {
    for (const guard of guards) {
      if (guard.recordId !== PARAMETER_RECORD || guard.expectedRecordRevision !== this.head.revision + 1)
        return {
          ok: false,
          error: {
            code: 'conflict',
            detailCode: 'read_guard',
            message: 'read guard does not match the current record',
            retryAdvice: { kind: 'never' },
            diagnosticId: 'fixture',
          },
        }
    }
    return { ok: true, value: undefined }
  }
}

export function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

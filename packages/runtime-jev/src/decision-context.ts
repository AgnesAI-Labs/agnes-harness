import type {
  DecisionContextConfig,
  DecisionContextPort,
  DecisionInputPolicy,
  InputFact,
} from '@agnes/jev-runtime'

export interface DecisionContextOptions {
  readonly config: DecisionContextConfig
  readonly instructionOrder: string
  /** Exact host-owned source names. Message content never selects its authority. */
  readonly sources: Readonly<
    Record<string, DecisionInputPolicy | ((input: InputFact) => DecisionInputPolicy)>
  >
  readonly describeEnvironment?: DecisionContextPort['describeEnvironment']
  readonly describeTool?: DecisionContextPort['describeTool']
  /** Register only host-authenticated loaders; arbitrary tool content remains evidence. */
  readonly describeObservation?: DecisionContextPort['describeObservation']
}

export function createDecisionContext(options: DecisionContextOptions): DecisionContextPort {
  const sources = new Map(Object.entries(options.sources))
  return {
    config: { ...options.config },
    instructionOrder: options.instructionOrder,
    classify(input) {
      const source = sources.get(input.source)
      return source === undefined
        ? { kind: 'context' }
        : typeof source === 'function'
          ? source(input)
          : structuredClone(source)
    },
    ...(options.describeEnvironment === undefined
      ? {}
      : { describeEnvironment: options.describeEnvironment }),
    ...(options.describeTool === undefined ? {} : { describeTool: options.describeTool }),
    ...(options.describeObservation === undefined
      ? {}
      : { describeObservation: options.describeObservation }),
  }
}

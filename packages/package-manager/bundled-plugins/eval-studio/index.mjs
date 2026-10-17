import { compare, dataset, report } from './src/contract.mjs'

const Kind = Symbol.for('TypeBox.Kind')
const string = { [Kind]: 'String', type: 'string', minLength: 1, maxLength: 1048576 }
export const main = {
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'eval_studio_import',
      description:
        'Validate a version 1 eval dataset/report or compare two reports. Explicitly imported evidence is unverified, never permission or a publication gate. Reports are saved as a session artifact. Does not execute datasets or models.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'json'],
        properties: {
          kind: {
            [Kind]: 'Union',
            anyOf: ['dataset', 'report', 'comparison'].map((v) => ({
              [Kind]: 'Literal',
              type: 'string',
              const: v,
            })),
          },
          json: string,
        },
      },
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'never',
        costHint: {},
        deferLoading: true,
        requiresApproval: 'never',
      },
      async execute(input, tool) {
        try {
          tool.signal.throwIfAborted()
          let value
          if (input.kind === 'dataset') value = dataset(input.json)
          else if (input.kind === 'report') value = report(input.json)
          else if (input.kind === 'comparison') {
            if (input.json.length > 1048576) throw new Error('E_EVAL_SIZE')
            const pair = JSON.parse(input.json)
            value = compare(pair.baseline, pair.candidate)
          } else throw new Error('E_EVAL_SCHEMA')
          const artifact = await tool.artifacts.put(
            new TextEncoder().encode(JSON.stringify(value, null, 2)),
            { mime: 'application/json', name: `eval-${input.kind}.json` },
          )
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  artifact,
                  evidence: 'imported-unverified',
                  ...(value.status ? { status: value.status, executed: value.executed } : {}),
                }),
              },
            ],
          }
        } catch {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'E_EVAL_IMPORT: invalid, oversized, cancelled or unavailable artifact. Check the v1 dataset/report and retry.',
              },
            ],
          }
        }
      },
    })
  },
}

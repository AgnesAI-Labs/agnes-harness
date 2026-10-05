import { defineTool, type PureToolDefinition, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type { StandardToolOutput } from '@agnes/protocol/runtime'

/** Fixed text-only example: code points, whitespace-delimited words and CRLF/LF/CR lines. */
export function createTextStatisticsTool(): PureToolDefinition<StandardToolOutput> {
  return defineTool({
    id: 'text-statistics',
    description: 'Count Unicode code points, whitespace-delimited words and lines in one text block',
    execution: 'pure',
    input: runtimeAuthorSchemas.StandardToolOutput,
    execute(input, { signal }) {
      if (signal.aborted) throw new Error('Text statistics cancelled')
      const first = input.content[0]
      if (!first || input.content.length !== 1 || input.structured !== undefined)
        throw new TypeError('Text statistics requires exactly one text block')
      const text = first.text
      let characters = 0,
        words = 0,
        lines = text.length ? 1 : 0,
        inWord = false,
        previousCR = false
      for (const character of text) {
        characters++
        const whitespace = /\s/u.test(character)
        if (!whitespace && !inWord) words++
        inWord = !whitespace
        if (character === '\r' || (character === '\n' && !previousCR)) lines++
        previousCR = character === '\r'
      }
      return {
        content: [{ type: 'text', text: `characters=${characters}; words=${words}; lines=${lines}` }],
        structured: { characters, words, lines },
      }
    },
  }) as PureToolDefinition<StandardToolOutput>
}

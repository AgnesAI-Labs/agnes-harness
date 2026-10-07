import { readFileSync } from 'node:fs'

export const referenceUri = 'evidence://reference'
export const toolCatalog = [{
  name: 'answer',
  description: 'Return a deterministic answer with its evidence URI.',
  inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['question'], additionalProperties: false },
}]
export const resourceCatalog = [{ uri: referenceUri, name: 'reference', mimeType: 'text/plain' }]

export function callTool(name, args) {
  if (name !== 'answer') throw new Error('Unknown tool')
  if (!args || typeof args.question !== 'string' || !args.question.trim() || args.question.length > 256 || Object.keys(args).some(key => key !== 'question')) {
    throw new TypeError('Expected a nonempty question of at most 256 characters')
  }
  return { content: [{ type: 'text', text: '42; evidence: ' + referenceUri }], structuredContent: { answer: 42, evidence: referenceUri } }
}

export function readResource(uri) {
  if (uri !== referenceUri) throw new Error('Unknown resource')
  return { contents: [{ uri, mimeType: 'text/plain', text: readFileSync(new URL('../skills/mcp-skills/assets/reference.txt', import.meta.url), 'utf8') }] }
}

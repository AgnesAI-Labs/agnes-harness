// Inspect captured inference prefixes without exposing message bodies or credentials.
// Usage: node tools/bench-prompt-prefix.mjs <isolated AGH home>
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const home = process.argv[2]
if (!home) throw new Error('Pass an isolated AGH home')
const root = resolve(home, 'data/model-requests')
const calls = []
for (const name of await readdir(root, { recursive: true })) {
  if (!name.endsWith('.call.json')) continue
  const file = join(root, name)
  const call = JSON.parse(await readFile(file, 'utf8'))
  if (call.params?.kind !== 'inference') continue
  const blob = async (hash) => JSON.parse(await readFile(join(dirname(file), `${hash}.blob.json`), 'utf8'))
  const sections = await blob(call.sectionsHash)
  const tools = await blob(call.toolsHash)
  const system = sections.map((section) => section.text).join('\n\n')
  const systemBytes = Buffer.byteLength(system)
  const schemaBytes = Buffer.byteLength(JSON.stringify(tools))
  calls.push({
    createdAt: call.createdAt,
    model: call.params.model,
    systemBytes,
    toolCount: tools.length,
    schemaBytes,
    // A byte heuristic only. Provider token counts below also include the conversation and framing.
    estimatedPrefixTokens: Math.ceil((systemBytes + schemaBytes) / 4),
    sections: sections.map(({ id, order, text }) => ({ id, order, bytes: Buffer.byteLength(text) })),
    tools: tools.map(({ name, description, parameters }) => ({
      name,
      bytes: Buffer.byteLength(JSON.stringify({ name, description, parameters })),
    })),
    attempts: (call.attempts ?? []).map(({ providerActualTokens }) => providerActualTokens ?? null),
  })
}
calls.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
if (!calls.length) throw new Error('No captured inference requests')
console.log(JSON.stringify(calls, null, 2))

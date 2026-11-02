import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// Stream JSONL ledger rows and print only diagnostic fields.
export async function inspectComposition(lines, write = console.log) {
  write(
    'REQUEST\tLANE\tTURN\tSTEP\tTOTAL\tPREFIX\tCONVERSATION\tTOOLS_NEW\tTOOLS_OLD\tTHINKING\tNOTES\tFRAMING\tRESULTS\tMAX_BYTES\tMAX_TOOL',
  )
  let lineNumber = 0
  for await (const line of lines) {
    lineNumber++
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      throw new Error(`Invalid JSON at line ${lineNumber}`)
    }
    const data = row.data
    const cell = (value) => JSON.stringify(value ?? null)
    if (row.type === 'x/core/context-breakdown' && data?.composition) {
      const c = data.composition
      const t = c.tokens ?? {}
      write(
        [
          row.seq,
          row.lane,
          data.turn,
          data.step,
          c.total,
          t.fixedPrefix,
          t.conversation,
          t.toolResultsCurrentStep,
          t.toolResultsEarlier,
          t.thinking,
          t.runtimeNotes,
          t.framing,
          c.toolResultCount,
          c.largestToolResult?.bytes,
          c.largestToolResult?.tool,
        ]
          .map(cell)
          .join('\t'),
      )
    }
    if (row.type === 'x/core/turn-wait') {
      const emit = (kind, name, total) =>
        write(
          ['WAIT', row.lane, data.turn, kind, name, total?.ms, total?.count, total?.missing]
            .map(cell)
            .join('\t'),
        )
      emit('model', null, data.model)
      for (const tool of data.tools ?? []) emit('tool', tool.tool, tool)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: node tools/inspect-request-composition.mjs <ledger.jsonl>')
    process.exitCode = 1
  } else {
    try {
      await inspectComposition(createInterface({ input: createReadStream(file), crlfDelay: Infinity }))
    } catch (error) {
      console.error(error instanceof SyntaxError ? 'Invalid ledger JSON' : error.message)
      process.exitCode = 1
    }
  }
}

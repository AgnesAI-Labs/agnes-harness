// Regenerates `fixtures/op-state-golden/*.jsonl` (one commit per line) from the scenarios in `record-transitions.ts`.
// The recordings are the reference for how today's code stores the program counter; regenerate
// them only for a change that is meant to alter what a transition commits.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { GOLDEN_DIR, recordTransitions, TRANSITION_SCENARIOS } from './record-transitions.js'

rmSync(GOLDEN_DIR, { recursive: true, force: true })
mkdirSync(GOLDEN_DIR, { recursive: true })
for (const name of TRANSITION_SCENARIOS) {
  const commits = await recordTransitions(name, new MemoryStorage())
  writeFileSync(
    `${GOLDEN_DIR}${name}.jsonl`,
    `${commits.map((commit) => JSON.stringify(commit)).join('\n')}\n`,
  )
}
console.log(`wrote ${TRANSITION_SCENARIOS.length} recordings`)

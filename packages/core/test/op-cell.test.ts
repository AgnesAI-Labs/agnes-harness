import { describe, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { OP_CELL_CASES } from '../testkit/op-cell-cases.js'

describe('the program counter as a register cell (MemoryStorage)', () => {
  for (const [name, run] of Object.entries(OP_CELL_CASES)) it(name, () => run(() => new MemoryStorage()))
})

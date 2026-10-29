import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { describe, it } from 'vitest'
import { OP_CELL_CASES } from '../testkit/op-cell-cases.js'

describe('the program counter as a register cell (MemoryStorage)', () => {
  for (const [name, run] of Object.entries(OP_CELL_CASES)) it(name, () => run(() => new MemoryStorage()))
})

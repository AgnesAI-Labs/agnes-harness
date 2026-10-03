import { expect, it } from 'vitest'
import { budgetContext, budgetFixture, budgetRequest } from './fixtures/budget-authority.js'

it('rejects money under the actual stored bounded-units admission mode', async () => {
  const f = budgetFixture()
  try {
    f.put('profile', 'mode', 'bounded-units')
    const legitimate = await f.operations.reserve(budgetRequest('a', '1', null), budgetContext)
    expect(legitimate.reservation.held).toBeNull()
    const writes = f.writes()
    await expect(f.operations.reserve(budgetRequest('b', '1', '10'), budgetContext)).rejects.toThrow(
      'trusted budget mode',
    )
    expect(f.writes()).toBe(writes)
  } finally {
    f.close()
  }
})

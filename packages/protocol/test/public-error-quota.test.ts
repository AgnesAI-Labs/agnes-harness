import { expect, it } from 'vitest'
import { publicErrorCopy } from '../src/public-errors.js'

it("says a provider account out of quota is the provider's balance, not an AGH budget", () => {
  expect(publicErrorCopy('QUOTA')['zh-CN']).toEqual({
    reason: '模型服务商账户额度不足。',
    action: '请到服务商充值，或换用其他模型账户。',
  })
  expect(publicErrorCopy('QUOTA').en.reason).toBe('The model provider account has run out of quota.')
  // AGH's own budget refusals keep their copy.
  expect(publicErrorCopy('E_BUDGET')['zh-CN'].reason).toBe('操作因预算限制被拒绝。')
})

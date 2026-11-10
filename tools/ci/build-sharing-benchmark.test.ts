import { expect, it } from 'vitest'
import { benchmarkResult } from './build-sharing-benchmark.mjs'

it('compares measured consumer and complete transfer costs against the actual build separately', () => {
  expect(
    benchmarkResult({ build: 21000, pack: 2000, upload: 18000, download: 7000, restore: 4000 }),
  ).toMatchObject({
    complete: true,
    consumerMs: 11000,
    producerMs: 20000,
    singleConsumerMs: 31000,
    consumerFaster: true,
    singleConsumerFaster: false,
  })
  expect(
    benchmarkResult({ build: 21000, pack: 1000, upload: 2000, download: 7000, restore: 4000 }),
  ).toMatchObject({
    complete: true,
    consumerFaster: true,
    singleConsumerFaster: true,
  })
  expect(
    benchmarkResult({ build: 21000, pack: 1000, upload: 2000, download: 17000, restore: 4000 }),
  ).toMatchObject({
    complete: true,
    consumerFaster: false,
    singleConsumerFaster: false,
  })
})

it('never reports a positive comparison with missing, failed or invalid measurements', () => {
  const measured = { build: 21000, pack: 1000, upload: 2000, download: 7000, restore: 4000 }
  for (const label of Object.keys(measured)) {
    for (const value of [undefined, null, '', -1, Number.NaN, Number.POSITIVE_INFINITY, '7ms']) {
      const result = benchmarkResult({ ...measured, [label]: value })
      expect(result.complete).toBe(false)
      expect(result.consumerFaster).toBeNull()
      expect(result.singleConsumerFaster).toBeNull()
    }
  }
})

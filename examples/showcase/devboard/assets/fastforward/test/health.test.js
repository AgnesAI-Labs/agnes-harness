'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { alarms, average, grade, ranking, score } = require('../src/health')

const flat = (v) => ({ slide: v, resistance: v, bufferWear: v, closeTime: v, motorPeak: v })

test('a door with no wear scores 100', () => {
  assert.equal(score(flat(0)), 100)
})

test('a door at every alarm limit scores 0', () => {
  assert.equal(score(flat(1)), 0)
})

test('the weights add up: half wear everywhere scores 50', () => {
  assert.equal(score(flat(0.5)), 50)
})

test('missing and out-of-range signals are clamped, not trusted', () => {
  assert.equal(score({ slide: 7, resistance: -3 }), 75)
  assert.equal(score(undefined), 100)
})

test('grades change exactly at 80 and 60', () => {
  assert.equal(grade(80), '健康')
  assert.equal(grade(79.9), '关注')
  assert.equal(grade(60), '关注')
  assert.equal(grade(59.9), '告警')
})

test('alarms name the signals at 0.8 or above', () => {
  assert.deepEqual(alarms({ slide: 0.8, resistance: 0.79, motorPeak: 1 }), ['slide', 'motorPeak'])
})

test('ranking puts the lowest score first and honours the limit', () => {
  const doors = [
    { id: 'A', signals: flat(0.1) },
    { id: 'B', signals: flat(0.9) },
    { id: 'C', signals: flat(0.5) },
  ]
  assert.deepEqual(
    ranking(doors, 2).map((d) => d.id),
    ['B', 'C'],
  )
})

test('average of no doors is null', () => {
  assert.equal(average([]), null)
  assert.equal(average([{ signals: flat(0) }, { signals: flat(1) }]), 50)
})

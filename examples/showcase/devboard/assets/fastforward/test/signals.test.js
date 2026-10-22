'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { DOORS_PER_TRAIN, LINES, SIGNALS, generate } = require('../src/signals')

test('the same seed gives the same fleet', () => {
  assert.deepEqual(generate(7), generate(7))
})

test('different seeds give different fleets', () => {
  assert.notDeepEqual(generate(7), generate(8))
})

test('the fleet covers every line, train and door', () => {
  const expected = LINES.reduce((sum, line) => sum + line.trains * DOORS_PER_TRAIN, 0)
  assert.equal(generate().length, expected)
})

test('every door carries the five PHM signals between 0 and 1', () => {
  for (const door of generate()) {
    assert.deepEqual(Object.keys(door.signals), SIGNALS)
    for (const value of Object.values(door.signals)) assert.ok(value >= 0 && value <= 1, door.id)
  }
})

test('door ids are unique', () => {
  const ids = generate().map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length)
})

'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHandler, parseLimit } = require('../src/app')
const { generate } = require('../src/signals')

/** Drives the handler with plain objects: no listener is needed. */
function call(method, url) {
  const handler = createHandler(generate())
  let status = 0
  let body = ''
  handler({ method, url }, { writeHead: (s) => (status = s), end: (text) => (body = text) })
  return { status, body }
}
const json = (r) => JSON.parse(r.body)

test('the home page is HTML and names the dashboard', () => {
  const r = call('GET', '/')
  assert.equal(r.status, 200)
  assert.match(r.body, /车门健康监测看板/)
})

test('lines list every line with an average and a grade', () => {
  const lines = json(call('GET', '/api/lines')).lines
  assert.equal(lines.length, 2)
  for (const line of lines) assert.ok(line.average > 0 && ['健康', '关注', '告警'].includes(line.grade))
})

test('doors need a known line and train', () => {
  assert.equal(call('GET', '/api/doors?line=L9&train=T01').status, 200)
  assert.equal(call('GET', '/api/doors?line=X1').status, 400)
  assert.equal(call('GET', '/api/doors?line=L9&train=T99').status, 400)
})

test('the ranking limit is a whole number from 1 to 50', () => {
  assert.equal(parseLimit(null), 10)
  assert.equal(parseLimit('50'), 50)
  for (const bad of ['0', '51', '-1', '1.5', 'abc', '']) assert.equal(parseLimit(bad), null, bad)
})

test('only GET is served, unknown paths are 404', () => {
  assert.equal(call('POST', '/api/lines').status, 405)
  assert.equal(call('GET', '/nope').status, 404)
  assert.equal(call('GET', '/api/ranking?limit=0').status, 400)
})

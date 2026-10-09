import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPluginTestHost } from '@agnes/host/author-testkit'
import { echo, main } from '../dist/index.js'

test('register, invoke, reject invalid inputs and unload', async () => {
  const host = await createPluginTestHost(main)
  try {
    assert.deepEqual((await host.invoke(echo.name, { message: 'hello' })).structured, { message: 'hello' })
    assert.equal((await host.invoke(echo.name, { message: '' })).isError, true)
    await assert.rejects(host.invoke(echo.name, { message: 1 }), /Invalid arguments/)
    const cancelled = new AbortController()
    cancelled.abort(new DOMException('Stopped', 'AbortError'))
    await assert.rejects(host.invoke(echo.name, { message: 'hello' }, cancelled.signal), /Stopped/)
  } finally {
    await host.dispose()
  }
  assert.equal(host.tools.size, 0)
})

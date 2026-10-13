import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Context, FiberState } from '@agnes/cordis'
import { createPluginTestHost } from '@agnes/host/author-testkit'
import { main } from '../dist/index.js'

test('configured tool validates inputs, returns deterministic results and unregisters', async () => {
  const host = await createPluginTestHost(main, {
    config: { prefix: 'Hello: ' },
  })
  try {
    const name = 'plugin_tool_panel'
    assert.deepEqual((await host.invoke(name, { message: '  Agnes  ' })).structured, {
      message: 'Hello: Agnes',
      characters: 5,
    })
    assert.equal((await host.invoke(name, { message: ' ' })).isError, true)
    await assert.rejects(host.invoke(name, { message: 1 }), /Invalid arguments/)
    const stop = new AbortController()
    stop.abort(new DOMException('Stopped', 'AbortError'))
    await assert.rejects(host.invoke(name, { message: 'Agnes' }, stop.signal), /Stopped/)
  } finally {
    await host.dispose()
  }
  assert.equal(host.tools.size, 0)
})

test('missing tool service prevents activation and invalid config reports useful author errors', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const entry = manifest.agnes.plugins.find((entry) => entry.export === 'main')
  assert.ok(entry)
  const root = new Context()
  const fiber = root.plugin({ ...main, inject: entry.inject })
  try {
    assert.equal(fiber.state, FiberState.PENDING)
  } finally {
    await fiber.dispose()
    await root.fiber.dispose()
  }
  await assert.rejects(createPluginTestHost(main, { config: { prefix: 42 } }), /prefix must be a string/)
})

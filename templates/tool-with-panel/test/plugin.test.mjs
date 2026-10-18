import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPluginTestHost, scriptedModel } from '@agnes/host/author-testkit'
import { main, todos } from '../dist/index.js'

const packageDir = fileURLToPath(new URL('../', import.meta.url))
test('tool and profile services share durable items across Host restart; refuse invalid inputs and unload', async () => {
  const storeDir = await mkdtemp(join(tmpdir(), 'agh-panel-store-'))
  let host
  try {
    host = await createPluginTestHost(main, { packageDir, storeDir })
    const scripted = scriptedModel([
      [
        {
          type: 'toolcall_end',
          via: 'native',
          call: { toolUseId: 'list-1', ordinal: 0, name: todos.name, args: { action: 'list' } },
        },
      ],
    ])
    const request = {
      kind: 'inference',
      sessionKey: 'test',
      slot: 'primary',
      route: 'demo',
      model: 'demo',
      contractId: null,
      derivedHash: '0'.repeat(64),
      system: 'test',
      messages: [],
      tools: [],
    }
    for (const event of await scripted.model.complete(request, new AbortController().signal)) {
      if (event.type === 'toolcall_end') {
        const result = await host.invoke(event.call.name, event.call.args)
        assert.notEqual(result.isError, true, JSON.stringify(result))
        assert.deepEqual(result.structured, { items: [] })
      }
    }
    assert.equal(scripted.remaining, 0)
    const added = await host.invokeProfileService('__SERVICE_NAME__.change', {
      action: 'add',
      text: 'First item',
    })
    assert.equal(added.items[0].text, 'First item')
    assert.deepEqual((await host.invoke(todos.name, { action: 'list' })).structured, added)
    const toggled = await host.invoke(todos.name, { action: 'toggle', id: added.items[0].id })
    assert.equal(toggled.structured.items[0].done, true)
    assert.deepEqual(await host.invokeProfileService('__SERVICE_NAME__.list', {}), toggled.structured)
    const again = await host.invokeProfileService('__SERVICE_NAME__.change', {
      action: 'toggle',
      id: added.items[0].id,
    })
    assert.equal(again.items[0].done, false)
    assert.equal((await host.invoke(todos.name, { action: 'add', text: ' ' })).isError, true)
    await assert.rejects(
      host.invokeProfileService('__SERVICE_NAME__.change', { action: 'toggle', id: 'missing' }),
      /not found/,
    )
    await assert.rejects(host.invoke(todos.name, { action: 'remove' }), /Invalid arguments/)
    const cancelled = new AbortController()
    cancelled.abort(new Error('Stopped'))
    await assert.rejects(host.invoke(todos.name, { action: 'list' }, cancelled.signal), /Stopped/)
    await host.dispose()
    assert.equal(host.tools.size, 0)
    await assert.rejects(host.invokeProfileService('__SERVICE_NAME__.list', {}), /disposed/)
    host = await createPluginTestHost(main, { packageDir, storeDir })
    assert.deepEqual(await host.invokeProfileService('__SERVICE_NAME__.list', {}), again)
    assert.deepEqual((await host.invoke(todos.name, { action: 'list' })).structured, again)
  } finally {
    await host?.dispose()
    await rm(storeDir, { recursive: true, force: true })
  }
  const withoutStore = await createPluginTestHost(main, { packageDir })
  try {
    assert.equal((await withoutStore.invoke(todos.name, { action: 'list' })).isError, true)
  } finally {
    await withoutStore.dispose()
  }
})

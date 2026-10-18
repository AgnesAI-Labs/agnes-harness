import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createClientPanelTestHost } from '@agnes/web-client/testkit'
import * as module from '../client/index.js'

test('profile page loads, adds, toggles and displays failures through the real client facade', async () => {
  const { client } = JSON.parse(
    await readFile(new URL('../client/agnes.client.json', import.meta.url), 'utf8'),
  )
  for (const locale of ['en', 'zh-CN']) {
    let items = [{ id: 'first', text: 'Existing item', done: false }]
    let finish
    let failure = false
    let uncertain = false
    const effects = []
    const reads = []
    const identity = {
      packageId: '__PACKAGE_NAME__',
      rowId: 'ext:__PACKAGE_NAME__/main',
      revision: 'one',
      services: client.services,
      homeEntries: client.homeEntries,
      publicConfig: client.publicConfig,
      binding: {
        owner: 'ext:__PACKAGE_NAME__/main',
        packageId: '__PACKAGE_NAME__',
        lifetime: 'profile',
        availability: 'active',
        integrity: 'one',
        profileId: 'test',
        activationId: 'current',
      },
    }
    const host = await createClientPanelTestHost(
      module,
      identity,
      async (_module, name, input, options) => {
        if (name === '__SERVICE_NAME__.list') {
          if (!finish)
            return new Promise((resolve) => {
              finish = () => resolve({ output: { items } })
            })
          if (failure) throw new Error('List unavailable')
          return { output: { items } }
        }
        assert.equal(name, '__SERVICE_NAME__.change')
        assert.ok(options.operationId)
        if (options.read) {
          reads.push(options.operationId)
          return { state: 'completed', operationId: options.operationId }
        }
        effects.push({ input, operationId: options.operationId })
        if (failure) throw new Error('Write unavailable')
        if (input.action === 'add') items = [...items, { id: 'added', text: input.text, done: false }]
        else items = items.map((item) => (item.id === input.id ? { ...item, done: !item.done } : item))
        return { state: uncertain ? 'unknown' : 'completed', operationId: options.operationId }
      },
      locale,
    )
    try {
      await host.render('__SKILL_NAME__')
      assert.match(host.container.querySelector('[role=status]').textContent, /Loading|加载中/)
      await host.act(async () => finish())
      assert.match(host.container.textContent, /Existing item/)
      const input = host.container.querySelector('input:not([type=checkbox])')
      await host.act(async () => {
        input.value = 'New item'
        input.dispatchEvent(new host.window.Event('input', { bubbles: true }))
      })
      await host.act(async () => host.container.querySelector('button[type=submit]').click())
      assert.deepEqual(effects[0].input, { action: 'add', text: 'New item' })
      assert.match(host.container.textContent, /New item/)
      await host.act(async () => host.container.querySelector('input[type=checkbox]').click())
      assert.deepEqual(effects[1].input, { action: 'toggle', id: 'first' })
      assert.equal(host.container.querySelector('input[type=checkbox]').checked, true)
      assert.notEqual(effects[0].operationId, effects[1].operationId)
      uncertain = true
      await host.act(async () => host.container.querySelector('input[type=checkbox]').click())
      assert.match(host.container.querySelector('[role=alert]').textContent, /unknown/)
      assert.equal(input.disabled, true)
      const check = [...host.container.querySelectorAll('button')].find((button) =>
        /Check operation|查询操作/.test(button.textContent),
      )
      await host.act(async () => check.click())
      assert.deepEqual(reads, [effects[2].operationId])
      assert.equal(host.container.querySelector('input[type=checkbox]').checked, false)
      failure = true
      await host.act(async () => host.container.querySelector('input[type=checkbox]').click())
      assert.match(host.container.querySelector('[role=alert]').textContent, /Write unavailable/)
      const refresh = [...host.container.querySelectorAll('button')].find((button) =>
        /Refresh|刷新/.test(button.textContent),
      )
      await host.act(async () => refresh.click())
      assert.match(host.container.querySelector('[role=alert]').textContent, /List unavailable/)
    } finally {
      await host.dispose()
    }
  }
})

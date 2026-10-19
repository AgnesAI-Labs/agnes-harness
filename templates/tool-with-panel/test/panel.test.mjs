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
    let readState = 'completed'
    let readDelay = false
    let readFailure = false
    let finishRead
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
    const caller = async (_module, name, input, options) => {
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
        if (readFailure) throw new Error('Receipt unavailable')
        if (readDelay)
          await new Promise((resolve) => {
            finishRead = resolve
          })
        return { state: readState, operationId: options.operationId }
      }
      effects.push({ input, operationId: options.operationId })
      if (failure) throw new Error('Write unavailable')
      if (input.action === 'add') items = [...items, { id: 'added', text: input.text, done: false }]
      else items = items.map((item) => (item.id === input.id ? { ...item, done: !item.done } : item))
      return { state: uncertain || 'completed', operationId: options.operationId }
    }
    let host = await createClientPanelTestHost(module, identity, caller, locale)
    async function reopen(binding = identity.binding) {
      const storage = Array.from({ length: host.window.sessionStorage.length }, (_, i) => {
        const key = host.window.sessionStorage.key(i)
        return [key, host.window.sessionStorage.getItem(key)]
      })
      await host.dispose()
      host = await createClientPanelTestHost(module, { ...identity, binding }, caller, locale)
      for (const [key, value] of storage) host.window.sessionStorage.setItem(key, value)
      await host.render('__SKILL_NAME__')
    }
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
      for (const [state, final] of [
        ['unknown', 'completed'],
        ['running', 'refused'],
        ['approval-required', 'cancelled'],
      ]) {
        uncertain = readState = state
        await host.act(async () => host.container.querySelector('input[type=checkbox]').click())
        const operationId = effects.at(-1).operationId
        const count = effects.length
        assert.equal(host.container.querySelector('input').disabled, true)
        // A different profile or activation must not pick up this pending command.
        for (const binding of [
          { ...identity.binding, profileId: 'other' },
          { ...identity.binding, activationId: 'replacement' },
        ]) {
          const before = reads.length
          await reopen(binding)
          assert.equal(reads.length, before)
          assert.equal(host.container.querySelector('input').disabled, false)
        }
        await reopen()
        assert.equal(reads.at(-1), operationId)
        assert.equal(host.container.querySelector('input').disabled, true)
        await host.act(async () =>
          host.container
            .querySelector('form')
            .dispatchEvent(new host.window.Event('submit', { bubbles: true, cancelable: true })),
        )
        assert.equal(effects.length, count, 'Uncertain commands cannot acquire a new id')
        readState = final
        if (final === 'completed') {
          const check = [...host.container.querySelectorAll('button')].find((button) =>
            /Check operation|查询操作/.test(button.textContent),
          )
          await host.act(async () => check.click())
        } else {
          readDelay = true
          await reopen()
          assert.equal(host.container.querySelector('input').disabled, true)
          await host.act(async () => finishRead())
          readDelay = false
        }
        assert.equal(reads.at(-1), operationId)
        assert.equal(host.container.querySelector('input').disabled, false)
        assert.equal(host.window.sessionStorage.length, 0)
        assert.equal(effects.length, count)
      }
      failure = true
      await host.act(async () => host.container.querySelector('input[type=checkbox]').click())
      assert.match(host.container.querySelector('[role=alert]').textContent, /Write unavailable/)
      const refresh = [...host.container.querySelectorAll('button')].find((button) =>
        /Refresh|刷新/.test(button.textContent),
      )
      await host.act(async () => refresh.click())
      assert.match(host.container.querySelector('[role=alert]').textContent, /List unavailable/)
      // A lost response also retains the original operation across reopening.
      failure = false
      readState = 'unknown'
      readFailure = true
      await reopen()
      assert.match(host.container.querySelector('[role=alert]').textContent, /Receipt unavailable/)
      assert.equal(host.container.querySelector('input').disabled, true)
      readFailure = false
      await reopen()
      assert.equal(reads.at(-1), effects.at(-1).operationId)
      assert.equal(host.container.querySelector('input').disabled, true)
      readState = 'completed'
      await reopen()
      assert.equal(host.container.querySelector('input').disabled, false)
      const count = effects.length
      const storage = host.window.sessionStorage
      const setItem = storage.setItem
      Object.defineProperty(storage, 'setItem', {
        configurable: true,
        value: () => {
          throw new Error('Storage unavailable')
        },
      })
      await host.act(async () => host.container.querySelector('input[type=checkbox]').click())
      assert.match(host.container.querySelector('[role=alert]').textContent, /Storage unavailable/)
      assert.equal(effects.length, count, 'Storage must succeed before dispatch')
      Object.defineProperty(storage, 'setItem', { value: setItem })
    } finally {
      await host.dispose()
    }
  }
})

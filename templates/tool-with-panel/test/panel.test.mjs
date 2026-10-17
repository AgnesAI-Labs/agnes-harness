import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { apply } from '../client/index.js'

test('page matches its descriptor and renders localized public configuration', async () => {
  const { client } = JSON.parse(
    await readFile(new URL('../client/agnes.client.json', import.meta.url), 'utf8'),
  )
  let page
  const locale = { locale: 'en' }
  apply(
    {
      locale,
      homeEntries: {
        register(entry) {
          page = entry
        },
      },
    },
    { publicConfig: { label: 'My tool' } },
  )
  assert.equal(page.id, client.homeEntries[0].id)
  assert.equal(client.lifetime, 'profile')
  assert.deepEqual(client.slots, [])
  assert.match(page.component(), /My tool: ask/)
  locale.locale = 'zh-CN'
  assert.match(page.component(), /请智能体调用/)
})

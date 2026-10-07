import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { apply } from '../client/index.js'

test('panel matches its descriptor and renders public configuration', async () => {
  const descriptor = JSON.parse(
    await readFile(new URL('../client/agnes.client.json', import.meta.url), 'utf8'),
  )
  let rendered
  apply(
    {
      slots: {
        register(slot, render) {
          assert.ok(descriptor.client.slots.includes(slot))
          rendered = render()
        },
      },
    },
    { publicConfig: { label: 'My tool' } },
  )
  assert.match(rendered, /My tool/)
})

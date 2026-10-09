import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPluginTestHost } from '@agnes/host/author-testkit'
import { main, mcpServer } from '../dist/index.js'

test('bundles matching config and registers the packaged skill', async () => {
  const config = JSON.parse(await readFile(new URL('../mcp.json', import.meta.url), 'utf8'))
  assert.deepEqual(mcpServer, config)
  let skill
  const host = await createPluginTestHost(main, {
    services: {
      skills: {
        register(value) {
          skill = value
          return () => {}
        },
      },
    },
  })
  try {
    assert.equal(skill.name, '__SKILL_NAME__')
    assert.match(skill.body, /Inspect the MCP tool catalog/)
  } finally {
    await host.dispose()
  }
})

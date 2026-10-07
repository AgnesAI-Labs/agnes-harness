import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@agnes/cordis'
import { createSkillCandidateRegistry, createSkillCordisService } from '@agnes/resource-control-runtime'
import { main, mcpServer } from '../dist/index.js'
import { callTool, readResource, resourceCatalog, toolCatalog } from '../mcp/fixture.mjs'

test('bundled tools and resources return evidence and reject invalid calls', () => {
  assert.equal(toolCatalog[0].name, 'answer')
  assert.equal(resourceCatalog[0].uri, 'evidence://reference')
  const result = callTool('answer', { question: 'What is the answer?' })
  assert.equal(result.structuredContent.answer, 42)
  assert.match(readResource(result.structuredContent.evidence).contents[0].text, /answer is 42/)
  assert.throws(() => callTool('answer', { question: '' }), /nonempty question/)
  assert.throws(() => readResource('evidence://missing'), /Unknown resource/)
})

test('enabled skill references its packaged MCP asset and unload removes it', async () => {
  assert.equal(mcpServer.transport.kind, 'stdio')
  const registry = createSkillCandidateRegistry({ barrier: { quiesce: async (_id, publish) => publish({}) } })
  const root = new Context()
  root.provide('skills', createSkillCordisService(registry))
  const fiber = root.plugin(main)
  try {
    await fiber.await()
    const skill = registry
      .snapshot()
      .list()
      .find((value) => value.name === 'mcp-skills')
    assert.ok(skill)
    const result = registry.read(skill.resourceId, { sessionKey: 'community-test' })
    assert.equal(result.ok, true)
    assert.match(result.content, /\]\(evidence:\/\/reference\)/)
  } finally {
    await fiber.dispose()
    await root.fiber.dispose()
  }
  assert.equal(registry.snapshot().list().length, 0)
})

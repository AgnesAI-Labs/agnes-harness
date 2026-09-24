import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AI_ERROR_CODES, SLOT_NAMES } from '../src/index.js'
import {
  validateContractManifest,
  validateContractStamp,
  validateModelRecord,
  validateRouteTable,
} from '../src/model.js'
import { type Fixture, runFixtureLine } from '../tools/conformance-core.js'

const H = 'a'.repeat(64)
// Every literal below is written against the shipped schema. toolCallFormats is
// anyOf[const 'native', $ref DecodeRule], and 'xml-v1' is not a DecodeRule; thinkingReplay is
// native | drop | text.
const rec = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://gw.internal/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
  contextWindow: 128000,
  maxTokens: 8192,
  toolCallFormats: ['native', 'think_tag'],
  thinkingReplay: 'drop',
  contract_id: 'agnes-model-contract@v1',
}
const manifest = {
  version: '1',
  model_family: 'deepseek-v4',
  parser_version: '1',
  released_at: '2026-09-09T00:00:00Z',
  sha256: { prefix: H, tools: H, syntax: H },
}

describe('model.json', () => {
  // The two closed sets already exist on the export surface. Asserted here so this file cannot
  // quietly introduce a second copy of either under a different name.
  it('reuses the closed sets already exported, under their shipped names', () => {
    expect(AI_ERROR_CODES).toHaveLength(11)
    expect(SLOT_NAMES).toEqual(['primary', 'escalation', 'fast', 'compaction', 'verifier', 'image', 'video'])
  })
  it('validates ModelRecord and RouteTable as shipped', () => {
    const r = validateModelRecord(rec)
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
    expect(validateModelRecord({ ...rec, thinkingReplay: 'summarize' }).ok).toBe(false)
    expect(validateModelRecord({ ...rec, toolCallFormats: ['xml-v1'] }).ok).toBe(false)
    expect(validateRouteTable({ primary: { route: 'default', model: rec.id } }).ok).toBe(true)
    // primary is the one required slot: a table without it routes nothing.
    expect(validateRouteTable({ fast: { route: 'default', model: rec.id } }).ok).toBe(false)
  })
  it('ContractStamp requires sent_hash and transforms, and its hashes are Sha256', () => {
    const stamp = {
      prompt_prefix_hash: null,
      tool_schema_hash: H,
      parser_version: '1',
      contract_id: null,
      model: { route: 'r', id: 'm' },
      derived_hash: H,
      sent_hash: H,
      transforms: [],
    }
    const r = validateContractStamp(stamp)
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
    const { sent_hash: _s, ...noSent } = stamp
    expect(validateContractStamp(noSent).ok).toBe(false)
    expect(validateContractStamp({ ...stamp, derived_hash: 'd' }).ok).toBe(false)
  })
  it('ContractStamp keys are a subset of RequestHeader keys', () => {
    const sess = JSON.parse(readFileSync(new URL('../schema/session-v1.json', import.meta.url), 'utf8')) as {
      $defs: { RequestHeader: { properties: Record<string, unknown> } }
    }
    const m = JSON.parse(readFileSync(new URL('../schema/model.json', import.meta.url), 'utf8')) as {
      $defs: { ContractStamp: { properties: Record<string, unknown> } }
    }
    const header = new Set(Object.keys(sess.$defs.RequestHeader.properties))
    for (const k of Object.keys(m.$defs.ContractStamp.properties)) expect(header.has(k), k).toBe(true)
  })
  it('validates the new ContractManifest', () => {
    const r = validateContractManifest(manifest)
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
    expect(validateContractManifest({ ...manifest, sha256: { ...manifest.sha256, tools: 'short' } }).ok).toBe(
      false,
    )
    const { released_at: _r, ...noDate } = manifest
    expect(validateContractManifest(noDate).ok).toBe(false)
    // released_at declares format:date-time, and the generator registers a real checker for it, so
    // a date-shaped-but-invalid string has to be refused rather than passed through as any string.
    expect(validateContractManifest({ ...manifest, released_at: 'yesterday' }).ok).toBe(false)
  })
  // ContractManifest and I9's Billing alias / ThinkingLevel extend the shipped definition set
  // without silently dropping any of the long-lived model contracts.
  it('retains shipped $defs while adding the versioned extensions', () => {
    const m = JSON.parse(readFileSync(new URL('../schema/model.json', import.meta.url), 'utf8')) as {
      $defs: Record<string, unknown>
    }
    const names = Object.keys(m.$defs)
    expect(names).toHaveLength(24)
    for (const shipped of [
      'JsonValue',
      'ContentBlock',
      'ToolCall',
      'Billing',
      'SlotName',
      'ThinkingLevel',
      'AiErrorCode',
      'DecodeRule',
      'Sha256',
      'ToolSchema',
      'RequestMessage',
      'RequestBody',
      'ModelCost',
      'ModelRecord',
      'ContractStamp',
      'TokenCounts',
      'Timing',
      'CountResult',
      'InferenceEvent',
      'RouteDecl',
      'RouteTarget',
      'RouteTable',
      'ProbeReport',
    ])
      expect(names, shipped).toContain(shipped)
    expect(names).toContain('ContractManifest')
  })
  it('the checked-in model fixtures agree with the validators', () => {
    const lines = readFileSync(new URL('../fixtures/model/model.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(8) // four definitions x (one positive + one negative)
    for (const line of lines) {
      const f = JSON.parse(line) as Fixture
      expect(runFixtureLine(f).pass, f.id).toBe(true)
    }
  })
})

import { subagentInterruptTool, subagentSendMessageTool } from '@agnes/base'
import type { ExtensionManifest, ToolContext } from '@agnes/extension-api'
import { assertCapabilityCeiling, manifestCapabilities } from '@agnes/package-manager'
import { describe, expect, it, vi } from 'vitest'
import { capabilityToolContext } from '../../src/ext-host/tool-context-capabilities.js'

const manifest = (enabled = false): ExtensionManifest => ({
  id: 'test/web',
  version: '1.0.0',
  apiRange: '^1.1',
  entry: './index.js',
  capabilities: { network: { hosts: ['example.com'] }, ...(enabled ? { 'network.publicRead': true } : {}) },
})
const raw = () =>
  ({ net: { fetch: vi.fn(), fetchPublic: vi.fn(async () => ({ url: 'ok' })) } }) as unknown as ToolContext

describe('independent public retrieval grant', () => {
  it('exposes human questions only when explicitly declared and keeps the original bound closure', async () => {
    const questions = { ask: vi.fn(async () => ({ answers: [] })) }
    const context = { ...raw(), questions }
    expect(capabilityToolContext(manifest(), context).questions).toBeUndefined()
    const declared = { ...manifest(), capabilities: { ...manifest().capabilities, questions: true } }
    const projected = capabilityToolContext(declared, context)
    expect(projected.questions).toBe(questions)
    await projected.questions?.ask({ questions: [{ id: 'q', question: 'Continue?' }] })
    expect(questions.ask).toHaveBeenCalledOnce()
    expect(capabilityToolContext(declared, raw()).questions).toBeUndefined()
  })
  it('does not infer public access from a normal network grant', () => {
    const ctx = raw(),
      projected = capabilityToolContext(manifest(), ctx)
    expect(() => projected.net.fetchPublic?.('https://example.com')).toThrow('E_CAPABILITY_UNDECLARED')
    expect(ctx.net.fetchPublic).not.toHaveBeenCalled()
    expect(manifestCapabilities(manifest(true))).toContain('network.publicRead')
    expect(() => assertCapabilityCeiling(manifest(true), ['network'])).toThrow(
      'extension exceeds capability ceiling',
    )
  })
  it('passes public retrieval without widening ordinary fetch', async () => {
    const ctx = raw(),
      projected = capabilityToolContext(manifest(true), ctx)
    await projected.net.fetchPublic?.('https://other.example')
    expect(ctx.net.fetchPublic).toHaveBeenCalledWith('https://other.example')
    expect(() => projected.net.fetch('https://other.example')).toThrow('E_CAPABILITY_UNDECLARED')
  })
  it('fails closed when an older host lacks the method', () => {
    const projected = capabilityToolContext(manifest(true), {
      net: { fetch: vi.fn() },
    } as unknown as ToolContext)
    expect(() => projected.net.fetchPublic?.('https://example.com')).toThrow('unavailable')
  })
})

it('projects child continuation only with an explicit subagent grant and calls the real builtin through that projection', async () => {
  const sendMessage = vi.fn(async (childKey: string) => ({ childKey, messageId: 'receipt', acceptedSeq: 12 }))
  const interrupt = vi.fn(async () => ({ accepted: true as const }))
  const context = { ...raw(), subagent: { sendMessage, interrupt } } as unknown as ToolContext
  const denied = capabilityToolContext(manifest(), context)
  expect(denied.subagent.sendMessage).toBeUndefined()
  expect(denied.subagent.interrupt).toBeUndefined()
  const declared = { ...manifest(), capabilities: { ...manifest().capabilities, subagent: true } }
  const allowed = capabilityToolContext(declared, context)
  expect(
    await subagentSendMessageTool.execute({ childKey: 'child', message: 'new message' }, allowed),
  ).toMatchObject({ details: { messageId: 'receipt', acceptedSeq: 12 } })
  expect(await subagentInterruptTool.execute({ childKey: 'child' }, allowed)).toMatchObject({
    details: { accepted: true },
  })
  expect(sendMessage).toHaveBeenCalledWith('child', 'new message')
  expect(interrupt).toHaveBeenCalledWith('child')
  expect(capabilityToolContext(declared, raw()).subagent.sendMessage).toBeUndefined()
  expect(capabilityToolContext(declared, raw()).subagent.interrupt).toBeUndefined()
})

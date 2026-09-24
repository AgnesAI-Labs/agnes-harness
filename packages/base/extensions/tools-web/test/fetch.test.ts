import { readFileSync } from 'node:fs'
import { checkManifest, type PublicFetchResult } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { webFetchTool } from '../src/fetch.js'
import { renderHtml } from '../src/render.js'

const result = (content: string, kind: 'html' | 'text' = 'html'): PublicFetchResult => ({
  url: 'https://example.com/final',
  statusCode: 200,
  contentType: 'text/html',
  body: { kind, content },
  truncation: { bytes: false, decoded: false },
})

describe('web_fetch tool', () => {
  it('registers a valid manifest and stable model schema', () => {
    expect(
      checkManifest(JSON.parse(readFileSync(new URL('../agnes.extension.json', import.meta.url), 'utf8'))).ok,
    ).toBe(true)
    const schema = JSON.parse(
      readFileSync(new URL('../../../fixtures/tool-schemas/web_fetch.json', import.meta.url), 'utf8'),
    )
    expect(webFetchTool.parameters).toMatchObject(schema)
    expect(webFetchTool.meta).toMatchObject({ isOpenWorld: true, replay: 'never' })
  })
  it('renders HTML without active content, remote images or dangerous links', () => {
    const text = renderHtml(
      '<h1>Title</h1><script>secret()</script><p hidden>hidden</p><p>中文 <a href="/next">next</a><a href="javascript:evil()">bad</a><img src="https://tracker" alt="picture"></p><table><tr><th colspan="99999999">A</th></tr><tr><td>B</td></tr></table>',
      'https://example.com/path',
    )
    expect(text).toContain('# Title')
    expect(text).toContain('中文')
    expect(text).toContain('https://example.com/next')
    expect(text).toContain('| A |')
    expect(text).not.toMatch(/secret|hidden|javascript|tracker|<table|!\[/u)
    expect(text.length).toBeLessThan(500)
  })
  it('rejects pathological nesting rather than returning raw markup', () => {
    expect(() => renderHtml(`${'<div>'.repeat(600)}x`, 'https://example.com')).toThrow(
      'WEB_CONVERSION_FAILED',
    )
    expect(() => renderHtml('<div/>'.repeat(600), 'https://example.com')).toThrow('WEB_CONVERSION_FAILED')
  })
  it('returns 404 as an explicitly labeled response', async () => {
    const ctx = fakeToolContext()
    ctx.net.fetchPublic = vi.fn(async () => ({ ...result('missing', 'text'), statusCode: 404 }))
    const output = await webFetchTool.execute({ url: 'https://example.com' }, ctx)
    expect(JSON.stringify(output.content)).toContain('non-success response')
    expect(output.details).toMatchObject({ statusCode: 404, truncated: false })
    expect(output.isError).toBeUndefined()
    expect(output.structured).toBeUndefined()
  })
  it.each([false, true])('bounds source and model output even if artifacts fail: %s', async (fail) => {
    const ctx = fakeToolContext(fail ? { artifactsFail: 'offline' } : {})
    ctx.net.fetchPublic = async () => ({
      ...result('正文'.repeat(10_000), 'text'),
      truncation: { bytes: true, decoded: false },
    })
    const output = await webFetchTool.execute({ url: 'https://example.com' }, ctx)
    expect(output.details).toMatchObject({ truncated: true, truncation: { bytes: true, output: true } })
    const text = output.content
      .filter((v) => v.type === 'text')
      .map((v) => v.text)
      .join('')
    expect(new TextEncoder().encode(text).length).toBeLessThan(8192)
    expect(text).toContain('stored text is also partial')
    expect(output.structured).toBeUndefined()
  })
  it('does not fall back to ambient fetch when the host is old', async () => {
    const output = await webFetchTool.execute({ url: 'https://example.com' }, fakeToolContext())
    expect(output.isError).toBe(true)
    expect(JSON.stringify(output.content)).toContain('WEB_FETCH_UNAVAILABLE')
  })
  it('preserves capability denial and caller cancellation', async () => {
    const ctx = fakeToolContext()
    ctx.net.fetchPublic = async () => {
      throw Object.assign(new Error('denied'), { code: 'E_CAPABILITY_UNDECLARED' })
    }
    await expect(webFetchTool.execute({ url: 'https://example.com' }, ctx)).rejects.toThrow('denied')
    const ac = new AbortController()
    ac.abort(new Error('stop'))
    await expect(
      webFetchTool.execute({ url: 'https://example.com' }, { ...ctx, signal: ac.signal }),
    ).rejects.toThrow('stop')
    expect(ctx.calls.artifacts).toHaveLength(0)
  })
})

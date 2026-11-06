import { describe, expect, it } from 'vitest'
import { renderOAuthResultPage } from '../src/oauth-result-page.js'

describe('OAuth result page', () => {
  it('renderOAuthResultPage escapes detail', () => {
    const page = renderOAuthResultPage('failed', `<script>alert("x")</script> & 'y'`)
    expect(page.body).not.toContain('<script>')
    expect(page.body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;')
  })

  it('sends security headers and no cache', () => {
    const page = renderOAuthResultPage('signed-in')
    expect(page.status).toBe(200)
    expect(page.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    expect(page.body).toContain('You can close this page')
    expect(page.body).toContain('可以关掉这个页面')
  })

  it.each([
    ['cancelled', 400],
    ['discovery-failed', 502],
    ['client-id-required', 400],
    ['state-expired', 400],
    ['failed', 400],
  ] as const)('%s is a failure page with status %i', (kind, status) => {
    const page = renderOAuthResultPage(kind)
    expect(page.status).toBe(status)
    expect(page.body).not.toContain('You can close this page')
    expect(page.body).toMatch(/<!doctype html>/i)
  })
})

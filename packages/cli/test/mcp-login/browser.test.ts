import { describe, expect, it } from 'vitest'
import { openMcpLoginBrowser } from '../../src/mcp-login/browser.js'

describe('opening the browser for a sign-in', () => {
  it('opens an https address without shell interpolation', () => {
    const runs: [string, readonly string[]][] = []
    openMcpLoginBrowser('https://auth.example.com/authorize?a=1&b=$(x)', (command, args) => {
      runs.push([command, args])
    })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.[1]).toContain('https://auth.example.com/authorize?a=1&b=$(x)')
  })

  it('opens nothing for any other address, and never throws', () => {
    const runs: unknown[] = []
    for (const url of [
      'http://auth.example.com/',
      'file:///etc/passwd',
      'https://u:p@auth.example.com/',
      'not a url',
    ])
      openMcpLoginBrowser(url, () => runs.push(url))
    expect(runs).toEqual([])
    expect(() =>
      openMcpLoginBrowser('https://auth.example.com/', () => {
        throw new Error('no browser')
      }),
    ).not.toThrow()
  })
})

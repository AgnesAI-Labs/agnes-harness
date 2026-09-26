import { describe, expect, it } from 'vitest'
import { pageText } from '../../extensions/skills/src/page.js'

describe('UTF-8 skill text pages', () => {
  it('reserves the exact footer bytes and advances at a character boundary', () => {
    const body = `${'界'.repeat(12_000)}\n${'😀'.repeat(3_000)}`
    const footer = (end: number, total: number) => `\n[next ${end}/${total} "界"]`
    const source = new TextEncoder().encode(body)
    const collected: Uint8Array[] = []
    let offset = 0
    while (true) {
      const page = pageText(body, offset, 32768, footer)
      expect(page).toBeDefined()
      if (!page) break
      expect(new TextEncoder().encode(page.text).byteLength).toBeLessThanOrEqual(32768)
      const end = page.nextOffset ?? source.byteLength
      const chunk =
        page.nextOffset === undefined ? page.text : page.text.slice(0, -footer(end, source.byteLength).length)
      collected.push(new TextEncoder().encode(chunk))
      if (end === source.byteLength) break
      expect(end).toBeGreaterThan(offset)
      offset = end
    }
    expect(Buffer.concat(collected)).toEqual(Buffer.from(source))
  })

  it('still advances one code point when the repeated header leaves no room', () => {
    const footer = (end: number, total: number) => `\n[next ${end}/${total}]`
    expect(pageText('😀a', 0, -10, footer)).toMatchObject({ nextOffset: 4 })
    expect(pageText('😀a', 4, -10, footer)).toMatchObject({ text: 'a', totalBytes: 5 })
    expect(pageText('😀a', 1, 32768, footer)).toBeUndefined()
    expect(pageText('😀a', 5, 32768, footer)).toBeUndefined()
  })
})

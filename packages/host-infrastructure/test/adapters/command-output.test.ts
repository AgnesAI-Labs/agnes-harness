import { describe, expect, it } from 'vitest'
import { commandOutputDecoder } from '../../src/adapters/command-output.js'
import { createExecOutput } from '../../src/adapters/exec-output.js'

describe('command output encoding', () => {
  it.each([undefined, 936, 437])('preserves UTF-8 at every chunk boundary with code page %s', (codePage) => {
    const text = '\uFEFF中文🙂\uFEFF prompt'
    const bytes = Buffer.from(text)
    for (let i = 0; i <= bytes.length; i++) {
      const decoder = commandOutputDecoder(codePage)
      expect(decoder.write(bytes.subarray(0, i)) + decoder.write(bytes.subarray(i)) + decoder.end()).toBe(
        text,
      )
    }
    expect(commandOutputDecoder(codePage).write(Buffer.from('ready> '))).toBe('ready> ')
  })
  it('uses the measured code page for legacy output and resets to UTF-8 for the next line', () => {
    const legacy = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 10])
    for (let i = 0; i <= legacy.length; i++) {
      const decoder = commandOutputDecoder(936)
      expect(
        decoder.write(legacy.subarray(0, i)) +
          decoder.write(legacy.subarray(i)) +
          decoder.write(Buffer.from('中文🙂\n')) +
          decoder.end(),
      ).toBe('中文\n中文🙂\n')
    }
    const out = createExecOutput(100, 936)
    out.stderr(legacy)
    out.stderr(Buffer.from('中文🙂\n'))
    expect(out.result()).toEqual({ stdout: '', stderr: '中文\n中文🙂\n', truncated: false })
  })
  it('caps captured bytes independently per stream and safely falls back for unsupported code pages', () => {
    const output = createExecOutput(4, 437)
    output.stdout(Buffer.from('abcdef'))
    output.stderr(Buffer.from([0xff]))
    expect(output.result()).toEqual({ stdout: 'abcd', stderr: '�', truncated: true })
  })
})

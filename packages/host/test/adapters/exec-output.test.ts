import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { codePageDecoder, createExecOutput, createOutputDecoder } from '../../src/adapters/exec-output.js'
import { ownedProcess } from '../../src/adapters/exec-owned.js'

// "模式 program 中文" as a Chinese-locale Windows program writes it to a pipe (code page 936). The
// first four bytes happen to be valid UTF-8 ("ģʽ") and the rest is not: decoded as UTF-8, the model
// was shown "ģʽ program" and four replacement characters.
const gbk = Buffer.from([
  0xc4, 0xa3, 0xca, 0xbd, 0x20, 0x70, 0x72, 0x6f, 0x67, 0x72, 0x61, 0x6d, 0x20, 0xd6, 0xd0, 0xce, 0xc4,
])
const decodeAll = (bytes: Buffer, codePage?: number) => {
  const decoder = createOutputDecoder(codePage)
  return decoder.write(bytes) + decoder.end()
}

describe('command output decoding', () => {
  it('decodes UTF-8 as UTF-8 whatever the code page', () => {
    const text = '中文 🙂 café\r\nsecond line\n'
    expect(decodeAll(Buffer.from(text), 936)).toBe(text)
    expect(decodeAll(Buffer.from(text), 1252)).toBe(text)
    expect(decodeAll(Buffer.from(text))).toBe(text)
  })

  it("decodes a line that is not UTF-8 in the console's code page", () => {
    expect(decodeAll(Buffer.concat([gbk, Buffer.from('\r\n')]), 936)).toBe('模式 program 中文\r\n')
  })

  it('decides line by line, so UTF-8 and code page output can share a stream', () => {
    const mixed = Buffer.concat([Buffer.from('PowerShell 中文\n'), gbk, Buffer.from('\nPython 结束\n')])
    expect(decodeAll(mixed, 936)).toBe('PowerShell 中文\n模式 program 中文\nPython 结束\n')
  })

  it('keeps the replacement characters it always produced when no usable code page is known', () => {
    const plain = Buffer.concat([gbk, Buffer.from('\n')]).toString('utf8')
    for (const codePage of [undefined, 65001, 437, 850, 0, 70000])
      expect(decodeAll(Buffer.concat([gbk, Buffer.from('\n')]), codePage)).toBe(plain)
  })

  it('decodes the code pages a Windows console starts in', () => {
    const cases: Array<[number, number[], string]> = [
      [932, [0x93, 0xfa, 0x96, 0x7b], '日本'],
      [949, [0xc7, 0xd1, 0xb1, 0xdb], '한글'],
      [950, [0xa4, 0xa4, 0xa4, 0xe5], '中文'],
      [1251, [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2], 'Привет'],
      [1252, [0x47, 0x72, 0xf6, 0xdf, 0x65], 'Größe'],
      [866, [0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2], 'Привет'],
    ]
    for (const [codePage, bytes, text] of cases) expect(decodeAll(Buffer.from(bytes), codePage)).toBe(text)
    expect(codePageDecoder(936)?.encoding).toBe('gbk')
    expect(codePageDecoder(65001)).toBeUndefined()
  })

  it('does not take a UTF-8 character cut off at the end for code page text', () => {
    const cut = Buffer.from('数据')
    expect(decodeAll(cut.subarray(0, 4), 936)).toBe('数\ufffd')
  })

  it('assembles characters and lines split across chunks', () => {
    const decoder = createOutputDecoder(936)
    const bytes = Buffer.concat([Buffer.from('起点\n'), gbk, Buffer.from('\n终点\n')])
    let text = ''
    for (const byte of bytes) text += decoder.write(Buffer.from([byte]))
    expect(text + decoder.end()).toBe('起点\n模式 program 中文\n终点\n')
  })

  it('passes an unfinished line on at once when it is plain ASCII, and holds one that is not', () => {
    const decoder = createOutputDecoder(936)
    expect(decoder.write(Buffer.from('Password: '))).toBe('Password: ')
    expect(decoder.write(gbk.subarray(0, 6))).toBe('')
    expect(decoder.write(gbk.subarray(6))).toBe('')
    expect(decoder.write(Buffer.from('\n'))).toBe('模式 program 中文\n')
    expect(decoder.write(gbk)).toBe('')
    expect(decoder.end()).toBe('模式 program 中文')
  })

  it('passes on a long unfinished line instead of holding it without bound', () => {
    const decoder = createOutputDecoder(936)
    const long = Buffer.from(`${'中'.repeat(30_000)}`)
    const text = decoder.write(long.subarray(0, long.length - 1))
    expect(text).toBe('中'.repeat(29_999))
    expect(decoder.write(long.subarray(long.length - 1)) + decoder.end()).toBe('中')
  })

  it('applies the per-stream byte caps before decoding', () => {
    const output = createExecOutput(8, 936)
    output.stdout(Buffer.concat([gbk.subarray(13), Buffer.from('\nmore output')]))
    output.stderr(Buffer.from('中文中文'))
    expect(output.result()).toEqual({ stdout: '中文\nmor', stderr: '中文\ufffd', truncated: true })
  })
})

describe('background job output', () => {
  it("decodes each stream in the console's code page when it is not UTF-8", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const process = ownedProcess({
      pid: 1,
      stdout,
      stderr,
      done: new Promise(() => {}),
      stop: async () => {},
      codePage: 936,
    })
    let text = ''
    process.onOutput((chunk) => {
      text += chunk
    })
    stdout.write(gbk.subarray(0, 14))
    stderr.write(Buffer.from('UTF-8 错误\n'))
    stdout.end(Buffer.concat([gbk.subarray(14), Buffer.from('\n')]))
    await new Promise((resolve) => setImmediate(resolve))
    expect(text).toBe('UTF-8 错误\n模式 program 中文\n')
  })
})

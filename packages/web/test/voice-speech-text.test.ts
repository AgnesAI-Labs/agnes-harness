import { VOICE_SPEAK_MAX_CHARS } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { speechSegments, speechText } from '../src/voice/speech-text.js'

describe('speechText', () => {
  it('skips code blocks, tables and link URLs', () => {
    expect(
      speechText('看[文档](https://x.y)。\n```js\nx()\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n完成'),
    ).toBe('看文档。 完成')
  })

  it('skips tilde fences and an unclosed fence, and keeps text after a closed one', () => {
    expect(speechText('前\n~~~\ncode\n~~~\n后')).toBe('前 后')
    expect(speechText('前\n```\ncode that never closes')).toBe('前')
    expect(speechText('````\n```\ninner\n```\n````\n后')).toBe('后')
  })

  it('skips tables without leading pipes and alignment rows', () => {
    expect(speechText('前\na | b\n:---: | ---:\n1 | 2\n后')).toBe('前 后')
  })

  it('removes images and bare URLs, keeps link text', () => {
    expect(
      speechText('![图](a.png)看 https://a.b/c?d=1。再 www.x.org/y, <https://z.io> 完 [t](u "title")'),
    ).toBe('看 。再 , 完 t')
    expect(speechText('[ref][1] and [a](http://x.y/(b))')).toBe('ref and a')
  })

  it('strips markdown marks but keeps their text', () => {
    expect(speechText('# 标题\n> 引用\n- 项一\n* 项二\n1. 项三\n2) 项四\n- [x] 完成')).toBe(
      '标题 引用 项一 项二 项三 项四 完成',
    )
    expect(speechText('**粗** and *斜* and __粗__ and _斜_ and ~~删~~ and `code`')).toBe(
      '粗 and 斜 and 粗 and 斜 and 删 and code',
    )
    expect(speechText('<b>bold</b> <!-- note -->text<br/>')).toBe('bold text')
  })

  it('leaves snake_case, products and comparisons alone', () => {
    expect(speechText('use snake_case_name and 3*4*5 or a < b and c > d')).toBe(
      'use snake_case_name and 3*4*5 or a < b and c > d',
    )
  })

  it('drops rules and link reference definitions', () => {
    expect(speechText('前\n---\n***\n[1]: https://x.y\n后')).toBe('前 后')
  })

  it('returns an empty string for markdown with nothing to read', () => {
    expect(speechText('```\ncode\n```')).toBe('')
    expect(speechText('  \n\n ')).toBe('')
  })
})

describe('speechSegments', () => {
  it('splits at sentence punctuation into segments of at most 120 code units', () => {
    const sentence = '这是一个比较长的句子，用来测试分段，每一句大约有四十个字左右的长度，足够长了吧。'
    const text = sentence.repeat(8)
    const segs = speechSegments(text)
    expect(segs.length).toBeGreaterThan(1)
    expect(segs.every((s) => s.length <= VOICE_SPEAK_MAX_CHARS && s.length > 0)).toBe(true)
    expect(segs.join('')).toBe(text)
    expect(segs.every((s) => s.endsWith('。'))).toBe(true)
  })

  it('packs short sentences greedily', () => {
    expect(speechSegments('一。二。三。', 4)).toEqual(['一。二。', '三。'])
    expect(speechSegments('甲！乙？丙；丁…戊!己?庚;辛', 100)).toEqual(['甲！乙？丙；丁…戊!己?庚;辛'])
  })

  it('splits after a period followed by whitespace but not inside 3.14', () => {
    expect(speechSegments('Pi is 3.14 today. Next one here.', 20)).toEqual([
      'Pi is 3.14 today.',
      'Next one here.',
    ])
    expect(speechSegments('value is 3.14159265', 8)).toEqual(['value is', '3.14159', '265'])
    expect(speechSegments('3.14', 120)).toEqual(['3.14'])
  })

  it('keeps closing quotes and repeated terminators with their sentence', () => {
    expect(speechSegments('他说“好！”然后走了。', 6)).toEqual(['他说“好！”', '然后走了。'])
    expect(speechSegments('真的吗？！是的。', 5)).toEqual(['真的吗？！', '是的。'])
  })

  it('splits an over-long sentence at commas, then hard-cuts', () => {
    const part = '甲'.repeat(70)
    const segs = speechSegments(`${part}，${part}，${part}。`)
    expect(segs).toEqual([`${part}，`, `${part}，`, `${part}。`])
    const long = 'x'.repeat(250)
    const cut = speechSegments(long)
    expect(cut.map((s) => s.length)).toEqual([120, 120, 10])
    expect(cut.join('')).toBe(long)
  })

  it('never splits a surrogate pair: 61 emoji become two segments', () => {
    const emoji = '😀'.repeat(61)
    const segs = speechSegments(emoji)
    expect(segs).toEqual(['😀'.repeat(60), '😀'])
    expect(segs.every((s) => s.length <= VOICE_SPEAK_MAX_CHARS)).toBe(true)
    const odd = `a${'😀'.repeat(60)}`
    const cut = speechSegments(odd)
    expect(cut.every((s) => s.length <= VOICE_SPEAK_MAX_CHARS)).toBe(true)
    expect(cut.join('')).toBe(odd)
    for (const s of cut) {
      expect(s.charCodeAt(0) >= 0xdc00 && s.charCodeAt(0) <= 0xdfff).toBe(false)
      const last = s.charCodeAt(s.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
  })

  it('drops empty and whitespace-only segments and trims the rest', () => {
    expect(speechSegments('')).toEqual([])
    expect(speechSegments('   \n\t ')).toEqual([])
    expect(speechSegments('  一。   二。  ', 2)).toEqual(['一。', '二。'])
    expect(speechSegments('甲。\n\n乙。', 2)).toEqual(['甲。', '乙。'])
  })

  it('keeps the whole text when it fits', () => {
    expect(speechSegments('hello. world.')).toEqual(['hello. world.'])
  })
})

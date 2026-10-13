import { describe, expect, it } from 'vitest'
import {
  estimateImageTokens,
  imageBlockTokens,
  noUserImages,
  selectUserImages,
  USER_IMAGE_STEPS,
  type UserImageCandidate,
} from '../src/request/user-images.js'

const img = (seq: number, o: Partial<UserImageCandidate> = {}): UserImageCandidate => ({
  key: `${seq}/1`,
  seq,
  index: 1,
  fresh: false,
  bytes: 100_000,
  pixels: 500_000,
  ...o,
})
const budget = { count: 4, bytes: 16 * 1024 * 1024, pixels: 8_000_000, perMessage: Infinity }
const omittedFor = (n: number) =>
  selectUserImages(
    Array.from({ length: n }, (_, i) => img(i + 1)),
    budget,
  ).omitted

describe('stepped omission', () => {
  it('omits in whole steps from the oldest, so the omitted prefix holds until the next step', () => {
    expect(omittedFor(4)).toEqual([])
    expect(omittedFor(5)).toEqual(['1/1', '2/1'])
    expect(omittedFor(6)).toEqual(['1/1', '2/1'])
    expect(omittedFor(7)).toEqual(['1/1', '2/1', '3/1', '4/1'])
  })

  it('rounds byte and pixel excess up to their steps', () => {
    const big = (seq: number) => img(seq, { bytes: 5 * 1024 * 1024, pixels: 100 })
    const out = selectUserImages([big(1), big(2), big(3), big(4)], { ...budget, count: 10 })
    // 20 MiB against 16 MiB: excess 4 MiB rounds to one 4 MiB step -> the oldest 5 MiB image goes.
    expect(out.omitted).toEqual(['1/1'])
    expect(USER_IMAGE_STEPS).toEqual({ bytes: 4 * 1024 * 1024, pixels: 2_000_000 })
  })

  it('never omits a fresh image; refuses when only fresh images are left to drop', () => {
    const fresh = [img(1, { fresh: true }), img(2, { fresh: true })]
    expect(() => selectUserImages(fresh, { ...budget, count: 1 })).toThrow(/E_ENVELOPE/)
    expect(
      selectUserImages([img(1), ...fresh.map((f) => ({ ...f, seq: f.seq + 1, key: `${f.seq + 1}/1` }))], {
        ...budget,
        count: 2,
      }).omitted,
    ).toEqual(['1/1'])
  })

  it('rounds pixel excess up to whole 2,000,000-pixel steps', () => {
    const images = Array.from({ length: 9 }, (_, i) => img(i + 1, { pixels: 1_000_000 }))
    // 9,000,000 against 8,000,000: the 1,000,000 excess rounds to one step, so two images go, not one.
    expect(selectUserImages(images, { ...budget, count: 20 }).omitted).toEqual(['1/1', '2/1'])
  })

  it('refuses when the per-message limit would drop an image of this turn', () => {
    const msg = [1, 2, 3].map((i) => ({ ...img(9, { fresh: true }), key: `9/${i}`, index: i }))
    expect(() => selectUserImages(msg, { ...budget, perMessage: 2 })).toThrow(/E_ENVELOPE/)
  })

  it('applies the per-message limit to each message, oldest images first', () => {
    const msg = [1, 2, 3].map((i) => ({ ...img(9), key: `9/${i}`, index: i }))
    expect(selectUserImages(msg, { ...budget, perMessage: 2 }).omitted).toEqual(['9/1'])
  })

  it('omits everything for a text-only model budget and refuses a fresh image there', () => {
    expect(selectUserImages([img(1), img(2)], { ...budget, count: 0 }).omitted).toEqual(['1/1', '2/1'])
    expect(() => selectUserImages([img(1, { fresh: true })], { ...budget, count: 0 })).toThrow(/E_ENVELOPE/)
  })
})

describe('image token estimate', () => {
  const jpeg = (width: number, height: number) =>
    Buffer.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      ...Buffer.from('JFIF\0'),
      1,
      1,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      0xff,
      0xc0,
      0x00,
      0x11,
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
      0xff,
      0xd9,
    ]).toString('base64')

  it('uses the recorded size, else the size in the bytes header, else 1600', () => {
    expect(imageBlockTokens({ width: 1456, height: 1456 })).toBe(Math.ceil((1456 * 1456) / 750))
    expect(imageBlockTokens({ data: jpeg(1500, 600) })).toBe(1200)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
      'base64',
    )
    expect(imageBlockTokens({ data: png.toString('base64') })).toBe(1)
    expect(imageBlockTokens({ data: 'AAAA' })).toBe(1600)
    expect(imageBlockTokens({ dataOmitted: { bytes: 1 } } as never)).toBe(1600)
    expect(estimateImageTokens({})).toBe(1600)
  })
})

it('hands every caller its own empty selection', () => {
  const first = noUserImages()
  first.header.included.push('1/1')
  first.header.missing.push('1/1')
  expect(noUserImages()).toEqual({
    mode: 'none',
    canRead: false,
    blocks: new Map(),
    header: { included: [], omitted: 0, missing: [] },
    fresh: new Set(),
  })
})

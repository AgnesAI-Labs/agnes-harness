import { expect, it, vi } from 'vitest'
import { normalizeFakeObserveResult } from '../../src/computer-use/fake/observe.js'

function jpeg(width: number, height: number): string {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >>> 8,
    height & 0xff,
    width >>> 8,
    width & 0xff,
    1,
    1,
    0x11,
    0,
    0xff,
    0xda,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    1,
    2,
    3,
    0xff,
    0xd9,
  ]).toString('base64')
}

function capture(width: number, height: number) {
  return {
    mode: 'vision',
    width,
    height,
    target: { app: 'Fake Notes', pid: 41, window_id: 51, snapshot_id: 'snapshot' },
    elements: [],
  }
}

const sink = { put: vi.fn() }

it('rejects a fake screenshot whose longest edge exceeds 1456px before artifact storage', async () => {
  await expect(
    normalizeFakeObserveResult(
      'capture',
      {
        content: [{ type: 'image', data: jpeg(1457, 1), mimeType: 'image/jpeg' }],
        structuredContent: capture(1457, 1),
        isError: false,
      },
      sink,
    ),
  ).rejects.toThrow('1456px dimension limit')
  expect(sink.put).not.toHaveBeenCalled()
})

it('rejects an encoded screenshot above 4 MiB before artifact storage', async () => {
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')
  await expect(
    normalizeFakeObserveResult(
      'capture',
      {
        content: [{ type: 'image', data: oversized, mimeType: 'image/jpeg' }],
        structuredContent: capture(1, 1),
        isError: false,
      },
      sink,
    ),
  ).rejects.toThrow(/byte limit/i)
  expect(sink.put).not.toHaveBeenCalled()
})

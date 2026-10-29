import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLoopbackTransport } from '../../src/adapters/remote-transport.js'

const scratch = () => mkdtempSync(join(tmpdir(), 'agnes-loopback-'))

describe('loopback transport', () => {
  it('round-trips a file through upload and download', async () => {
    const root = scratch()
    const t = createLoopbackTransport({ root })
    await t.upload([{ path: join(root, 'a.txt'), content: new TextEncoder().encode('hello') }])
    const got = await t.download([join(root, 'a.txt')])
    expect(new TextDecoder().decode(got[0]?.content)).toBe('hello')
    await t.close()
  })

  it('round-trips bytes that are not valid utf-8', async () => {
    const root = scratch()
    const t = createLoopbackTransport({ root })
    const raw = new Uint8Array([0xff, 0x00, 0xfe, 0x80])
    await t.upload([{ path: join(root, 'b.bin'), content: raw }])
    const got = await t.download([join(root, 'b.bin')])
    expect(Array.from(got[0]?.content ?? [])).toEqual(Array.from(raw))
    await t.close()
  })

  it('runs a command and reports its exit code', async () => {
    const root = scratch()
    const t = createLoopbackTransport({ root })
    const r = await t.exec(['node', '-e', 'process.stdout.write("ok"); process.exit(3)'], { cwd: root })
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('ok')
    await t.close()
  })

  it('refuses every operation once closed, instead of falling back to anything local', async () => {
    const root = scratch()
    const t = createLoopbackTransport({ root })
    await t.close()
    expect(t.alive()).toBe(false)
    await expect(t.exec(['node', '-e', ''], { cwd: root })).rejects.toThrow()
    await expect(t.download([join(root, 'a.txt')])).rejects.toThrow()
  })
})

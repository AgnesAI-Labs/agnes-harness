import { describe, expect, it } from 'vitest'
import { fakeToolContext } from './tool-context.js'

// Every tool test in this package leans on this fake, so a fake that quietly does nothing would
// make those tests pass no matter what the tools do. These cases check that it records effects and
// refuses the calls it does not implement.
describe('fakeToolContext', () => {
  it('seeds files relative to cwd and reads them back', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': 'hello', '/abs/b.txt': 'world' } })
    expect(ctx.mem.files.has('/work/proj/a.txt')).toBe(true)
    expect(new TextDecoder().decode(await ctx.fs.read('a.txt'))).toBe('hello')
    expect(new TextDecoder().decode(await ctx.fs.read('/abs/b.txt'))).toBe('world')
  })

  it('honours read offset and limit in bytes', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': '0123456789' } })
    expect(new TextDecoder().decode(await ctx.fs.read('a.txt', { offset: 2, limit: 3 }))).toBe('234')
    expect(new TextDecoder().decode(await ctx.fs.read('a.txt', { limit: 4 }))).toBe('0123')
  })

  it('throws ENOENT for a missing file', async () => {
    const ctx = fakeToolContext()
    await expect(ctx.fs.read('nope')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(ctx.fs.stat('nope')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records exec calls with their options and returns the scripted result', async () => {
    const ctx = fakeToolContext({ exec: (cmd) => ({ code: 3, stdout: cmd.join(' '), stderr: 'e' }) })
    const r = await ctx.exec(['sh', '-c', 'x'], { cwd: '/tmp', timeoutMs: 5 })
    expect(r).toEqual({ code: 3, stdout: 'sh -c x', stderr: 'e', truncated: false })
    expect(ctx.calls.exec).toEqual([['sh', '-c', 'x']])
    expect(ctx.calls.execOpts).toEqual([{ cwd: '/tmp', timeoutMs: 5 }])
  })

  it('records artifacts with their sha256 and byte length', async () => {
    const ctx = fakeToolContext()
    const ref = await ctx.artifacts.put(new TextEncoder().encode('abc'), { mime: 'text/plain' })
    expect(ref).toEqual({
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      size: 3,
      mime: 'text/plain',
    })
    expect(ctx.calls.artifacts).toHaveLength(1)
  })

  it('can be told to fail artifact writes', async () => {
    const ctx = fakeToolContext({ artifactsFail: 'store offline' })
    await expect(ctx.artifacts.put(new Uint8Array([1]))).rejects.toThrow('store offline')
  })

  it('rejects the methods it does not implement, naming the method', async () => {
    const ctx = fakeToolContext()
    await expect(ctx.net.fetch('http://x')).rejects.toThrow('not supported in fakeToolContext: net.fetch')
    await expect(ctx.subagent.fork('q')).rejects.toThrow('not supported in fakeToolContext: subagent.fork')
    await expect(ctx.tools.invoke('read', {})).rejects.toThrow(
      'not supported in fakeToolContext: tools.invoke',
    )
  })
})

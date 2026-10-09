import { describe, expect, it } from 'vitest'
import { fencedFs, testFsPolicy } from '../../testkit/fenced-fs.js'
import type { FsOps } from '@agnes/core-effects/effects/tool-context'

const inner: FsOps = {
  read: async (path) => new TextEncoder().encode(path),
  write: async () => undefined,
  list: async () => [],
  stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
}

describe('test filesystem Windows paths on every test platform', () => {
  it.each([
    ['C:\\工作 空间\\repo', 'C:/工作 空间/repo'],
    ['\\\\server\\share\\repo', '//server/share/repo'],
    ['/workspace/repo/../repo', '/workspace/repo'],
  ])('preserves the root identity of %s', (input, expected) => {
    expect(testFsPolicy(input).workspaceRoot).toBe(expected)
  })

  it.each(['C:\\work\\repo', '\\\\server\\share\\repo'])('fences %s', async (root) => {
    const policy = testFsPolicy(root)
    const fs = fencedFs(inner, policy)
    const expected = `${policy.workspaceRoot}/src/file.txt`
    for (const path of ['src\\file.txt', `${root}\\src\\file.txt`]) {
      expect(new TextDecoder().decode(await fs.read(path))).toBe(expected)
    }
    expect(new TextDecoder().decode(await fs.read('src\\..\\.agnes\\secrets\\key'))).toBe(
      `${policy.workspaceRoot}/.agnes/secrets/key`,
    )
    for (const path of [
      '..\\outside',
      '.git\\config',
      'src\\..\\.agh\\secrets\\key',
      'D:\\other\\file',
      '\\\\server\\other\\file',
      'C:relative',
    ]) {
      await expect(fs.read(path)).rejects.toThrow('FS_DENIED')
    }
  })
})

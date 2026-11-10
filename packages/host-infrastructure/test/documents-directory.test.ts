import { expect, test } from 'vitest'

test('resolves a redirected Linux XDG directory without shell expansion', async () => {
  const { parseXdgDocumentsDirectory } = await import('../src/documents-directory.js')
  expect(parseXdgDocumentsDirectory('XDG_DOCUMENTS_DIR="$HOME/文稿"', '/tmp/fixture-home')).toBe(
    '/tmp/fixture-home/文稿',
  )
  expect(() =>
    parseXdgDocumentsDirectory('XDG_DOCUMENTS_DIR="$(touch /tmp/no)"', '/tmp/fixture-home'),
  ).toThrow()
  expect(() => parseXdgDocumentsDirectory('', '/tmp/fixture-home')).toThrow()
})

test.runIf(process.platform === 'darwin')('queries the native macOS system Documents directory', async () => {
  const { resolveDocumentsDirectory } = await import('../src/documents-directory.js')
  const { isAbsolute } = await import('node:path')
  const root = await resolveDocumentsDirectory(AbortSignal.timeout(6000))
  expect(isAbsolute(root)).toBe(true)
})

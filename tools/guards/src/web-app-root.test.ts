import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { isTestFile, listPackages, listSourceFiles, repoRoot } from './repo.js'

it('keeps every Web region under the one application root and ConfigProvider', () => {
  const root = repoRoot()
  const calls: string[] = []
  const imports: string[] = []
  const providers: string[] = []
  for (const pkg of listPackages(root).filter((pkg) => /web/.test(pkg.name))) {
    for (const file of listSourceFiles(join(pkg.dir, 'src')).filter((file) => !isTestFile(file))) {
      const code = readFileSync(file, 'utf8')
      const path = relative(root, file)
      for (const _match of code.matchAll(/\b(?:createRoot|createAntdRoot)\s*\(/g)) calls.push(path)
      if (/from\s*['"]react-dom\/client['"]/.test(code)) imports.push(path)
      for (const _match of code.matchAll(/<ConfigProvider\b/g)) providers.push(path)
    }
  }
  expect(calls).toEqual(['packages/web-ui/src/antd-root.tsx'])
  expect(imports).toEqual(['packages/web-ui/src/antd-root.tsx'])
  expect(providers).toEqual(['packages/web-ui/src/antd-root.tsx'])
})

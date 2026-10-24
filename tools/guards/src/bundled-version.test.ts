import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { repoRoot } from './repo.js'

const root = repoRoot()
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const shippedContent = (file: string) =>
  !/(^|\/)(test|tests|scripts|node_modules|dist|\.test-build)\//.test(file) &&
  !/(^|\/)(tsconfig[^/]*\.json|.*\.test\.[^/]+)$/.test(file)

function versionViolations(
  directory: string,
  previous: { name: string; version: string },
  current: { version: string },
  changed: readonly string[],
): string[] {
  const shipped = changed.filter(
    (file) => file.startsWith(`${directory}/`) && shippedContent(file.slice(directory.length + 1)),
  )
  return previous.version === current.version && shipped.length
    ? [
        `${previous.name}: shipped content changed at ${current.version}; bump the package version: ${shipped.join(', ')}`,
      ]
    : []
}

it('requires a version change when a previously bundled package changes shipped content', () => {
  // PR checks compare the whole branch. Push/local checks compare the last commit plus worktree.
  // A release gate can pin an explicit base without relying on a local tracking branch.
  const base =
    process.env.AGH_BUNDLED_VERSION_BASE ??
    (process.env.GITHUB_BASE_REF
      ? git('merge-base', 'HEAD', `origin/${process.env.GITHUB_BASE_REF}`)
      : 'HEAD^')
  const changed = [
    ...git('diff', '--name-only', base, '--').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ]
  const bundledRoot = 'packages/package-manager/bundled-plugins'
  // Read the release-owned literal example list; guards do not load the application runtime.
  const source = readFileSync(join(root, 'packages/package-manager/src/bundled-plugin-source.ts'), 'utf8')
  const declaration = source.slice(source.indexOf('export const BUNDLED_EXAMPLES'))
  const literals = new Set([...declaration.matchAll(/'([^']+)'/g)].map((match) => match[1]))
  const directories = [
    ...readdirSync(join(root, bundledRoot)).map((name) => `${bundledRoot}/${name}`),
    ...readdirSync(join(root, 'examples'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && literals.has(entry.name))
      .flatMap((family) =>
        readdirSync(join(root, 'examples', family.name), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && literals.has(entry.name))
          .map((entry) => `examples/${family.name}/${entry.name}`),
      ),
  ]
  expect(directories).toContain('examples/showcase/aerospace-quality')
  expect(directories).toContain('examples/showcase/pharma-gmp')
  const violations: string[] = []
  for (const directory of directories) {
    const file = `${directory}/package.json`
    if (!existsSync(join(root, file))) continue
    const old = git('ls-tree', base, '--', file)
    if (!old) continue // New bundled identities have no previous content to replace.
    const previous = JSON.parse(git('show', `${base}:${file}`))
    const current = JSON.parse(readFileSync(join(root, file), 'utf8'))
    violations.push(...versionViolations(directory, previous, current, changed))
  }
  expect(violations, `bundled version comparison base: ${base}`).toEqual([])
  const previous = { name: '@community/kit', version: '1.0.0' }
  expect(versionViolations('kit', previous, previous, ['kit/client/panel.js'])).not.toEqual([])
  expect(versionViolations('kit', previous, previous, ['kit/src/tool.ts'])).not.toEqual([])
  expect(versionViolations('kit', previous, previous, ['kit/README.md'])).not.toEqual([])
  expect(versionViolations('kit', previous, { version: '1.1.0' }, ['kit/client/panel.js'])).toEqual([])
  expect(versionViolations('kit', previous, previous, ['kit/test/panel.test.ts'])).toEqual([])
})

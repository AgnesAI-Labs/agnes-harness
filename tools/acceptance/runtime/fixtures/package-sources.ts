import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

export function writePackageTree(
  root: string,
  packageId: string,
  version: string,
  body: string,
  extra: Record<string, unknown> = {},
): string {
  const dir = join(root, packageId, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agnes.plugin.json'), JSON.stringify({ id: packageId, version, ...extra }))
  writeFileSync(join(dir, 'readme.txt'), body)
  return dir
}

export async function startNpmRegistry(
  packageName: string,
  archive: Buffer,
  integrity: string,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = request.url ?? ''
    if (url.endsWith(`/${encodeURIComponent(packageName)}`)) {
      response.end(
        JSON.stringify({
          versions: {
            '1.0.0': { integrity, dist: { tarball: '/tarball.tgz' } },
          },
        }),
      )
      return
    }
    response.end(archive)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('registry did not bind')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** A local repository whose catalog pins a full commit. `advance` moves HEAD and leaves that commit in place. */
export function initGitPackage(
  root: string,
  body: string,
): {
  readonly repo: string
  readonly commit: string
  advance(): string
} {
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'dev@example.com'])
  git(repo, ['config', 'user.name', 'Dev'])
  writePackageTree(repo, 'acme.tools', '1.0.0', body)
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'package'])
  const commit = git(repo, ['rev-parse', 'HEAD'])
  writeFileSync(
    join(repo, 'catalog.json'),
    JSON.stringify({
      packages: [{ packageId: 'acme.tools', version: '1.0.0', commit, subdirectory: 'acme.tools/1.0.0' }],
    }),
  )
  git(repo, ['add', 'catalog.json'])
  git(repo, ['commit', '-m', 'catalog'])
  return {
    repo,
    commit,
    advance() {
      writeFileSync(join(repo, 'acme.tools', '1.0.0', 'readme.txt'), `${body}\nmoved`)
      git(repo, ['add', '.'])
      git(repo, ['commit', '-m', 'move head'])
      return git(repo, ['rev-parse', 'HEAD'])
    },
  }
}

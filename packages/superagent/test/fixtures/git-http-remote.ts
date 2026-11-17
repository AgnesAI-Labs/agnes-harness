import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { hostFloor } from './daemon-harness.js'
import { gitEnv } from './git.js'

const run = promisify(execFile)

/**
 * A smart-HTTP git remote on 127.0.0.1 over a bare repository with one commit on `main`: `git http-backend`
 * behind Basic authentication. A request without valid credentials gets 401 (and is logged as such); an
 * authenticated one is logged as `<user> <METHOD> <path+query>`.
 */
export async function startGitHttpRemote(opts: { users: Record<string, string> }): Promise<{
  url: string
  /** The bare repository on disk. */
  repository: string
  authLog(): string[]
  refs(): Promise<string[]>
  close(): Promise<void>
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-git-remote-')))
  const projects = join(root, 'srv')
  const repository = join(projects, 'origin.git')
  const seed = join(root, 'seed')
  const env = gitEnv({ HOME: root, GIT_CONFIG_NOSYSTEM: '1' })
  const git = (cwd: string, ...args: string[]) => run('git', args, { cwd, env: env as NodeJS.ProcessEnv })
  const log: string[] = []
  const live = new Set<ReturnType<typeof spawn>>()
  let server: ReturnType<typeof createServer> | undefined
  try {
    mkdirSync(projects)
    mkdirSync(seed)
    await git(root, 'init', '--bare', '-q', '-b', 'main', repository)
    await git(repository, 'config', 'http.receivepack', 'true')
    await git(seed, 'init', '-q', '-b', 'main')
    writeFileSync(join(seed, 'README'), 'seed\n')
    await git(seed, 'add', '.')
    await git(
      seed,
      '-c',
      'user.name=seed',
      '-c',
      'user.email=seed@example.invalid',
      'commit',
      '-q',
      '-m',
      'init',
    )
    await git(seed, 'push', '-q', repository, 'main')
    const backend = join((await git(root, '--exec-path')).stdout.trim(), 'git-http-backend')

    server = createServer((request, response) => {
      const header = request.headers.authorization
      const credential = header?.startsWith('Basic ')
        ? Buffer.from(header.slice(6), 'base64').toString()
        : undefined
      const colon = credential?.indexOf(':') ?? -1
      const user = credential && colon >= 0 ? credential.slice(0, colon) : undefined
      const password = credential && colon >= 0 ? credential.slice(colon + 1) : undefined
      const target = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (user === undefined || !Object.hasOwn(opts.users, user) || opts.users[user] !== password) {
        log.push(`401 ${request.method} ${target.pathname}${target.search}`)
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="agh-test"' }).end()
        request.resume()
        return
      }
      log.push(`${user} ${request.method} ${target.pathname}${target.search}`)
      const child = spawn(backend, [], {
        env: {
          // What a Windows program needs to start (its system directory, temporary directory); nothing elsewhere.
          ...hostFloor(),
          PATH: process.env.PATH ?? '',
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_PROJECT_ROOT: projects,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: target.pathname,
          QUERY_STRING: target.search.slice(1),
          REQUEST_METHOD: request.method ?? 'GET',
          CONTENT_TYPE: String(request.headers['content-type'] ?? ''),
          HTTP_CONTENT_ENCODING: String(request.headers['content-encoding'] ?? ''),
          GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
          REMOTE_USER: user,
          REMOTE_ADDR: '127.0.0.1',
        },
      })
      live.add(child)
      child.stdin.on('error', () => {})
      request.pipe(child.stdin)
      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.once('close', () => {
        live.delete(child)
        const output = Buffer.concat(chunks)
        const split = output.indexOf('\r\n\r\n')
        const headers: Record<string, string> = {}
        let status = 200
        for (const line of output
          .subarray(0, split < 0 ? 0 : split)
          .toString()
          .split('\r\n')) {
          const at = line.indexOf(':')
          if (at < 0) continue
          const name = line.slice(0, at).trim()
          const value = line.slice(at + 1).trim()
          if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
          else headers[name] = value
        }
        response.writeHead(split < 0 ? 500 : status, headers)
        response.end(split < 0 ? undefined : output.subarray(split + 4))
      })
    })
    const listening = server
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject)
      listening.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    server?.close()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('git remote listener unavailable')
  const listening = server
  return {
    url: `http://127.0.0.1:${address.port}/origin.git`,
    repository,
    authLog: () => [...log],
    async refs() {
      const { stdout } = await git(repository, 'for-each-ref', '--format=%(refname)')
      return stdout.split('\n').filter(Boolean)
    },
    async close() {
      for (const child of live) child.kill('SIGKILL')
      listening.closeAllConnections()
      await new Promise<void>((resolve) => listening.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    },
  }
}

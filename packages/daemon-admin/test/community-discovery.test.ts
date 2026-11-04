import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openCommunityDiscovery } from '../src/packages/community-discovery.js'

const directories: string[] = []
const owners: Awaited<ReturnType<typeof openCommunityDiscovery>>[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function setup(fetcher: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'agh-community-'))
  directories.push(directory)
  const owner = await openCommunityDiscovery({ directory, fetch: fetcher, random: () => 0 })
  owners.push(owner)
  return { owner, directory }
}
const repo = (id = 1) => ({
  id,
  full_name: `example/plugin-${id}`,
  private: false,
  description: '<script>not markup</script>',
  topics: ['dsh-plugin', 'memory'],
  stargazers_count: 20,
  forks_count: 2,
  open_issues_count: 1,
  pushed_at: '2026-01-01T00:00:00Z',
})
const result = (items = [repo()], total_count = items.length) =>
  Response.json({ items, total_count, incomplete_results: false })

it('serves clones without networking and refreshes independently, persisting a deduplicated cache across restart', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => result())
  const { owner, directory } = await setup(fetcher)
  expect(owner.read().state).toBe('pending')
  owner.read()
  owner.read()
  expect(fetcher).not.toHaveBeenCalled()
  owner.start()
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  const snapshot = owner.read()
  expect(snapshot.items).toMatchObject([
    { id: 1, fullName: 'example/plugin-1', topics: ['dsh-plugin', 'memory'] },
  ])
  snapshot.items.length = 0
  expect(owner.read().items).toHaveLength(1)
  expect(fetcher.mock.calls.every(([url]) => String(url).includes('is%3Apublic'))).toBe(true)
  const recorded = JSON.parse(await readFile(join(directory, 'community-discovery-cache.json'), 'utf8'))
  expect(recorded.snapshot.items).toHaveLength(1)
  await owner.close()
  const reloaded = await openCommunityDiscovery({ directory, fetch: fetcher, random: () => 0 })
  owners.push(reloaded)
  expect(reloaded.read().lastSuccessAt).toBe(snapshot.lastSuccessAt)
  expect(reloaded.read().items).toHaveLength(1)
  const before = fetcher.mock.calls.length
  reloaded.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(fetcher.mock.calls).toHaveLength(before)
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(reloaded.read().state).toBe('ready'))
  expect(fetcher.mock.calls.length).toBeGreaterThan(before)
})

it('retains the previous snapshot on a later page failure and respects server retry delay', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => result())
  const { owner } = await setup(fetcher)
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  const original = owner.read()
  fetcher.mockImplementation(async (url) =>
    new URL(String(url)).searchParams.get('page') === '1'
      ? result(
          Array.from({ length: 100 }, (_, id) => repo(id + 10)),
          200,
        )
      : new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
  )
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
  expect(owner.read()).toMatchObject({
    items: original.items,
    lastSuccessAt: original.lastSuccessAt,
    error: 'rate-limit',
  })
  const before = fetcher.mock.calls.length
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  expect(fetcher.mock.calls).toHaveLength(before)
  await owner.close()
  await vi.advanceTimersByTimeAsync(24 * 3600_000)
  expect(fetcher.mock.calls).toHaveLength(before)
})

it.each([
  'disabled',
  'invalid',
  'corrupt-cache',
  'empty',
  'invalid-response',
  'incomplete',
  'oversized',
  'bad-json',
  'storage',
] as const)('handles %s without executing repository code', async (mode) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    if (mode === 'invalid-response')
      return Response.json({ items: [{ ...repo(), private: true }], total_count: 1 })
    if (mode === 'incomplete')
      return Response.json({ items: [repo()], total_count: 1, incomplete_results: true })
    if (mode === 'oversized') return new Response('x'.repeat(2 * 1024 * 1024 + 1))
    if (mode === 'bad-json') return new Response('not JSON')
    return result([], 0)
  })
  const { owner: unused, directory } = await setup(fetcher)
  await unused.close()
  if (mode === 'disabled') await writeFile(join(directory, 'community-discovery.json'), '{"enabled":false}')
  if (mode === 'invalid')
    await writeFile(join(directory, 'community-discovery.json'), '{"topics":["secret-topic"]}')
  if (mode === 'corrupt-cache') await writeFile(join(directory, 'community-discovery-cache.json'), 'not JSON')
  if (mode === 'storage') await mkdir(join(directory, 'community-discovery-cache.json'))
  const owner = await openCommunityDiscovery({ directory, fetch: fetcher, random: () => 0 })
  owners.push(owner)
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  if (mode === 'disabled' || mode === 'invalid') {
    expect(fetcher).not.toHaveBeenCalled()
    expect(owner.read().state).toBe('disabled')
  } else {
    const failed = ['invalid-response', 'incomplete', 'oversized', 'bad-json', 'storage'].includes(mode)
    await vi.waitFor(() => expect(owner.read().state).toBe(failed ? 'failed' : 'ready'))
    expect(owner.read().items).toEqual([])
    if (failed) expect(owner.read().error).toBe(mode === 'storage' ? 'storage' : 'invalid-data')
  }
})

it('cancels an in-flight response and never publishes after the owner closes', async () => {
  vi.useFakeTimers()
  let cancelled = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            cancelled = true
            reject(init.signal?.reason)
          },
          { once: true },
        )
      }),
  )
  const { owner, directory } = await setup(fetcher)
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(owner.read().state).toBe('syncing')
  await owner.close()
  expect(cancelled).toBe(true)
  expect(owner.read().lastSuccessAt).toBeNull()
  await expect(readFile(join(directory, 'community-discovery-cache.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await vi.advanceTimersByTimeAsync(24 * 3600_000)
  expect(owner.read().items).toEqual([])
})

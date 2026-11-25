import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSemver } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { projectCommunitySnapshot } from '../src/packages/community-catalog.js'
import { openCommunityDiscovery } from '../src/packages/community-discovery.js'
import { COMMUNITY_INDEX_URL } from '../src/packages/community-index.js'

/**
 * Fake timers and the clock of `Date`, but not the monotonic clocks (`performance`, `hrtime`). On Windows a cache write
 * the destination refuses retries for 100 ms by `performance.now()` (see `replacePublishedFileSync`); a faked one never
 * advances while the write spins, so the 'storage' case below, whose cache path is a directory, would never return.
 */
const fakeTimers = () =>
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  })
const directories: string[] = []
const owners: Awaited<ReturnType<typeof openCommunityDiscovery>>[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const entry = (url = 'https://github.com/example/plugin-1', name = '@example/plugin') => ({
  name,
  title: { en: 'Plugin', 'zh-cn': '插件' },
  description: { en: '<script>not markup</script>', 'zh-cn': '简介' },
  author: 'Example Author',
  repository: { url },
  versions: [{ version: '1.0.0', source: { type: 'git', url, commit: 'a'.repeat(40) } }],
})
const fixtureSource = {
  type: 'git' as const,
  ref: `git:https://github.com/example/plugin-1.git#${'a'.repeat(40)}`,
}
const index = (plugins: unknown[] = [entry()]) => ({ format: 1, plugins })
async function setup(fetcher: typeof fetch = async () => Response.json(index())) {
  const directory = await mkdtemp(join(tmpdir(), 'agh-community-'))
  directories.push(directory)
  const network = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(COMMUNITY_INDEX_URL)
    expect(init?.redirect).toBe('error')
    return fetcher(url, init)
  })
  const owner = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(owner)
  return { owner, directory, network }
}

it('fakes the timers these cases advance, but not the monotonic clock a bounded synchronous retry waits by', () => {
  fakeTimers()
  const start = performance.now()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  expect(performance.now()).toBeGreaterThan(start)
})

it('restores v4 offline, synchronizes once, and keeps facts rather than verdicts in v5', async () => {
  fakeTimers()
  const candidate = entry()
  const updated = index([
    {
      ...candidate,
      versions: candidate.versions.map((version) => ({
        ...version,
        provides: ['tool', 'skills'],
        publishTimestamp: 1795593000,
        engines: { agh: ' >=1.2.3-rc.1 <2.0.0 ' },
      })),
    },
  ])
  const { owner: unused, directory, network } = await setup(async () => Response.json(updated))
  await unused.close()
  const cache = join(directory, 'community-discovery-cache.json')
  const oldVersion = { version: '1.0.0', source: fixtureSource }
  const legacy = {
    state: 'ready',
    lastSuccessAt: new Date(Date.now() - 1000).toISOString(),
    nextAttemptAt: new Date(Date.now() + 10_000).toISOString(),
    error: null,
    totalReported: 1,
    items: [{ id: 'old', fullName: 'example/plugin-1', description: '', versions: [oldVersion] }],
  }
  await writeFile(
    cache,
    JSON.stringify({ version: 4, fingerprint: `index-v4|${COMMUNITY_INDEX_URL}`, snapshot: legacy }),
  )
  const owner = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(owner)
  expect(owner.read()).toEqual(legacy)
  const installed = parseSemver('1.2.3-rc.2+build.9')
  expect(projectCommunitySnapshot(owner.read(), 2)).toEqual(legacy)
  expect(projectCommunitySnapshot(owner.read(), 3, installed).items[0]?.versions).toEqual([
    { ...oldVersion, compatibility: { kind: 'unknown' } },
  ])
  expect(network).not.toHaveBeenCalled()
  owner.start()
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().items[0]?.id).toBe('@example/plugin'))
  expect(network).toHaveBeenCalledOnce()
  const snapshot = owner.read()
  expect(snapshot.items).toMatchObject([
    {
      id: '@example/plugin',
      name: '@example/plugin',
      fullName: 'example/plugin-1',
      author: 'Example Author',
      summary: { en: '<script>not markup</script>', 'zh-cn': '简介' },
      versions: [
        {
          version: '1.0.0',
          source: fixtureSource,
          provides: ['tool', 'skills'],
          publishTimestamp: 1795593000,
          aghEngine: { kind: 'range', range: '>=1.2.3-rc.1 <2.0.0' },
        },
      ],
    },
  ])
  expect(snapshot.items[0]).not.toHaveProperty('stars')
  snapshot.items.length = 0
  expect(owner.read().items).toHaveLength(1)
  const recorded = JSON.parse(await readFile(cache, 'utf8'))
  expect(recorded).toEqual({
    version: 5,
    fingerprint: `index-v5|${COMMUNITY_INDEX_URL}`,
    snapshot: owner.read(),
  })
  expect(recorded.snapshot.items[0].versions[0]).not.toHaveProperty('compatibility')
  await owner.close()
  const reloaded = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(reloaded)
  expect(reloaded.read().lastSuccessAt).toBe(snapshot.lastSuccessAt)
  expect(reloaded.read().items).toEqual(recorded.snapshot.items)
  expect(projectCommunitySnapshot(reloaded.read(), 2).items[0]?.versions).toEqual([oldVersion])
  const range = '>=1.2.3-rc.1 <2.0.0'
  for (const [release, kind] of [
    [installed, 'declared-compatible'],
    [parseSemver('2.0.0'), 'incompatible'],
    [null, 'unknown'],
  ] as const) {
    expect(projectCommunitySnapshot(reloaded.read(), 3, release).items[0]?.versions).toEqual([
      {
        ...oldVersion,
        provides: ['tool', 'skills'],
        publishTimestamp: 1795593000,
        compatibility: { kind, range },
      },
    ])
  }
  const before = network.mock.calls.length
  reloaded.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(network.mock.calls).toHaveLength(before)
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(before + 1))
})

it('drops malformed per-version hints without dropping the selected release or its fixed source', async () => {
  fakeTimers()
  const candidate = entry()
  const badTimes = [0, -1, 253402300800, 1795593000000, '1795593000', 1.5]
  const badTypes = [undefined, [], ['tool', 'other'], ['tool', 'tool'], 'skills', null]
  const badEngines = [
    null,
    [],
    { agh: '' },
    { agh: 1 },
    { agh: '^1.0.0 || *' },
    { agh: ` ${' '.repeat(500)}*` },
  ]
  const mixed = index([
    {
      ...candidate,
      versions: candidate.versions.flatMap((version) => [
        { ...version, publishTimestamp: 1, provides: ['service'], engines: { node: '>=24' } },
        { ...version, version: '2.0.0', publishTimestamp: 253402300799, engines: { agh: '*' } },
        ...badTimes.map((publishTimestamp, i) => ({
          ...version,
          version: `3.0.${i}`,
          publishTimestamp,
          provides: badTypes[i],
          engines: badEngines[i],
        })),
      ]),
    },
  ])
  const { owner, network } = await setup(async () => Response.json(mixed))
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  expect(projectCommunitySnapshot(owner.read(), 3, parseSemver('2.0.0-pre')).items[0]?.versions).toEqual([
    {
      version: '1.0.0',
      source: fixtureSource,
      publishTimestamp: 1,
      provides: ['service'],
      compatibility: { kind: 'undeclared' },
    },
    {
      version: '2.0.0',
      source: fixtureSource,
      publishTimestamp: 253402300799,
      compatibility: { kind: 'declared-compatible', range: '*' },
    },
    ...badTimes.map((_, i) => ({
      version: `3.0.${i}`,
      source: fixtureSource,
      compatibility: { kind: 'unknown' },
    })),
  ])
  expect(network).toHaveBeenCalledOnce()
})

it('retains the previous complete snapshot on failure and respects server retry delay', async () => {
  fakeTimers()
  let limited = false
  const { owner, network } = await setup(async () =>
    limited ? new Response('', { status: 429, headers: { 'retry-after': '3600' } }) : Response.json(index()),
  )
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  const original = owner.read()
  limited = true
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
  expect(owner.read()).toMatchObject({
    items: original.items,
    lastSuccessAt: original.lastSuccessAt,
    error: 'rate-limit',
  })
  const before = network.mock.calls.length
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  expect(network.mock.calls).toHaveLength(before)
  await owner.close()
  await vi.advanceTimersByTimeAsync(24 * 3600_000)
  expect(network.mock.calls).toHaveLength(before)
})

it.each([
  'disabled',
  'invalid',
  'legacy-topic',
  'legacy-disabled',
  'corrupt-cache',
  'invalid-v5-cache',
  'legacy-cache',
  'empty',
  'storage',
] as const)('handles %s without executing repository code', async (mode) => {
  fakeTimers()
  const { owner: unused, directory } = await setup()
  await unused.close()
  const config =
    mode === 'disabled'
      ? { enabled: false }
      : mode === 'invalid'
        ? { topics: ['secret-topic'] }
        : mode === 'legacy-topic' || mode === 'legacy-disabled'
          ? { enabled: mode !== 'legacy-disabled', topics: ['agh-plugin', 'dsh-plugin'] }
          : undefined
  if (config) await writeFile(join(directory, 'community-discovery.json'), JSON.stringify(config))
  if (mode === 'corrupt-cache') await writeFile(join(directory, 'community-discovery-cache.json'), 'not JSON')
  if (mode === 'legacy-cache')
    await writeFile(
      join(directory, 'community-discovery-cache.json'),
      JSON.stringify({
        version: 2,
        fingerprint: 'agh-plugin',
        snapshot: { ...unused.read(), items: [{ id: 1, fullName: 'unlisted/plugin', description: '' }] },
      }),
    )
  if (mode === 'invalid-v5-cache')
    await writeFile(
      join(directory, 'community-discovery-cache.json'),
      JSON.stringify({
        version: 5,
        fingerprint: `index-v5|${COMMUNITY_INDEX_URL}`,
        snapshot: {
          ...unused.read(),
          state: 'ready',
          totalReported: 1,
          items: [
            {
              id: 'unlisted/plugin',
              fullName: 'unlisted/plugin',
              description: '',
              versions: [
                {
                  version: '1.0.0',
                  source: fixtureSource,
                  aghEngine: { kind: 'range', range: '^1.0.0' },
                  compatibility: { kind: 'declared-compatible', range: '^1.0.0' },
                },
              ],
            },
          ],
        },
      }),
    )
  if (mode === 'storage') await mkdir(join(directory, 'community-discovery-cache.json'))
  const network = vi.fn<typeof fetch>(async () => Response.json(index(mode === 'empty' ? [] : undefined)))
  const owner = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(owner)
  expect(owner.read().items).toEqual([])
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  if (['disabled', 'invalid', 'legacy-disabled'].includes(mode)) {
    expect(network).not.toHaveBeenCalled()
    expect(owner.read()).toMatchObject({
      state: 'disabled',
      error: mode === 'invalid' ? 'configuration' : null,
    })
  } else {
    await vi.waitFor(() => expect(owner.read().state).toBe(mode === 'storage' ? 'failed' : 'ready'))
    if (mode === 'empty' || mode === 'storage') expect(owner.read().items).toEqual([])
    else expect(owner.read().items).toHaveLength(1)
    if (config)
      expect(JSON.parse(await readFile(join(directory, 'community-discovery.json'), 'utf8'))).toEqual(config)
  }
})

it.each(['network', 'rate-limit', 'oversized', 'bad-json'] as const)(
  'fails closed without a cache when the index has a %s failure',
  async (failure) => {
    fakeTimers()
    let limitedAt = 0
    const { owner } = await setup(async () => {
      if (failure === 'network') return new Response('', { status: 503 })
      if (failure === 'rate-limit') {
        limitedAt = Date.now()
        return new Response('', { status: 429, headers: { 'retry-after': '3600' } })
      }
      return new Response(failure === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'not JSON')
    })
    owner.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
    expect(owner.read()).toMatchObject({
      items: [],
      lastSuccessAt: null,
      error: ['oversized', 'bad-json'].includes(failure) ? 'invalid-data' : failure,
    })
    if (failure === 'rate-limit')
      expect(Date.parse(owner.read().nextAttemptAt ?? '')).toBeGreaterThanOrEqual(limitedAt + 3600_000)
  },
)

it('cancels an in-flight index response and never publishes after the owner closes', async () => {
  fakeTimers()
  let cancelled = false
  const { owner, directory } = await setup(
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
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(owner.read().state).toBe('syncing')
  await owner.close()
  expect(cancelled).toBe(true)
  expect(owner.read().lastSuccessAt).toBeNull()
  await expect(readFile(join(directory, 'community-discovery-cache.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it.each([
  [1101, 0],
  [300, 2000],
  [600, 2000],
])('retains all %i entries with %i-character summaries across refresh and restart', async (size, length) => {
  fakeTimers()
  let listed = Array.from({ length: size }, (_, i) => ({
    ...entry(`https://github.com/example/plugin-${i}`, `@example/plugin-${i}`),
    ...(length ? { description: 'x'.repeat(length) } : {}),
  }))
  const { owner, directory } = await setup(async () => Response.json(index(listed)))
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  expect(owner.read().items).toHaveLength(size)
  expect(owner.read().totalReported).toBe(size)
  const restarted = await openCommunityDiscovery({ directory, random: () => 0 })
  owners.push(restarted)
  expect(restarted.read().items).toEqual(owner.read().items)
  listed = [entry('https://github.com/Example/plugin-1.git/')]
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().items).toHaveLength(1))
  expect(owner.read().items[0]?.fullName).toBe('example/plugin-1')
  listed = []
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read()).toMatchObject({ totalReported: 0, items: [] }))
})

it.each([
  { format: 2, plugins: [entry()] },
  { format: 1 },
  index([entry('https://github.com.attacker.example/example/plugin-1')]),
  index([entry('https://github.com/example/plugin-1?other=1')]),
  index([entry('https://user:password@github.com/example/plugin-1')]),
  index([entry(), entry()]),
  index([{ ...entry(), versions: [...entry().versions, ...entry().versions] }]),
  index([{ ...entry(), versions: [] }]),
  index([{ ...entry(), author: { name: 'unsupported' } }]),
  index([{ ...entry(), description: { en: 42 } }]),
  index([
    {
      ...entry(),
      versions: [
        {
          version: '1.0.0',
          source: { type: 'git', url: 'https://github.com/other/plugin', commit: 'a'.repeat(40) },
        },
      ],
    },
  ]),
  index([
    {
      ...entry(),
      versions: [
        {
          version: '1.0.0',
          source: { type: 'git', url: 'https://github.com/example/plugin-1', commit: 'main' },
        },
      ],
    },
  ]),
])('rejects malformed index identity and retains the latest complete snapshot: %j', async (body) => {
  fakeTimers()
  let valid = true
  const { owner, network } = await setup(async () => Response.json(valid ? index() : body))
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  const { items, lastSuccessAt } = owner.read()
  valid = false
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
  expect(owner.read()).toMatchObject({ error: 'invalid-data', lastSuccessAt, items })
  expect(network).toHaveBeenCalledTimes(2)
})

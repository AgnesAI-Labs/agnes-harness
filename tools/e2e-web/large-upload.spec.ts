import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { uploadedAttachment } from '@agnes/protocol'
import { expect, test } from './fixtures.js'
import { readSessionEvents } from './ledger.js'
import { accessible, translated } from './quality.js'
import { chooseWorkspace, preferences } from './ui.js'

const MiB = 1024 * 1024
test.describe.configure({ mode: 'serial' })
async function synthetic(path: string, size: number) {
  const file = await open(path, 'w')
  try {
    await file.truncate(size)
  } finally {
    await file.close()
  }
}
async function digest(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path, { highWaterMark: 64 * 1024 })) hash.update(bytes)
  return hash.digest('hex')
}
async function files(root: string): Promise<string[]> {
  const rows = await readdir(root, { withFileTypes: true }).catch(() => [])
  const result: string[] = []
  for (const row of rows) {
    const path = join(root, row.name)
    if (row.isDirectory()) result.push(...(await files(path)))
    else result.push(path)
  }
  return result
}

for (const locale of ['en', 'zh-CN'])
  test(`large attachment progress, chunk retry and mid-upload cancel (${locale})`, async ({
    page,
    runtime,
  }, info) => {
    test.setTimeout(180_000)
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    const source = join(runtime.workspace, 'synthetic-contract.bin')
    await synthetic(source, 50 * MiB)
    let retried = false
    let release: (() => void) | undefined
    const pause = new Promise<void>((resolve) => {
      release = resolve
    })
    // A lost chunk request is retried. Hold the next chunk to inspect real acknowledged progress.
    await page.route('**/api/attachments/upload?*', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('operation') !== 'chunk') {
        await route.continue()
        return
      }
      if (!retried) {
        retried = true
        await route.abort('connectionreset')
        return
      }
      if (url.searchParams.get('offset') === String(MiB)) await pause
      await route.continue().catch(() => undefined)
    })
    await page.getByTestId('attachment-file-input').setInputFiles(source)
    const chip = page.getByTestId('attachment-upload')
    await expect(chip).toHaveAttribute('data-state', 'uploading', { timeout: 40_000 })
    await expect(page.getByTestId('attachment-upload-progress')).toHaveAttribute('value', String(MiB))
    await expect(page.getByTestId('attachment-upload-status')).toContainText('2%')
    await page
      .getByTestId('attachment-upload')
      .screenshot({ path: info.outputPath(`upload-progress-${locale}.png`) })
    await accessible(page, info, `upload-${locale}`)
    release?.()
    await expect(page.getByTestId('attachment-ready')).toBeVisible({ timeout: 60_000 })
    await page.unroute('**/api/attachments/upload?*')
    expect(retried).toBe(true)

    // Cancel a second file after one chunk has reached the worker, with another request in flight.
    const cancelled = join(runtime.workspace, 'synthetic-scan.bin')
    await synthetic(cancelled, 50 * MiB)
    let resumeCancelled: (() => void) | undefined
    const hold = new Promise<void>((resolve) => {
      resumeCancelled = resolve
    })
    await page.route('**/api/attachments/upload?*', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('operation') === 'chunk' && url.searchParams.get('offset') === String(MiB))
        await hold
      await route.continue().catch(() => undefined)
    })
    await page.getByTestId('attachment-file-input').setInputFiles(cancelled)
    await expect(page.getByTestId('attachment-upload-progress')).toHaveAttribute('value', String(MiB))
    await page.getByTestId('attachment-upload-cancel').click()
    await expect(chip).toHaveAttribute('data-state', 'cancelled')
    resumeCancelled?.()
    await page.unroute('**/api/attachments/upload?*')
    const stored = await files(join(runtime.workspace, '.agnes-attachments'))
    expect(stored).toHaveLength(1)
    expect(await digest(stored[0] ?? '')).toBe(await digest(source))
    expect(stored.some((file) => file.includes('.partial-'))).toBe(false)
    await translated(page)
    await page.screenshot({ path: info.outputPath(`upload-cancelled-${locale}.png`) })
    await page.getByTestId('attachment-upload-dismiss').click()
    const input = page.getByRole('textbox', {
      name: locale === 'en' ? 'Task content' : '任务内容',
      exact: true,
    })
    await input.fill('Remember the uploaded business file.')
    await input.press('Enter')
    await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
      timeout: 40_000,
    })
    const id = new URL(page.url()).searchParams.get('session')
    if (!id) throw new Error('Missing session identity')
    const client = await runtime.connect()
    const session = await client.session.load(id, { cwd: runtime.workspace })
    const rows = (await readSessionEvents(session)).filter((row) => row.type === 'user/message').slice(0, 10)
    const saved = JSON.stringify(rows)
    expect(saved.length).toBeLessThan(4096)
    expect(saved).toContain('agnes-upload://')
    expect(saved).toContain('synthetic-contract.bin')
  })

test('uploads 512 MiB with measured bounded browser and server memory', async ({
  page,
  runtime,
  browser,
}, info) => {
  test.skip(process.env.AGH_UPLOAD_MEMORY !== '1', 'Run large memory acceptance explicitly and in isolation.')
  test.setTimeout(240_000)
  await preferences(page)
  const client = await runtime.connect()
  const session = await client.session.new({ cwd: runtime.workspace })
  await page.goto(`${runtime.url}/?session=${encodeURIComponent(session.id)}`)
  await page
    .getByTestId('first-run-skip')
    .click()
    .catch(() => undefined)
  await expect(page.getByTestId('attachment-file-input')).toBeAttached()
  const source = join(runtime.workspace, 'synthetic-512MiB.bin')
  await synthetic(source, 512 * MiB)
  const owner = JSON.parse(await readFile(join(runtime.home, 'daemon/owner.json'), 'utf8')) as { pid: number }
  const cdp = await page.context().newCDPSession(page)
  const system = await browser.newBrowserCDPSession()
  const processes = await system.send('SystemInfo.getProcessInfo')
  const browserPids = new Set(
    processes.processInfo.filter((row) => ['browser', 'renderer'].includes(row.type)).map((row) => row.id),
  )
  const samples: { serverRss: number; browserRss: number; heap: number; backing: number }[] = []
  const command = promisify(execFile)
  let sampling = false
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      const [heap, processRows] = await Promise.all([
        cdp.send('Runtime.getHeapUsage'),
        command('ps', ['-axo', 'pid,ppid,rss,comm']),
      ])
      const rows = processRows.stdout
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => {
          const fields = line.trim().split(/\s+/)
          return {
            pid: Number(fields[0]),
            parent: Number(fields[1]),
            rss: Number(fields[2]) * 1024,
            command: fields.slice(3).join(' '),
          }
        })
      const server = new Set(
        rows
          .filter(
            (row) => row.pid === owner.pid || (row.parent === process.pid && row.command.endsWith('node')),
          )
          .map((row) => row.pid),
      )
      for (let count = 0; count < 5; count++)
        for (const row of rows) if (server.has(row.parent)) server.add(row.pid)
      samples.push({
        serverRss: rows.filter((row) => server.has(row.pid)).reduce((sum, row) => sum + row.rss, 0),
        browserRss: rows.filter((row) => browserPids.has(row.pid)).reduce((sum, row) => sum + row.rss, 0),
        heap: heap.usedSize,
        backing: heap.backingStorageSize ?? 0,
      })
    } finally {
      sampling = false
    }
  }
  await sample()
  const timer = setInterval(() => {
    void sample().catch(() => undefined)
  }, 500)
  try {
    await page.getByTestId('attachment-file-input').setInputFiles(source)
    await expect(page.getByTestId('attachment-ready')).toBeVisible({ timeout: 180_000 })
    await sample()
  } finally {
    clearInterval(timer)
  }
  const originals = await files(join(runtime.workspace, '.agnes-attachments'))
  expect(originals).toHaveLength(1)
  const original = originals[0] ?? ''
  expect((await stat(original)).size).toBe(512 * MiB)
  expect(await digest(original)).toBe(await digest(source))
  const input = page.getByRole('textbox', { name: 'Task content', exact: true })
  await input.fill('Keep this large business original.')
  await input.press('Enter')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 40_000,
  })
  const messages = (await readSessionEvents(session))
    .filter((row) => row.type === 'user/message')
    .slice(0, 10)
  const ref = (messages.at(-1)?.data as { content?: { type: string; uri?: string }[] })?.content?.find(
    (block) => block.uri,
  )?.uri
  expect(uploadedAttachment(ref ?? '')?.size).toBe(512 * MiB)
  expect(JSON.stringify(messages).length).toBeLessThan(4096)
  const baseline = samples[0]
  if (!baseline) throw new Error('Missing memory baseline')
  const peak = Object.fromEntries(
    Object.keys(baseline).map((key) => [
      key,
      Math.max(...samples.map((sample) => sample[key as keyof typeof sample])),
    ]),
  )
  const evidence = {
    fileBytes: 512 * MiB,
    chunkBytes: MiB,
    intervalMs: 500,
    baseline,
    peak,
    sampleCount: samples.length,
    serverRssGrowth: (peak.serverRss ?? 0) - baseline.serverRss,
    browserRssGrowth: (peak.browserRss ?? 0) - baseline.browserRss,
  }
  await info.attach('upload-memory.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
  if (process.env.AGH_UPLOAD_REPORT) {
    await mkdir(process.env.AGH_UPLOAD_REPORT, { recursive: true })
    await writeFile(
      join(process.env.AGH_UPLOAD_REPORT, 'upload-memory.json'),
      JSON.stringify(evidence, null, 2),
    )
  }
  expect(evidence.serverRssGrowth).toBeLessThan(256 * MiB)
  expect(evidence.browserRssGrowth).toBeLessThan(256 * MiB)
  expect(peak.heap).toBeLessThan(128 * MiB)
})

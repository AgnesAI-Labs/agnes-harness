#!/usr/bin/env node
/**
 * Opt-in Web Plugins DSH parity acceptance.
 *
 * The browser dependency stays outside the repository dependency graph. Set
 * AGNES_PLAYWRIGHT_MODULE to an installed Playwright entry for real captures.
 * Captures are ephemeral and must be kept outside the repository.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PARITY_LAYERS = Object.freeze(['pixels', 'text', 'accessibility', 'interaction'])
export const VIEWPORTS = Object.freeze([
  Object.freeze({ id: '1440x1000', width: 1440, height: 1000 }),
  Object.freeze({ id: '390x844', width: 390, height: 844 }),
])
export const THEMES = Object.freeze(['light', 'dark'])
export const FIXED_TIME = '2026-01-01T00:00:00.000Z'

/** The only screenshot masking vocabulary permitted by D31. */
export const DYNAMIC_MASK_SELECTORS = Object.freeze([
  '[data-agnes-dynamic="time"]',
  '[data-agnes-dynamic="relative-time"]',
  '[data-agnes-dynamic="session-id"]',
  '[data-agnes-dynamic="duration"]',
  '[data-agnes-dynamic="turn-process"]',
  '.turn-meta',
  '[aria-busy="true"]',
  '.spinner',
  // A message footer's clock is produced by the host, not Playwright's page clock.  `time`
  // therefore belongs to the explicit D31 dynamic vocabulary rather than making an otherwise
  // identical transcript fail an image comparison.
  'time',
  '.workspace-option-path',
  '.session-row',
  '#config-close',
  '#config-base-url',
])

/**
 * Every state has a real setup function below. The matrix is data-only so a new state cannot
 * accidentally bypass the four viewport/theme combinations.
 */
export const STATE_MATRIX = Object.freeze(
  [
    ['settings-model', ['settings-pane', 'dialog']],
    ['settings-plugins', ['settings-pane', 'dialog']],
    ['settings-resources', ['settings-pane', 'dialog']],
    ['settings-computer-use', ['settings-pane', 'dialog']],
    ['settings-archived', ['settings-pane', 'dialog']],
    ['settings-appearance', ['settings-pane', 'dialog']],
    ['account-dialog-before', ['dialog']],
    ['account-dialog-after', ['dialog']],
    ['new-session-dialog', ['dialog']],
    ['empty-session', ['empty-state', 'composer', 'composer-input']],
    ['composer-short', ['composer', 'composer-input']],
    ['composer-long', ['composer', 'composer-input']],
    ['model-open', ['topbar', 'composer']],
    ['permission-open', ['topbar', 'composer']],
    ['conversation-markdown', ['conversation', 'transcript']],
    ['tool-card-inline', ['transcript', 'slot-card']],
    ['approval-pending', ['approval']],
    ['trace-open', ['trace']],
    ['sidebar-menu', ['sidebar']],
    ['admin-page', []],
    ['resources-page', []],
  ].map(([id, regions]) =>
    Object.freeze({
      id,
      regions: Object.freeze(regions),
      viewports: VIEWPORTS,
      themes: THEMES,
    }),
  ),
)

export const MATRIX_COMBINATIONS = Object.freeze(
  STATE_MATRIX.flatMap((state) =>
    state.viewports.flatMap((viewport) =>
      state.themes.map((theme) => ({
        id: `${state.id}__${viewport.id}__${theme}`,
        stateId: state.id,
        viewport,
        theme,
      })),
    ),
  ),
)
const MATRIX_ARTIFACT_IDS = new Set(MATRIX_COMBINATIONS.map((item) => item.id))
const EXPECTED_REGIONS = [
  'sidebar',
  'transcript',
  'conversation',
  'topbar',
  'approval',
  'composer',
  'composer-input',
  'trace',
  'empty-state',
  'settings-pane',
  'dialog',
  'slot-card',
]

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const cliEntry = resolve(process.env.AGNES_LOCAL_CLI ?? 'packages/cli/dist/local/agnes.mjs')
const MASK_TEXT = Object.freeze([
  [/agnes-d31-[a-z0-9]+/gi, '<d31-run>'],
  [/http:\/\/127\.0\.0\.1:\d+\/v1/gi, 'http://127.0.0.1:<provider>/v1'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<uuid>'],
  [/会话 [0-9a-f]{8}\b/g, '会话 <session-id>'],
  [/\b(?:session|turn|task)[-_][a-z0-9-]{8,}\b/gi, '<session-id>'],
  [/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>'],
  [/\d+(?:\.\d+)?\s*(?:毫秒|ms|秒|s)/gi, '<duration>'],
])

function clone(value) {
  return structuredClone(value)
}

function normalizeDynamicText(value) {
  return MASK_TEXT.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
}

function normalizeDynamic(value) {
  if (typeof value === 'string') return normalizeDynamicText(value)
  if (Array.isArray(value)) return value.map(normalizeDynamic)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeDynamic(item)]))
  return value
}

function valueForLayer(capture, layer) {
  return capture[layer]
}

function compareCapture(baseline, candidate, artifactId) {
  const differences = []
  if (typeof baseline.pixels !== 'string' || !baseline.pixels.endsWith('.png')) {
    if (baseline.pixels !== candidate.pixels) differences.push({ layer: 'pixels', artifactId })
  }
  for (const layer of PARITY_LAYERS) {
    if (layer === 'pixels') continue
    if (JSON.stringify(valueForLayer(baseline, layer)) !== JSON.stringify(valueForLayer(candidate, layer)))
      differences.push({ layer, artifactId })
  }
  return differences
}

async function readArtifact(dir, artifactId) {
  const manifest = JSON.parse(await readFile(join(dir, `${artifactId}.json`), 'utf8'))
  if (!manifest || typeof manifest !== 'object') throw new Error(`invalid manifest: ${artifactId}`)
  if (typeof manifest.pixels !== 'string') throw new Error(`missing pixels path: ${artifactId}`)
  const pixels = await readFile(resolve(dir, manifest.pixels))
  return { manifest, pixels }
}

async function loadPlaywright() {
  const modulePath = process.env.AGNES_PLAYWRIGHT_MODULE
  if (!modulePath) throw new Error('Set AGNES_PLAYWRIGHT_MODULE to an installed Playwright module entry')
  return import(pathToFileURL(modulePath).href)
}

async function createDiffRenderer(diffDir) {
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await mkdir(diffDir, { recursive: true })
  return {
    async render(artifactId, baselineBytes, candidateBytes) {
      const baseline = baselineBytes.toString('base64')
      const candidate = candidateBytes.toString('base64')
      await page.setContent('<canvas id="diff"></canvas><img id="baseline"><img id="candidate">')
      const result = await page.evaluate(
        async ({ baseline, candidate }) => {
          const load = (id, data) => {
            const image = document.querySelector(id)
            image.src = `data:image/png;base64,${data}`
            return new Promise((resolve, reject) => {
              image.onload = () => resolve(image)
              image.onerror = () => reject(new Error(`cannot decode ${id}`))
            })
          }
          const [left, right] = await Promise.all([
            load('#baseline', baseline),
            load('#candidate', candidate),
          ])
          if (left.naturalWidth !== right.naturalWidth || left.naturalHeight !== right.naturalHeight)
            throw new Error('PNG dimensions differ')
          const canvas = document.querySelector('#diff')
          canvas.width = left.naturalWidth
          canvas.height = left.naturalHeight
          const context = canvas.getContext('2d', { willReadFrequently: true })
          context.drawImage(left, 0, 0)
          const base = context.getImageData(0, 0, canvas.width, canvas.height)
          context.clearRect(0, 0, canvas.width, canvas.height)
          context.drawImage(right, 0, 0)
          const next = context.getImageData(0, 0, canvas.width, canvas.height)
          let different = 0
          for (let index = 0; index < base.data.length; index += 4) {
            const changed =
              base.data[index] !== next.data[index] ||
              base.data[index + 1] !== next.data[index + 1] ||
              base.data[index + 2] !== next.data[index + 2] ||
              base.data[index + 3] !== next.data[index + 3]
            if (changed) {
              different++
              next.data[index] = 255
              next.data[index + 1] = 0
              next.data[index + 2] = 0
              next.data[index + 3] = 255
            } else {
              const gray = Math.round((base.data[index] + base.data[index + 1] + base.data[index + 2]) / 3)
              next.data[index] = gray
              next.data[index + 1] = gray
              next.data[index + 2] = gray
              next.data[index + 3] = 255
            }
          }
          context.putImageData(next, 0, 0)
          return { different, width: canvas.width, height: canvas.height }
        },
        { baseline, candidate },
      )
      const path = join(diffDir, `${artifactId}.diff.png`)
      await page.locator('#diff').screenshot({ path })
      return { ...result, path }
    },
    async close() {
      await browser.close()
    },
  }
}

/** Compare complete capture directories and emit a PNG diff for every pixel mismatch. */
export async function compareArtifactDirectories(baselineDir, candidateDir, options = {}) {
  const differences = []
  const isArtifactManifest = (name) => name.endsWith('.json') && name !== 'summary.json'
  const baselineNames = new Set((await readdir(baselineDir)).filter(isArtifactManifest))
  const candidateNames = new Set((await readdir(candidateDir)).filter(isArtifactManifest))
  for (const name of baselineNames) {
    if (!candidateNames.has(name))
      differences.push({ layer: 'state', artifactId: name.slice(0, -5), reason: 'candidate missing' })
  }
  for (const name of candidateNames) {
    const artifactId = name.slice(0, -5)
    if (!MATRIX_ARTIFACT_IDS.has(artifactId))
      differences.push({ layer: 'state', artifactId, reason: 'not in state matrix' })
  }
  let renderer
  try {
    for (const combination of MATRIX_COMBINATIONS) {
      const { id: artifactId } = combination
      const name = `${artifactId}.json`
      if (!baselineNames.has(name) || !candidateNames.has(name)) {
        differences.push({ layer: 'state', artifactId, reason: 'matrix state missing' })
        continue
      }
      const [baseline, candidate] = await Promise.all([
        readArtifact(baselineDir, artifactId),
        readArtifact(candidateDir, artifactId),
      ])
      differences.push(...compareCapture(baseline.manifest, candidate.manifest, artifactId))
      if (!baseline.pixels.equals(candidate.pixels)) {
        if (options.diffDir) {
          renderer ??= await createDiffRenderer(options.diffDir)
          const diff = await renderer.render(artifactId, baseline.pixels, candidate.pixels)
          if (diff.different > 0) {
            differences.push({
              layer: 'pixels',
              artifactId,
              diffPath: diff.path,
              differentPixels: diff.different,
            })
          } else {
            const index = differences.findIndex(
              (item) => item.layer === 'pixels' && item.artifactId === artifactId,
            )
            if (index >= 0) differences.splice(index, 1)
          }
        } else {
          differences.push({
            layer: 'pixels',
            artifactId,
            reason: 'PNG bytes differ; pass --diff-dir for pixel diff',
          })
        }
      }
    }
  } finally {
    await renderer?.close()
  }
  return differences
}

function fixture() {
  return {
    pixels: 'PNG-BYTES-BASELINE',
    text: { empty: 'Agnes Harness\n让每一个模型，都能完成任务。' },
    accessibility: '- button "发送"',
    interaction: { tab: ['new'], enter: { opened: true }, escape: { closed: true } },
  }
}

/** Deterministic comparator and reverse-mutation proof; runs without Playwright or a daemon. */
export function runSelfTest() {
  const baseline = fixture()
  assert.deepEqual(compareCapture(baseline, clone(baseline), 'fixture'), [])
  const mutations = [
    ['pixels', (value) => ({ ...value, pixels: 'PNG-BYTES-MUTATED' })],
    ['text', (value) => ({ ...value, text: { empty: 'Agnes Harness (changed)' } })],
    ['accessibility', (value) => ({ ...value, accessibility: '- button' })],
    ['interaction', (value) => ({ ...value, interaction: { ...value.interaction, tab: ['send', 'new'] } })],
  ]
  for (const [layer, mutate] of mutations) {
    const candidate = mutate(clone(baseline))
    const diffs = compareCapture(baseline, candidate, 'fixture')
    assert.deepEqual(
      diffs.map((item) => item.layer),
      [layer],
    )
  }
  const coveredRegions = new Set(STATE_MATRIX.flatMap((state) => state.regions))
  for (const region of EXPECTED_REGIONS)
    assert.equal(coveredRegions.has(region), true, `${region} is uncovered`)
  assert.equal(MATRIX_COMBINATIONS.length, STATE_MATRIX.length * 4)
  assert.equal(new Set(MATRIX_COMBINATIONS.map((item) => item.id)).size, MATRIX_COMBINATIONS.length)
  assert.equal(new Set(DYNAMIC_MASK_SELECTORS).size, DYNAMIC_MASK_SELECTORS.length)
  console.log(
    `SELF-TEST PASS ${STATE_MATRIX.length} states × 4 combinations × ${PARITY_LAYERS.length} layers; 4 reverse mutations`,
  )
}

function spawnResult(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else
        reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})\n${stderr.slice(-4000)}`))
    })
  })
}

function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      fetch(url)
        .then((response) => {
          if (response.ok) return resolvePromise()
          throw new Error(`HTTP ${response.status}`)
        })
        .catch(() => {
          if (Date.now() - started > timeoutMs) reject(new Error(`Web readiness timeout: ${url}`))
          else setTimeout(poll, 100)
        })
    }
    poll()
  })
}

async function startFixtureProvider({ holdApproval = true } = {}) {
  const apiKey = ['d31', 'deterministic', 'fixture', 'key'].join('-')
  let completion = 0
  let releaseApproval
  let approvalReleaseRequested = false
  const observations = []
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${apiKey}`) return response.writeHead(401).end()
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      return response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }))
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions')
      return response.writeHead(404).end()
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const user = JSON.stringify(body.messages.findLast((message) => message.role === 'user')?.content ?? '')
    const messages = JSON.stringify(body.messages)
    const results = body.messages.filter((message) => message.role === 'tool')
    observations.push({
      user,
      toolResults: results.length,
      tools: Array.isArray(body.tools) ? body.tools.map((tool) => tool.function?.name ?? tool.type) : [],
      messages: body.messages,
    })
    completion++
    if (user.includes('D31_PROVIDER_ERROR')) return response.writeHead(401).end('fixture rejection')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta, finish_reason = null) => {
      if (!response.destroyed)
        response.write(
          `data: ${JSON.stringify({ id: `d31-${completion}`, object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        )
    }
    if (messages.includes('D31_APPROVAL') && !results.length) {
      emit({ role: 'assistant', content: '我会先执行一个受控工具调用。\n' })
      if (holdApproval) {
        if (approvalReleaseRequested) approvalReleaseRequested = false
        else await new Promise((done) => (releaseApproval = done))
      }
      emit({
        tool_calls: [
          {
            index: 0,
            id: `d31-tool-${completion}`,
            type: 'function',
            function: { name: 'shell', arguments: JSON.stringify({ command: "printf 'd31-tool-ok\\n'" }) },
          },
        ],
      })
      emit({}, 'tool_calls')
    } else if (user.includes('D31_MARKDOWN')) {
      emit({ role: 'assistant', content: '' })
      for (const chunk of [
        '# D31 parity\n\n',
        'A **stable** markdown response with `code`.\n\n',
        '```txt\nfixture\n```\n',
      ]) {
        emit({ content: chunk })
        await new Promise((done) => setTimeout(done, 20))
      }
      emit({}, 'stop')
    } else {
      emit({ role: 'assistant', content: 'D31 fixture response.' })
      emit({}, 'stop')
    }
    if (!response.destroyed) response.end('data: [DONE]\n\n')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('D31 provider failed to bind')
  return {
    apiKey,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    releaseApproval() {
      if (releaseApproval) {
        releaseApproval()
        releaseApproval = undefined
      } else {
        approvalReleaseRequested = true
      }
    },
    observations,
    async close() {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    },
  }
}

async function reserveOrigin() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('D31 origin reservation failed')
  await new Promise((done) => server.close(done))
  return `http://127.0.0.1:${address.port}`
}

async function createRuntime(entry) {
  const root = await mkdtemp(join(tmpdir(), 'agnes-d31-'))
  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  const cwd = join(root, 'workspace')
  await mkdir(cwd, { recursive: true })
  const provider = await startFixtureProvider()
  const origin = await reserveOrigin()
  const env = {
    ...process.env,
    HOME: home,
    AGH_HOME: home,
    // D31 is the evidence namespace, not a production profile template. The local CLI ships
    // `local-dev`; using an invented profile here makes the real launcher fail before a browser
    // can observe anything and would hide a harness defect as an environment failure.
    AGNES_PROFILE: 'local-dev',
    AGNES_WEB_ORIGIN: origin,
  }
  let web
  let launchUrl
  return {
    origin,
    cwd,
    provider,
    async start() {
      web = spawn(process.execPath, [entry, 'serve', '--home', home, '--data-dir', dataDir], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      web.stdout.on('data', (chunk) => (output += String(chunk)))
      web.stderr.on('data', (chunk) => (output += String(chunk)))
      const started = Date.now()
      while (!launchUrl) {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#\S+/)
        if (match) launchUrl = match[0]
        else if (Date.now() - started > 30000)
          throw new Error(`D31 Web launch timeout\n${output.slice(-4000)}`)
        else await new Promise((done) => setTimeout(done, 100))
      }
      await waitForHttp(origin)
      return launchUrl
    },
    async stop() {
      if (web && web.exitCode === null && web.signalCode === null) {
        web.kill('SIGTERM')
        await new Promise((done) => {
          const timer = setTimeout(() => web.kill('SIGKILL'), 10000)
          web.once('exit', () => {
            clearTimeout(timer)
            done()
          })
        })
      }
      await spawnResult(
        process.execPath,
        [entry, 'daemon', 'stop', '--profile', 'local-dev', '--home', home, '--data-dir', dataDir],
        { cwd, env },
      ).catch(() => undefined)
      await provider.close()
      await rm(root, { recursive: true, force: true })
    },
    get launchUrl() {
      if (!launchUrl) throw new Error('D31 runtime has not started')
      return launchUrl
    },
  }
}

async function configureWorkbench(page, runtime) {
  await page.goto(runtime.launchUrl, { waitUntil: 'networkidle' })
  const firstRun = await page
    .locator('#config[open]')
    .isVisible()
    .catch(() => false)
  if (firstRun) {
    // The current settings contract keeps provider inputs in the account-detail dialog. The
    // outer settings dialog is intentionally open on first launch, but its hidden controls must
    // not be driven directly.
    await page.locator('#config-add-account').click()
    await page.locator('#account-dialog[open]').waitFor()
    await page.locator('#config-account-name').fill('D31 fixture')
    await page.locator('#config-provider').selectOption('deepseek')
    await page.locator('#config-base-url').fill(runtime.provider.baseUrl)
    await page.locator('#config-api-key').fill(runtime.provider.apiKey)
    await page.locator('#config-test').click()
    await page.waitForFunction(() => document.querySelector('#config-model')?.options.length > 1)
    await page.locator('#config-model').selectOption('deepseek-v4-flash')
    await page.waitForFunction(() => !document.querySelector('#config-save')?.disabled)
    await page.locator('#config-save').click()
    await page.locator('#account-dialog[open]').waitFor({ state: 'hidden' })
    await page.locator('#config-close').click()
    await page.locator('#config[open]').waitFor({ state: 'hidden' })
  } else {
    await page.locator('#prompt').waitFor({ timeout: 30000 })
  }
  if (
    !(await page
      .locator('#new-session[open]')
      .isVisible()
      .catch(() => false))
  ) {
    if (
      await page
        .locator('#prompt')
        .isDisabled()
        .catch(() => false)
    ) {
      await openMobileSidebar(page)
      await page.locator('#new').click()
    } else {
      if (
        await page
          .locator('body.sidebar-open')
          .isVisible()
          .catch(() => false)
      )
        await page.locator('#sidebar-close').click()
      await page.locator('#composer-workspace').click()
    }
  }
  await page.locator('#new-session[open]').waitFor()
  await fillWorkspacePath(page, runtime.cwd)
  await page.locator('#new-session-create').click()
  await page.locator('#prompt').waitFor()
  await page.waitForFunction(() => !document.querySelector('#prompt')?.disabled)
  await ensureSessionModel(page)
}

async function fillWorkspacePath(page, cwd) {
  const input = page.locator('#new-session-cwd')
  if (!(await input.isVisible())) await page.locator('#workspace-manual summary').click()
  await input.fill(cwd)
}

async function openMobileSidebar(page) {
  const narrow = await page.evaluate(() => matchMedia('(max-width: 720px)').matches)
  if (!narrow) return
  const toggle = page.locator('#sidebar-toggle')
  const isOpen = await page.locator('body').evaluate((node) => node.classList.contains('sidebar-open'))
  if ((await toggle.isVisible().catch(() => false)) && !isOpen) {
    await toggle.click()
    await page.waitForFunction(() => document.body.classList.contains('sidebar-open'))
  }
}

async function ensureSessionModel(page) {
  const label = page.locator('[data-model-label]')
  if ((await label.textContent())?.trim() !== '选择模型') return
  await page.locator('#model').click()
  await page.getByRole('listbox').waitFor()
  const option = page.getByRole('option').first()
  await option.waitFor()
  await option.click()
  await page.waitForFunction(
    () => (document.querySelector('[data-model-label]')?.textContent?.trim() ?? '') !== '选择模型',
  )
}

async function openSettings(page) {
  await openMobileSidebar(page)
  await page.locator('#settings').click()
  await page.locator('#config[open]').waitFor()
}

async function waitTerminal(page) {
  await page.waitForFunction(
    () => ['已完成', '执行失败', '已取消'].includes(document.querySelector('#status')?.textContent ?? ''),
    null,
    { timeout: 45000 },
  )
}

async function setupState(page, runtime, stateId) {
  if (stateId === 'admin-page') {
    await page.goto(new URL('/admin/plugins', runtime.origin).href, { waitUntil: 'networkidle' })
    return
  }
  if (stateId === 'resources-page') {
    await page.goto(new URL('/admin/resources', runtime.origin).href, { waitUntil: 'networkidle' })
    return
  }
  await configureWorkbench(page, runtime)
  if (stateId.startsWith('settings-')) {
    await openSettings(page)
    const controls = {
      'settings-model': 'model-settings',
      'settings-plugins': 'plugin-management',
      'settings-resources': 'skills-tab',
      'settings-computer-use': 'computer-use-management',
      'settings-archived': 'archived-settings',
      'settings-appearance': 'appearance-settings',
    }
    await page.locator(`#${controls[stateId]}`).click()
    return
  }
  if (stateId === 'account-dialog-before' || stateId === 'account-dialog-after') {
    await openSettings(page)
    await page.locator('#config-add-account').click()
    await page.locator('#account-dialog[open]').waitFor()
    if (stateId === 'account-dialog-after') {
      await page.locator('#config-account-name').fill('D31 fixture')
      await page.locator('#config-provider').selectOption('deepseek')
      await page.locator('#config-base-url').fill(runtime.provider.baseUrl)
      await page.locator('#config-api-key').fill(runtime.provider.apiKey)
      await page.locator('#config-test').click()
      await page.waitForFunction(() => document.querySelector('#config-model')?.options.length > 1)
    }
    return
  }
  if (stateId === 'new-session-dialog') {
    if (
      !(await page
        .locator('#new-session[open]')
        .isVisible()
        .catch(() => false))
    ) {
      if (
        await page
          .locator('body.sidebar-open')
          .isVisible()
          .catch(() => false)
      )
        await page.locator('#sidebar-close').click()
      // The composer workspace control is the product path that always opens the workspace
      // picker, even when the current session already has a selected workspace.
      await page.locator('#composer-workspace').click()
    }
    await page.locator('#new-session[open]').waitFor()
    return
  }
  if (stateId === 'composer-short') {
    await page.locator('#prompt').fill('D31 short input')
    return
  }
  if (stateId === 'composer-long') {
    await page.locator('#prompt').fill('D31 long input\n'.repeat(30))
    await page.locator('#prompt').evaluate((node) => (node.scrollTop = 0))
    return
  }
  if (stateId === 'model-open') {
    await page.locator('#model').click()
    await page.getByRole('listbox').waitFor()
    return
  }
  if (stateId === 'permission-open') {
    await page.locator('#composer-permission').click()
    await page.getByRole('listbox').waitFor()
    return
  }
  if (stateId === 'conversation-markdown') {
    await page.locator('#prompt').fill('D31_MARKDOWN')
    await page.locator('#send').click()
    await waitTerminal(page)
    return
  }
  if (stateId === 'tool-card-inline' || stateId === 'approval-pending') {
    await selectWorkspacePermission(page)
    await page.locator('#prompt').fill('D31_APPROVAL')
    await page.locator('#send').click()
    // Release the deterministic provider stream so the real tool-call/approval event can reach
    // the browser. Waiting for the card before releasing would deadlock the fixture itself.
    runtime.provider.releaseApproval()
    const approvalAction = page.locator('#approval [data-approval-key] [data-approval-action]').first()
    await approvalAction.waitFor({ state: 'visible', timeout: 45000 })
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === '等待审批')
    if (stateId === 'tool-card-inline') {
      await approvalAction.click()
      await waitTerminal(page)
    }
    return
  }
  if (stateId === 'trace-open') {
    await page.locator('#view-trace').click()
    await page.locator('#trace-panel:not([hidden])').waitFor()
    return
  }
  if (stateId === 'sidebar-menu') {
    // A fresh state must not inherit the previous viewport/theme's menu.  Without this teardown
    // the same toggle click closes the old menu on the second theme instead of opening it, which
    // turns a real interaction capture into a timing-dependent false failure.
    const menu = page.getByRole('menu')
    if (await menu.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
    }
    const mobileSidebarOpen = await page
      .locator('body')
      .evaluate((node) => node.classList.contains('sidebar-open'))
    if (mobileSidebarOpen) await page.locator('#sidebar-close').click()
    await page.locator('#prompt').fill('D31_MARKDOWN')
    await page.locator('#send').click()
    await waitTerminal(page)
    await openMobileSidebar(page)
    // A completed matrix has many historical rows.  Target the current active session instead
    // of whichever row happens to be first, then allow the just-refreshed sidebar one event turn
    // to bind its menu listener.  This keeps the capture on the same product click path while
    // avoiding a cumulative-state race that a single-state run cannot expose.
    const trigger = page.locator('#sessions .session-row[data-active="true"] button[aria-haspopup="menu"]')
    await trigger.waitFor({ state: 'visible' })
    const narrow = await page.evaluate(() => matchMedia('(max-width: 720px)').matches)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Use the product input path rather than a DOM-only click.  Merely waiting for a menu
      // node to be attached is insufficient: the session renderer keeps a hidden reusable
      // menu node around, which produced a screenshot without its promised open menu.
      if (narrow) {
        // A compact viewport stands in for touch, where hover does not exist.  Exercise the
        // equally real keyboard activation route; CSS separately keeps the visible touch slot
        // pointer-enabled.  This avoids reading a transient layout box while the sidebar list
        // finishes its last streamed redraw.
        await trigger.focus()
        await page.keyboard.press('Enter')
      } else {
        // The DSH-style affordance deliberately only accepts pointers after its parent row is
        // hovered.  Move the real mouse into that row first; a forced click or
        // `HTMLElement.click` would bypass precisely the hit-testing behaviour this capture is
        // meant to exercise. Sidebar navigation may redraw once after the streamed turn settles,
        // so re-resolve and scroll the live locator before reading its box.
        // The locator is deliberately re-resolved by Playwright.  A render between the initial
        // visibility check and this scroll only means this particular DOM node became stale;
        // retry against the current active row instead of treating that expected redraw as a
        // product failure.
        await trigger.scrollIntoViewIfNeeded().catch(() => undefined)
        let box = await trigger.boundingBox()
        if (!box) {
          await page.waitForTimeout(50)
          await trigger.scrollIntoViewIfNeeded().catch(() => undefined)
          box = await trigger.boundingBox()
        }
        if (!box) throw new Error('active session menu trigger has no layout box')
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForFunction(
          () => {
            const active = document.querySelector(
              '#sessions .session-row[data-active="true"] button[aria-haspopup="menu"]',
            )
            return active instanceof HTMLElement && getComputedStyle(active).pointerEvents !== 'none'
          },
          undefined,
          { timeout: 1_000 },
        )
        await trigger.click()
      }
      const opened = await page
        .waitForFunction(
          () => {
            const active = document.querySelector(
              '#sessions .session-row[data-active="true"] button[aria-haspopup="menu"]',
            )
            return (
              active?.getAttribute('aria-expanded') === 'true' &&
              Array.from(document.querySelectorAll('[role="menu"]')).some(
                (node) =>
                  node instanceof HTMLElement && !node.hidden && getComputedStyle(node).display !== 'none',
              )
            )
          },
          undefined,
          { timeout: 1_000 },
        )
        .then(() => true)
        .catch(() => false)
      if (opened) break
      await page.keyboard.press('Escape')
    }
    await menu.waitFor({ state: 'visible' })
  }
}

async function selectWorkspacePermission(page) {
  await page.locator('#composer-permission').click()
  const option = page.getByRole('option', { name: /工作区内修改/ })
  await option.waitFor()
  await option.click()
  await page.waitForFunction(
    () => document.querySelector('#composer-permission')?.getAttribute('aria-expanded') === 'false',
  )
}

function visible(page, selector) {
  return page
    .locator(selector)
    .isVisible()
    .catch(() => false)
}

async function elementIdentity(page) {
  return page.evaluate(() => {
    const node = document.activeElement
    if (!(node instanceof HTMLElement)) return null
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id,
      role: node.getAttribute('role'),
      label: node.getAttribute('aria-label'),
      text: (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    }
  })
}

async function keyboardContract(page) {
  // Starting from the body lets browser focus restoration race a just-closed dialog, so the
  // very first Tab can be body in one run and a sidebar row in the next.  Start from the same
  // real, visible product control on every capture; the following Tab sequence still validates
  // the actual keyboard traversal rather than a synthetic tab order.
  const newSession = page.locator('#new')
  if (await newSession.isVisible().catch(() => false)) await newSession.focus()
  // Admin/resource pages deliberately do not mount the workbench sidebar.  They retain the
  // native, unfocused start state rather than making the D31 keyboard probe depend on a control
  // that is not part of those routes.
  else
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  const tab = []
  const seen = new Set()
  for (let index = 0; index < 80; index++) {
    await page.keyboard.press('Tab')
    const active = await elementIdentity(page)
    if (!active) continue
    const key = JSON.stringify(active)
    tab.push(active)
    if (seen.has(key) && tab.length > 3) break
    seen.add(key)
  }
  const events = []
  const press = async (key, selector) => {
    const target = page.locator(selector).first()
    if (!(await target.isVisible().catch(() => false))) return
    await target.focus()
    const before = await elementIdentity(page)
    await page.keyboard.press(key)
    await page.waitForTimeout(100)
    await page
      .waitForFunction(() => document.querySelector('#status')?.textContent !== '正在准备会话')
      .catch(() => {})
    events.push({
      key,
      selector,
      before,
      after: await elementIdentity(page),
      open: await page.locator('dialog[open], [role="menu"]').count(),
    })
  }
  if (await visible(page, '#config[open]')) {
    await press('Enter', '#config-close')
    await page
      .locator('#settings')
      .click()
      .catch(() => {})
    await page
      .locator('#config[open]')
      .waitFor()
      .catch(() => {})
    await press('Escape', '#config-close')
  } else if (await visible(page, '#new-session[open]')) {
    await press('Enter', '#new-session-cancel')
    await page
      .locator('#new')
      .click()
      .catch(() => {})
    await page
      .locator('#new-session[open]')
      .waitFor()
      .catch(() => {})
    await press('Escape', '#new-session-cancel')
  } else if (await visible(page, '#account-dialog[open]')) {
    await press('Enter', '#account-dialog-close')
    await page
      .locator('#account-dialog[open]')
      .waitFor({ state: 'hidden' })
      .catch(() => {})
    await page
      .locator('#config-add-account')
      .click()
      .catch(() => {})
    await page
      .locator('#account-dialog[open]')
      .waitFor()
      .catch(() => {})
    await press('Escape', '#account-dialog-close')
  } else if (await visible(page, '#model[aria-expanded="true"]')) {
    await press('Escape', '#model')
    await press('Enter', '#model')
    await press('Escape', '#model')
  } else if (await visible(page, '#composer-permission[aria-expanded="true"]')) {
    await press('Escape', '#composer-permission')
    await press('Enter', '#composer-permission')
    await press('Escape', '#composer-permission')
  } else {
    await press('Enter', '#new')
    await press('Escape', '#new-session-cancel')
  }
  return { tab, keys: events }
}

async function settleState(page, stateId) {
  // A terminal session status arrives before the browser's projection/timeline reconciliation
  // necessarily appends every process card.  Capturing in that gap compares two legitimate but
  // different frames of the same turn.  Wait for the concrete final transcript contract instead
  // of adding an arbitrary sleep.
  if (stateId === 'conversation-markdown')
    await page.waitForFunction(() => {
      const text = document.querySelector('#transcript-content')?.textContent ?? ''
      return text.includes('D31 fixture response.') && text.includes('动态内容')
    })
  if (stateId === 'tool-card-inline')
    await page.waitForFunction(() => {
      const text = document.querySelector('#transcript-content')?.textContent ?? ''
      return text.includes('D31 fixture response.') && text.includes('执行结果')
    })
  if (stateId === 'sidebar-menu')
    await page.waitForFunction(() => {
      const text = document.querySelector('#transcript-content')?.textContent ?? ''
      return text.includes('D31 fixture response.') && text.includes('动态内容')
    })
  if (stateId === 'approval-pending')
    await page.waitForFunction(() => {
      const approval = document.querySelector('#approval [data-approval-key]')
      return (
        approval instanceof HTMLElement &&
        !approval.hidden &&
        document.querySelector('#status')?.textContent === '等待审批'
      )
    })
  if (stateId === 'settings-plugins')
    await page.locator('#plugin-list .plugin-empty, #plugin-list [data-plugin-id]').first().waitFor()
  if (stateId === 'settings-resources') await page.locator('#resource-list > *').first().waitFor()
  if (stateId === 'settings-archived')
    await page.locator('#archived-empty, #archived-list > *').first().waitFor()
  if (stateId === 'settings-appearance') await page.locator('#skin-option-items > *').first().waitFor()
  if (stateId === 'settings-computer-use')
    await page.waitForFunction(() => {
      const state = document.querySelector('#computer-use-state')?.textContent ?? ''
      return state !== '' && !/正在读取/u.test(state)
    })
  // Let the completed projection finish its post-commit layout pass.  This is deliberately
  // bounded after the concrete state predicates above: it covers browser layout/paint, not an
  // unbounded wait for backend work.
  await page.waitForTimeout(250)
}

async function ariaSnapshot(page) {
  const body = page.locator('body')
  if (typeof body.ariaSnapshot === 'function') return normalizeDynamic(await body.ariaSnapshot())
  if (page.accessibility && typeof page.accessibility.snapshot === 'function')
    return normalizeDynamic(await page.accessibility.snapshot({ interestingOnly: false }))
  throw new Error('Playwright accessibility snapshot API is unavailable')
}

async function capturePage(page, artifactId, outDir) {
  const pixels = `${artifactId}.png`
  // The production page has a strict style-src CSP, so inline CSS injection is not a valid
  // stabilization mechanism. Playwright's screenshot option disables CSS animations/transitions
  // at the renderer level; the explicit DOM scroll reset below covers the remaining scroll state.
  const resetScroll = () =>
    page.evaluate(() => {
      scrollTo(0, 0)
      for (const node of document.querySelectorAll('*')) {
        if (node instanceof HTMLElement && node.scrollTop) node.scrollTop = 0
      }
    })
  await resetScroll()
  // The timeline's scroll listener records that the reader intentionally left the bottom.  Give
  // that event one turn to commit, then reset once more immediately before capture; otherwise a
  // pending follow-to-bottom write can win the race in one determinism run but not the other.
  await page.waitForTimeout(50)
  await resetScroll()
  // The page may receive one final projection render while Playwright is issuing its screenshot
  // command.  Freeze only the transcript reading position for this capture window: visual parity
  // compares the same viewport, while the keyboard contract below still exercises the live UI.
  await page.evaluate(() => {
    const transcript = document.getElementById('transcript')
    if (!(transcript instanceof HTMLElement)) return
    const frozen = () => {
      if (transcript.scrollTop) transcript.scrollTop = 0
    }
    // Force the renderer to observe an intentional departure from its prior expected bottom
    // position even when the native `scrollTop = 0` write would be a no-op in this particular
    // capture.  That turns sticky follow off before the final top-of-reader frame is frozen.
    transcript.scrollTop = 1
    transcript.dispatchEvent(new Event('scroll'))
    document.addEventListener('scroll', frozen, true)
    transcript.scrollTop = 0
    // `scrollTop`'s native event can otherwise be coalesced past the screenshot command.  The
    // renderer listens for this event to turn sticky follow off and reveal its new-content cue.
    transcript.dispatchEvent(new Event('scroll'))
    window.__agnesD31TranscriptFreeze = frozen
  })
  await page.mouse.move(0, 0)
  const mask = DYNAMIC_MASK_SELECTORS.map((selector) => page.locator(selector))
  await page.screenshot({
    path: join(outDir, pixels),
    fullPage: true,
    animations: 'disabled',
    mask,
    maskColor: '#ff00ff',
  })
  await page.evaluate(() => {
    if (window.__agnesD31TranscriptFreeze)
      document.removeEventListener('scroll', window.__agnesD31TranscriptFreeze, true)
    delete window.__agnesD31TranscriptFreeze
  })
  const text = await page.locator('[data-agnes-region]').evaluateAll((nodes) => {
    const result = {}
    for (const node of nodes) {
      const region = node.getAttribute('data-agnes-region')
      if (!region) continue
      const entries = result[region] ?? []
      entries.push(node.innerText)
      result[region] = entries
    }
    return result
  })
  const accessibility = await ariaSnapshot(page)
  const interaction = await keyboardContract(page)
  await writeFile(
    join(outDir, `${artifactId}.json`),
    JSON.stringify(
      { pixels, text: normalizeDynamic(text), accessibility, interaction: normalizeDynamic(interaction) },
      null,
      2,
    ),
  )
}

async function captureMatrix(entry, outDir) {
  const { chromium } = await loadPlaywright()
  const runtime = await createRuntime(entry)
  await mkdir(outDir, { recursive: true })
  const summary = {
    kind: 'real-browser-capture',
    entry,
    fixedTime: FIXED_TIME,
    states: STATE_MATRIX.length,
    combinations: MATRIX_COMBINATIONS.length,
    layers: PARITY_LAYERS,
    startedAt: new Date().toISOString(),
    completed: false,
    results: [],
    failures: [],
  }
  const log = async (event) => appendFile(join(outDir, 'run.log'), `${JSON.stringify(event)}\n`)
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  await log({ event: 'start', entry, fixedTime: FIXED_TIME, combinations: MATRIX_COMBINATIONS.length })
  const browser = await chromium.launch({ headless: true })
  try {
    try {
      await runtime.start()
      await log({ event: 'runtime-started', origin: runtime.origin, launchUrl: runtime.launchUrl })
    } catch (error) {
      const failure = { artifactId: 'runtime', error: String(error) }
      summary.failures.push(failure)
      await mkdir(join(outDir, 'failures'), { recursive: true })
      await writeFile(join(outDir, 'failures', 'runtime.json'), JSON.stringify(failure, null, 2))
      await log({ event: 'runtime-failed', ...failure })
      throw error
    }
    const combinations = process.env.AGNES_D31_ONLY_STATE
      ? MATRIX_COMBINATIONS.filter((item) => item.stateId === process.env.AGNES_D31_ONLY_STATE)
      : MATRIX_COMBINATIONS
    for (const combination of combinations) {
      const context = await browser.newContext({
        viewport: combination.viewport,
        colorScheme: combination.theme,
      })
      const page = await context.newPage()
      try {
        if (typeof page.clock?.install !== 'function')
          throw new Error('D31 requires Playwright page.clock.install for a fixed browser time')
        await page.clock.install({ time: FIXED_TIME })
        await setupState(page, runtime, combination.stateId)
        await settleState(page, combination.stateId)
        await capturePage(page, combination.id, outDir)
        summary.results.push({ artifactId: combination.id, status: 'passed' })
        await log({ event: 'captured', artifactId: combination.id })
        console.log(`CAPTURED ${combination.id}`)
      } catch (error) {
        const failureDir = join(outDir, 'failures')
        const failure = {
          artifactId: combination.id,
          error: String(error),
          url: page.url(),
          provider: runtime.provider.observations,
        }
        await mkdir(failureDir, { recursive: true })
        await page
          .screenshot({ path: join(failureDir, `${combination.id}.png`), fullPage: true })
          .catch(() => {})
        await page
          .content()
          .then((html) => writeFile(join(failureDir, `${combination.id}.html`), html))
          .catch(() => {})
        await writeFile(join(failureDir, `${combination.id}.json`), JSON.stringify(failure, null, 2))
        summary.failures.push(failure)
        await log({ event: 'capture-failed', ...failure })
        throw error
      } finally {
        runtime.provider.releaseApproval()
        await page.close()
        await context.close()
      }
    }
    summary.completed = true
  } finally {
    summary.finishedAt = new Date().toISOString()
    await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
    await log({ event: summary.completed ? 'complete' : 'failed', failures: summary.failures.length })
    await browser.close()
    await runtime.stop()
  }
}

async function captureBuild(buildDir, outDir) {
  const entry = resolve(buildDir, 'agnes.mjs')
  await captureMatrix(entry, outDir)
}

async function buildCommit(commit, outputDir) {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('D31 commit builds require Node >=24.10; current runtime is below the repository engine')
  const checkout = await mkdtemp(join(tmpdir(), 'agnes-d31-build-'))
  try {
    await new Promise((resolvePromise, reject) => {
      const archive = spawn('git', ['archive', commit], { cwd: repoRoot })
      const extract = spawn('tar', ['-x', '-C', checkout])
      let error = ''
      archive.stderr.on('data', (chunk) => (error += String(chunk)))
      extract.stderr.on('data', (chunk) => (error += String(chunk)))
      archive.stdout.pipe(extract.stdin)
      extract.once('error', reject)
      archive.once('error', reject)
      extract.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(error))))
    })
    await mkdir(dirname(outputDir), { recursive: true })
    const sourceModules = join(repoRoot, 'node_modules')
    if (!(await readFile(join(sourceModules, '.modules.yaml'), 'utf8').catch(() => undefined)))
      throw new Error('D31 commit build requires an installed root node_modules/.modules.yaml')
    await spawnResult('cp', ['-al', sourceModules, join(checkout, 'node_modules')])
    const tsx = resolve(repoRoot, 'node_modules/.bin/tsx')
    await spawnResult(tsx, [join(checkout, 'packages/cli/tools/build-local.ts'), '--output-dir', outputDir], {
      cwd: checkout,
    })
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
}

async function compareRuns(baselineDir, candidateDir, diffDir) {
  const differences = await compareArtifactDirectories(baselineDir, candidateDir, { diffDir })
  if (differences.length) {
    console.error(JSON.stringify({ ok: false, differences }, null, 2))
    process.exitCode = 1
  } else
    console.log(`PARITY PASS ${STATE_MATRIX.length} states × 4 combinations × ${PARITY_LAYERS.length} layers`)
}

async function main(argv) {
  if (argv.includes('--self-test')) return runSelfTest()
  const capture = argv.indexOf('--capture-matrix')
  if (capture >= 0) {
    const out = argv[argv.indexOf('--out') + 1]
    const build = argv[argv.indexOf('--build') + 1]
    if (!out) throw new Error('usage: --capture-matrix --build <local-build-dir> --out <dir>')
    await captureBuild(build || dirname(cliEntry), out)
    return
  }
  const compare = argv.indexOf('--compare')
  if (compare >= 0) {
    const baseline = argv[compare + 1]
    const candidate = argv[compare + 2]
    if (!baseline || !candidate)
      throw new Error('usage: --compare <baseline-dir> <candidate-dir> [--diff-dir <dir>]')
    const diff = argv.indexOf('--diff-dir')
    await compareRuns(baseline, candidate, diff >= 0 ? argv[diff + 1] : join(candidate, 'diff'))
    return
  }
  const deterministic = argv.indexOf('--determinism')
  if (deterministic >= 0) {
    const build = argv[deterministic + 1]
    const out = argv[argv.indexOf('--out') + 1] ?? resolve(tmpdir(), 'agnes-d31-determinism')
    if (!build) throw new Error('usage: --determinism <local-build-dir> [--out <dir>]')
    const first = join(out, 'first')
    const second = join(out, 'second')
    await captureBuild(build, first)
    await captureBuild(build, second)
    await compareRuns(first, second, join(out, 'diff'))
    return
  }
  const commits = argv.indexOf('--compare-commits')
  if (commits >= 0) {
    const baseline = argv[commits + 1]
    const candidate = argv[commits + 2]
    const out = argv[argv.indexOf('--out') + 1]
    if (!baseline || !candidate || !out)
      throw new Error('usage: --compare-commits <baseline-sha> <candidate-sha> --out <dir>')
    const baselineBuild = join(out, 'baseline-build')
    const candidateBuild = join(out, 'candidate-build')
    await buildCommit(baseline, baselineBuild)
    await buildCommit(candidate, candidateBuild)
    await captureBuild(baselineBuild, join(out, 'baseline-capture'))
    await captureBuild(candidateBuild, join(out, 'candidate-capture'))
    await compareRuns(join(out, 'baseline-capture'), join(out, 'candidate-capture'), join(out, 'diff'))
    return
  }
  console.log(
    `Web parity matrix: ${STATE_MATRIX.length} states × 4 combinations; layers: ${PARITY_LAYERS.join(', ')}`,
  )
  console.log(
    'Run --self-test, --capture-matrix --build <dir> --out <dir>, --determinism <dir>, or --compare-commits <base> <candidate> --out <dir>.',
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))

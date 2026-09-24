// Opt-in real-browser acceptance: AGNES_PLAYWRIGHT_MODULE points to an installed playwright entry.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = resolve(process.env.AGNES_LOCAL_CLI ?? 'packages/cli/dist/local/agnes.mjs')
const modulePath = process.env.AGNES_PLAYWRIGHT_MODULE
if (!modulePath) {
  console.log('SKIP real browser acceptance: AGNES_PLAYWRIGHT_MODULE is not configured')
  process.exit(0)
}
const { chromium } = await import(pathToFileURL(modulePath).href)
const { createCredentialStore } = await import('../../packages/host/src/index.ts')
const { createClient, memoryJournal } = await import('../../packages/sdk/src/index.node.ts')
const { createPrivateDirectorySync } = await import('../../packages/system-node/src/index.ts')
const { startWorkbenchProvider } = await import('./workbench-provider.ts')
const root = await mkdtemp(join(tmpdir(), 'aw-'))
const home = join(root, 'h')
const cwd = join(root, 'w')
createPrivateDirectorySync(home)
await mkdir(cwd)
// The service fixture deliberately needs an operator grant. This isolated profile keeps local-dev's
// reviewed ceiling and adds only `services`; production profiles continue to decide this explicitly.
await mkdir(join(home, 'profiles', 'local-dev'), { recursive: true, mode: 0o700 })
await writeFile(
  join(home, 'profiles', 'local-dev', 'profile.yaml'),
  `name: local-dev\npolicy:\n  capabilityCeiling: [tools, hooks, slots, events, resources, ui, services, network, network.publicRead, tools.invoke, artifacts, subagent]\n`,
)
// The lifecycle assertion uses the repository's reviewed v1/v2 fixture packages, copied into
// the isolated daemon cwd. The package source therefore exercises the same file: resolver a
// local operator uses, without reaching outside the test root after setup.
await cp(resolve('examples/packages/client-panel/v1'), join(cwd, 'client-panel-v1'), { recursive: true })
await cp(resolve('examples/packages/client-panel/v2'), join(cwd, 'client-panel-v2'), { recursive: true })
await cp(resolve('examples/packages/client-service-panel/v1'), join(cwd, 'client-service-panel-v1'), {
  recursive: true,
})
await cp(resolve('examples/packages/client-service-panel/v2'), join(cwd, 'client-service-panel-v2'), {
  recursive: true,
})
await cp(resolve('examples/packages/client-multi-panel/v1'), join(cwd, 'client-multi-panel-v1'), {
  recursive: true,
})
await cp(resolve('examples/packages/client-multi-panel/v2'), join(cwd, 'client-multi-panel-v2'), {
  recursive: true,
})
const dshFixtures = ['dsh-input-controls', 'dsh-model-picker-a', 'dsh-model-picker-b', 'dsh-tool-view']
for (const family of dshFixtures) {
  for (const release of ['v1', 'v2', 'broken']) {
    await cp(resolve(`examples/packages/${family}/${release}`), join(cwd, `${family}-${release}`), {
      recursive: true,
    })
  }
}
const failureFixtureRoot = join(cwd, 'client-module-failure-fixtures')
await mkdir(failureFixtureRoot, { recursive: true })
const failureFixtures = {}
const failurePackageId = '@agnes-examples/client-panel-failure'
for (const [name, version, entry, label] of [
  [
    'recovery-0',
    '2.0.0',
    "export function apply(ctx) { ctx.slots.register('ui:sidebar', () => 'fixture recovery 0', { priority: -2 }) }\n",
    'fixture recovery 0',
  ],
  [
    'import-404',
    '3.0.0',
    "export function apply(ctx) { ctx.slots.register('ui:sidebar', () => 'fixture import 404', { priority: -2 }) }\n",
    'fixture import 404',
  ],
  ['syntax', '4.0.0', 'export function apply(ctx) { await Promise.resolve() }\n', 'fixture syntax'],
  [
    'stylesheet-404',
    '5.0.0',
    "export function apply(ctx) { ctx.slots.register('ui:sidebar', () => 'fixture stylesheet 404', { priority: -2 }) }\n",
    'fixture stylesheet 404',
  ],
  [
    'apply-failure',
    '6.0.0',
    "export function apply(ctx) { ctx.slots.register('ui:sidebar', () => 'fixture apply failure', { priority: -2 }); throw new Error('fixture apply failure') }\n",
    'fixture apply failure',
  ],
  [
    'recovery-1',
    '7.0.0',
    "export function apply(ctx) { ctx.slots.register('ui:sidebar', () => 'fixture recovery 1', { priority: -2 }) }\n",
    'fixture recovery 1',
  ],
  [
    'recovery-2',
    '8.0.0',
    "export function apply(ctx) { ctx.slots.register('ui:sidebar', () => 'fixture recovery 2', { priority: -2 }) }\n",
    'fixture recovery 2',
  ],
  [
    'recovery-3',
    '9.0.0',
    "export function apply(ctx) { ctx.slots.register('ui:sidebar', () => 'fixture recovery 3', { priority: -2 }) }\n",
    'fixture recovery 3',
  ],
  [
    'recovery-4',
    '10.0.0',
    "export function apply(ctx) { ctx.slots.register('ui:sidebar', () => 'fixture recovery 4', { priority: -2 }) }\n",
    'fixture recovery 4',
  ],
]) {
  const destination = join(failureFixtureRoot, name)
  await cp(resolve('examples/packages/client-panel/v1'), destination, { recursive: true })
  await writeFile(
    join(destination, 'package.json'),
    `${JSON.stringify({ name: failurePackageId, version, type: 'module', license: 'MIT', private: true, agnes: { extensions: ['./extensions/main'] } }, null, 2)}\n`,
  )
  await writeFile(
    join(destination, 'extensions/main/agnes.extension.json'),
    `${JSON.stringify({ id: 'examples/client-panel-failure', version, apiRange: '^1.1', entry: './index.mjs', runtime: { supports: ['in-process'] }, capabilities: { ui: ['client'] }, contributes: { client: { entry: './client/index.js', styles: ['./client/index.css'], slots: ['ui:sidebar'], publicConfig: { label }, services: [], projections: [] } } }, null, 2)}\n`,
  )
  await writeFile(join(destination, 'extensions/main/client/index.js'), entry)
  failureFixtures[name] = { type: 'file', ref: `file:./client-module-failure-fixtures/${name}` }
}
const reserve = createServer()
await new Promise((done) => reserve.listen(0, '127.0.0.1', done))
const port = reserve.address().port
await new Promise((done) => reserve.close(done))
const origin = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  HOME: home,
  AGH_HOME: home,
  AGNES_PROFILE: 'local-dev',
  AGNES_WEB_ORIGIN: origin,
}
const command = (args) =>
  new Promise((done, reject) => {
    const child = execFile(
      process.execPath,
      [entry, ...args],
      { cwd, env, timeout: 45000, windowsHide: true },
      (error, stdout) => (error ? reject(new Error(`CLI ${args[0]} failed`)) : done(stdout)),
    )
    child.stdin.end()
  })
const provider = await startWorkbenchProvider({ holdApproval: true, dshToolName: 'bash' })
let web
let browser
const artifacts = resolve(process.env.AGNES_WEB_ARTIFACTS ?? join(tmpdir(), 'agnes-web-workbench-artifacts'))
await mkdir(artifacts, { recursive: true })
const focusedRunComplete = Symbol('focused model hot-update acceptance complete')
const checks = []
const checkpoint = (label) => {
  checks.push(label)
  console.log(`PASS ${label}`)
}

async function waitForPackageOperation(client, receipt) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const operation = await client.packages.operation.get({
      profile: receipt.profile,
      operationId: receipt.operationId,
    })
    if (['completed', 'rolled-back'].includes(operation.state)) return operation
    if (['failed', 'cancelled'].includes(operation.state)) {
      throw new Error(
        `package ${operation.operation} ${operation.error?.safeMessage ?? operation.state}: ${JSON.stringify(operation)}`,
      )
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`package operation ${receipt.operationId} did not finish`)
}

/** The browser only imports an immutable row after the daemon has published its roster snapshot. */
async function waitForClientModuleRow(client, packageId) {
  let last
  for (let attempt = 0; attempt < 150; attempt++) {
    last = await client.clientModules.list('local-dev')
    if (last.rows.some((row) => row.packageId === packageId && row.enabled && row.phase === 'ready')) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`client module row was not published for ${packageId}: ${JSON.stringify(last)}`)
}

async function inspectPackage(client, clientId, commandId, source) {
  const receipt = await client.packages.inspect({ profile: 'local-dev', clientId, commandId, source })
  const operation = await waitForPackageOperation(client, receipt)
  if (!operation.preview) throw new Error('package inspection completed without a preview')
  return operation.preview
}

async function installAndEnableClientFixture(client, clientId, commandId, id, source) {
  const preview = await inspectPackage(client, clientId, commandId('inspect'), source)
  assert.deepEqual(preview.blockers, [])
  const install = await client.packages.install({
    profile: 'local-dev',
    clientId,
    commandId: commandId('install'),
    source,
    expectedIntegrity: preview.integrity,
  })
  await waitForPackageOperation(client, install)
  const trust = await client.packages.trust({
    profile: 'local-dev',
    clientId,
    commandId: commandId('trust'),
    id,
    expectedIntegrity: preview.integrity,
    capabilityHash: preview.capabilityHash ?? '',
  })
  await waitForPackageOperation(client, trust)
  const enable = await client.packages.enable({
    profile: 'local-dev',
    clientId,
    commandId: commandId('enable'),
    id,
  })
  await waitForPackageOperation(client, enable)
  await waitForClientModuleRow(client, id)
  return preview
}

async function updateDshClientFixture(
  client,
  clientId,
  commandId,
  id,
  source,
  previousIntegrity,
  { waitForReady = true } = {},
) {
  const preview = await inspectPackage(client, clientId, commandId('inspect'), source)
  assert.deepEqual(preview.blockers, [])
  const update = await client.packages.update({
    profile: 'local-dev',
    clientId,
    commandId: commandId('update'),
    id,
    source,
    expectedIntegrity: preview.integrity,
    activation: {
      expectedInstalledIntegrity: previousIntegrity,
      expectedActiveIntegrity: null,
      trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash ?? '' },
    },
  })
  await waitForPackageOperation(client, update)
  if (waitForReady) await waitForClientModuleRow(client, id)
  return preview
}

async function openPluginManagement(page) {
  if (!(await page.locator('#config[open]').count())) {
    await page.locator('#settings').click()
  }
  await page.locator('#config[open]').waitFor()
  await page.locator('#plugin-management').click()
  await page.locator('#plugin-settings-pane').waitFor({ state: 'visible' })
  await page.locator('#plugin-list').waitFor()
}

async function closePluginManagement(page) {
  await page.locator('#config-close').click()
  await page.locator('#config[open]').waitFor({ state: 'hidden' })
}

async function assertBrowserRuntimeFailure(page, packageId, expectedReason) {
  const row = page.locator(`.plugin-row[data-plugin-id="${packageId}"]`)
  await row.waitFor()
  await row.getByText('加载失败，可重试', { exact: true }).waitFor()
  await row.click()
  const detail = page.locator('#plugin-detail[open]')
  await detail.waitFor()
  assert.equal(await detail.getByText(expectedReason, { exact: true }).count(), 1)
  await detail.getByRole('button', { name: `关闭 ${packageId} 的详情` }).click()
}
/**
 * Account fields intentionally live in the account dialog, not invisibly in the settings rail.
 * The acceptance path follows the same explicit add/edit action that a person uses, which catches
 * regressions in the split settings-pane lifecycle instead of bypassing it through hidden DOM.
 */
async function openSettingsAccount(page) {
  const accountDialog = page.locator('#account-dialog')
  if (await accountDialog.isVisible()) return
  const existing = page.locator('#config-accounts .config-account-select').first()
  if ((await existing.count()) > 0) await existing.click()
  else {
    await page.locator('#config-add-account').click()
    // A new account is a first-class entity; its label is not inferred from an API key or URL.
    await accountDialog.waitFor()
    await page.locator('#config-account-name').fill('Workbench fixture account')
  }
  await accountDialog.waitFor()
}
async function fillWorkspacePath(page, value) {
  const input = page.locator('#new-session-cwd')
  if (!(await input.isVisible())) await page.locator('#workspace-manual summary').click()
  await input.fill(value)
}
async function startNextTask(page) {
  await page.locator('#new').click()
  await page.locator('#prompt').waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled)
}
async function launchWeb() {
  web = spawn(process.execPath, [entry, 'serve'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return await new Promise((done, reject) => {
    let output = ''
    let errors = ''
    web.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    const timer = setTimeout(() => reject(new Error('Web readiness timeout')), 30000)
    web.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`Web exited before ready: ${errors.replace(/#[^\s]+/g, '#[redacted]')}`))
    })
    web.stdout.on('data', (chunk) => {
      output += String(chunk)
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#[^\s]+/)
      if (match) {
        clearTimeout(timer)
        done(match[0])
      }
    })
  })
}
async function stopWeb() {
  if (!web || web.exitCode !== null || web.signalCode !== null) return
  await new Promise((done) => {
    const child = web
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    child.kill('SIGTERM')
  })
}
try {
  const launch = await launchWeb()
  const ownerPath = join(home, 'data', 'daemon', 'owner.json')
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let socketRoute
  let dropConnections = false
  let failClientImport = false
  let failClientStyles = false
  await page.route('**/plugins/**', (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (failClientImport && pathname.endsWith('/client/index.js')) {
      void route.abort('failed')
      return
    }
    if (failClientStyles && pathname.endsWith('/client/index.css')) {
      void route.abort('failed')
      return
    }
    void route.continue()
  })
  await page.routeWebSocket('**/*', (route) => {
    if (dropConnections) {
      void route.close({ code: 1012, reason: 'controlled transport interruption' })
      return
    }
    socketRoute = route
    route.connectToServer()
  })
  const errors = []
  let navigationCount = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigationCount++
  })
  let modelSwitchRequests = 0
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      try {
        if (JSON.parse(String(payload)).method === '_agnes/v1/session.setModel') modelSwitchRequests++
      } catch {
        // Only complete JSON-RPC method frames count; never log credentials or frame bodies.
      }
    })
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(launch)
  await page.locator('#config[open]').waitFor()
  await openSettingsAccount(page)
  await page.locator('#config-provider').selectOption('deepseek')
  await page.locator('#config-base-url').fill(provider.baseUrl)
  await page.locator('#config-api-key').fill('incorrect-fixture-key')
  await page.locator('#config-test').click()
  await page.waitForFunction(() => document.querySelector('#config-error').textContent.length > 0)
  assert(await page.locator('#config-save').isDisabled())
  await page.locator('#config-api-key').fill(provider.apiKey)
  await page.locator('#config-test').click()
  await page.waitForFunction(() => document.querySelector('#config-model').options.length > 1)
  await page.locator('#config-model').selectOption('deepseek-v4-flash')
  await page.waitForFunction(() => !document.querySelector('#config-save').disabled)
  await page.screenshot({ path: join(artifacts, '00-settings.png'), fullPage: true, animations: 'disabled' })
  await page.locator('#config-save').click()
  await page.locator('#account-dialog[open]').waitFor({ state: 'hidden' })
  await page.locator('#config-close').click()
  await page.locator('#config[open]').waitFor({ state: 'hidden' })
  await page.locator('#new').click()
  await page.locator('#new-session[open]').waitFor()
  await page.screenshot({ path: join(artifacts, '00-new-task.png'), fullPage: true, animations: 'disabled' })
  await fillWorkspacePath(page, cwd)
  await page.locator('#new-session-create').click()
  await page.locator('#prompt').waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled)
  assert(await page.locator('#send').isDisabled())
  assert.equal(await page.locator('#config-api-key').inputValue(), '')
  assert(!page.url().includes('#'))
  checkpoint('first-run Provider failure/correction/test/model/save and task creation')
  const composerBox = await page.locator('#composer').boundingBox()
  const modelBox = await page.locator('#model').boundingBox()
  assert(modelBox.width < composerBox.width / 2, 'model control should remain compact')
  assert(composerBox.height <= 128, 'idle desktop composer should be compact')
  assert.equal(await page.locator('#send').getAttribute('aria-label'), '发送')
  await page.screenshot({ path: join(artifacts, '00-empty.png'), fullPage: true, animations: 'disabled' })
  await page.locator('#prompt').fill('检查这个项目，说明主要模块的职责。')
  assert(await page.locator('#send').isEnabled())
  await page.screenshot({ path: join(artifacts, '00-composer.png'), fullPage: true, animations: 'disabled' })
  await page.locator('#prompt').fill('逐步检查代码，并保留验证证据。\n'.repeat(30))
  const longInput = await page.locator('#prompt').evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    scroll: node.scrollHeight,
    overflow: getComputedStyle(node).overflowY,
  }))
  assert(longInput.height <= 180 && longInput.scroll > longInput.height && longInput.overflow === 'auto')
  await page.locator('#prompt').fill('')
  assert(await page.locator('#send').isDisabled())
  checkpoint('compact composer keeps accessible send, narrow model, draft growth and blank protection')
  const modelTrigger = page.locator('#model')
  const modelList = page.getByRole('listbox')
  await modelTrigger.click()
  await modelList.waitFor()
  assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'true')
  assert.equal(await modelList.getByRole('option').count(), 1)
  assert.equal(await modelList.getByRole('option', { name: '选择模型', exact: true }).count(), 0)
  // Saving the account seeds the new-session draft from its configured default model. This is a
  // confirmed selection, not just the keyboard active descendant; the same option is asserted
  // selected again after a reopen below.
  assert.equal(await modelList.getByRole('option').getAttribute('aria-selected'), 'true')
  await page.screenshot({
    path: join(artifacts, '00-model-open.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await modelList.waitFor({ state: 'hidden' })
  assert(await modelTrigger.evaluate((node) => node === document.activeElement))
  assert.equal(modelSwitchRequests, 0)
  await modelTrigger.click()
  await page.locator('#prompt').click()
  await modelList.waitFor({ state: 'hidden' })
  assert.equal(modelSwitchRequests, 0)
  await modelTrigger.press('ArrowDown')
  await modelList.waitFor({ state: 'visible' })
  await page.keyboard.press('Shift+Tab')
  await modelList.waitFor({ state: 'hidden' })
  // The listbox owns a portal. Both Tab directions dismiss it back to its trigger; this keeps
  // focus in the ordinary document order rather than dropping it on a removed portal node.
  assert(await modelTrigger.evaluate((node) => node === document.activeElement))
  assert.equal(modelSwitchRequests, 0)
  checkpoint('model popover opens real candidates; Escape and outside click cancel without writes')

  await page.setViewportSize({ width: 320, height: 740 })
  await modelTrigger.click()
  const listBox = await modelList.boundingBox()
  assert(listBox.x >= 0 && listBox.x + listBox.width <= 320)
  assert(listBox.y >= 0 && listBox.y + listBox.height <= 740)
  await page.screenshot({
    path: join(artifacts, '00-model-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await modelTrigger.click()
  await modelList.getByRole('option').click()
  await page.waitForFunction(
    () =>
      document.querySelector('#model').textContent.includes('deepseek-v4-flash') &&
      !document.querySelector('#model').disabled,
  )
  // This is still a draft session. Its chosen model is carried into session creation instead of
  // issuing a write for a session that does not yet exist.
  assert.equal(modelSwitchRequests, 0)
  await modelTrigger.click()
  assert.equal(await modelList.getByRole('option').getAttribute('aria-selected'), 'true')
  await page.screenshot({
    path: join(artifacts, '00-model-selected.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  checkpoint('320px model popover fits; draft selection is retained without a premature daemon write')
  let sessionUrl = page.url()
  const send = async (text) => {
    await page.locator('#prompt').fill(text)
    await page.locator('#send').click()
  }
  const terminal = async (text = '已完成') =>
    page.waitForFunction((label) => document.querySelector('#status').textContent === label, text, {
      timeout: 45000,
    })
  if (process.env.AGNES_WEB_ACCEPTANCE_FOCUS === 'model-hot-update') {
    await send('WB_MODEL_HOT_UPDATE_BEFORE')
    await terminal()
    const peerPage = await context.newPage()
    await peerPage.goto(launch)
    await peerPage.waitForFunction(() => !document.querySelector('#model')?.disabled)
    await page.locator('#settings').click()
    await page.locator('#config-add-account').click()
    await page.locator('#config-account-name').fill('热更新验收账户')
    await page.locator('#config-provider').selectOption('deepseek')
    await page.locator('#config-base-url').fill(provider.baseUrl)
    await page.locator('#config-api-key').fill(provider.apiKey)
    await page.locator('#config-test').click()
    await page.waitForFunction(() => document.querySelector('#config-model').options.length > 1)
    await page.locator('#config-model').selectOption('deepseek-v4-flash')
    await page.locator('#config-save').click()
    await page.locator('#account-dialog[open]').waitFor({ state: 'hidden' })
    // Reproduce the reported outside-click dismissal, rather than only the explicit close button.
    await page.mouse.click(3, 3)
    await page.locator('#config[open]').waitFor({ state: 'hidden' })
    for (const id of ['model', 'composer-workspace', 'composer-permission', 'new', 'prompt'])
      assert(await page.locator(`#${id}`).isEnabled(), `${id} remains enabled after save`)
    await page.locator('#model').click()
    await page.getByRole('option').filter({ hasText: '热更新验收账户' }).click()
    await send('WB_MODEL_HOT_UPDATE_AFTER')
    await terminal()
    await page.locator('#composer-permission').click()
    assert(await page.getByRole('listbox').isVisible())
    await page.keyboard.press('Escape')
    await page.locator('#composer-workspace').click()
    await page.locator('#new-session[open]').waitFor()
    await page.keyboard.press('Escape')
    // A second already-open page learns the new account without reload or protocol changes.
    await peerPage.locator('#model').click()
    await peerPage.getByRole('option').filter({ hasText: '热更新验收账户' }).waitFor()
    await peerPage.close()
    await page.locator('#new').click()
    await page.waitForFunction(() => !document.querySelector('#model').disabled)
    for (const id of ['composer-workspace', 'composer-permission', 'prompt'])
      assert(await page.locator(`#${id}`).isEnabled())
    await send('WB_MODEL_HOT_UPDATE_NEW_SESSION')
    await terminal()
    assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).generation, owner.generation)
    assert.deepEqual(errors, [])
    await page.screenshot({
      path: join(artifacts, 'model-hot-update.png'),
      fullPage: true,
      animations: 'disabled',
    })
    checkpoint(
      'model hot update: existing session, outside dismissal, pickers, second client and new session',
    )
    throw focusedRunComplete
  }
  await send('WB_STREAM')
  await page.waitForFunction(
    () =>
      document.querySelector('#transcript').scrollHeight >
      document.querySelector('#transcript').clientHeight + 200,
  )
  assert((await page.locator('#status').innerText()).startsWith('正在执行'))
  // Freeze the CSS-only smooth behavior while producing an immediate browser scroll event. This
  // lets the assertion observe the reader contract itself, instead of a transient animation frame.
  await page.locator('#transcript').evaluate((area) => {
    const previousBehavior = area.style.scrollBehavior
    try {
      area.style.scrollBehavior = 'auto'
      area.scrollTop = Math.min(80, Math.max(1, area.scrollHeight - area.clientHeight))
      area.dispatchEvent(new Event('scroll'))
      area.scrollTop = 0
      area.dispatchEvent(new Event('scroll'))
    } finally {
      area.style.scrollBehavior = previousBehavior
    }
  })
  await page.waitForFunction(
    () =>
      document.querySelector('#transcript').scrollTop < 20 && !document.querySelector('#new-content').hidden,
  )
  const selected = await page.locator('#transcript').evaluate((area) => {
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode()
    while (text && !text.textContent.includes('第 1 项')) text = walker.nextNode()
    if (!text) throw new Error('stream text unavailable')
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(8, text.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  })
  await terminal()
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selected)
  assert((await page.locator('#transcript').evaluate((area) => area.scrollTop)) < 20)
  assert.equal(await page.evaluate(() => window.workbenchUnsafe), undefined)
  await page.locator('#new-content').click()
  await page.screenshot({ path: join(artifacts, '01-reading.png'), fullPage: true, animations: 'disabled' })
  checkpoint('streaming preserves selection/scroll and renders untrusted text safely')
  await startNextTask(page)
  await send('WB_APPROVAL')
  await page.waitForFunction((previous) => location.href !== previous, sessionUrl)
  sessionUrl = page.url()
  await page.waitForFunction(() =>
    document.querySelector('#transcript').textContent.includes('我会先检查工作目录'),
  )
  await page.screenshot({ path: join(artifacts, '01-executing.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 320, height: 740 })
  await page.locator('#prompt').fill('完成后再总结一下。')
  assert.equal(await page.locator('#send').getAttribute('aria-label'), '加入下一轮')
  for (const selector of ['#send', '#cancel', '#model']) {
    const box = await page.locator(selector).boundingBox()
    assert(box && box.x >= 0 && box.x + box.width <= 320, `${selector} must stay reachable at 320px`)
  }
  await page.screenshot({
    path: join(artifacts, '01-mobile-running.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.locator('#prompt').fill('')
  await page.setViewportSize({ width: 1440, height: 1000 })
  checkpoint('320px running composer retains separate stop and next-round actions')
  provider.continueTool()
  await page.locator('#approval:not([hidden]) button').first().waitFor({ timeout: 45000 })
  assert.equal(await page.locator('#status').innerText(), '等待审批')
  await page.screenshot({ path: join(artifacts, '02-approval.png'), fullPage: true, animations: 'disabled' })
  const peerPage = await context.newPage()
  const peerUrl = new URL(launch)
  peerUrl.search = new URL(sessionUrl).search
  await peerPage.goto(peerUrl.href)
  await peerPage.waitForFunction(() => document.querySelector('#connection').dataset.state === 'connected')
  await peerPage.waitForFunction(() => document.querySelector('#transcript .tool'))
  await page.locator('#approval button').first().click()
  await terminal()
  await peerPage.waitForFunction(() => document.querySelector('#status').textContent === '已完成')
  assert(await peerPage.locator('#approval').isHidden())
  assert.equal(await peerPage.locator('#transcript .tool').count(), 1)
  assert.equal(await page.locator('#transcript .tool').count(), 1)
  await peerPage.close()
  checkpoint('second Web client observes same approval result without duplicate tools')
  assert((await page.locator('#transcript').innerText()).includes('工具结果已经返回'))
  await page.screenshot({ path: join(artifacts, '03-completed.png'), fullPage: true, animations: 'disabled' })
  checkpoint('real shell permission/result and completed turn')
  await send('WB_STREAM keep prior tool detail open during output')
  await page.waitForFunction(() => document.querySelector('#transcript').textContent.includes('第 1 项'))
  assert((await page.locator('#status').innerText()).startsWith('正在执行'))
  const tool = page.locator('#transcript .tool button').last()
  await tool.click()
  await page.locator('#transcript .tool-detail-body:not([hidden])').waitFor()
  assert.equal(await tool.getAttribute('aria-expanded'), 'true')
  assert((await page.locator('#transcript .tool-detail-body').innerText()).includes('workbench-ok'))
  await terminal()
  assert.equal(await tool.getAttribute('aria-expanded'), 'true')
  assert((await page.locator('#transcript .tool-detail-body').innerText()).includes('workbench-ok'))
  await page.screenshot({
    path: join(artifacts, '03-tool-detail-expanded.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await tool.click()
  assert.equal(await tool.getAttribute('aria-expanded'), 'false')
  assert(await tool.evaluate((node) => node === document.activeElement))
  checkpoint('inline tool detail persists across streaming and restores keyboard focus')
  await send('WB_FAILURE')
  await page.locator('#approval:not([hidden]) button').first().waitFor()
  await page.locator('#approval button').first().click()
  await terminal()
  assert((await page.locator('#transcript').innerText()).includes('失败'))
  checkpoint('real failed tool remains visible')
  await send('WB_PROVIDER_ERROR')
  await terminal('执行失败')
  checkpoint('model request failure has explicit failed terminal')
  await send('WB_CANCEL pending approval')
  await page.locator('#approval:not([hidden]) button').first().waitFor()
  const beforePendingCancel = provider.completions
  await page.locator('#cancel').click()
  await page.waitForFunction(
    () => document.querySelector('#prompt').disabled && document.querySelector('#send').disabled,
  )
  await page.locator('#cancel').evaluate(() => {
    const prompt = document.querySelector('#prompt')
    prompt.value = 'MUST_NOT_QUEUE_DURING_STOP'
    document.querySelector('#composer').requestSubmit()
  })
  await terminal('已取消')
  await page.locator('#approval').waitFor({ state: 'hidden' })
  assert.equal(provider.completions, beforePendingCancel)
  assert(
    !(await page.locator('#transcript .user').allTextContents()).some((text) =>
      text.includes('MUST_NOT_QUEUE_DURING_STOP'),
    ),
  )
  checkpoint('cancel during approval clears card and prevents follow-up admission')
  await send('WB_CANCEL')
  await page.locator('#approval:not([hidden]) button').first().waitFor()
  await page.locator('#approval button').first().click()
  await page.waitForFunction(() => document.querySelector('#transcript').textContent.includes('正在执行'))
  await page.locator('#cancel').click()
  await terminal('已取消')
  checkpoint('Stop waits for real cancelled terminal')
  await page.reload()
  await terminal('已取消')
  assert.equal(page.url(), sessionUrl)
  assert((await page.locator('#transcript').innerText()).includes('工具结果已经返回'))
  assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).generation, owner.generation)
  checkpoint('refresh restores selected session, history and terminal without new daemon')
  dropConnections = true
  await socketRoute.close({ code: 1012, reason: 'controlled transport interruption' })
  await page.waitForFunction(() => document.querySelector('#connection').dataset.state !== 'connected')
  assert.equal(await page.locator('#status').innerText(), '已取消')
  dropConnections = false
  await page.waitForFunction(() => document.querySelector('#connection').dataset.state === 'connected')
  checkpoint('transport reconnect separate from execution state')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#sidebar-toggle').click()
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().left >= 0)
  await page.screenshot({
    path: join(artifacts, '04-mobile-navigation.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.locator('#settings').click()
  await page.locator('#config[open]').waitFor()
  assert.equal(await page.locator('#config-api-key').inputValue(), '')
  await page.keyboard.press('Escape')
  assert(await page.locator('#settings').evaluate((node) => node === document.activeElement))
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () =>
      !document.body.classList.contains('sidebar-open') &&
      document.querySelector('.sidebar').getBoundingClientRect().right <= 0,
  )
  assert(await page.locator('#sidebar-toggle').evaluate((node) => node === document.activeElement))
  assert(await page.locator('.sidebar').evaluate((node) => node.inert))
  assert(!(await page.locator('main').evaluate((node) => node.inert)))
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390)
  const smallTargets = await page.locator('button,input,select').evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const r = node.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && node.checkVisibility() && r.height < 44
      })
      .map((node) => node.id),
  )
  assert.deepEqual(smallTargets, [])
  const mobileTool = page.locator('#transcript .tool button').last()
  const mobileProcess = mobileTool
    .locator('xpath=ancestor::details[contains(@class, "turn-process")]')
    .first()
  if (!(await mobileProcess.evaluate((node) => node.open)))
    await mobileProcess.locator(':scope > summary').click()
  await mobileTool.scrollIntoViewIfNeeded()
  await mobileTool.click()
  const mobileDetailBody = mobileTool
    .locator('xpath=ancestor::article[contains(@class, "tool")][1]')
    .locator('.tool-detail-body')
  await mobileDetailBody.waitFor()
  const mobileDetail = await mobileDetailBody.boundingBox()
  assert(mobileDetail.x >= 0 && mobileDetail.x + mobileDetail.width <= 390)
  assert((await mobileDetailBody.innerText()).includes('工具：'))
  await page.screenshot({
    path: join(artifacts, '04-mobile-tool-detail.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await mobileTool.click()
  assert(await mobileTool.evaluate((node) => node === document.activeElement))
  await page.locator('#sidebar-toggle').focus()
  await page.screenshot({ path: join(artifacts, '04-mobile.png'), fullPage: true, animations: 'disabled' })
  checkpoint('390px navigation/settings/inline tool detail and keyboard dismissal')
  await page.setViewportSize({ width: 320, height: 700 })
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 320)
  await page.screenshot({
    path: join(artifacts, '05-mobile-320.png'),
    fullPage: true,
    animations: 'disabled',
  })
  checkpoint('320px task and composer stay within the viewport')
  await page.setViewportSize({ width: 1024, height: 800 })
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1024)
  await page.screenshot({ path: join(artifacts, '06-tablet.png'), fullPage: true, animations: 'disabled' })
  checkpoint('1024px workbench keeps a readable task column')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const selector of ['#composer', '#config', '#new-session']) {
    const seconds = await page.locator(selector).evaluate((node) =>
      getComputedStyle(node)
        .transitionDuration.split(',')
        .map((value) => Number.parseFloat(value)),
    )
    assert(
      seconds.every((value) => value === 0),
      `${selector} must respect reduced motion`,
    )
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  checkpoint('rounded panels respect reduced-motion preference')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await stopWeb()
  await command(['daemon', 'stop'])
  const restarted = new URL(await launchWeb())
  restarted.search = new URL(sessionUrl).search
  await page.goto(restarted.href)
  await page.waitForFunction(
    () => !location.hash && document.querySelector('#connection').dataset.state === 'connected',
  )
  await terminal('已取消')
  assert.notEqual(JSON.parse(await readFile(ownerPath, 'utf8')).generation, owner.generation)
  assert((await page.locator('#transcript').innerText()).includes('工具结果已经返回'))
  checkpoint('backend stop/relaunch restores same browser task with new lifecycle credential')

  const currentOwner = JSON.parse(await readFile(ownerPath, 'utf8'))
  const peer = createClient({
    transport: { kind: 'unix', path: currentOwner.socketPath },
    auth: { kind: 'local' },
    journal: memoryJournal(),
  })
  try {
    await page.locator('#settings').click()
    await page.locator('#config[open]').waitFor()
    await openSettingsAccount(page)
    // The configuration test endpoint accepts an explicit candidate secret. Re-enter the fixture
    // secret after daemon relaunch so this stale-write check tests revision handling, not secret
    // retrieval semantics (the persisted secret is never read back into the DOM).
    // Re-enter the loopback endpoint too. A reconnect intentionally clears transient form state;
    // the acceptance probe must not mistake that UI safety behavior for a provider regression.
    await page.locator('#config-base-url').fill(provider.baseUrl)
    await page.locator('#config-api-key').fill(provider.apiKey)
    const restartSnapshot = await peer.config.get()
    const restartAccount = restartSnapshot.accounts?.find(
      (entry) => entry.accountId === restartSnapshot.defaultAccountId,
    )
    if (!restartAccount) throw new Error('fixture account did not survive backend restart')
    const restartVerification = await peer.config.test({
      providerId: 'deepseek',
      accountId: restartAccount.accountId,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    })
    assert.equal(restartVerification.verified, true)
    await page.locator('#config-test').click()
    await page.waitForFunction(() => document.querySelector('#config-model').options.length > 1)
    await page.locator('#config-model').selectOption('deepseek-v4-flash')
    const before = restartSnapshot
    const account = restartAccount
    if (!account) throw new Error('fixture account did not survive backend restart')
    const saved = await peer.config.save({
      providerId: 'deepseek',
      accountId: account.accountId,
      label: account.label,
      baseUrl: provider.baseUrl,
      model: 'deepseek-v4-flash',
      expectedRevision: before.revision,
    })
    await page.locator('#config-save').click()
    await page.waitForFunction(() => document.querySelector('#config-error').textContent.length > 0)
    assert.equal((await peer.config.get()).revision, saved.revision)
    await page.keyboard.press('Escape')
    await page.locator('#config-close').click()
    checkpoint('concurrent configuration revision refuses stale browser overwrite')

    // RW-07: drive the actual PackageManager control plane while the already-running browser
    // subscribes to the daemon roster. This is deliberately not a mocked inventory or direct
    // browser import: every stage below has to survive daemon → worker → Host → web-server →
    // reconciler before the visible sidebar changes.
    const packageClientId = await peer.clientId()
    let packageCommand = 0
    const commandId = (operation) => `browser-lifecycle-${operation}-${++packageCommand}`
    const dshSource = (family, release) => ({ type: 'file', ref: `file:./${family}-${release}` })
    const dshInputId = '@agnes-examples/dsh-input-controls'
    const dshModelAId = '@agnes-examples/dsh-model-picker-a'
    const dshModelBId = '@agnes-examples/dsh-model-picker-b'
    const dshToolId = '@agnes-examples/dsh-tool-view'
    const dshIds = [dshInputId, dshModelAId, dshModelBId, dshToolId]

    // DSH-01: the native composer is present before any example package is activated.
    assert.equal(await page.locator('[data-demo-plugin]').count(), 0)
    assert.equal(await page.locator('[data-demo-model]').count(), 0)
    assert.equal(await page.locator('[data-demo-tool-view]').count(), 0)
    assert(await page.locator('#composer').isVisible())
    assert(await page.locator('#model').isVisible())

    const dshInputV1 = await installAndEnableClientFixture(
      peer,
      packageClientId,
      commandId,
      dshInputId,
      dshSource('dsh-input-controls', 'v1'),
    )
    const dshModelAV1 = await installAndEnableClientFixture(
      peer,
      packageClientId,
      commandId,
      dshModelAId,
      dshSource('dsh-model-picker-a', 'v1'),
    )
    await installAndEnableClientFixture(
      peer,
      packageClientId,
      commandId,
      dshModelBId,
      dshSource('dsh-model-picker-b', 'v1'),
    )
    const dshToolV1 = await installAndEnableClientFixture(
      peer,
      packageClientId,
      commandId,
      dshToolId,
      dshSource('dsh-tool-view', 'v1'),
    )
    await page.locator('[data-demo-plugin="dsh-input-controls"][data-demo-version="v1"]').waitFor()
    await page.locator('[data-demo-model="a"][data-demo-version="v1"]').waitFor()
    assert.equal(await page.locator('[data-demo-model="b"]').count(), 0)
    assert.equal(await page.locator('#model').count(), 1)
    assert.equal(await page.locator(`link[data-plugin="${dshInputId}"]`).count(), 1)
    const initialDshRows = (await peer.clientModules.list('local-dev')).rows
    const dshInputRowV1 = initialDshRows.find((row) => row.packageId === dshInputId)
    const dshToolRowV1 = initialDshRows.find((row) => row.packageId === dshToolId)
    assert(dshInputRowV1?.revision && dshInputRowV1.contentDigest)
    assert(dshToolRowV1?.revision && dshToolRowV1.contentDigest)
    checkpoint('DSH fixtures install/trust/enable and the native composer/model control stays mounted')

    // The previous shell task supplies a generic tool row. This task adds a provider-generated bash
    // node, so the keyed fixture can be tested against a real timeline owner instead of a mock DOM.
    await startNextTask(page)
    await send('WB_APPROVAL')
    await page.waitForFunction(() =>
      document.querySelector('#transcript').textContent.includes('我会先检查工作目录'),
    )
    provider.continueTool()
    await page.locator('#approval button').first().waitFor()
    await page.locator('#approval button').first().click()
    await terminal()
    const genericToolCount = await page.locator('#transcript .tool').count()
    await send('WB_DSH_BASH')
    await page.waitForFunction(
      (previous) => document.querySelectorAll('#transcript .tool').length > previous,
      genericToolCount,
    )
    if (await page.locator('#approval:not([hidden])').isVisible()) {
      await page.locator('#approval button').first().click()
    }
    await terminal()
    await page.locator('[data-demo-tool-view="bash"]').waitFor()
    assert((await page.locator('#transcript .tool').count()) > genericToolCount)
    assert.equal(await page.locator('[data-node-id] [data-demo-tool-view="bash"]').count(), 1)
    checkpoint('provider-generated bash selects the keyed tool renderer while the generic tool row remains')

    const disableModelA = await peer.packages.disable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('disable-dsh-model-a'),
      id: dshModelAId,
    })
    await waitForPackageOperation(peer, disableModelA)
    await page.locator('[data-demo-model="b"]').waitFor()
    assert.equal(await page.locator('[data-demo-model="a"]').count(), 0)
    assert(await page.locator('#model').isVisible())
    const disableModelB = await peer.packages.disable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('disable-dsh-model-b'),
      id: dshModelBId,
    })
    await waitForPackageOperation(peer, disableModelB)
    await page.locator('[data-demo-model]').waitFor({ state: 'hidden' })
    assert(await page.locator('#model').isVisible())
    checkpoint(
      'model priority fallback shows B after A is disabled and restores native #model after B is disabled',
    )

    // Re-enable B for the broken-A fallback assertion after the explicit A/B disable sequence.
    const enableModelB = await peer.packages.enable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('re-enable-dsh-model-b'),
      id: dshModelBId,
    })
    await waitForPackageOperation(peer, enableModelB)
    await waitForClientModuleRow(peer, dshModelBId)
    await page.locator('[data-demo-model="b"]').waitFor()

    const dshNavigationStart = navigationCount
    const inputAccentV1 = await page
      .locator('[data-demo-plugin="dsh-input-controls"]')
      .evaluate((node) => getComputedStyle(node).color)
    const toolBorderV1 = await page
      .locator('[data-demo-tool-view="bash"]')
      .evaluate((node) => getComputedStyle(node).borderTopWidth)
    const dshInputV2 = await updateDshClientFixture(
      peer,
      packageClientId,
      commandId,
      dshInputId,
      dshSource('dsh-input-controls', 'v2'),
      dshInputV1.integrity,
    )
    const dshToolV2 = await updateDshClientFixture(
      peer,
      packageClientId,
      commandId,
      dshToolId,
      dshSource('dsh-tool-view', 'v2'),
      dshToolV1.integrity,
    )
    await page.locator('[data-demo-plugin="dsh-input-controls"][data-demo-version="v2"]').waitFor()
    await page.locator('[data-demo-tool-view="bash"][data-demo-version="v2"]').waitFor()
    assert.equal(await page.locator('[data-demo-plugin][data-demo-version="v1"]').count(), 0)
    assert.equal(await page.locator('[data-demo-tool-view][data-demo-version="v1"]').count(), 0)
    assert.notEqual(
      await page
        .locator('[data-demo-plugin="dsh-input-controls"]')
        .evaluate((node) => getComputedStyle(node).color),
      inputAccentV1,
    )
    assert.notEqual(
      await page
        .locator('[data-demo-tool-view="bash"]')
        .evaluate((node) => getComputedStyle(node).borderTopWidth),
      toolBorderV1,
    )
    assert.equal(await page.locator(`link[data-plugin="${dshInputId}"]`).count(), 1)
    assert.equal(await page.locator(`link[data-plugin="${dshToolId}"]`).count(), 1)
    assert.notEqual(dshInputV2.integrity, dshInputV1.integrity)
    assert.notEqual(dshToolV2.integrity, dshToolV1.integrity)
    const updatedDshRows = (await peer.clientModules.list('local-dev')).rows
    const dshInputRowV2 = updatedDshRows.find((row) => row.packageId === dshInputId)
    const dshToolRowV2 = updatedDshRows.find((row) => row.packageId === dshToolId)
    assert(dshInputRowV2?.revision && dshInputRowV2.contentDigest)
    assert(dshToolRowV2?.revision && dshToolRowV2.contentDigest)
    assert.notEqual(dshInputRowV2.revision, dshInputRowV1.revision)
    assert.notEqual(dshInputRowV2.contentDigest, dshInputRowV1.contentDigest)
    assert.notEqual(dshToolRowV2.revision, dshToolRowV1.revision)
    assert.notEqual(dshToolRowV2.contentDigest, dshToolRowV1.contentDigest)
    assert.equal(navigationCount, dshNavigationStart)
    checkpoint(
      'DSH v1-to-v2 hot update replaces markers/CSS and keeps one owner stylesheet without navigation',
    )

    const brokenModelA = await updateDshClientFixture(
      peer,
      packageClientId,
      commandId,
      dshModelAId,
      dshSource('dsh-model-picker-a', 'broken'),
      dshModelAV1.integrity,
      { waitForReady: false },
    )
    const enableBrokenModelA = await peer.packages.enable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('enable-dsh-model-a-broken'),
      id: dshModelAId,
    })
    await waitForPackageOperation(peer, enableBrokenModelA)
    await waitForClientModuleRow(peer, dshModelAId)
    await page.locator('[data-demo-model="b"]').waitFor()
    assert.equal(await page.locator('[data-demo-model="a"]').count(), 0)
    assert(await page.locator('#model').isVisible())
    await openPluginManagement(page)
    await assertBrowserRuntimeFailure(page, dshModelAId, '插件 UI 渲染失败，可重试')
    await closePluginManagement(page)
    assert.equal(
      brokenModelA.integrity,
      (await peer.packages.list({ profile: 'local-dev' })).packages.find((item) => item.id === dshModelAId)
        ?.integrity,
    )
    checkpoint(
      'broken model A is marked render-failed, abdicates its entry, and leaves B/native model available',
    )

    const brokenTool = await updateDshClientFixture(
      peer,
      packageClientId,
      commandId,
      dshToolId,
      dshSource('dsh-tool-view', 'broken'),
      dshToolV2.integrity,
    )
    assert.equal(
      brokenTool.integrity,
      (await peer.packages.list({ profile: 'local-dev' })).packages.find((item) => item.id === dshToolId)
        ?.integrity,
    )
    assert.equal(await page.locator('[data-demo-tool-view="bash"]').count(), 0)
    assert((await page.locator('#transcript .tool').count()) > genericToolCount)
    assert((await page.locator('#transcript').innerText()).includes('bash'))
    await openPluginManagement(page)
    await assertBrowserRuntimeFailure(page, dshToolId, '插件 UI 渲染失败，可重试')
    await closePluginManagement(page)
    assert.equal(navigationCount, dshNavigationStart)
    checkpoint(
      'broken bash renderer is isolated while native bash and unrelated generic tool rows remain visible',
    )

    for (const id of [dshModelAId, dshModelBId, dshInputId, dshToolId]) {
      const disable = await peer.packages.disable({
        profile: 'local-dev',
        clientId: packageClientId,
        commandId: commandId(`disable-${id}`),
        id,
      })
      await waitForPackageOperation(peer, disable)
      const remove = await peer.packages.remove({
        profile: 'local-dev',
        clientId: packageClientId,
        commandId: commandId(`remove-${id}`),
        id,
      })
      await waitForPackageOperation(peer, remove)
    }
    await page
      .locator('[data-demo-plugin],[data-demo-model],[data-demo-tool-view]')
      .first()
      .waitFor({ state: 'hidden' })
    assert.equal(await page.locator('[data-demo-plugin],[data-demo-model],[data-demo-tool-view]').count(), 0)
    assert(await page.locator('#model').isVisible())
    const remainingDshPackages = (await peer.packages.list({ profile: 'local-dev' })).packages.filter(
      (item) => dshIds.includes(item.id),
    )
    assert.equal(remainingDshPackages.length, 0)
    const remainingDshRows = (await peer.clientModules.list('local-dev')).rows.filter((row) =>
      dshIds.includes(row.packageId),
    )
    assert.equal(remainingDshRows.length, 0)
    assert.equal(navigationCount, dshNavigationStart)
    checkpoint(
      'all DSH fixtures disable/remove cleanly with no markers, rows, styles or cleanup-pending state left',
    )

    const packageId = '@agnes-examples/client-panel'
    const v1Source = { type: 'file', ref: 'file:./client-panel-v1' }
    const v2Source = { type: 'file', ref: 'file:./client-panel-v2' }
    const v1 = await inspectPackage(peer, packageClientId, commandId('inspect-v1'), v1Source)
    assert.deepEqual(v1.blockers, [])
    const install = await peer.packages.install({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('install-v1'),
      source: v1Source,
      expectedIntegrity: v1.integrity,
    })
    await waitForPackageOperation(peer, install)
    assert.equal(await page.getByText('Agnes client module demo · v1').count(), 0)
    const trust = await peer.packages.trust({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('trust-v1'),
      id: packageId,
      expectedIntegrity: v1.integrity,
      capabilityHash: v1.capabilityHash ?? '',
    })
    await waitForPackageOperation(peer, trust)
    const enable = await peer.packages.enable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('enable-v1'),
      id: packageId,
    })
    await waitForPackageOperation(peer, enable)
    await waitForClientModuleRow(peer, packageId)
    await page.getByText('Agnes client module demo · v1').waitFor()
    const enabledPackage = (await peer.packages.list({ profile: 'local-dev' })).packages.find(
      (entry) => entry.id === packageId,
    )
    assert.equal(enabledPackage?.actual, 'starting')
    checkpoint('client package install/trust/enable shadows the migrated sidebar in the live browser')

    const activateDshExample = async (family) => {
      const packageId = `@agnes-examples/${family}`
      const source = { type: 'file', ref: `file:./${family}-v1` }
      const preview = await inspectPackage(peer, packageClientId, commandId(`inspect-${family}`), source)
      assert.deepEqual(preview.blockers, [])
      const install = await peer.packages.install({
        profile: 'local-dev',
        clientId: packageClientId,
        commandId: commandId(`install-${family}`),
        source,
        expectedIntegrity: preview.integrity,
      })
      await waitForPackageOperation(peer, install)
      const trust = await peer.packages.trust({
        profile: 'local-dev',
        clientId: packageClientId,
        commandId: commandId(`trust-${family}`),
        id: packageId,
        expectedIntegrity: preview.integrity,
        capabilityHash: preview.capabilityHash ?? '',
      })
      await waitForPackageOperation(peer, trust)
      const enable = await peer.packages.enable({
        profile: 'local-dev',
        clientId: packageClientId,
        commandId: commandId(`enable-${family}`),
        id: packageId,
      })
      await waitForPackageOperation(peer, enable)
      await waitForClientModuleRow(peer, packageId)
      return { packageId, preview }
    }

    await activateDshExample('dsh-input-controls')
    await activateDshExample('dsh-model-picker-a')
    await activateDshExample('dsh-model-picker-b')
    await activateDshExample('dsh-tool-view')
    await page.locator('[data-demo-plugin="dsh-input-controls"]').waitFor()
    await page.locator('[data-demo-model="a"]').waitFor()
    checkpoint('DSH input and model contributions cross PackageManager → daemon → browser rows')
    await send('WB_DSH_BASH')
    await provider.continueTool()
    await page.locator('#approval:not([hidden]) button').first().waitFor()
    await page.locator('[data-demo-tool-view="bash"]').waitFor()
    await page.locator('#approval button').first().click()
    await terminal()
    assert.equal(await page.locator('[data-demo-tool-view="bash"]').count(), 1)
    checkpoint('DSH keyed bash tool renderer mounts in the live transcript and survives completion')

    const v2 = await inspectPackage(peer, packageClientId, commandId('inspect-v2'), v2Source)
    assert.deepEqual(v2.blockers, [])
    const update = await peer.packages.update({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('update-v2'),
      id: packageId,
      source: v2Source,
      expectedIntegrity: v2.integrity,
      activation: {
        expectedInstalledIntegrity: v1.integrity,
        expectedActiveIntegrity: null,
        trust: { integrity: v2.integrity, capabilityHash: v2.capabilityHash ?? '' },
      },
    })
    await waitForPackageOperation(peer, update)
    await page.getByText('Agnes client module demo · v2').waitFor()
    assert.equal(await page.getByText('Agnes client module demo · v1').count(), 0)
    const rollback = await peer.packages.rollback({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('rollback-v1'),
      id: packageId,
      expectedTargetIntegrity: v1.integrity,
      activation: {
        expectedInstalledIntegrity: v2.integrity,
        expectedActiveIntegrity: null,
        trust: { integrity: v1.integrity, capabilityHash: v1.capabilityHash ?? '' },
      },
    })
    await waitForPackageOperation(peer, rollback)
    await page.getByText('Agnes client module demo · v1').waitFor()
    checkpoint('client package update and rollback atomically switch the live sidebar module')

    // M10: one installed package can publish several browser rows.  They keep one package trust
    // boundary, while the roster and browser lifecycle remain row-scoped.
    const multiPackageId = '@agnes-examples/client-multi-panel'
    const multiSource = { type: 'file', ref: 'file:./client-multi-panel-v1' }
    const multiBrokenSource = { type: 'file', ref: 'file:./client-multi-panel-v2' }
    const multiPreview = await inspectPackage(
      peer,
      packageClientId,
      commandId('inspect-multi-row'),
      multiSource,
    )
    assert.deepEqual(multiPreview.blockers, [])
    const multiInstall = await peer.packages.install({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('install-multi-row'),
      source: multiSource,
      expectedIntegrity: multiPreview.integrity,
    })
    await waitForPackageOperation(peer, multiInstall)
    const multiTrust = await peer.packages.trust({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('trust-multi-row'),
      id: multiPackageId,
      expectedIntegrity: multiPreview.integrity,
      capabilityHash: multiPreview.capabilityHash ?? '',
    })
    await waitForPackageOperation(peer, multiTrust)
    const multiEnable = await peer.packages.enable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('enable-multi-row'),
      id: multiPackageId,
    })
    await waitForPackageOperation(peer, multiEnable)
    const multiRows = (await peer.clientModules.list('local-dev')).rows?.filter(
      (row) => row.packageId === multiPackageId && row.enabled && row.phase === 'ready',
    )
    assert.equal(multiRows?.length, 2)
    assert.deepEqual(multiRows?.map((row) => row.rowId).sort(), [
      'web:@agnes-examples/client-multi-panel:examples/client-multi-panel-primary',
      'web:@agnes-examples/client-multi-panel:examples/client-multi-panel-secondary',
    ])
    try {
      await page.getByText('Agnes multi row · primary').waitFor()
      await page.getByText('Agnes multi row · secondary').waitFor()
    } catch (error) {
      throw new Error(
        `multi-row package roster did not render both rows; rows=${JSON.stringify(multiRows)}; sidebar=${JSON.stringify(await page.locator('.sidebar').innerText())}; ${String(error)}`,
      )
    }
    checkpoint('one package publishes two independently addressed browser rows')
    // The v2 fixture keeps the primary row valid but makes the secondary row's own apply fail.
    // This crosses the real package update, roster, import and browser reconciliation path; a
    // package-wide lifecycle key would incorrectly withdraw the primary row with its sibling.
    const multiBrokenPreview = await inspectPackage(
      peer,
      packageClientId,
      commandId('inspect-multi-row-broken'),
      multiBrokenSource,
    )
    assert.deepEqual(multiBrokenPreview.blockers, [])
    const multiBrokenUpdate = await peer.packages.update({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('update-multi-row-broken'),
      id: multiPackageId,
      source: multiBrokenSource,
      expectedIntegrity: multiBrokenPreview.integrity,
      activation: {
        expectedInstalledIntegrity: multiPreview.integrity,
        expectedActiveIntegrity: null,
        trust: {
          integrity: multiBrokenPreview.integrity,
          capabilityHash: multiBrokenPreview.capabilityHash ?? '',
        },
      },
    })
    await waitForPackageOperation(peer, multiBrokenUpdate)
    await page.getByText('Agnes multi row · primary v2').waitFor()
    await page.getByText('Agnes multi row · secondary').waitFor({ state: 'hidden' })
    assert.equal(
      (await peer.clientModules.list('local-dev')).rows?.filter(
        (row) => row.packageId === multiPackageId && row.enabled && row.phase === 'ready',
      ).length,
      2,
    )
    checkpoint('one failing browser row does not withdraw its same-package sibling')
    const multiRollback = await peer.packages.rollback({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('rollback-multi-row-v1'),
      id: multiPackageId,
      expectedTargetIntegrity: multiPreview.integrity,
      activation: {
        expectedInstalledIntegrity: multiBrokenPreview.integrity,
        expectedActiveIntegrity: null,
        trust: { integrity: multiPreview.integrity, capabilityHash: multiPreview.capabilityHash ?? '' },
      },
    })
    await waitForPackageOperation(peer, multiRollback)
    await page.getByText('Agnes multi row · primary').waitFor()
    await page.getByText('Agnes multi row · secondary').waitFor()
    checkpoint('multi-row rollback restores each row after a sibling failure')
    const multiUntrust = await peer.packages.untrust({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('untrust-multi-row'),
      id: multiPackageId,
      expectedIntegrity: multiPreview.integrity,
      capabilityHash: multiPreview.capabilityHash ?? '',
    })
    await waitForPackageOperation(peer, multiUntrust)
    await page.getByText('Agnes multi row · primary').waitFor({ state: 'hidden' })
    await page.getByText('Agnes multi row · secondary').waitFor({ state: 'hidden' })
    assert.equal(
      (await peer.clientModules.list('local-dev')).rows?.filter((row) => row.packageId === multiPackageId)
        .length,
      0,
    )
    checkpoint('untrust withdraws every browser row owned by one package')

    // M11/RW-07: this fixture owns both the client row and a manifest-declared query service.
    // Its visible marker is produced only after the browser module crosses the same-origin BFF,
    // daemon roster gate, worker and Host service registry.
    const servicePackageId = '@agnes-examples/client-service-panel'
    const serviceSource = { type: 'file', ref: 'file:./client-service-panel-v1' }
    const serviceV2Source = { type: 'file', ref: 'file:./client-service-panel-v2' }
    const servicePreview = await inspectPackage(
      peer,
      packageClientId,
      commandId('inspect-service'),
      serviceSource,
    )
    assert.deepEqual(servicePreview.blockers, [])
    const serviceInstall = await peer.packages.install({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('install-service'),
      source: serviceSource,
      expectedIntegrity: servicePreview.integrity,
    })
    await waitForPackageOperation(peer, serviceInstall)
    const serviceTrust = await peer.packages.trust({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('trust-service'),
      id: servicePackageId,
      expectedIntegrity: servicePreview.integrity,
      capabilityHash: servicePreview.capabilityHash ?? '',
    })
    await waitForPackageOperation(peer, serviceTrust)
    const serviceEnable = await peer.packages.enable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('enable-service'),
      id: servicePackageId,
    })
    await waitForPackageOperation(peer, serviceEnable)
    await waitForClientModuleRow(peer, servicePackageId)
    const serviceRow = (await peer.clientModules.list('local-dev')).rows?.find(
      (row) => row.packageId === servicePackageId && row.enabled && row.phase === 'ready',
    )
    if (!serviceRow) throw new Error('ready browser service row disappeared before BFF verification')
    let serviceProbe
    try {
      serviceProbe = await peer.clientModules.callService({
        profile: 'local-dev',
        rowId: serviceRow.rowId,
        sessionId: new URL(sessionUrl).searchParams.get('session') ?? '',
        service: 'panel.version',
        input: {},
      })
    } catch (error) {
      throw new Error(
        `ready browser service row refused its backend query: ${JSON.stringify(serviceRow)}; ${String(error)}; ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`,
      )
    }
    assert.deepEqual(serviceProbe.output, { version: '1.0.0' })
    // Exercise the exact same-origin boundary from the page. The launch credential is read inside
    // the browser's session storage and is never emitted by this harness.
    const browserServiceProbe = await page.evaluate(
      async ({ rowId, sessionId }) => {
        const credential = sessionStorage.getItem('agnes-web-token') ?? ''
        const response = await fetch('/api/client-modules/service', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ rowId, sessionId, service: 'panel.version', input: {} }),
        })
        return { status: response.status, body: await response.json().catch(() => undefined) }
      },
      {
        rowId: serviceRow.rowId,
        sessionId: new URL(sessionUrl).searchParams.get('session') ?? '',
      },
    )
    assert.deepEqual(browserServiceProbe, { status: 200, body: { output: { version: '1.0.0' } } })
    try {
      await page.getByText('Agnes client service demo · v1 · backend 1.0.0').waitFor()
    } catch (error) {
      throw new Error(
        `browser service module did not render its backend result; sidebar=${JSON.stringify(await page.locator('.sidebar').innerText())}; pageErrors=${JSON.stringify(errors)}; ${String(error)}`,
      )
    }
    checkpoint('browser client row calls its declared query service through BFF and Host')
    const serviceV2Preview = await inspectPackage(
      peer,
      packageClientId,
      commandId('inspect-service-v2'),
      serviceV2Source,
    )
    assert.deepEqual(serviceV2Preview.blockers, [])
    const serviceUpdate = await peer.packages.update({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('update-service-v2'),
      id: servicePackageId,
      source: serviceV2Source,
      expectedIntegrity: serviceV2Preview.integrity,
      activation: {
        expectedInstalledIntegrity: servicePreview.integrity,
        expectedActiveIntegrity: servicePreview.integrity,
        trust: {
          integrity: serviceV2Preview.integrity,
          capabilityHash: serviceV2Preview.capabilityHash ?? '',
        },
      },
    })
    await waitForPackageOperation(peer, serviceUpdate)
    await page.getByText('Agnes client service demo · v2 · backend 2.0.0').waitFor()
    const serviceV2Row = (await peer.clientModules.list('local-dev')).rows?.find(
      (row) => row.packageId === servicePackageId && row.enabled && row.phase === 'ready',
    )
    if (!serviceV2Row) throw new Error('updated browser service row disappeared before verification')
    assert.deepEqual(
      (
        await peer.clientModules.callService({
          profile: 'local-dev',
          rowId: serviceV2Row.rowId,
          sessionId: new URL(sessionUrl).searchParams.get('session') ?? '',
          service: 'panel.version',
          input: {},
        })
      ).output,
      { version: '2.0.0' },
    )
    checkpoint('backend service update atomically switches browser row and Host query')
    const serviceRollback = await peer.packages.rollback({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('rollback-service-v1'),
      id: servicePackageId,
      expectedTargetIntegrity: servicePreview.integrity,
      activation: {
        expectedInstalledIntegrity: serviceV2Preview.integrity,
        expectedActiveIntegrity: serviceV2Preview.integrity,
        trust: { integrity: servicePreview.integrity, capabilityHash: servicePreview.capabilityHash ?? '' },
      },
    })
    await waitForPackageOperation(peer, serviceRollback)
    await page.getByText('Agnes client service demo · v1 · backend 1.0.0').waitFor()
    checkpoint('backend service rollback restores browser row and Host query together')
    const serviceDisable = await peer.packages.disable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('disable-service'),
      id: servicePackageId,
    })
    await waitForPackageOperation(peer, serviceDisable)
    await page.getByText('Agnes client service demo · v1 · backend 1.0.0').waitFor({ state: 'hidden' })
    const serviceEnableAgain = await peer.packages.enable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('reenable-service'),
      id: servicePackageId,
    })
    await waitForPackageOperation(peer, serviceEnableAgain)
    await page.getByText('Agnes client service demo · v1 · backend 1.0.0').waitFor()
    checkpoint('backend service disable withdraws and re-enable restores the browser row')
    const serviceUntrust = await peer.packages.untrust({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('untrust-service'),
      id: servicePackageId,
      expectedIntegrity: servicePreview.integrity,
      capabilityHash: servicePreview.capabilityHash ?? '',
    })
    await waitForPackageOperation(peer, serviceUntrust)
    await page.getByText('Agnes client service demo · v1 · backend 1.0.0').waitFor({ state: 'hidden' })
    checkpoint('untrust revokes the browser service row without stale BFF fallback')
    const serviceRemove = await peer.packages.remove({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('remove-service'),
      id: servicePackageId,
    })
    await waitForPackageOperation(peer, serviceRemove)
    assert.equal(
      (await peer.packages.list({ profile: 'local-dev' })).packages.some(
        (entry) => entry.id === servicePackageId,
      ),
      false,
    )
    checkpoint('removed backend service package cannot remain as a browser capability')

    // Keep the failure-injection history in its own package. The daemon intentionally bounds
    // retained package snapshots; mixing these eight controlled revisions with the lifecycle
    // package's install/update/rollback history would turn a valid browser test into a retention
    // policy failure before the final recovery frame.
    const failureClient = await inspectPackage(
      peer,
      packageClientId,
      commandId('inspect-failure-initial'),
      failureFixtures['recovery-0'],
    )
    assert.deepEqual(failureClient.blockers, [])
    const failureInstall = await peer.packages.install({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('install-failure-initial'),
      source: failureFixtures['recovery-0'],
      expectedIntegrity: failureClient.integrity,
    })
    await waitForPackageOperation(peer, failureInstall)
    const failureTrust = await peer.packages.trust({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('trust-failure-initial'),
      id: failurePackageId,
      expectedIntegrity: failureClient.integrity,
      capabilityHash: failureClient.capabilityHash ?? '',
    })
    await waitForPackageOperation(peer, failureTrust)
    const failureEnable = await peer.packages.enable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('enable-failure-initial'),
      id: failurePackageId,
    })
    await waitForPackageOperation(peer, failureEnable)
    await page.getByText('fixture recovery 0').waitFor()

    async function updateClientFixture(source, previousIntegrity) {
      const preview = await inspectPackage(peer, packageClientId, commandId('inspect-failure'), source)
      assert.deepEqual(preview.blockers, [])
      const receipt = await peer.packages.update({
        profile: 'local-dev',
        clientId: packageClientId,
        commandId: commandId('update-failure'),
        id: failurePackageId,
        source,
        expectedIntegrity: preview.integrity,
        activation: {
          expectedInstalledIntegrity: previousIntegrity,
          expectedActiveIntegrity: null,
          trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash ?? '' },
        },
      })
      await waitForPackageOperation(peer, receipt)
      return preview
    }

    failClientImport = true
    const importFailure = await updateClientFixture(failureFixtures['import-404'], failureClient.integrity)
    await page.getByText('fixture recovery 0').waitFor()
    assert.equal(await page.getByText('fixture import 404').count(), 0)
    failClientImport = false
    const recovery1 = await updateClientFixture(failureFixtures['recovery-1'], importFailure.integrity)
    await page.getByText('fixture recovery 1').waitFor()
    assert.equal(await page.getByText('Agnes client module demo · v1').count(), 0)
    checkpoint('real dynamic import 404 isolates one package and a later roster frame recovers it')

    const syntaxFailure = await updateClientFixture(failureFixtures.syntax, recovery1.integrity)
    await page.getByText('fixture recovery 1').waitFor()
    assert.equal(await page.getByText('fixture syntax').count(), 0)
    const recovery2 = await updateClientFixture(failureFixtures['recovery-2'], syntaxFailure.integrity)
    await page.getByText('fixture recovery 2').waitFor()
    checkpoint('real module syntax failure leaves the prior slot and recovers on the next package frame')

    failClientStyles = true
    const stylesheetFailure = await updateClientFixture(
      failureFixtures['stylesheet-404'],
      recovery2.integrity,
    )
    await page.getByText('fixture recovery 2').waitFor()
    assert.equal(await page.getByText('fixture stylesheet 404').count(), 0)
    assert.equal(await page.locator(`head link[data-plugin="${failurePackageId}"]`).count(), 1)
    failClientStyles = false
    const recovery3 = await updateClientFixture(failureFixtures['recovery-3'], stylesheetFailure.integrity)
    await page.getByText('fixture recovery 3').waitFor()
    checkpoint('real stylesheet failure removes only staged styles and retries cleanly')

    const applyFailure = await updateClientFixture(failureFixtures['apply-failure'], recovery3.integrity)
    await page.getByText('fixture recovery 3').waitFor({ state: 'hidden' })
    assert.equal(await page.getByText('fixture apply failure').count(), 0)
    assert.equal(await page.locator(`head link[data-plugin="${failurePackageId}"]`).count(), 0)
    await updateClientFixture(failureFixtures['recovery-4'], applyFailure.integrity)
    await page.getByText('fixture recovery 4').waitFor()
    assert.equal(await page.locator(`head link[data-plugin="${failurePackageId}"]`).count(), 1)
    checkpoint('real apply failure cleans slot and stylesheet with no residual before the next recovery')

    const disableFailure = await peer.packages.disable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('disable-failure'),
      id: failurePackageId,
    })
    await waitForPackageOperation(peer, disableFailure)
    await page.getByText('fixture recovery 4').waitFor({ state: 'hidden' })
    const removeFailure = await peer.packages.remove({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('remove-failure'),
      id: failurePackageId,
    })
    await waitForPackageOperation(peer, removeFailure)

    const disable = await peer.packages.disable({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('disable-v1'),
      id: packageId,
    })
    await waitForPackageOperation(peer, disable)
    await page.getByText('Agnes client module demo · v1').waitFor({ state: 'hidden' })
    await page.locator('#new').waitFor()
    const remove = await peer.packages.remove({
      profile: 'local-dev',
      clientId: packageClientId,
      commandId: commandId('remove-v1'),
      id: packageId,
    })
    await waitForPackageOperation(peer, remove)
    await stopWeb()
    await command(['daemon', 'stop'])
    const afterRemoval = new URL(await launchWeb())
    afterRemoval.search = new URL(sessionUrl).search
    await page.goto(afterRemoval.href)
    await page.waitForFunction(
      () => !location.hash && document.querySelector('#connection').dataset.state === 'connected',
    )
    assert.equal(await page.getByText(/Agnes client module demo · v[12]/).count(), 0)
    assert.equal(await page.getByText(/Agnes client service demo/).count(), 0)
    await page.locator('#new').waitFor()
    checkpoint(
      'disabled/removed client package withdraws browser code and cannot revive after daemon restart',
    )

    const realHome = process.env.AGNES_WEB_REAL_PROVIDER_HOME
    if (realHome) {
      const real = JSON.parse(
        await readFile(join(realHome, 'profiles', 'local-dev', 'configuration.json'), 'utf8'),
      )
      const credential = await createCredentialStore({ root: realHome }).read(real.provider.credentialRef)
      if (credential?.kind !== 'api-key') throw new Error('real Provider credential unavailable')
      await peer.config.save({
        providerId: real.provider.id,
        baseUrl: real.provider.baseUrl,
        model: real.provider.model,
        apiKey: credential.value,
        expectedRevision: saved.revision,
      })
      await page.reload()
      await terminal('已取消')
      await startNextTask(page)
      await send('Reply with only AGNES_WEB_REAL_READY. Do not use tools.')
      await page.waitForFunction((previous) => location.href !== previous, sessionUrl)
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('#transcript .assistant .node-body')].some((node) =>
            node.textContent.includes('AGNES_WEB_REAL_READY'),
          ),
        undefined,
        { timeout: 120000 },
      )
      await terminal()
      await page.screenshot({
        path: join(artifacts, '05-real-provider.png'),
        fullPage: true,
        animations: 'disabled',
      })
      await page.reload()
      await terminal()
      assert(
        (await page.locator('#transcript .assistant .node-body').allTextContents()).some((text) =>
          text.includes('AGNES_WEB_REAL_READY'),
        ),
      )
      checkpoint('configured real Provider completes Web task and refresh preserves response')
    }
  } finally {
    await peer.close()
  }
  assert.deepEqual(errors, [])
  console.log(`COMPLETE ${checks.length} browser acceptance checks; screenshots ${artifacts}`)
} catch (error) {
  if (error === focusedRunComplete) {
    console.log(`COMPLETE ${checks.length} focused browser checks; screenshots ${artifacts}`)
  } else {
    if (browser) {
      const page = browser.contexts()[0]?.pages()[0]
      if (page) {
        // No form contents or URL are logged. Screenshot password inputs stay masked.
        await page
          .screenshot({ path: join(artifacts, 'failure.png'), fullPage: true, animations: 'disabled' })
          .catch(() => {})
        console.error(
          'VISIBLE STATE',
          await page.locator('#status,#connection,#notice,#config-error').allTextContents(),
        )
      }
    }
    throw error
  }
} finally {
  await browser?.close()
  await stopWeb()
  await command(['daemon', 'stop']).catch(() => {})
  await provider.close()
  await rm(root, { recursive: true, force: true })
}

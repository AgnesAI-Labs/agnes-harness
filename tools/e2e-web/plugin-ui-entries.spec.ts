import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { settled } from './quality.js'
import { command, complete, install, prompt } from './sdk.js'
import { closeSettings, homePage, pluginTab, preferences, section, settings } from './ui.js'

const profile = 'local-dev'
const galleryId = '@community/deliverables-gallery'
const narrow = { width: 390, height: 812 }
const desktop = { width: 1280, height: 900 }
const checklist = 'Field guide pre-departure checklist for overnight workspace handoffs'
const baselineEntry = process.env.AGH_WEB_TEST_BASELINE_ENTRY

if (baselineEntry) test.use({ runtimeSetup: { startEntry: baselineEntry } })

async function openChoice(page: Page, trigger: Locator, title: string) {
  await trigger.click()
  await page.getByRole('menuitem', { name: title, exact: true }).click()
}

async function legacyMenu(page: Page, trigger: Locator) {
  if (!(await trigger.isVisible())) return null
  await trigger.click()
  const items = page.getByRole('menuitem')
  await expect(items.first()).toBeVisible()
  const titles = (await items.allInnerTexts())
    .map((title) => title.trim())
    .filter((title) => !/^(Field guide|Dispatch) /.test(title))
  await page.keyboard.press('Escape')
  await expect(items.first()).toBeHidden()
  return titles
}

async function bounds(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`Expected a visible layout box for ${locator}`)
  return [box.x, box.y, box.width, box.height].map(Math.round)
}

async function nativeLayout(page: Page) {
  await settled(page)
  const nav = page.getByTestId('home-entries')
  const right = page.locator('#workbench-right')
  return {
    sidebar: await nav
      .locator('[data-testid^="home-entry-"]')
      .evaluateAll((buttons) =>
        buttons.map((button) => [button.getAttribute('data-testid'), button.getAttribute('aria-current')]),
      ),
    sidebarMore: await legacyMenu(page, nav.getByTestId('home-entry-more')),
    settingsButton: await bounds(page.locator('#settings')),
    composer: await bounds(page.getByRole('textbox', { name: 'Task content', exact: true })),
    rightDock: await bounds(right),
    rightTabs: await right.getByRole('tab').allInnerTexts(),
    rightMore: await legacyMenu(
      page,
      right.locator('.workbench-dock-heading').getByRole('button', { name: 'More', exact: true }),
    ),
  }
}

async function fitCompactDock(page: Page) {
  const resize = page.locator('#workbench-right .workbench-resize')
  const edge = await resize.boundingBox()
  if (!edge) throw new Error('Right dock must have a visible resize handle')
  const minimum = await resize.getAttribute('aria-valuemin')
  if (!minimum) throw new Error('Right dock must expose its minimum size')
  const x = edge.x + edge.width / 2
  const y = edge.y + edge.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + Number(await resize.getAttribute('aria-valuenow')) - Number(minimum) + 24, y)
  await page.mouse.up()
  await expect(resize).toHaveAttribute('aria-valuenow', minimum)
}

async function noHorizontalPageOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1)
}

test('declarative plugin entries coexist with reviewed legacy UI and preserve native selections', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(baselineEntry ? 180_000 : 120_000)
  await page.setViewportSize(desktop)
  let client = await runtime.connect()
  const old = await install(client, 'tools/e2e-web/fixtures/plugin-config')
  await install(client, 'examples/community/deliverables-gallery')
  const session = await client.session.new({
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  await session.attach()
  await prompt(session, 'call present {"files":[{"path":"report.md","name":"Legacy handoff evidence"}]}')
  const pinnedGeneration = (await client.session.runtime(session.id)).generation.id
  expect(pinnedGeneration).toBeTruthy()

  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  const sessionUrl = `${runtime.url}/?session=${encodeURIComponent(session.id)}`
  await preferences(page)
  await page.goto(sessionUrl)
  const gallery = page
    .getByTestId('deliverables-gallery')
    .filter({ hasText: 'Legacy handoff evidence' })
    .first()
  await expect(page.getByTestId('turn-deliverables')).toContainText('Legacy handoff evidence')
  await expect(gallery).toHaveCount(0)

  await settings(page)
  await section(page, 'application')
  await page.getByRole('button', { name: 'Advanced interface choices', exact: true }).click()
  const role = page.getByRole('region', { name: 'Deliverables', exact: true })
  await role
    .locator('p')
    .filter({ hasText: `${galleryId}#gallery` })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()
  const consent = page.getByTestId('interface-preview-page')
  await expect(consent).toContainText('Presentation only. No execution change.')
  await consent.getByRole('button', { name: 'Use this implementation', exact: true }).click()
  await expect(consent).toBeHidden()
  await expect(role.getByText(`Your choice · ${galleryId}#gallery`, { exact: true })).toBeVisible()
  await closeSettings(page)
  await expect(gallery).toBeVisible()
  await expect(page.getByTestId('turn-deliverables')).toHaveCount(0)

  const roster = () => client.clientModules.list(profile)
  const galleryRow = async () => (await roster()).rows.find((row) => row.packageId === galleryId)
  const approved = await galleryRow()
  if (!approved?.entryUrl) throw new Error('The reviewed legacy frontend must publish its entry')
  expect(approved.documentAdmission).toMatchObject({ kind: 'approved-presentation' })
  expect(requests.map((url) => new URL(url).pathname)).toContain(approved.entryUrl)

  const config = () => client.packages.config.get({ profile, id: old.id })
  const configPanel = page.getByTestId('plugin-config-panel')
  const configName = configPanel.getByTestId('plugin-config-field/name')
  await homePage(page, 'plugins')
  const openLegacyDetails = page.locator(`.plugin-row[data-plugin-id="${old.id}"] .plugin-details-button`)
  await openLegacyDetails.click()
  await pluginTab(page, 'config').click()
  await expect(configName).toHaveValue('Support')
  await configName.fill('Legacy operations')
  await configPanel.getByTestId('plugin-config-save').click()
  await expect
    .poll(async () => (await config()).entries[0]?.value)
    .toMatchObject({ name: 'Legacy operations' })
  const savedLegacy = await config()
  const legacyGrants = async () =>
    (await client.packages.list({ profile })).packages
      .filter((pkg) => pkg.id === old.id || pkg.id === galleryId)
      .map(({ id, integrity, capabilityHash, trusted, desired }) => ({
        id,
        integrity,
        capabilityHash,
        trusted,
        desired,
      }))
  const beforeGrants = await legacyGrants()
  expect(beforeGrants).toHaveLength(2)
  expect(beforeGrants.every((grant) => grant.trusted && grant.desired === 'enabled')).toBe(true)
  await page.goto(sessionUrl)
  await expect(gallery).toBeVisible()

  const settingsItems = page.getByTestId('settings-navigation').locator('[data-testid^="settings-nav-"]')
  await settings(page)
  const oldSettings = await settingsItems.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  )
  expect(oldSettings).toContain('settings-nav-general')
  await expect(page.getByRole('button', { name: 'Field guide settings', exact: true })).toHaveCount(0)
  await settled(page)
  await info.attach('settings-before.png', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await closeSettings(page)

  const right = page.locator('#workbench-right')
  const bottom = page.locator('#workbench-bottom')
  const rightToggle = page.getByTestId('workbench-right-toggle')
  const rightMore = right
    .locator('.workbench-dock-heading')
    .getByRole('button', { name: 'More', exact: true })
  const rightExtensions = right.getByRole('button', { name: 'Extensions', exact: true })
  const bottomExtensions = right.getByRole('button', { name: 'Bottom extensions', exact: true })
  const selectedLegacyTab = right.getByRole('tab', { name: 'Changes', exact: true })
  const oldSelection = () => expect(selectedLegacyTab).toHaveAttribute('aria-selected', 'true')
  const reloadLegacy = page
    .getByTestId('presentation-reload-required')
    .getByRole('button', { name: 'Reload', exact: true })
  const compareNativeLayout = async (expected: Awaited<ReturnType<typeof nativeLayout>>) => {
    let measured = expected
    let reloaded = false
    await expect(async () => {
      // The existing native UI gate can require a clean document while a package generation changes.
      if (!reloaded && (await reloadLegacy.isVisible())) {
        await Promise.all([page.waitForEvent('domcontentloaded'), reloadLegacy.click()])
        reloaded = true
        info.annotations.push({
          type: 'legacy-presentation-reload',
          description: 'Used the existing workbench recovery without changing the saved approval.',
        })
        await expect(gallery).toBeVisible()
        await oldSelection()
      }
      measured = await nativeLayout(page)
      expect(measured).toEqual(expected)
    }).toPass({ timeout: 12_000 })
    return measured
  }
  await rightToggle.click()
  await expect(page.getByTestId('workbench-tab-files')).toHaveAttribute('aria-selected', 'true')
  await selectedLegacyTab.click()
  await oldSelection()
  await expect(page.getByTestId('workbench-bottom-toggle')).toHaveCount(0)
  await expect(bottom).toBeHidden()
  await expect(bottomExtensions).toHaveCount(0)
  const beforeWide = await nativeLayout(page)
  await fitCompactDock(page)
  await expect(rightMore).toBeVisible()
  const beforeCompact = await nativeLayout(page)
  expect(beforeCompact.rightMore?.length).toBeGreaterThan(0)
  await page.setViewportSize(narrow)
  await expect(right).toBeVisible()
  await expect(bottom).toBeHidden()
  await oldSelection()
  await noHorizontalPageOverflow(page)
  await page.setViewportSize(desktop)
  await expect(rightMore).toBeVisible()

  if (baselineEntry) {
    await page.goto('about:blank')
    await runtime.restart(process.env.AGH_WEB_TEST_ENTRY ?? 'packages/cli/dist/local/agnes.mjs')
    client = await runtime.connect('local', false)
    await page.goto(sessionUrl)
    await expect(gallery).toBeVisible()
    expect((await galleryRow())?.documentAdmission).toEqual(approved.documentAdmission)
    expect(await legacyGrants()).toEqual(beforeGrants)
    expect((await config()).entries).toEqual(savedLegacy.entries)
    expect((await client.session.runtime(session.id)).generation.id).toBe(pinnedGeneration)
    if (!(await right.isVisible())) await rightToggle.click()
    await oldSelection()
    expect(await nativeLayout(page)).toEqual(beforeCompact)
  }

  const guide = await install(client, 'tools/e2e-web/fixtures/declarative-field-guide')
  const { capabilityHash: guideCapabilityHash } = guide
  if (!guideCapabilityHash) throw new Error('The reviewed guide capability hash is required to revoke trust')
  const dispatch = await install(client, 'tools/e2e-web/fixtures/declarative-dispatch')
  await expect(bottomExtensions).toBeVisible()
  await expect(bottom).toBeHidden()
  await expect(page.getByTestId('workbench-bottom-toggle')).toHaveCount(0)
  await oldSelection()
  const mixedCompact = await compareNativeLayout(beforeCompact)
  await right.locator('.workbench-resize').dblclick()
  await expect(right.locator('.workbench-resize')).not.toHaveAttribute('aria-valuenow', '240')
  const mixedWide = await compareNativeLayout(beforeWide)
  await info.attach('native-layout-before-and-mixed.json', {
    body: JSON.stringify({ beforeWide, mixedWide, beforeCompact, mixedCompact }, null, 2),
    contentType: 'application/json',
  })

  expect(await legacyGrants()).toEqual(beforeGrants)
  await expect
    .poll(async () => (await roster()).statuses)
    .toContainEqual(
      expect.objectContaining({ packageId: dispatch.id, state: 'blocked', reason: 'native-ui-not-admitted' }),
    )
  expect((await roster()).rows.find((row) => row.packageId === dispatch.id)?.entryUrl).toBeUndefined()
  expect((await galleryRow())?.documentAdmission).toEqual(approved.documentAdmission)
  await expect(gallery).toBeVisible()
  await openChoice(page, beforeWide.rightMore ? rightMore : rightExtensions, 'Field guide reference')
  await expect(right.getByText('Compare the map with the field notes.', { exact: true })).toBeVisible()
  await right.getByRole('button', { name: 'Back', exact: true }).click()
  await oldSelection()

  const sidebarTrigger = page.getByTestId(
    beforeWide.sidebarMore ? 'home-entry-more' : 'declarative-ui-sidebar-menu',
  )
  await openChoice(page, sidebarTrigger, 'Field guide start')
  await expect(page.getByText('Start with the site inventory.', { exact: true })).toBeVisible()
  await openChoice(page, sidebarTrigger, 'Dispatch start')
  await expect(page.getByText('Check which deliveries are ready.', { exact: true })).toBeVisible()
  await page.goto(sessionUrl)
  await expect(gallery).toBeVisible()

  await settings(page)
  const fieldSettings = page.getByRole('button', { name: 'Field guide settings', exact: true })
  const dispatchSettings = page.getByRole('button', { name: 'Dispatch settings', exact: true })
  await expect(fieldSettings).toBeVisible()
  await expect(dispatchSettings).toBeVisible()
  expect(
    await settingsItems.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))),
  ).toEqual(oldSettings)
  await settled(page)
  await info.attach('settings-mixed.png', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await fieldSettings.click()
  await expect(page.getByRole('heading', { name: 'Handoff checklist', exact: true })).toBeVisible()
  await expect(page.locator('strong').filter({ hasText: /^field notes$/ })).toBeVisible()
  await expect(page.getByText('Printable map', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /Printable map/ })).toHaveCount(0)
  await expect(page.getByText('Route diagram', { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Route diagram' })).toHaveCount(0)
  await dispatchSettings.click()
  await expect(page.getByText('Set the name of the secondary dispatch queue.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Configure', exact: true }).click()
  await expect(configName).toHaveValue('Secondary dispatch')
  await expect(configPanel.getByTestId('plugin-config-entry')).toHaveCount(0)
  await configName.fill('Prepared dispatch')
  await configPanel.getByTestId('plugin-config-save').click()
  await expect
    .poll(async () => {
      const { entries } = await client.packages.config.get({ profile, id: dispatch.id })
      return Object.fromEntries(entries.map((entry) => [entry.rowId, entry.value]))
    })
    .toEqual({
      'ext:e2e/dispatch-primary': { name: 'Primary intake' },
      'ext:e2e/dispatch-secondary': { name: 'Prepared dispatch' },
    })

  await page.goto(sessionUrl)
  await expect(gallery).toBeVisible()
  await page.setViewportSize(narrow)
  if (!(await right.isVisible())) await rightToggle.click()
  await oldSelection()
  await expect(bottom).toBeHidden()
  await bottomExtensions.click()
  await expect(page.getByRole('menuitem', { name: 'Dispatch checklist', exact: true })).toBeVisible()
  const longChoice = page.getByRole('menuitem', { name: checklist, exact: true })
  await expect(longChoice).toBeInViewport({ ratio: 1 })
  await noHorizontalPageOverflow(page)
  await longChoice.click()
  await expect(bottom.getByText('Confirm that the next shift has a copy.', { exact: true })).toBeVisible()
  await expect(right).toBeHidden()
  await expect(page.getByTestId('workbench-bottom-toggle')).toHaveCount(0)
  await noHorizontalPageOverflow(page)
  await complete(
    client,
    await client.packages.untrust({
      ...(await command(client)),
      id: guide.id,
      expectedIntegrity: guide.integrity,
      capabilityHash: guideCapabilityHash,
    }),
  )
  await expect(bottom).toBeHidden()
  if (!(await right.isVisible())) await rightToggle.click()
  await oldSelection()
  await bottomExtensions.click()
  await expect(page.getByRole('menuitem', { name: checklist, exact: true })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Dispatch checklist', exact: true }).click()
  await expect(bottom.getByText('Confirm the dispatch has a destination.', { exact: true })).toBeVisible()
  await expect(right).toBeHidden()
  await bottom.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(bottom).toBeHidden()
  await noHorizontalPageOverflow(page)

  await page.setViewportSize(desktop)
  if (!(await right.isVisible())) await rightToggle.click()
  await oldSelection()
  await fitCompactDock(page)
  await openChoice(page, rightMore, 'Dispatch reference')
  await expect(right.getByText('Look up the receiving team first.', { exact: true })).toBeVisible()
  await complete(client, await client.packages.disable({ ...(await command(client)), id: dispatch.id }))
  await expect(right.getByText('Look up the receiving team first.', { exact: true })).toHaveCount(0)
  await oldSelection()
  await expect(bottomExtensions).toHaveCount(0)
  await compareNativeLayout(beforeCompact)
  await complete(client, await client.packages.remove({ ...(await command(client)), id: dispatch.id }))
  const { packages } = await client.packages.list({ profile })
  expect(packages).not.toContainEqual(expect.objectContaining({ id: dispatch.id }))

  await expect(gallery).toBeVisible()
  expect((await galleryRow())?.documentAdmission).toEqual(approved.documentAdmission)
  expect(await legacyGrants()).toEqual(beforeGrants)
  expect((await config()).entries).toEqual(savedLegacy.entries)
  expect((await client.session.runtime(session.id)).generation.id).toBe(pinnedGeneration)
  expect(
    requests.filter((request) => {
      const url = new URL(request)
      const path = decodeURIComponent(url.pathname)
      return (
        url.hostname === 'declarative-entry.invalid' ||
        path.includes('unapproved-dispatch-client') ||
        (path.startsWith('/plugins/') && path.includes(`${dispatch.id}/`))
      )
    }),
  ).toEqual([])
  await expect(page.getByText('Unapproved dispatch frontend', { exact: true })).toHaveCount(0)
  await homePage(page, 'plugins')
  await openLegacyDetails.click()
  await pluginTab(page, 'config').click()
  await expect(configName).toHaveValue('Legacy operations')
  await settings(page)
  await expect(fieldSettings).toHaveCount(0)
  await expect(dispatchSettings).toHaveCount(0)
})

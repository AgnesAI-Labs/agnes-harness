import type { JsonValue } from '@agnes/protocol'
import { expect, test } from './fixtures.js'
import { command, install } from './sdk.js'
import { chooseWorkspace, preferences, section, settings } from './ui.js'

for (const locale of ['en', 'zh-CN'] as const) {
  test(`configure an installed business agent with validation, CAS and redacted audit (${locale})`, async ({
    page,
    runtime,
  }) => {
    const client = await runtime.connect()
    const pkg = await install(client, 'tools/e2e-web/fixtures/plugin-config')
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await settings(page, locale)
    await section(page, 'plugins')
    await page.locator(`.plugin-row[data-plugin-id="${pkg.id}"] .plugin-details-button`).click()
    const tab = page.getByTestId('plugin-config-tab')
    await expect(tab).toHaveText(locale === 'en' ? 'Configuration' : '配置')
    await tab.click()
    const panel = page.getByTestId('plugin-config-panel')
    const name = panel.getByTestId('plugin-config-field/name')
    const save = panel.getByTestId('plugin-config-save')
    await expect(name).toHaveValue('Support')
    await expect(panel.getByTestId('plugin-config-reload-mode')).toContainText(
      locale === 'en' ? 'Live' : '实时',
    )
    await name.fill('')
    await expect(panel.getByTestId('plugin-config-errors')).toContainText('/name')
    await expect(save).toBeDisabled()
    await name.fill('Sales')
    await panel.getByTestId('plugin-config-field/credential').fill('secret://fixture/updated')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(panel.getByTestId('plugin-config-notice')).toHaveText(
      locale === 'en' ? 'Configuration saved.' : '配置已保存。',
    )
    const saved = await client.packages.config.get({ profile: 'local-dev', id: pkg.id })
    expect(saved.entries[0]?.value).toMatchObject({ name: 'Sales', credential: 'secret://fixture/updated' })
    expect(JSON.stringify(saved.audit)).not.toContain('secret://')
    await name.fill('refuse')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(panel.getByTestId('plugin-config-notice')).toContainText(
      locale === 'en' ? 'refused' : '拒绝',
    )
    expect((await client.packages.config.get({ profile: 'local-dev', id: pkg.id })).revision).toBe(
      saved.revision,
    )
    // A second administrator changes the configuration while the Web draft remains open.
    const updated = await client.packages.config.save({
      ...(await command(client)),
      id: pkg.id,
      rowId: 'ext:e2e/config-agent',
      expectedRevision: saved.revision,
      value: { ...(saved.entries[0]!.value as Record<string, JsonValue>), name: 'Operations' },
    })
    expect(updated.ok).toBe(true)
    await name.fill('Unsaved draft')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(panel.getByTestId('plugin-config-notice')).toContainText(
      locale === 'en' ? 'changed elsewhere' : '其他操作修改',
    )
    await expect(name).toHaveValue('Unsaved draft')
    expect(
      (await client.packages.config.get({ profile: 'local-dev', id: pkg.id })).entries[0]?.value,
    ).toMatchObject({ name: 'Operations' })
  })
}

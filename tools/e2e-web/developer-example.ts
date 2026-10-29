import { resolve, sep } from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'
import { homePage } from './ui.js'

/** Teaching packages are installed deliberately, never advertised in the product gallery. */
export async function installDeveloperExample(page: Page, directory: string) {
  await homePage(page, 'plugins')
  await page.getByTestId('plugin-install-source').click()
  const source = page.getByRole('dialog', { name: 'Check a plugin source', exact: true })
  await source.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('file')
  await source
    .getByRole('textbox', { name: 'Source reference', exact: true })
    .fill(`file:${resolve(directory).split(sep).join('/')}`)
  await source.getByRole('button', { name: 'Check source', exact: true }).click()
  await page
    .getByTestId('install-review')
    .getByRole('button', { name: 'Install and enable', exact: true })
    .click()
  await expect(page.getByTestId('install-review')).toBeHidden({ timeout: 90_000 })
}

import { chromium } from '@playwright/test'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const state = JSON.parse(await readFile('/tmp/agh-acme-whitelabel-state.json', 'utf8'))
const out = resolve('../reports/mp/ARCH/PC-ARCH0-WHITELABEL')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: process.argv.includes('--saved') ? `${out}/browser-state.json` : undefined })
const page = await context.newPage()
page.on('pageerror', (error) => console.log('PAGEERROR', error.message))
page.on('console', (msg) => { if (msg.type() === 'error') console.log('CONSOLE', msg.text().slice(0, 400)) })
await page.goto(`http://127.0.0.1:${state.port}${process.argv[3] ?? '/'}`)
await page.waitForTimeout(6000)
const name = process.argv[2] ?? 'before-en'
await page.screenshot({ path: `${out}/${name}.png`, fullPage: true })
console.log(JSON.stringify({ name, title: await page.title(), favicon: await page.locator('link[rel="icon"]').getAttribute('href'), url: page.url(), text: (await page.locator('body').innerText()).slice(0, 9000), brand: await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--agnes-brand-primary')) }, null, 2))
await context.storageState({ path: `${out}/browser-state.json` })
await browser.close()

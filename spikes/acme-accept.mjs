import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const state = JSON.parse(await readFile('/tmp/agh-acme-whitelabel-state.json', 'utf8'))
const out = resolve('../reports/mp/ARCH/PC-ARCH0-WHITELABEL')
await mkdir(out,{recursive:true})
const lang = process.argv[2] ?? 'en'
const browser = await chromium.launch({ headless:true })
const context = await browser.newContext({ viewport:{width:1440,height:1000}, storageState:existsSync(`${out}/browser-state.json`)?`${out}/browser-state.json`:undefined })
try {
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', e=>console.log('PAGEERROR',e.message))
  await page.goto(`http://127.0.0.1:${state.port}/?settings=general`)
  await page.locator('#skin-select option[value="acme"]').waitFor({state:'attached'})
  // The host's React picker mirrors a hidden native select; use its real change handler.
  await page.locator('#skin-select').selectOption('acme',{force:true})
  await page.locator('#locale-select').selectOption(lang,{force:true})
  await page.goto(`http://127.0.0.1:${state.port}/?page=acme-home`)
  await page.getByTestId('acme-home').waitFor()
  const cancel = page.getByRole('button', {name: lang==='en'?'Cancel':'取消', exact:true})
  if(await cancel.isVisible()) await cancel.click()
  const start = lang==='en'?'Start maintenance agent':'启动维保智能体'
  const conv = lang==='en'?'Conversation':'对话'
  const home = lang==='en'?'Maintenance home':'维保首页'
  await page.getByRole('button',{name:start,exact:true}).waitFor()
  assert.equal(await page.getByTestId('home-entry-agents').count(),0)
  assert.equal(await page.getByTestId('home-entry-plugins').count(),0)
  assert.equal(await page.getByTestId('home-entry-automation').count(),0)
  await page.screenshot({path:`${out}/after-${lang==='en'?'en':'zh'}.png`,fullPage:true})
  await page.getByRole('button',{name:conv,exact:true}).click()
  await page.screenshot({path:`${out}/hero-${lang==='en'?'en':'zh'}.png`,fullPage:true})
  if (process.argv.includes('--start')) {
    await page.getByRole('button',{name:home,exact:true}).click()
    await page.getByRole('button',{name:start,exact:true}).click()
    try { await page.waitForURL(u=>u.searchParams.has('session'),{timeout:20000}) }
    catch(error) { console.log('START-ERROR',await page.locator('body').innerText()); throw error }
    await page.locator('.acme-sidebar').waitFor()
    await page.getByText('ACME-001',{exact:false}).first().waitFor()
    await page.waitForTimeout(2000)
    await page.screenshot({path:`${out}/session-${lang==='en'?'en':'zh'}.png`,fullPage:true})
    await writeFile(`${out}/session-url.txt`,page.url())
  }
  console.log(JSON.stringify({lang,url:page.url(),title:await page.title(),favicon:await page.locator('link[rel="icon"]').getAttribute('href'),brand:await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--agnes-brand-primary')),text:await page.locator('body').innerText()},null,2))
  await context.storageState({path:`${out}/browser-state.json`})
} finally { await browser.close() }

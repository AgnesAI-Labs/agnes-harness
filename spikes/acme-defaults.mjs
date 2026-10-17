import { existsSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const s=JSON.parse(await readFile('/tmp/agh-acme-whitelabel-state.json','utf8'))
const out=resolve('../reports/mp/ARCH/PC-ARCH0-WHITELABEL')
await mkdir(out,{recursive:true})
const b=await chromium.launch({headless:true})
try {
 const c=await b.newContext({viewport:{width:1440,height:1000},storageState:existsSync(`${out}/browser-state.json`)?`${out}/browser-state.json`:undefined})
 const p=await c.newPage();p.setDefaultTimeout(15000)
 const prefix=process.argv[2]??'uninstalled'
 for(const [lang,name] of [['zh-CN',`${prefix}-zh`],['en',`${prefix}-en`]]) {
  await p.goto(`http://127.0.0.1:${s.port}/?settings=general`)
  await p.locator('#locale-select').selectOption(lang,{force:true})
  await p.goto(`http://127.0.0.1:${s.port}/?new=1`)
  await p.getByTestId('home-entry-plugins').waitFor()
  await p.waitForTimeout(2000)
  const cancel=p.getByRole('button',{name:lang==='en'?'Cancel':'取消',exact:true})
  if(await cancel.isVisible()) await cancel.click()
  await p.screenshot({path:`${out}/${name}.png`,fullPage:true})
  console.log(name,(await p.locator('body').innerText()).slice(0,900))
 }
 await c.storageState({path:`${out}/browser-state.json`})
}finally{await b.close()}

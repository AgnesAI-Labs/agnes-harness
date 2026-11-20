import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { buildPdfPreview } from '../../../tools/pdf-preview-build.mjs'
import {
  inCssLayer,
  readMarkdownThemeCss,
  readUiCss,
  readWebStyleSource,
  readWebUiStyleSource,
} from '../../../tools/web-style-source.mjs'
import { createWebServer } from '../src/server.js'
import { twoPages } from './pdf-fixture.js'

const repository = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(repository, 'packages/web-ui/package.json'))
const fixture = process.env.AGH_DELIVERABLE_PREVIEW_FIXTURE
  ? JSON.parse(readFileSync(process.env.AGH_DELIVERABLE_PREVIEW_FIXTURE, 'utf8'))
  : {
      markdown:
        '# 标题\n\n- [简介](#简介)\n\n## 简介\n\n- [ ] 待办事项 1\n- [x] 待办事项 2\n- [ ] 待办事项 3',
      html: '<!doctype html><style>body{background:#050816}</style><object data="animation.svg" type="image/svg+xml"></object>',
    }
const sampleSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="red"><animate attributeName="fill" values="red;blue;red" dur="1s" repeatCount="indefinite"/></rect></svg>'
const encoded = (text: string) => Buffer.from(text).toString('base64')
const defaultRefs = [
  { sha256: 'b'.repeat(64), size: Buffer.byteLength(sampleSvg), mime: 'application/octet-stream' },
  { sha256: 'a'.repeat(64), size: Buffer.byteLength(fixture.html), mime: 'text/html' },
]
const snapshots = process.env.AGH_SVG_HTML_FIXTURE
  ? JSON.parse(readFileSync(process.env.AGH_SVG_HTML_FIXTURE, 'utf8'))
  : {
      call: {
        name: 'present',
        toolUseId: 'p',
        args: { files: [{ path: 'animation.svg' }, { path: 'page.html' }] },
      },
      result: { toolUseId: 'p', structured: { deliverables: defaultRefs.map((ref) => ({ ref })) } },
      files: [
        { sha256: defaultRefs[0]?.sha256, base64: encoded(sampleSvg) },
        { sha256: defaultRefs[1]?.sha256, base64: encoded(fixture.html) },
      ],
    }
const htmlRef = snapshots.result.structured.deliverables[1].ref
const animationRef = snapshots.result.structured.deliverables[0].ref
const staticBytes = snapshots.files[2] ?? snapshots.files[0]
const staticRef = {
  sha256: staticBytes.sha256,
  size: Buffer.from(staticBytes.base64, 'base64').length,
  mime: 'application/octet-stream',
}
const pdfBytes = process.env.AGH_PDF_PREVIEW_FIXTURE
  ? readFileSync(process.env.AGH_PDF_PREVIEW_FIXTURE)
  : twoPages()

for (const cloud of [false, true])
  for (const [locale, theme] of [
    ['zh-CN', 'dark'],
    ['en', 'light'],
  ])
    test(`uses real Markdown, HTML and SVG cards on the ${cloud ? 'cloud' : 'local'} origin (${locale}, ${theme})`, async ({
      page,
    }, info) => {
      const external: string[] = []
      page.on('request', (request) => {
        if (request.url().includes('preview-network.invalid')) external.push(request.url())
      })
      const root = await mkdtemp(join(tmpdir(), 'agh-deliverable-previews-'))
      await buildPdfPreview(root)
      const reservation = createServer()
      await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
      const address = reservation.address()
      if (!address || typeof address === 'string') throw Error('missing port')
      await new Promise<void>((done) => reservation.close(() => done()))
      const bundle = await build({
        stdin: {
          resolveDir: repository,
          loader: 'tsx',
          contents: `
import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DocumentPreview, HtmlPreviewFrame } from './packages/web-ui/src/conversation-vendor.ts'
import { FileCard } from './packages/package-manager/bundled-plugins/deliverables-ui/src/client.js'
import { Context } from '@agnes/cordis'
import { ClientResourceService, SessionService } from './packages/web-client/src/index.ts'
addEventListener('DOMContentLoaded', () => {
  if (${cloud} && !new URLSearchParams(location.search).has('child')) {
    const outer=document.createElement('iframe');outer.id='cloud';outer.width='1000';outer.height='1000';
    outer.sandbox='allow-scripts allow-same-origin allow-forms allow-downloads allow-popups';
    outer.src=document.querySelector('#agnes-config').dataset.cloudOrigin+'/?remote=https%3A%2F%2Ffixture.example&child=1';
    document.body.append(outer);return;
  }
  const host=document.createElement('main');host.style.width='800px';document.body.append(host);
  const snapshots=${JSON.stringify(snapshots)};
  const attack='<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>window.__svgExecuted=true</script><image href="https://preview-network.invalid/image.png"/><rect width="40" height="40" fill="red"/></svg>';
  const missing='<img src="missing.svg">';
  const entries=[...snapshots.files,{sha256:'e'.repeat(64),base64:btoa(attack)},{sha256:'f'.repeat(64),base64:btoa(missing)}];
  const sdk={call:async (method,input)=>{
    if(method!=='_agnes/v1/artifact.read'||input.sessionId!=='preview-session'||input.laneId!=='main')throw Error('unauthorized fixture read');
    const base64=entries.find(entry=>entry.sha256===input.artifact.sha256)?.base64;
    if(!base64)throw Error('missing fixture snapshot');
    return {ok:true,status:200,artifact:input.artifact,contentLength:atob(base64).length,base64};
  },sessions:{get:()=>({readToolDetail:async (call,result)=>{
    if(call!==263||result!==278)throw Error('unexpected tool coordinates');return snapshots;
  }})}};
  const owner=new Context(), session=new SessionService(owner,'preview-session');
  const resources=new ClientResourceService(owner,sdk,session);
  const ctx={locale:{locale:${JSON.stringify(locale)},t:key=>key},resources};
  const card=(id,artifact,name='插画.svg')=>h(FileCard,{file:{id,name,laneId:'main',artifact,source:{callSeq:263,resultSeq:278}},ctx:{...ctx,selection:{id}}});
  const blobOnlyUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(pdfBytes.toString('base64'))}),ch=>ch.charCodeAt(0))],{type:'application/pdf'}));
  window.blobOnlyUrl=blobOnlyUrl;
  function LegacyPdf(){const[open,setOpen]=useState(true);return h('section',{id:'legacy-pdf'},
    h('button',{id:'close-legacy',onClick:()=>setOpen(false)},'Close legacy PDF'),
    open&&h(DocumentPreview,{kind:'pdf',resourceUrl:blobOnlyUrl}));}
  createRoot(host).render(h('div',null,
    h(LegacyPdf),
    h('input',{id:'form-field',type:'text','aria-label':'form field'}),
    h('section',{id:'markdown'},h(DocumentPreview,{kind:'markdown',theme:${JSON.stringify(theme)},content:${JSON.stringify(fixture.markdown)}})),
    h('section',{id:'self-contained'},h(HtmlPreviewFrame,{html:'<h1 id="content">HTML 正常</h1><svg width="80" height="40"><rect width="80" height="40" fill="red"/></svg>',title:'self contained'})),
    h('section',{id:'relative'},card('relative',${JSON.stringify(htmlRef)},'预览.html')),
    h('section',{id:'svg'},card('svg',${JSON.stringify(staticRef)})),
    h('section',{id:'animation'},card('animation',${JSON.stringify(animationRef)})),
    h('section',{id:'typed-svg'},card('typed', {...${JSON.stringify(staticRef)},mime:'image/svg+xml'})),
    h('section',{id:'inert-svg'},card('inert',{sha256:'e'.repeat(64),size:attack.length,mime:'image/svg+xml'})),
    h('section',{id:'missing'},card('missing',{sha256:'f'.repeat(64),size:missing.length,mime:'text/html'},'missing.html'))));
});`,
        },
        outdir: root,
        entryNames: 'app',
        bundle: true,
        nodePaths: [
          join(repository, 'packages/web-ui/node_modules'),
          join(repository, 'packages/web-client/node_modules'),
        ],
        write: false,
        jsx: 'automatic',
        format: 'iife',
        define: { 'import.meta.url': 'location.href' },
      })
      const app = bundle.outputFiles.find((file) => file.path.endsWith('.js'))
      if (!app) throw Error('fixture did not compile')
      await writeFile(join(root, 'app.js'), app.contents)
      const ui = join(repository, 'packages/web-ui/src')
      const css = [
        readWebStyleSource(join(repository, 'packages/web/public/style.css')),
        readWebUiStyleSource(join(ui, 'tokens.css')),
        readUiCss(join(ui, 'conversation/messages.css')),
        readUiCss(join(ui, 'intelligent-ui/styles.css')),
        inCssLayer(
          [
            bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '',
            readMarkdownThemeCss(require.resolve('@ant-design/x-markdown/themes/light.css')),
            readMarkdownThemeCss(require.resolve('@ant-design/x-markdown/themes/dark.css')),
          ].join('\n'),
          'vendor',
        ),
        readUiCss(join(ui, 'conversation/markdown.css')),
        'main iframe {width:780px;height:540px}',
      ].join('\n')
      await writeFile(join(root, 'style.css'), css)
      await writeFile(
        join(root, 'index.html'),
        `<!doctype html><html lang="${locale}" class="${theme === 'dark' ? 'dark' : ''}"><meta id="agnes-config"><meta name="agnes-csp-nonce" content="__AGNES_CSP_NONCE__"><meta content="__AGNES_WS_URL__"><link rel="stylesheet" href="/style.css"><script src="/app.js"></script><body data-agnes-region="app"></body></html>`,
      )
      const web = await createWebServer({ root, port: address.port, wsUrl: 'ws://127.0.0.1:4312' })
      try {
        await page.goto(web.url)
        const host = cloud ? page.frameLocator('#cloud') : page
        const markdown = host.locator('#markdown')
        const legacy = host.frameLocator('#legacy-pdf iframe')
        await expect
          .poll(() => legacy.locator('canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).width))
          .toBeGreaterThan(100)
        await expect(legacy.locator('#page')).toHaveText(
          process.env.AGH_PDF_PREVIEW_FIXTURE ? '1 / 1' : '1 / 2',
        )
        await host.locator('#close-legacy').click()
        await expect(host.locator('#legacy-pdf iframe')).toHaveCount(0)
        expect(
          await host.locator('main').evaluate(async () => {
            const url = Reflect.get(window, 'blobOnlyUrl')
            return (await fetch(url)).ok
          }),
        ).toBe(true)
        await expect(markdown.locator('input[type=checkbox]')).toHaveCount(3)
        const boxes = await markdown.locator('input[type=checkbox]').evaluateAll((inputs) =>
          inputs.map((input) => ({
            width: input.getBoundingClientRect().width,
            height: input.getBoundingClientRect().height,
            disabled: (input as HTMLInputElement).disabled,
          })),
        )
        expect(
          boxes.every(({ width, height }) => width <= 20 && height <= 20),
          JSON.stringify(boxes),
        ).toBe(true)
        expect(boxes.every(({ disabled }) => disabled)).toBe(true)
        expect(
          await host.locator('#form-field').evaluate((input) => input.getBoundingClientRect().width),
        ).toBeGreaterThan(300)
        await expect(host.frameLocator('#self-contained iframe').locator('#content')).toHaveText('HTML 正常')
        await expect(host.frameLocator('#self-contained iframe').locator('svg rect')).toHaveCount(1)
        const relative = host.frameLocator('#relative iframe')
        await expect(relative.locator('object')).toHaveCount(0)
        await expect
          .poll(() => relative.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth))
          .toBeGreaterThan(0)
        for (const id of ['svg', 'typed-svg', 'animation', 'inert-svg']) {
          await expect
            .poll(() => host.locator(`#${id} img`).evaluate((img) => (img as HTMLImageElement).naturalWidth))
            .toBeGreaterThan(0)
          await expect(host.locator(`#${id}`)).not.toContainText('不支持站内预览')
        }
        const animation = host.locator('#animation img')
        const first = await animation.screenshot()
        await expect
          .poll(async () => (await animation.screenshot()).equals(first), { timeout: 4000 })
          .toBe(false)
        expect(external).toEqual([])
        await expect(host.locator('#missing')).toContainText(
          locale === 'zh-CN' ? 'HTML 预览所需的同目录资源' : 'HTML preview resources are missing',
        )
        await expect(host.locator('#missing iframe')).toHaveCount(0)
        expect(
          await host.locator('main').evaluate(() => Reflect.get(window, '__svgExecuted')),
        ).toBeUndefined()
        await info.attach('html.png', {
          body: await host.locator('#relative iframe').screenshot({ path: info.outputPath('html.png') }),
          contentType: 'image/png',
        })
        await info.attach('svg.png', {
          body: await host.locator('#svg img').screenshot({ path: info.outputPath('svg.png') }),
          contentType: 'image/png',
        })
        await info.attach('markdown.png', {
          body: await markdown.screenshot({ path: info.outputPath('markdown.png') }),
          contentType: 'image/png',
        })
        for (const id of ['svg', 'relative']) {
          const toggle = host.locator(`#${id} [data-testid=deliverable-open]`)
          // Screenshots scroll between distant cards; settle the target before native hit testing.
          await toggle.scrollIntoViewIfNeeded()
          await expect(toggle).toHaveAttribute('aria-expanded', 'true')
          await toggle.click()
          await expect(toggle).toHaveAttribute('aria-expanded', 'false')
          await expect(host.locator(`#${id} img,#${id} iframe`)).toHaveCount(0)
          await toggle.click()
          await expect(toggle).toHaveAttribute('aria-expanded', 'true')
          const image =
            id === 'relative'
              ? host.frameLocator('#relative iframe').locator('img')
              : host.locator('#svg img')
          await expect
            .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
            .toBeGreaterThan(0)
        }
      } finally {
        await web.close()
        await rm(root, { recursive: true, force: true })
      }
    })

test('preserves full HTML and deferred srcset resources on both isolated origins', async ({ browser }) => {
  const root = await mkdtemp(join(tmpdir(), 'agh-html-semantics-'))
  const context = await browser.newContext({ deviceScaleFactor: 2 })
  const page = await context.newPage()
  const unexpected: string[] = []
  await context.route('**/__agnes/parse-audit', (route) => {
    unexpected.push(route.request().url())
    return route.fulfill({ status: 200, body: '' })
  })
  await context.route('https://preview-audit.invalid/**', (route) => {
    unexpected.push(route.request().url())
    return route.fulfill({ status: 200, body: '' })
  })
  const script =
    'document.body.dataset.scriptState=document.readyState;document.getElementById("target").textContent="deferred-ready";try{void parent.document.title;document.body.dataset.isolation="broken"}catch{document.body.dataset.isolation="opaque"}fetch("https://preview-audit.invalid/blocked").then(()=>document.body.dataset.network="allowed",()=>document.body.dataset.network="blocked")'
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8"/></svg>'
  const html =
    '<!doctype html><html lang="zh-CN"><head><style>body.page{background:rgb(1,2,3)}#css{background-image:url(data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=),url(art.svg);--local-filter:url(#mask)}</style><script defer src="app.js"></script></head><body class="page" style="padding:12px"><h1 id="target">waiting</h1><div id="css">CSS</div><img id="responsive" srcset="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs= 1x, art.svg 2x"></body></html>'
  const refs = [html, script, svg].map((text, index) => ({
    sha256: String(index + 1).repeat(64),
    size: Buffer.byteLength(text),
    mime: ['text/html', 'text/javascript', 'image/svg+xml'][index],
  }))
  const reservation = createServer()
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw Error('missing port')
  await new Promise<void>((done) => reservation.close(() => done()))
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><meta id="agnes-config"><meta content="__AGNES_CSP_NONCE__"><meta name="ws" content="__AGNES_WS_URL__"><script src="/app.js"></script>',
  )
  await build({
    stdin: {
      resolveDir: repository,
      contents: `
import { prepareHtmlPreview } from './packages/web-ui/src/conversation/html-preview-resources.ts';
addEventListener('DOMContentLoaded', async () => {
  const refs=${JSON.stringify(refs)}, values=${JSON.stringify([html, script, svg].map(encoded))};
  try { await prepareHtmlPreview('<img src="/__agnes/parse-audit"><script>window.__parsedRan=true</script>', refs[0], async()=>{throw Error('not delivered')}, async()=>{throw Error('not delivered')}); } catch {}
  const html=await prepareHtmlPreview(${JSON.stringify(html)}, refs[0], async()=>({
    call:{name:'present',toolUseId:'p',args:{files:['page.html','app.js','art.svg'].map(path=>({path:'demo/'+path}))}},
    result:{toolUseId:'p',structured:{deliverables:refs.map(ref=>({ref}))}}
  }),async ref=>{const base64=values[refs.findIndex(item=>item.sha256===ref.sha256)];return {base64,bytes:Uint8Array.from(atob(base64),c=>c.charCodeAt(0)).buffer}});
  const frame=document.createElement('iframe');frame.id='preview';frame.sandbox='allow-scripts';
  addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.data?.type==='agnes-preview-ready')frame.contentWindow.postMessage({type:'agnes-preview-html',html},'*')});
  frame.src='/__agnes/deliverable-preview';document.body.append(frame);
});`,
    },
    outfile: join(root, 'app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
  })
  const web = await createWebServer({ root, port: address.port, wsUrl: 'ws://127.0.0.1:4312' })
  try {
    await page.goto(web.url)
    const cloudOrigin = await page.locator('#agnes-config').getAttribute('data-cloud-origin')
    if (!cloudOrigin) throw Error('missing cloud origin')
    for (const origin of [web.url, `${cloudOrigin}/?remote=https%3A%2F%2Fpreview.invalid`]) {
      if (origin !== web.url) await page.goto(origin)
      const preview = page.frameLocator('#preview')
      await expect(preview.locator('#target')).toHaveText('deferred-ready')
      await expect(preview.locator('html')).toHaveAttribute('lang', 'zh-CN')
      await expect(preview.locator('body')).toHaveAttribute('class', 'page')
      await expect(preview.locator('body')).toHaveAttribute('data-script-state', 'interactive')
      await expect(preview.locator('body')).toHaveAttribute('data-isolation', 'opaque')
      await expect(preview.locator('body')).toHaveAttribute('data-network', 'blocked')
      await expect(preview.locator('body')).toHaveCSS('padding', '12px')
      await expect(preview.locator('body')).toHaveCSS('background-color', 'rgb(1, 2, 3)')
      await expect(preview.locator('#responsive')).toHaveJSProperty(
        'currentSrc',
        `data:image/svg+xml;base64,${encoded(svg)}`,
      )
      const styles = await preview.locator('#css').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.backgroundImage, style.getPropertyValue('--local-filter')]
      })
      expect(styles[0]).toContain('data:image/gif;base64,')
      expect(styles[0]).toContain(`data:image/svg+xml;base64,${encoded(svg)}`)
      expect(styles[1]).toContain('#mask')
      expect(await page.evaluate(() => Reflect.get(window, '__parsedRan'))).toBeUndefined()
    }
    expect(unexpected).toEqual([])
  } finally {
    await context.close()
    await web.close()
    await rm(root, { recursive: true, force: true })
  }
})

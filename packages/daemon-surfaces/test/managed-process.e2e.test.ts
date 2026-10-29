import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { createManagedServiceSupervisor } from '../src/managed/supervisor.js'

// Real child processes belong to the heavy tier. Central platform acceptance runs this test.
it.skipIf(process.platform === 'win32')(
  'reaps the managed artifact and its ordinary descendants on cold shutdown',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'agh-managed-tree-'))
    const artifact = join(root, 'dist', 'server.mjs')
    mkdirSync(dirname(artifact), { recursive: true })
    writeFileSync(
      artifact,
      `
import {createServer} from 'node:http'
import {createServer as tcp} from 'node:net'
import {spawn} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
const init=JSON.parse(process.env.AGNES_MANAGED_INIT)
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})
writeFileSync(join(dirname(init.storePath),'descendant.pid'),String(child.pid))
const device=tcp()
await new Promise((resolve)=>device.listen(init.listeners.device.port,'127.0.0.1',resolve))
const server=createServer((req,res)=>{
  if(req.headers['x-agnes-incarnation']!==init.incarnation){res.writeHead(403).end();return}
  res.setHeader('content-type','application/json')
  if(req.method==='POST'&&req.url==='/_agnes/managed/shutdown'){
    res.end(JSON.stringify({incarnation:init.incarnation,state:'settled'}));return
  }
  res.end(JSON.stringify({incarnation:init.incarnation,apiVersion:init.apiVersion,
    listeners:Object.keys(init.listeners),storageReady:true,shutdownReady:true}))
})
await new Promise((resolve)=>server.listen(Number(process.env.PORT),'127.0.0.1',resolve))
`,
    )
    const selector = { profileId: 'synthetic', owner: 'sample/plugin', serviceId: 'sample' }
    const supervisor = createManagedServiceSupervisor({
      installationId: 'synthetic',
      directory: join(root, 'managed'),
      async resolve() {
        return {
          owner: selector.owner,
          profileId: selector.profileId,
          packageId: '@sample/plugin',
          revision: 'synthetic-one',
          activationId: 'one',
          descriptor: {
            id: 'sample',
            scope: 'profile',
            artifact: { kind: 'node', entry: './dist/server.mjs' },
            healthPath: '/health',
            listeners: [{ name: 'device', host: '127.0.0.1', port: 'auto' }],
            startupTimeoutMs: 5000,
            shutdownTimeoutMs: 1000,
            apiVersion: '1.0.0',
            requires: [],
          },
          artifact: { entry: artifact, cwd: root },
          signal: new AbortController().signal,
          assertCurrent() {},
        }
      },
    })
    try {
      expect((await supervisor.ensure(selector)).state).toBe('ready')
      const pid = Number(readFileSync(join(root, 'managed', 'descendant.pid'), 'utf8'))
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      await supervisor.stop(selector)
      let gone = false
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(pid, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            gone = true
            break
          }
          throw error
        }
        await delay(10)
      }
      expect(gone).toBe(true)
      expect(supervisor.status(selector)?.state).toBe('stopped')
    } finally {
      await supervisor.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  10000,
)

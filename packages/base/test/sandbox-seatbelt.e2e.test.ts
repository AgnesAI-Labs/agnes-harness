import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExec } from '@agnes/host-infrastructure/adapters/exec'
import { openLocalProcess } from '@agnes/host-infrastructure/adapters/process'
import { createLocalSandboxProvider } from '@agnes/host-infrastructure/adapters/sandbox-local'
import * as systemNode from '@agnes/system-node'
import { LOOPBACK_GATE_PATH_PREFIX, openLoopbackListener } from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { seatbeltDenyNetworkArgv } from '../src/sandbox-seatbelt.js'

function run(argv: string[], env?: NodeJS.ProcessEnv) {
  const [file, ...args] = argv
  if (!file) throw new Error('missing executable')
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(file, args, { timeout: 3000, ...(env ? { env } : {}) }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout })
    })
  })
}
// These are platform acceptance checks, not simulated results. Non-macOS skips remain OS-matrix debt.
const seatbelt = it.runIf(existsSync('/usr/bin/sandbox-exec'))
seatbelt(
  'protects the Unix gate path against replacement and aliases even with broad temporary write access',
  async () => {
    const { createServer: unixServer } = await import('node:net')
    const directory = mkdtempSync(LOOPBACK_GATE_PATH_PREFIX)
    const path = join(directory, 's')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-gate-path-')))
    const server = unixServer((socket) => socket.end('private'))
    await new Promise<void>((resolve) => server.listen(path, resolve))
    const aliases = [path, path.replace('/private/tmp/', '/tmp/'), path.toUpperCase()].filter(existsSync)
    const program = `
    const fs=require('node:fs'), net=require('node:net');
    fs.writeFileSync(${JSON.stringify(join(root, 'allowed'))},'ok');
    const attempts=[
      ...${JSON.stringify(aliases)}.map(path=>()=>fs.unlinkSync(path)),
      ()=>fs.renameSync(${JSON.stringify(directory)},${JSON.stringify(join(root, 'moved'))}),
      ()=>fs.linkSync(${JSON.stringify(path)},${JSON.stringify(join(root, 'alias'))}),
      ()=>fs.symlinkSync(${JSON.stringify(join(root, 'peer'))},${JSON.stringify(join(directory, 'replacement'))}),
    ].map(f=>{try{f();return 'ALLOWED'}catch(e){return e.code}});
    const s=net.createServer();s.on('error',e=>console.log(JSON.stringify([...attempts,e.code])));s.listen(${JSON.stringify(join(root, 'new.sock'))},()=>{console.log(JSON.stringify([...attempts,'BOUND']));s.close()});
  `
    try {
      const result = await run(
        seatbeltDenyNetworkArgv([process.execPath, '-e', program], {
          allowPaths: ['/private/tmp', root],
          denyPaths: [],
          loopbackServe: true,
        }),
      )
      expect(result.code).toBe(0)
      expect(readFileSync(join(root, 'allowed'), 'utf8')).toBe('ok')
      expect(JSON.parse(result.stdout)).toEqual(
        Array(aliases.length + 4).fill(expect.stringMatching(/^(EPERM|EACCES)$/)),
      )
      expect(existsSync(path)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  },
)
seatbelt.each([
  ['exec', 'exit'],
  ['exec', 'abort'],
  ['exec', 'dispose'],
  ['exec', 'timeout'],
  ['interactive', 'exit'],
  ['interactive', 'call-end-then-close'],
  ['interactive', 'close'],
  ['interactive', 'dispose'],
  ['pty', 'close'],
] as const)(
  'revokes the public listener and an established stream on %s %s despite detached inherited pipes',
  async (mode, end) => {
    const { createConnection } = await import('node:net')
    const { once } = await import('node:events')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-gate-')))
    const ready = join(root, 'ready'),
      finish = join(root, 'finish')
    const controller = new AbortController()
    const instance = await createLocalSandboxProvider(createExec(), 'darwin', { ownProcesses: true }).create({
      workspaceRoot: root,
    })
    const enforcement = { level: 'full' as const, scope: ['file', 'network', 'process'] as const }
    const worker = `
      const net=require('node:net'),fs=require('node:fs');
      const server=net.createServer({allowHalfOpen:true},socket=>{
        let headers='';
        const read=chunk=>{
          headers+=chunk;
          if(!headers.includes('\\r\\n\\r\\n')) return;
          socket.off('data',read);
          const path=headers.split(' ')[1];
          if(path==='/ws') {
            const key=headers.match(/Sec-WebSocket-Key: (.+)\\r\\n/i)[1].trim();
            const accept=require('node:crypto').createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');
            const send=text=>socket.write(Buffer.concat([Buffer.from([0x81,Buffer.byteLength(text)]),Buffer.from(text)]));
            send('ws-ready');const timer=setInterval(()=>send('ws-tick'),20);
            socket.on('close',()=>clearInterval(timer));
          } else if(path==='/stream') {
            socket.write('HTTP/1.1 200 OK\\r\\nConnection: close\\r\\n\\r\\nstream-ready');
            const timer=setInterval(()=>socket.write('tick'),20);
            socket.on('close',()=>clearInterval(timer));
          } else {
            const body=path==='/half'?'half-response'.repeat(100000):'gate-ready';
            const send=()=>socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: '+body.length+'\\r\\nConnection: close\\r\\n\\r\\n'+body);
            if(path==='/half') setTimeout(send,20); else send();
          }
        };
        socket.on('data',read);
        socket.on('error',()=>{});
      });
      server.listen({fd:4},()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,url:process.env.AGH_LOOPBACK_URL})));
      setTimeout(()=>process.exit(),15000);
    `
    const leader = `
      const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:['ignore',1,2,'ignore',4]});child.unref();
      setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(finish)})) process.exit();},10);
    `
    const request = {
      argv: seatbeltDenyNetworkArgv([process.execPath, '-e', leader], {
        allowPaths: [root],
        denyPaths: [],
        loopbackServe: true,
      }),
      cwd: root,
      signal: controller.signal,
      policy: {
        workspaceRoot: root,
        digest: 'gate',
        fsRead: { allow: ['/'], deny: [] },
        fsWrite: { allow: [root], deny: [] },
        network: { mode: 'loopback-serve' as const, hosts: [] },
        requiredEnforcement: enforcement,
      },
      enforcement,
      limits: { timeoutMs: end === 'timeout' ? 2000 : 10000 },
    }
    const handle =
      mode === 'exec'
        ? undefined
        : await instance.openProcess!({
            ...request,
            ...(mode === 'pty' ? { pty: { columns: 80, rows: 24 } } : {}),
          })
    const invocation = handle ? handle.exited : instance.exec(request)
    void invocation.catch(() => undefined)
    let pid: number | undefined
    let stream: ReturnType<typeof createConnection> | undefined
    let websocket: ReturnType<typeof createConnection> | undefined
    try {
      await expect.poll(() => existsSync(ready)).toBe(true)
      const facts = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; url: string }
      pid = facts.pid
      expect(await (await fetch(facts.url)).text()).toBe('gate-ready')
      if (mode === 'exec' && end === 'exit') {
        const half = createConnection({
          host: '127.0.0.1',
          port: Number(new URL(facts.url).port),
          allowHalfOpen: true,
        })
        let response = ''
        half.on('data', (chunk) => {
          response += chunk
        })
        const ended = once(half, 'end')
        half.end('GET /half HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
        half.pause()
        await new Promise((resolve) => setTimeout(resolve, 50))
        half.resume()
        await ended
        const body = response.slice(response.indexOf('\r\n\r\n') + 4)
        expect(body.length).toBe(1_300_000)
        expect(createHash('sha256').update(body).digest('hex')).toBe(
          createHash('sha256').update('half-response'.repeat(100000)).digest('hex'),
        )
      }
      stream = createConnection({ host: '127.0.0.1', port: Number(new URL(facts.url).port) })
      stream.on('error', () => undefined)
      let streamText = ''
      stream.on('data', (chunk) => {
        streamText += chunk
      })
      stream.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n')
      await expect.poll(() => streamText).toContain('stream-ready')
      const closed = new Promise<void>((resolve) => stream!.once('close', () => resolve()))
      websocket = createConnection({ host: '127.0.0.1', port: Number(new URL(facts.url).port) })
      websocket.on('error', () => undefined)
      let websocketText = ''
      websocket.on('data', (chunk) => {
        websocketText += chunk.toString('latin1')
      })
      const websocketClosed = new Promise<void>((resolve) => websocket!.once('close', () => resolve()))
      websocket.write(
        'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      )
      await expect.poll(() => websocketText).toContain('101 Switching Protocols')
      expect(websocketText).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
      await expect.poll(() => websocketText).toContain('ws-tick')
      let closing: Promise<void> | undefined
      if (end === 'exit') writeFileSync(finish, '')
      if (end === 'abort') controller.abort()
      if (end === 'call-end-then-close') {
        controller.abort()
        expect(await (await fetch(facts.url)).text()).toBe('gate-ready')
        closing = handle!.close()
      }
      if (end === 'dispose') closing = Promise.resolve(instance.dispose())
      if (end === 'close') closing = handle!.close()
      await expect
        .poll(
          async () => {
            return fetch(facts.url, { signal: AbortSignal.timeout(200) }).then(
              () => false,
              () => true,
            )
          },
          { timeout: 4000 },
        )
        .toBe(true)
      await Promise.all([closed, websocketClosed])
      const received = streamText.length + websocketText.length
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(streamText.length + websocketText.length).toBe(received)
      // The descendant is still alive in a different group; revocation did not depend on killing it.
      expect(() => process.kill(pid!, 0)).not.toThrow()
      process.kill(pid, 'SIGKILL')
      pid = undefined
      await closing
      await invocation
    } finally {
      stream?.destroy()
      websocket?.destroy()
      controller.abort()
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already exited */
        }
      }
      await instance.dispose()
      await invocation.catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  },
  15000,
)
seatbelt.each(['exit', 'abort', 'dispose'] as const)(
  'security2: an activated listener cannot survive its owning command after %s',
  async (end) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-security2-listener-')))
    const ready = join(root, 'ready.json')
    const finish = join(root, 'finish')
    const controller = new AbortController()
    const exec = createExec()
    const provider = createLocalSandboxProvider(exec, 'darwin', { ownProcesses: true })
    const instance = await provider.create({ workspaceRoot: root })
    const enforcement = { level: 'full' as const, scope: ['file', 'network', 'process'] as const }
    const childProgram = `
      const server = require('node:http').createServer((_, res) => res.end('SECURITY2_ORPHAN_LISTENER'));
      server.listen({fd:4}, () => require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,url:process.env.AGH_LOOPBACK_URL})));
      setTimeout(() => process.exit(0), 10000);
    `
    const program = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], {detached:true, stdio:['ignore','ignore','ignore','ignore',4]});
      child.unref();
      ${end === 'exit' ? `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(finish)})) process.exit(0); }, 10);` : 'setInterval(() => {}, 1000);'}
    `
    const invocation = instance.exec({
      argv: seatbeltDenyNetworkArgv([process.execPath, '-e', program], {
        allowPaths: [root],
        denyPaths: [],
        loopbackServe: true,
      }),
      cwd: root,
      signal: controller.signal,
      policy: {
        workspaceRoot: root,
        digest: 'security2',
        fsRead: { allow: ['/'], deny: [] },
        fsWrite: { allow: [root], deny: [] },
        network: { mode: 'loopback-serve', hosts: [] },
        requiredEnforcement: enforcement,
      },
      enforcement,
      limits: { timeoutMs: 5000 },
    })
    void invocation.catch(() => undefined)
    let childPid: number | undefined
    try {
      const deadline = Date.now() + 4000
      while (!existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(existsSync(ready)).toBe(true)
      const facts = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; url: string }
      childPid = facts.pid
      expect(await (await fetch(facts.url, { signal: AbortSignal.timeout(1000) })).text()).toBe(
        'SECURITY2_ORPHAN_LISTENER',
      )
      if (end === 'exit') writeFileSync(finish, '')
      if (end === 'abort') controller.abort()
      if (end === 'dispose') await instance.dispose()
      await invocation
      await instance.dispose()
      const late = await fetch(facts.url, { signal: AbortSignal.timeout(500) }).then(
        (response) => response.text(),
        () => 'REFUSED',
      )
      expect(late).toBe('REFUSED')
    } finally {
      controller.abort()
      await instance.dispose()
      await invocation.catch(() => undefined)
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          /* already exited */
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  },
  15000,
)
seatbelt(
  'security2: loopback serving still denies UDP, DNS and Unix peers reached by an unconfined control',
  async () => {
    const { createSocket } = await import('node:dgram')
    const { createServer: createUnixServer } = await import('node:net')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-security2-peers-')))
    const path = join(root, 'peer.sock')
    const udp = createSocket('udp4')
    let datagrams = 0,
      connections = 0
    udp.on('message', () => {
      datagrams++
    })
    const unix = createUnixServer((socket) => {
      connections++
      socket.end()
    })
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => unix.listen(path, resolve))
    const port = udp.address().port
    const program = `
    const udp=require('node:dgram').createSocket('udp4');
    const direct=new Promise(resolve=>{udp.on('error',e=>{udp.close();resolve(e.code)});udp.send(Buffer.from('synthetic-udp'),${port},'127.0.0.1',e=>{udp.close();resolve(e?e.code:'SENT')})});
    const unix=new Promise(resolve=>{const s=require('node:net').connect(${JSON.stringify(path)});s.on('error',e=>resolve(e.code));s.on('connect',()=>{s.end();resolve('CONNECTED')})});
    const resolver=new (require('node:dns').Resolver)({timeout:100,tries:1});resolver.setServers(['127.0.0.1:${port}']);
    const dns=new Promise(resolve=>resolver.resolve4('security2.example.invalid',e=>resolve(e?e.code:'RESOLVED')));
    Promise.all([direct,unix,dns]).then(result=>console.log(JSON.stringify(result)));
  `
    try {
      const control = await run([process.execPath, '-e', program])
      expect(control.code).toBe(0)
      expect(JSON.parse(control.stdout).slice(0, 2)).toEqual(['SENT', 'CONNECTED'])
      expect(datagrams).toBeGreaterThan(1)
      expect(connections).toBe(1)
      datagrams = 0
      connections = 0
      const confined = await run(
        seatbeltDenyNetworkArgv([process.execPath, '-e', program], {
          allowPaths: [root],
          denyPaths: [],
          loopbackServe: true,
        }),
      )
      expect(confined.code).toBe(0)
      const results = JSON.parse(confined.stdout) as string[]
      expect(results).not.toContain('SENT')
      expect(results).not.toContain('CONNECTED')
      expect(results).not.toContain('RESOLVED')
      expect(datagrams).toBe(0)
      expect(connections).toBe(0)
    } finally {
      udp.close()
      await new Promise<void>((resolve) => unix.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  },
)
seatbelt(
  'enforces actual writes, secret reads/writes, symlink targets and descendant inheritance',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-seatbelt-')))
    const allowed = join(root, 'allow " \\ 中文')
    const denied = join(allowed, 'secret')
    mkdirSync(allowed)
    mkdirSync(denied)
    const secret = join(denied, 'value')
    writeFileSync(secret, 'private')
    symlinkSync(secret, join(allowed, 'link'))
    const confine = (cmd: string, ...args: string[]) =>
      seatbeltDenyNetworkArgv(['/bin/sh', '-c', cmd, 'probe', ...args], {
        allowPaths: [allowed],
        denyPaths: [denied],
      })
    try {
      expect(await run(confine('printf ok > "$1"; cat "$1"', join(allowed, 'ok')))).toEqual({
        code: 0,
        stdout: 'ok',
      })
      const env = {
        PATH: '/usr/bin:/bin',
        HOME: allowed,
        TMPDIR: allowed,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      }
      expect((await run(['/usr/bin/git', 'init', '--quiet', '--template=', allowed], env)).code).toBe(0)
      const status = await run(confine('git -C "$1" status --short', allowed), env)
      expect(status.code).toBe(0)
      expect(status.stdout).toContain('?? ok')
      expect(await run(confine('echo x > /dev/null; exec 3<> /dev/null'))).toEqual({ code: 0, stdout: '' })
      const denyNull = seatbeltDenyNetworkArgv(['/bin/sh', '-c', 'echo x > /dev/null'], {
        allowPaths: [allowed],
        denyPaths: [denied, '/dev/null'],
      })
      expect((await run(denyNull)).code).not.toBe(0)
      expect((await run(confine('echo x > /dev/zero'))).code).not.toBe(0)
      expect((await run(confine('printf bad > "$1"', join(root, 'outside')))).code).not.toBe(0)
      expect(existsSync(join(root, 'outside'))).toBe(false)
      expect((await run(confine('cat "$1"', secret))).code).not.toBe(0)
      expect((await run(confine('printf bad > "$1"', secret))).code).not.toBe(0)
      expect((await run(confine('cat "$1"', join(allowed, 'link')))).code).not.toBe(0)
      expect((await run(confine('/bin/sh -c \'cat "$1"\' child "$1"', secret))).code).not.toBe(0)
      expect(readFileSync(secret, 'utf8')).toBe('private')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
seatbelt('blocks a real loopback request whose unconfined control reaches the server', async () => {
  let requests = 0
  const server = createServer((_req, res) => {
    requests++
    res.end('reachable')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const argv = [
    '/usr/bin/curl',
    '--silent',
    '--show-error',
    '--max-time',
    '1',
    '--noproxy',
    '*',
    `http://127.0.0.1:${address.port}/`,
  ]
  try {
    expect(await run(argv)).toEqual({ code: 0, stdout: 'reachable' })
    expect(requests).toBe(1)
    const result = await run(seatbeltDenyNetworkArgv(argv, { allowPaths: [], denyPaths: [] }))
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(requests).toBe(1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it.runIf(existsSync('/usr/bin/sandbox-exec') && existsSync('/bin/zsh'))(
  'preserves controlling-TTY job control in a confined interactive shell',
  async () => {
    const handle = await openLocalProcess({
      argv: seatbeltDenyNetworkArgv(['/bin/zsh', '-f', '-i'], { allowPaths: [], denyPaths: [] }),
      cwd: tmpdir(),
      env: { HOME: tmpdir() },
      pty: { columns: 80, rows: 24 },
    })
    let output = ''
    handle.onOutput((chunk) => {
      output += chunk.text
    })
    try {
      await handle.write('tty; print -r -- control-$options[monitor]; exit\r')
      await handle.exited
      expect(output).toMatch(/\/dev\/tty[^\s]+/)
      expect(output).toContain('control-on')
      expect(output).not.toMatch(/can't set tty pgrp|no job control/i)
    } finally {
      await handle.close()
    }
  },
)

seatbelt('serves real IPv4/IPv6 loopback HTTP without wildcard binds or outbound connections', async () => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const control = createServer((_req, res) => res.end('control'))
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve))
  const address = control.address()
  if (!address || typeof address === 'string') throw new Error('missing control address')
  const program = `
    const http = require('node:http'), net = require('node:net');
    const bind = host => new Promise(resolve => {
      const server = http.createServer((_, res) => res.end('loopback-only'));
      server.once('error', error => resolve({ host, error: error.code }));
      server.listen(0, host, () => resolve({ host, port: server.address().port }));
    });
    const connect = host => new Promise(resolve => {
      const socket = net.connect({host, port: ${address.port}});
      socket.on('error', error => resolve(error.code));
      socket.on('connect', () => { socket.destroy(); resolve('CONNECTED'); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve('TIMEOUT'); });
    });
    (async () => {
      const activated = await Promise.all([4,5].map(fd => new Promise((resolve,reject) => { const s=http.createServer((_,r)=>r.end('loopback-only'));s.on('error',reject);s.listen({fd},()=>resolve({host:s.address().address,port:s.address().port})) })));
      const lan = Object.values(require('node:os').networkInterfaces()).flat().find(row=>row && row.family==='IPv4' && !row.internal)?.address;
      const binds = await Promise.all(['127.0.0.1','::1','0.0.0.0','::',...(lan?[lan]:[])].map(bind));
      const outbound = await Promise.all(['127.0.0.1','192.0.2.1'].map(connect));
      console.log(JSON.stringify({ activated, binds, outbound }));
    })();
  `
  const argv = seatbeltDenyNetworkArgv([process.execPath, '-e', program], {
    allowPaths: [],
    denyPaths: [],
    loopbackServe: true,
  })
  const descriptors: number[] = []
  let child: ReturnType<typeof spawn>
  try {
    descriptors.push(openLoopbackListener('ipv4').fd)
    descriptors.push(openLoopbackListener('ipv6').fd)
    child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe', 'ignore', ...descriptors] })
  } catch (error) {
    await new Promise<void>((resolve) => control.close(() => resolve()))
    throw error
  } finally {
    for (const fd of descriptors) closeSync(fd)
  }
  let stdout = '',
    stderr = ''
  child.stderr!.on('data', (chunk) => {
    stderr += chunk
  })
  try {
    const facts = await new Promise<{
      activated: { host: string; port: number }[]
      binds: { host: string; port?: number; error?: string }[]
      outbound: string[]
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 5000)
      child.stdout!.on('data', (chunk) => {
        stdout += chunk
        if (stdout.includes('\n')) {
          clearTimeout(timeout)
          resolve(JSON.parse(stdout.trim()))
        }
      })
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timeout)
        reject(new Error(`server exited: ${stderr}`))
      })
    })
    for (const host of ['127.0.0.1', '::1']) {
      const bind = facts.activated.find((bind) => bind.host === host)
      if (!bind) throw new Error('missing activated listener: ' + JSON.stringify(facts))
      const response = await fetch(`http://${host === '::1' ? '[::1]' : host}:${bind.port}/`)
      expect(await response.text()).toBe('loopback-only')
    }
    expect(
      facts.binds.every((bind) => bind.error === 'EPERM' || bind.error === 'EACCES'),
      JSON.stringify(facts),
    ).toBe(true)
    expect(facts.outbound.every((code) => code === 'EPERM' || code === 'EACCES')).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await new Promise<void>((resolve) => control.close(() => resolve()))
  }
})

seatbelt(
  'security-loopback: concurrent gates reject Unix peers, path replacement and cross-session termination',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-security-loopback-')))
    const exec = createExec()
    const privatePaths: string[] = []
    const openUnix = systemNode.openUnixListener
    const pathObserver = vi.spyOn(systemNode, 'openUnixListener').mockImplementation((path) => {
      privatePaths.push(path)
      return openUnix(path)
    })
    // Production shares its spawner; an instance must dispose only its own processes and gates.
    const provider = createLocalSandboxProvider(exec, 'darwin')
    const instances = await Promise.all([
      provider.create({ workspaceRoot: root }),
      provider.create({ workspaceRoot: root }),
    ])
    const otherPath = join(root, 'other-service.sock')
    const daemonPath = join(root, 'daemon.sock')
    let peerConnections = 0
    const peers = [otherPath, daemonPath].map((path) => {
      const server = createServer((_request, response) => response.end('UNRELATED_PEER'))
      server.on('connection', () => {
        peerConnections++
      })
      return { server, path }
    })
    const enforcement = { level: 'full' as const, scope: ['file', 'network', 'process'] as const }
    const policy = {
      workspaceRoot: root,
      digest: 'security-loopback',
      fsRead: { allow: ['/'], deny: [] },
      fsWrite: { allow: ['/private/tmp', root], deny: [] },
      network: { mode: 'loopback-serve' as const, hosts: [] },
      requiredEnforcement: enforcement,
    }
    const report = join(root, 'attempts.json')
    const connectionFunction = `const connect=path=>new Promise(resolve=>{
    const s=require('node:net').connect(path);s.on('error',e=>{s.destroy();resolve(e.code)});
    s.on('connect',()=>{s.end();resolve('CONNECTED')});s.setTimeout(500,()=>{s.destroy();resolve('TIMEOUT')});
  });`
    try {
      for (const peer of peers) await new Promise<void>((resolve) => peer.server.listen(peer.path, resolve))
      const control = await run([
        process.execPath,
        '-e',
        `${connectionFunction}
      Promise.all(${JSON.stringify([otherPath, daemonPath])}.map(connect)).then(x=>console.log(JSON.stringify(x)));
    `,
      ])
      expect(control.code).toBe(0)
      expect(JSON.parse(control.stdout)).toEqual(['CONNECTED', 'CONNECTED'])
      expect(peerConnections).toBe(2)
      peerConnections = 0
      symlinkSync('/private/tmp', join(root, 'tmp-alias'))
      const launch = async (index: number, extra = '') => {
        const ready = join(root, `ready-${index}.json`)
        const program = `const fs=require('node:fs'),http=require('node:http');
        const server=http.createServer((_,res)=>res.end('SESSION_${index}'));
        server.listen({fd:4},async()=>{
          fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,url:process.env.AGH_LOOPBACK_URL}));
          ${extra}
        });setTimeout(()=>process.exit(),20000);`
        const handle = await instances[index]!.openProcess!({
          argv: seatbeltDenyNetworkArgv([process.execPath, '-e', program], {
            allowPaths: ['/private/tmp', root],
            denyPaths: [],
            loopbackServe: true,
          }),
          cwd: root,
          policy,
          enforcement,
        })
        await expect
          .poll(
            () => {
              try {
                return JSON.parse(readFileSync(ready, 'utf8')).pid as number
              } catch {
                return undefined
              }
            },
            { timeout: 5000 },
          )
          .toBeGreaterThan(0)
        // Inherited pipe handles do not expose a Node server.address(); observe only our
        // own native bind path, forwarding every call to the real native implementation.
        const facts = { ...JSON.parse(readFileSync(ready, 'utf8')), path: privatePaths.at(-1)! } as {
          pid: number
          path: string
          url: string
        }
        expect(facts.path.startsWith(LOOPBACK_GATE_PATH_PREFIX)).toBe(true)
        expect(await (await fetch(facts.url)).text()).toBe(`SESSION_${index}`)
        return { handle, facts }
      }
      const second = await launch(1)
      const privatePath = second.facts.path
      const directory = privatePath.slice(0, privatePath.lastIndexOf('/'))
      const aliases = [
        privatePath,
        privatePath.replace('/private/tmp/', '/tmp/'),
        privatePath.toUpperCase(),
        privatePath.replace('/private/tmp/', '/private/tmp/../tmp/'),
        join(root, 'tmp-alias', privatePath.slice('/private/tmp/'.length)),
      ].filter(existsSync)
      expect(aliases.length).toBeGreaterThanOrEqual(4)
      const extra = `${connectionFunction}
      fs.writeFileSync(${JSON.stringify(join(root, 'allowed'))},'ordinary-write');
      fs.linkSync(${JSON.stringify(join(root, 'allowed'))},${JSON.stringify(join(root, 'ordinary-hardlink'))});
      fs.symlinkSync(${JSON.stringify(otherPath)},${JSON.stringify(join(root, 'ordinary-symlink'))});
      const attempt=(name,f)=>{try{f();return {name,result:'ALLOWED'}}catch(e){return {name,result:e.code}}};
      const mutations=${JSON.stringify(aliases)}.flatMap((path,i)=>[
        attempt('rename-peer-'+i,()=>fs.renameSync(${JSON.stringify(otherPath)},path)),
        attempt('symlink-replace-'+i,()=>{fs.unlinkSync(path);fs.symlinkSync(${JSON.stringify(otherPath)},path)}),
        attempt('hardlink-replace-'+i,()=>{fs.unlinkSync(path);fs.linkSync(${JSON.stringify(otherPath)},path)}),
        attempt('rename-directory-'+i,()=>fs.renameSync(path.slice(0,path.lastIndexOf('/')),${JSON.stringify(root)}+'/moved-'+i)),
        attempt('hardlink-out-'+i,()=>fs.linkSync(path,${JSON.stringify(root)}+'/leaked-'+i)),
      ]);
      mutations.push(attempt('symlink-inside',()=>fs.symlinkSync(${JSON.stringify(otherPath)},${JSON.stringify(join(directory, 'alias'))})));
      const targets=${JSON.stringify([otherPath, daemonPath, privatePath])};
      const connections=await Promise.all(targets.map(connect));
      const publicConnection=await connect({host:'127.0.0.1',port:${Number(new URL(second.facts.url).port)}});
      const signal=attempt('other-session-signal',()=>process.kill(${second.facts.pid},'SIGTERM'));
      const bind=await new Promise(resolve=>{const s=require('node:net').createServer();s.on('error',e=>resolve(e.code));s.listen(${JSON.stringify(join(root, 'new.sock'))},()=>{s.close();resolve('BOUND')})});
      fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({mutations,connections,publicConnection,signal,bind}));`
      const first = await launch(0, extra)
      await expect
        .poll(
          () => {
            try {
              return Array.isArray(JSON.parse(readFileSync(report, 'utf8')).mutations)
            } catch {
              return false
            }
          },
          { timeout: 5000 },
        )
        .toBe(true)
      const facts = JSON.parse(readFileSync(report, 'utf8')) as {
        mutations: { name: string; result: string }[]
        connections: string[]
        publicConnection: string
        signal: { result: string }
        bind: string
      }
      expect(readFileSync(join(root, 'ordinary-hardlink'), 'utf8')).toBe('ordinary-write')
      expect(realpathSync(join(root, 'ordinary-symlink'))).toBe(otherPath)
      for (const result of facts.mutations) expect(result.result, result.name).toMatch(/^(EPERM|EACCES)$/)
      for (const result of [...facts.connections, facts.publicConnection, facts.bind, facts.signal.result])
        expect(result).toMatch(/^(EPERM|EACCES)$/)
      expect(peerConnections).toBe(0)
      expect(await (await fetch(second.facts.url)).text()).toBe('SESSION_1')
      await instances[0]!.dispose()
      expect(
        await fetch(first.facts.url).then(
          () => 'OPEN',
          () => 'CLOSED',
        ),
      ).toBe('CLOSED')
      expect(await (await fetch(second.facts.url)).text()).toBe('SESSION_1')
      await instances[1]!.dispose()
      expect(
        await fetch(second.facts.url).then(
          () => 'OPEN',
          () => 'CLOSED',
        ),
      ).toBe('CLOSED')
    } finally {
      await Promise.all(instances.map((instance) => instance.dispose()))
      await exec.killAll()
      pathObserver.mockRestore()
      for (const peer of peers) await new Promise<void>((resolve) => peer.server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  },
  25000,
)

seatbelt(
  'security-loopback: a network-denied command cannot redirect another session through the reserved path',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/agh-lb-review-'))
    const ready = join(root, 'ready.json')
    const peerPath = join(root, 'unrelated.sock')
    const peer = createServer((_request, response) => response.end('UNRELATED_UNIX_PEER'))
    const nativeOpen = systemNode.openUnixListener
    let privatePath = ''
    const observer = vi.spyOn(systemNode, 'openUnixListener').mockImplementation((path) => {
      privatePath = path
      return nativeOpen(path)
    })
    const instance = await createLocalSandboxProvider(createExec(), 'darwin', { ownProcesses: true }).create({
      workspaceRoot: root,
    })
    const enforcement = { level: 'full' as const, scope: ['file', 'network', 'process'] as const }
    try {
      await new Promise<void>((resolve) => peer.listen(peerPath, resolve))
      const server = `const fs=require('node:fs');const server=require('node:http').createServer((_,res)=>res.end('AUTHORIZED_SESSION'));
      server.listen({fd:4},()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({url:process.env.AGH_LOOPBACK_URL})));
      setTimeout(()=>process.exit(),15000);`
      await instance.openProcess!({
        argv: seatbeltDenyNetworkArgv([process.execPath, '-e', server], {
          allowPaths: [root],
          denyPaths: [],
          loopbackServe: true,
        }),
        cwd: root,
        enforcement,
        policy: {
          workspaceRoot: root,
          digest: 'victim',
          fsRead: { allow: ['/'], deny: [] },
          fsWrite: { allow: [root], deny: [] },
          network: { mode: 'loopback-serve', hosts: [] },
          requiredEnforcement: enforcement,
        },
      })
      await expect
        .poll(() => {
          try {
            return JSON.parse(readFileSync(ready, 'utf8')).url as string
          } catch {
            return ''
          }
        })
        .toMatch(/^http:\/\/127\.0\.0\.1:/)
      const { url } = JSON.parse(readFileSync(ready, 'utf8')) as { url: string }
      expect(await (await fetch(url, { headers: { Connection: 'close' } })).text()).toBe('AUTHORIZED_SESSION')
      expect(privatePath.startsWith(LOOPBACK_GATE_PATH_PREFIX)).toBe(true)
      const connect = `const connect=()=>new Promise(resolve=>{const s=require('node:net').connect(${JSON.stringify(peerPath)});
      s.on('error',e=>{s.destroy();resolve(e.code)});s.on('connect',()=>{s.end();resolve('CONNECTED')})});`
      const control = await run([process.execPath, '-e', `${connect}connect().then(x=>console.log(x));`])
      expect(control).toEqual({ code: 0, stdout: 'CONNECTED\n' })
      const attack = await run(
        seatbeltDenyNetworkArgv(
          [
            process.execPath,
            '-e',
            `${connect}
      (async()=>{const direct=await connect();let replacement;
      require('node:fs').writeFileSync(${JSON.stringify(join(root, 'ordinary-write'))},'permitted');
      try{require('node:fs').unlinkSync(${JSON.stringify(privatePath)});require('node:fs').symlinkSync(${JSON.stringify(peerPath)},${JSON.stringify(privatePath)});replacement='REPLACED'}catch(e){replacement=e.code}
      console.log(JSON.stringify({direct,replacement}));})();
    `,
          ],
          { allowPaths: ['/private/tmp', root], denyPaths: [] },
        ),
      )
      expect(attack.code).toBe(0)
      const result = JSON.parse(attack.stdout) as { direct: string; replacement: string }
      expect(result.direct).toMatch(/^(EPERM|EACCES)$/)
      expect(readFileSync(join(root, 'ordinary-write'), 'utf8')).toBe('permitted')
      const served = await fetch(url, {
        headers: { Connection: 'close' },
        signal: AbortSignal.timeout(1000),
      }).then(
        (response) => response.text(),
        () => 'REFUSED',
      )
      expect({ replacementDenied: /^(EPERM|EACCES)$/.test(result.replacement), served }).toEqual({
        replacementDenied: true,
        served: 'AUTHORIZED_SESSION',
      })
    } finally {
      await instance.dispose()
      observer.mockRestore()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  },
  15000,
)

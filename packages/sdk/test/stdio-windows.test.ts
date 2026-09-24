import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RpcConnection } from '../src/rpc.js'
import { stdioTransport } from '../src/transport/stdio.node.js'

it('attaches POSIX spawn-error listeners before the nextTick error, including timer turns', () => {
  const moduleUrl = new URL('../src/transport/stdio.node.ts', import.meta.url).href
  const result = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import {stdioTransport} from ${JSON.stringify(moduleUrl)};
    const platform=process.platform;
    let closes=0;
    const deadline=setTimeout(()=>process.exit(2),3000);
    setImmediate(()=>{
      Object.defineProperty(process,'platform',{value:'linux'});
      stdioTransport({cmd:['agnes-missing-executable-regression']})({onMessage(){},onClose(){closes++;}})
      .then(async transport=>{
        await transport.close();
        Object.defineProperty(process,'platform',{value:platform});
        clearTimeout(deadline);
        process.stdout.write(String(closes));
      }).catch(()=>process.exit(3));
    });
  `,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  )
  expect(result).toBe('1')
})

it.runIf(process.platform === 'win32')(
  'launches a batch proxy with literal arguments and a spaced Chinese path',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-sdk-中文 空格-'))
    const script = join(root, 'server.mjs')
    const wrapper = join(root, 'server.cmd')
    const args = ['', '中文 空格', 'a&b', '%PATH%', 'a"b', 'tail\\', 'x!y', '(test)']
    const client = new RpcConnection(
      stdioTransport({
        cmd: [wrapper, ...args],
        windowsBatch: 'argv-proxy',
        env: { AGNES_TEST_NODE: process.execPath, AGNES_TEST_SCRIPT: script },
      }),
      { requestTimeoutMs: 5000 },
    )
    try {
      await writeFile(
        script,
        `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:process.argv.slice(2)})+'\\n');if(m.method==='shutdown'){lines.close();process.stdin.destroy();}});`,
      )
      await writeFile(wrapper, '@echo off\r\n"%AGNES_TEST_NODE%" "%AGNES_TEST_SCRIPT%" %*\r\n')
      await client.connect()
      expect(await client.request('arguments', {})).toEqual(args)
    } finally {
      await client.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

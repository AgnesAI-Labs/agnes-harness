// Restricted launches through the Windows Job gate with real tokens, ACLs and processes. Directories
// a restricted business process must be able to write ("open" ones) grant Everyone and carry a Low
// label, so a marker that stays missing proves the process never ran, not that it could not write.
// The failure-injection cases build and load the separate test build of the native module.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { windowsProcessStartTimeSync } from '../src/index.js'
import { windowsDetachedCommand } from '../src/process-detached.js'
import {
  sealWindowsConfinement,
  startWindowsJobProcess,
  type WindowsConfinement,
  type WindowsJobProcess,
} from '../src/process-spawn.js'
import {
  applyWindowsAclGrant,
  inspectWindowsAcl,
  readWindowsObjectIdentity,
  restoreWindowsAclGrant,
  type WindowsAclSnapshot,
  windowsAclGrantEntries,
} from '../src/windows-acl.js'

const live: WindowsJobProcess[] = []
const roots: string[] = []
const grants: Array<{ root: string; sid: string; before: WindowsAclSnapshot }> = []
const siblings: Array<() => void> = []
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

afterEach(async () => {
  for (const child of live.splice(0)) {
    child.terminate()
    await child.completion
  }
  for (const stop of siblings.splice(0)) stop()
  for (const { root, sid, before } of grants.splice(0).reverse())
    restoreWindowsAclGrant({
      before,
      grantId: 'restricted-launch-test',
      expectedCurrentFingerprint: inspectWindowsAcl(root).fingerprint,
      removableChanges: windowsAclGrantEntries(sid),
    })
  for (const root of roots.splice(0)) {
    try {
      execFileSync('icacls', [root, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' })
    } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

function temporary(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-restricted-')))
  roots.push(root)
  return root
}
/** Writable by any restricted Low integrity token, so only "never ran" keeps a marker missing. */
function open(): string {
  const root = temporary()
  execFileSync('icacls', [root, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'pipe' })
  execFileSync('icacls', [root, '/setintegritylevel', '(OI)(CI)L'], { stdio: 'pipe' })
  return root
}
function grant(root: string): string {
  const sid = `S-1-4-${randomInt(1, 2 ** 30)}-${randomInt(1, 2 ** 30)}`
  const before = inspectWindowsAcl(root)
  const result = applyWindowsAclGrant({ before, grantId: 'restricted-launch-test', writeSid: sid })
  expect(result.failures).toEqual([])
  grants.push({ root, sid, before })
  return sid
}
const readOnly = (root: string): WindowsConfinement => ({ mode: 'read-only', root, writeSids: [] })
const env = () => ({ SystemRoot: systemRoot, PATH: process.env.PATH ?? '' })
async function confined(
  argv: string[],
  confinement: WindowsConfinement,
  extra: Partial<Parameters<typeof startWindowsJobProcess>[1]> = {},
): Promise<WindowsJobProcess> {
  const child = await startWindowsJobProcess(argv, {
    cwd: confinement.root,
    env: env(),
    nodeExecutable: process.execPath,
    ...extra,
    confinement: sealWindowsConfinement(confinement),
  })
  live.push(child)
  return child
}
async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
async function run(child: WindowsJobProcess, input = '') {
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  child.stdin.end(input)
  const completion = await child.completion
  return { completion, stdout: await stdout, stderr: await stderr }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 500))

describe.skipIf(process.platform !== 'win32')('restricted Windows launch', { timeout: 120_000 }, () => {
  it('preserves argv, Unicode, empty arguments, stdin, EOF and the target exit code', async () => {
    const args = ['', '中文 空格', 'a"b', 'trailing\\', '$HOME && echo nope']
    const child = await confined(
      [
        process.execPath,
        '-e',
        `let input = ''; process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => input += c);
        process.stdin.on('end', () => {
          process.stdout.write(JSON.stringify({ args: process.argv.slice(1), input, env: process.env.GATE_VALUE }));
          process.stderr.write('错误信息'); process.exitCode = 7;
        });`,
        ...args,
      ],
      readOnly(temporary()),
      { env: { ...env(), GATE_VALUE: '环境值' } },
    )
    const result = await run(child, '输入🌱')
    expect(result.completion).toEqual({ code: 7, signal: null, cancelled: false, stoppedProcesses: 0 })
    expect(JSON.parse(result.stdout)).toEqual({ args, input: '输入🌱', env: '环境值' })
    expect(result.stderr).toBe('错误信息')
    expect(windowsProcessStartTimeSync(child.pid)).toBeNull()
  })

  it('runs at Low integrity', async () => {
    const child = await confined(
      [join(systemRoot, 'System32', 'whoami.exe'), '/groups'],
      readOnly(temporary()),
    )
    const result = await run(child)
    expect(result.completion.code).toBe(0)
    expect(result.stdout).toContain('S-1-16-4096')
    expect(result.stdout).not.toContain('S-1-16-8192')
  })

  it('writes inside the granted workspace and private temp only', async () => {
    const workspace = temporary()
    const temp = temporary()
    const outside = temporary()
    const confinement: WindowsConfinement = {
      mode: 'workspace-write',
      root: workspace,
      writeSids: [grant(workspace), grant(temp)],
      tempRoot: temp,
    }
    const script = `const fs = require('node:fs'), path = require('node:path');
      const attempt = (fn) => { try { fn(); return 'ok' } catch (error) { return error.code } };
      const [workspace, outside] = process.argv.slice(1);
      const file = path.join(workspace, 'sub', '新 文件.txt');
      process.stdout.write(JSON.stringify({
        create: attempt(() => { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'a') }),
        modify: attempt(() => fs.appendFileSync(file, 'b')),
        rename: attempt(() => fs.renameSync(file, file + '.moved')),
        remove: attempt(() => { fs.unlinkSync(file + '.moved'); fs.rmdirSync(path.dirname(file)) }),
        temp: attempt(() => fs.writeFileSync(path.join(process.env.TEMP, 'scratch'), 't')),
        tempVariables: [process.env.TEMP, process.env.TMP],
        outside: attempt(() => fs.writeFileSync(path.join(outside, 'x'), 'x')),
      }))`
    const child = await confined([process.execPath, '-e', script, workspace, outside], confinement)
    const result = await run(child)
    expect(result.completion.code).toBe(0)
    const facts = JSON.parse(result.stdout)
    expect(facts).toMatchObject({ create: 'ok', modify: 'ok', rename: 'ok', remove: 'ok', temp: 'ok' })
    expect(facts.tempVariables).toEqual([temp, temp])
    expect(['EPERM', 'EACCES']).toContain(facts.outside)
    expect(existsSync(join(outside, 'x'))).toBe(false)
  })

  it('cannot write a granted workspace in read-only mode', async () => {
    const workspace = temporary()
    grant(workspace)
    const child = await confined(
      [
        process.execPath,
        '-e',
        `try { require('node:fs').writeFileSync(process.argv[1], 'x'); process.exitCode = 9 }
         catch (error) { process.stdout.write(error.code) }`,
        join(workspace, 'denied.txt'),
      ],
      readOnly(workspace),
    )
    const result = await run(child)
    expect(result.completion.code).toBe(0)
    expect(['EPERM', 'EACCES']).toContain(result.stdout)
    expect(existsSync(join(workspace, 'denied.txt'))).toBe(false)
  })

  it('pipes a restricted child of the target and reaps a resident descendant after the main exit', async () => {
    const child = await confined(
      [
        process.execPath,
        '-e',
        `const { execFileSync, spawn } = require('node:child_process');
        const piped = execFileSync(process.execPath, ['-e', 'process.stdout.write("grandchild")'], { encoding: 'utf8' });
        const resident = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'],
          { detached: true, windowsHide: true, stdio: 'ignore' });
        resident.once('spawn', () => process.stdout.write(JSON.stringify({ piped, pid: resident.pid }), () => process.exit(3)));`,
      ],
      readOnly(temporary()),
    )
    const result = await run(child)
    expect(result.completion).toEqual({ code: 3, signal: null, cancelled: false, stoppedProcesses: 1 })
    const { piped, pid } = JSON.parse(result.stdout)
    expect(piped).toBe('grandchild')
    expect(windowsProcessStartTimeSync(pid)).toBeNull()
  })

  it('delivers large output intact and settles when the reader stops early', async () => {
    const bytes = 4 * 1024 * 1024
    const child = await confined(
      [process.execPath, '-e', `process.stdout.write(Buffer.alloc(${bytes}, 97))`],
      readOnly(temporary()),
    )
    const result = await run(child)
    expect(result.completion.code).toBe(0)
    expect(result.stdout.length).toBe(bytes)

    const endless = await confined(
      [
        process.execPath,
        '-e',
        'const b = Buffer.alloc(65536, 98); const w = () => process.stdout.write(b, w); w()',
      ],
      readOnly(temporary()),
    )
    await once(endless.stdout, 'data')
    endless.stdout.destroy()
    endless.stderr.resume()
    endless.stdin.end()
    endless.terminate()
    expect(await endless.completion).toMatchObject({ cancelled: true })
  })

  it.each([
    ['Windows PowerShell 5.1', powershell, '5'],
    ['PowerShell 7', 'pwsh.exe', '7'],
  ])('runs %s with stdin and its exit code', async (_name, shell, major) => {
    const workspace = temporary()
    const command = await confined(
      [
        shell,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::Out.Write("ps" + $PSVersionTable.PSVersion.Major); exit 7',
      ],
      readOnly(workspace),
    )
    const result = await run(command)
    expect(result.completion.code).toBe(7)
    expect(result.stdout).toBe(`ps${major}`)
    const piped = await confined(
      [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', '-'],
      readOnly(workspace),
    )
    const fromStdin = await run(piped, '[Console]::Out.Write("from-stdin")\nexit 4\n')
    expect(fromStdin.completion.code).toBe(4)
    expect(fromStdin.stdout).toContain('from-stdin')
  })

  it('runs a batch file with literal arguments through cmd.exe', async () => {
    const workspace = temporary()
    const script = join(workspace, 'run 脚本.cmd')
    writeFileSync(script, '@echo off\r\necho [%~1]\r\nexit /b 5\r\n')
    const result = await run(await confined([script, 'x y'], readOnly(workspace)))
    expect(result.completion.code).toBe(5)
    expect(result.stdout.trim()).toBe('[x y]')
  })

  it('cancels the restricted tree without touching a process outside its Job', async () => {
    const sibling = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    siblings.push(() => sibling.kill())
    await once(sibling, 'spawn')
    const siblingStart = windowsProcessStartTimeSync(sibling.pid as number)
    const child = await confined(
      [
        process.execPath,
        '-e',
        `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'],
          { detached: true, windowsHide: true, stdio: 'ignore' });
        c.once('spawn', () => process.stdout.write(String(c.pid)));
        setTimeout(() => {}, 15000);`,
      ],
      readOnly(temporary()),
    )
    const [chunk] = await once(child.stdout, 'data')
    const descendant = Number(chunk.toString())
    child.stdout.resume()
    child.stderr.resume()
    child.stdin.end()
    child.terminate()
    expect(await child.completion).toEqual({ code: 1, signal: null, cancelled: true })
    expect(windowsProcessStartTimeSync(descendant)).toBeNull()
    expect(windowsProcessStartTimeSync(sibling.pid as number)).toBe(siblingStart)
  })

  it.each(['before', 'during'])('does not run business code when cancelled %s startup', async (when) => {
    const marker = join(open(), 'must-not-run')
    const controller = new AbortController()
    if (when === 'before') controller.abort()
    const pending = startWindowsJobProcess(
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
      {
        cwd: tmpdir(),
        env: env(),
        nodeExecutable: process.execPath,
        signal: controller.signal,
        confinement: sealWindowsConfinement(readOnly(temporary())),
      },
    )
    if (when === 'during') controller.abort()
    await expect(pending).rejects.toBeInstanceOf(Error)
    await settle()
    expect(existsSync(marker)).toBe(false)
  })

  it('times out a startup that cannot finish without running business code', async () => {
    const marker = join(open(), 'must-not-run')
    await expect(
      startWindowsJobProcess(
        [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
        {
          cwd: tmpdir(),
          env: env(),
          nodeExecutable: process.execPath,
          startupTimeoutMs: 1,
          confinement: sealWindowsConfinement(readOnly(temporary())),
        },
      ),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await settle()
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a confinement it did not seal', async () => {
    await expect(
      startWindowsJobProcess([process.execPath], {
        cwd: tmpdir(),
        env: env(),
        nodeExecutable: process.execPath,
        confinement: readOnly(temporary()),
      }),
    ).rejects.toMatchObject({ code: 'E_WINDOWS_CONFINEMENT_INVALID' })
  })

  it('reads the same root identity as an inspection', () => {
    const root = temporary()
    expect(readWindowsObjectIdentity(root)).toEqual(inspectWindowsAcl(root).identity)
  })

  it('launches PowerShell and Node from a Host without a console', async () => {
    const output = join(temporary(), 'results.json')
    const workspace = temporary()
    const module = new URL('../src/process-spawn.ts', import.meta.url).href
    const commands = [
      { argv: [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], input: 'exit 7\n' },
      { argv: ['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], input: 'exit 7\n' },
      {
        argv: [
          process.execPath,
          '-e',
          "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exitCode = 7)",
        ],
        input: 'echo 中文',
      },
    ]
    // DETACHED_PROCESS, as the CLI starts its daemon: the gate and target find no console to share.
    const host = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { writeFileSync } from 'node:fs';
        import { sealWindowsConfinement, startWindowsJobProcess } from ${JSON.stringify(module)};
        const { output, workspace, commands, env } = JSON.parse(process.argv[1]);
        const results = [];
        for (const { argv, input } of commands) {
          try {
            const child = await startWindowsJobProcess(argv, { cwd: workspace, env, nodeExecutable: process.execPath,
              confinement: sealWindowsConfinement({ mode: 'read-only', root: workspace, writeSids: [] }) });
            let stdout = '';
            child.stdout.setEncoding('utf8').on('data', (text) => stdout += text);
            child.stderr.resume();
            child.stdin.end(input);
            const { code } = await child.completion;
            results.push({ code, stdout });
          } catch (error) { results.push({ error: error.code ?? String(error) }) }
        }
        writeFileSync(output, JSON.stringify(results));`,
        JSON.stringify({ output, workspace, commands, env: env() }),
      ],
      { detached: true, windowsHide: true, stdio: 'ignore' },
    )
    siblings.push(() => host.kill())
    const [code] = await once(host, 'exit')
    expect(code).toBe(0)
    const results = JSON.parse(readFileSync(output, 'utf8'))
    expect(results).toEqual([
      { code: 7, stdout: expect.any(String) },
      { code: 7, stdout: expect.any(String) },
      { code: 7, stdout: 'echo 中文' },
    ])
  })
})

// Each case runs in its own process with AGNES_TEST_FAULT set, loading the test build directly.
describe.skipIf(process.platform !== 'win32')(
  'restricted launch failure injection',
  { timeout: 600_000 },
  () => {
    const output = join(tmpdir(), `agh-native-test-${process.pid}-${randomInt(1, 2 ** 30)}`)
    const artifact = join(output, 'agnes-system.node')
    beforeAll(() => {
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/build-native.mjs', import.meta.url)),
          '--output-dir',
          output,
          '--test-faults',
        ],
        { stdio: 'pipe', timeout: 600_000 },
      )
    })
    afterAll(() => rmSync(output, { recursive: true, force: true, maxRetries: 5 }))

    // Launches the marker writer read-only; on success it resumes and waits for the target to exit.
    const harness = `const native = require(process.env.AGNES_TEST_ARTIFACT);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const result = { testBuild: native.testFaults === true };
    let target;
    try {
      target = native.spawnRestricted(process.execPath, process.env.AGNES_TEST_COMMAND_LINE, process.cwd(),
        'SystemRoot=' + process.env.SystemRoot + '\\0\\0', [], true);
      result.created = true;
      if (process.env.AGNES_TEST_FAULT === 'job') {
        const job = native.createProcessJob();
        try { result.member = job.contains(target.pid, target.startTime) } finally { job.close() }
      } else {
        target.resume();
        result.resumed = true;
        while (target.exitCode() === null) Atomics.wait(pause, 0, 0, 20);
        result.exitCode = target.exitCode();
      }
    } catch (error) { result.error = error.code }
    finally { target?.close() }
    process.stdout.write(JSON.stringify(result));`

    function launch(fault: string) {
      const marker = join(open(), 'business-marker')
      const child = spawnSync(process.execPath, ['-e', harness], {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: {
          SystemRoot: systemRoot,
          AGNES_TEST_ARTIFACT: artifact,
          AGNES_TEST_FAULT: fault,
          AGNES_TEST_COMMAND_LINE: windowsDetachedCommand(process.execPath, [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ]),
        },
      })
      expect(child.status, child.stderr).toBe(0)
      return { result: JSON.parse(child.stdout), marker }
    }

    it('runs business code when no step fails', () => {
      const { result, marker } = launch('none')
      expect(result).toEqual({ testBuild: true, created: true, resumed: true, exitCode: 0 })
      expect(readFileSync(marker, 'utf8')).toBe('ran')
    })

    it.each(['token', 'dacl', 'label', 'stdio', 'create', 'resume'])(
      'does not run business code when the %s step fails',
      async (step) => {
        const { result, marker } = launch(step)
        expect(result.error).toBe('EIO')
        expect(result.resumed).toBeUndefined()
        expect(result.created).toBe(step === 'resume' ? true : undefined)
        await settle()
        expect(existsSync(marker)).toBe(false)
      },
    )

    it('does not run business code when its Job membership cannot be confirmed', async () => {
      const { result, marker } = launch('job')
      expect(result).toEqual({ testBuild: true, created: true, error: 'EIO' })
      await settle()
      expect(existsSync(marker)).toBe(false)
    })
  },
)

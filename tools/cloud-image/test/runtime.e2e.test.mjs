import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { privateDirectory } from '../sync/private-files.mjs'
import { harnessRuntime } from '../sync/runtime.mjs'
import { fixture } from './helpers.mjs'

test('LLMSG CFS initializer starts only envd and refuses an unexpected state identity', async (t) => {
  const { env, root } = await fixture(t)
  const envd = join(root, 'envd')
  await writeFile(envd, '#!/bin/sh\nprintf "fixture-envd-only\\n"\n', { mode: 0o700 })
  const original = await readFile(new URL('../start.sh', import.meta.url), 'utf8')
  const script = join(root, 'start.sh')
  await writeFile(script, original.replaceAll('/usr/bin/envd', envd))
  const childEnv = { ...process.env, ...env, WORKSPACE_DIR: '/workspace/llmsg-cfs-init' }
  for (const name of Object.keys(childEnv))
    if (/^AGH_(?:TENANT_ID|USER_ID|STATE_|RESTORE_FROM_EPOCH)/u.test(name)) delete childEnv[name]
  delete childEnv.AGH_CLOUD_API_BASE_URL
  delete childEnv.LLMSG_TRACK_URL
  const run = (overrides) =>
    new Promise((resolve) =>
      execFile(
        'bash',
        [script],
        {
          env: { ...childEnv, ...overrides },
          timeout: 3000,
        },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      ),
    )
  assert.deepEqual(await run({}), { code: 0, stdout: 'fixture-envd-only\n', stderr: '' })
  const rejected = await run({ AGH_STATE_ID: '' })
  assert.equal(rejected.code, 64)
  assert.equal(rejected.stdout, '')
  assert.match(rejected.stderr, /SYNC_INITIALIZER_IDENTITY_UNEXPECTED/)
})

test('first boot from an environment Key persists a private file and does not replace a later rotation', async (t) => {
  const { cfg, root } = await fixture(t)
  const runtimeDir = join(root, 'runtime')
  await privateDirectory(runtimeDir)
  const previous = process.env.AGH_CLOUD_KEY
  process.env.AGH_CLOUD_KEY = 'fixture-env-key'
  t.after(() => {
    if (previous === undefined) delete process.env.AGH_CLOUD_KEY
    else process.env.AGH_CLOUD_KEY = previous
  })
  await writeFile(
    join(runtimeDir, 'agnes.mjs'),
    `
    import { readdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    if (process.argv[2] === 'plugins') {
      if (!(await readdir(process.env.AGH_HOME)).length)
        await writeFile(join(process.env.AGH_HOME, 'home-layout.json'), '{}');
    }
    else if (process.argv[2] === 'serve') {
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => process.exit(0));
    } else if (process.argv[2] !== 'daemon') process.exit(1);
  `,
  )
  const runtime = harnessRuntime({ ...cfg, runtime: runtimeDir })
  t.after(() => runtime.cleanup())
  await runtime.boot()
  const keyFile = join(cfg.home, 'cloud-key')
  assert.equal(await readFile(keyFile, 'utf8'), 'fixture-env-key')
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
  await writeFile(keyFile, 'fixture-new-key')
  await runtime.stop(AbortSignal.timeout(3000))
  await runtime.boot()
  assert.equal(await readFile(keyFile, 'utf8'), 'fixture-new-key')
  await runtime.stop(AbortSignal.timeout(3000))
  await rm(keyFile)
  process.env.AGH_CLOUD_KEY = 'fixture-reissued-key'
  await runtime.boot()
  assert.equal(await readFile(keyFile, 'utf8'), 'fixture-reissued-key')
})

test('runtime initializes a file-Key-only home, preserves a concurrent rotation and stops only its owned processes', async (t) => {
  const { cfg, root } = await fixture(t)
  const runtimeDir = join(root, 'runtime')
  await privateDirectory(runtimeDir)
  await writeFile(join(cfg.home, 'cloud-key'), 'fixture-initial-key', { mode: 0o600 })
  await writeFile(
    join(runtimeDir, 'agnes.mjs'),
    `
    import { writeFile, readdir } from 'node:fs/promises';
    import { join } from 'node:path';
    const home=process.env.AGH_HOME;
    if (process.argv[2]==='plugins') {
      if ((await readdir(home)).length) process.exit(1);
      await writeFile(join(home,'home-layout.json'), '{}');
      await writeFile(join(home,'cloud-key'), 'fixture-rotated-key', {mode:0o600});
    } else if(process.argv[2]==='serve') {
      if(process.env.AGH_CLOUD_KEY!=='fixture-rotated-key') process.exit(2);
      await writeFile(join(process.env.AGH_SYNC_DIR,'frontend.pid'), String(process.pid));
      setInterval(()=>{},1000);
      process.on('SIGTERM',()=>process.exit(0));
    }
  `,
  )
  const runtime = harnessRuntime({ ...cfg, runtime: runtimeDir })
  t.after(() => runtime.cleanup())
  await runtime.boot()
  assert.equal(await readFile(join(cfg.home, 'cloud-key'), 'utf8'), 'fixture-rotated-key')
  let pid
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      pid = Number(await readFile(join(cfg.run, 'frontend.pid'), 'utf8'))
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await new Promise((r) => setTimeout(r, 30))
    }
  }
  assert.ok(pid > 0)
  process.kill(pid, 0)
  await runtime.stop(AbortSignal.timeout(3000))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })

  // An I/O failure publishing the only current Key must not discard its private staged copy.
  const failed = await fixture(t)
  const failedRuntimeDir = join(failed.root, 'runtime')
  await privateDirectory(failedRuntimeDir)
  await writeFile(join(failed.cfg.home, 'cloud-key'), 'fixture-retained-key', { mode: 0o600 })
  await writeFile(
    join(failedRuntimeDir, 'agnes.mjs'),
    `import { rename } from 'node:fs/promises';
     if (process.argv[2] === 'plugins')
       await rename(process.env.AGH_HOME, process.env.AGH_HOME + '.retained');`,
  )
  const failedRuntime = harnessRuntime({ ...failed.cfg, runtime: failedRuntimeDir })
  t.after(() => failedRuntime.cleanup())
  await assert.rejects(failedRuntime.boot(), { code: 'ENOENT' })
  const staged = join(failed.cfg.run, 'cloud-key.initializing')
  assert.equal(await readFile(staged, 'utf8'), 'fixture-retained-key')
  assert.equal((await stat(staged)).mode & 0o777, 0o600)
})

test('startup refuses an invalid initial STS before booting Harness and publishes only a sanitized failure', async (t) => {
  const { cfg, env } = await fixture(t)
  await writeFile(cfg.sts, JSON.stringify({ tmp_secret_key: 'never-log-this-secret' }), { mode: 0o600 })
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL('../sync/main.mjs', import.meta.url))],
      {
        env: { ...process.env, ...env },
        timeout: 5000,
      },
      (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }),
    )
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /SYNC_STS_INVALID/)
  assert.ok(!JSON.stringify(result).includes('never-log-this-secret'))
  const health = JSON.parse(await readFile(join(cfg.run, 'health.json'), 'utf8'))
  assert.equal(health.backup_status, 'failed')
  assert.equal(health.last_sync_at, null)
})

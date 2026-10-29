import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
it.each(['public', 'system', 'dispatch'].flatMap(kind => [false, true].map(brokenSink => ({ kind, brokenSink }))))('a rejected async $kind listener cannot crash a strict Node process (broken sink: $brokenSink)', async ({ kind, brokenSink }) => {
  const script = `
    import { Context } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    const root = new Context();
    const failure = new Error('synthetic async listener failure');
    if (${JSON.stringify(brokenSink)}) root.logger.exporter({ export() { throw new Error('synthetic broken diagnostic sink'); } });
    const owner = await root.plugin(function processObserver(ctx) {
      if (${JSON.stringify(kind)} === 'public') ctx.on('probe', async () => { throw failure });
      if (${JSON.stringify(kind)} === 'system') ctx.on('internal/plugin', async () => { throw failure });
      if (${JSON.stringify(kind)} === 'dispatch') ctx.on('internal/dispatch', async (_mode, name) => {
        if (name === 'probe') throw failure;
      });
    });
    if (${JSON.stringify(kind)} === 'system') await root.plugin(() => {});
    else root.emit('probe');
    await new Promise(setImmediate);
    if (!root.logger.buffer.some(message => message.type === 'error' && message.args.includes(failure) && message.fiber?.deref() === owner)) {
      throw new Error('missing owner-attributed diagnostic');
    }
    await owner.dispose();
    console.log('alive');
  `
  const result = await run(process.execPath, ['--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, timeout: 15_000,
  })
  expect(result.stdout.trim()).toBe('alive')
  expect(result.stderr).toBe('')
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { distributions, ledgerRef, previousRef, run } from './distributions.mjs'
import { provider } from './provider.mjs'
import { runtime } from './runtime.mjs'

// Suspended across the extension API 5.0.0 major bump: the previous build (API 4) refuses a seed plugin
// that declares ^5 and the current build refuses one that declares ^4, and the previous build's data
// directory is refused by the current data-dir version gate. Set AGH_UPGRADE_GATE=1 to run it once
// AGH_UPGRADE_PREVIOUS_REF points at a 5.0 build.
const suspended = !process.env.AGH_UPGRADE_GATE

// guards-allow-platform: Windows process identity/crash acceptance is a separate platform follow-up.
it.skipIf(process.platform === 'win32' || suspended)(
  'refuses retired previous-build homes and resumes supported formats after shutdown or process loss',
  async () => {
    const repository = fileURLToPath(new URL('../../', import.meta.url))
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agh-upgrade-gate-')))
    console.info(`Upgrade scratch: ${scratch}`)
    const fake = await provider()
    let daemon: Awaited<ReturnType<typeof runtime>> | undefined
    let passed = false
    try {
      const selected = process.env.AGH_UPGRADE_CASE
      const variant = process.env.AGH_UPGRADE_VARIANT
      assert.ok(!selected || ['recent', 'legacy'].includes(selected), 'unknown upgrade case')
      assert.ok(!variant || ['clean', 'unclean'].includes(variant), 'unknown upgrade variant')
      let currentDistribution: string | undefined
      const refs = [process.env.AGH_UPGRADE_PREVIOUS_REF ?? previousRef, ledgerRef]
      for (const ref of refs.filter(
        (ref) => !selected || (ref === ledgerRef ? 'legacy' : 'recent') === selected,
      )) {
        const buildRoot = join(scratch, ref === ledgerRef ? 'legacy' : 'recent')
        await mkdir(buildRoot)
        const builds = await distributions(repository, buildRoot, ref, currentDistribution)
        currentDistribution = builds.current
        for (const variant of process.env.AGH_UPGRADE_VARIANT
          ? [process.env.AGH_UPGRADE_VARIANT]
          : ['clean', 'unclean']) {
          for (const marker of ref === ledgerRef ? ['none'] : ['legacy', 'identity']) {
            console.info(`Upgrade marker: ${marker}`)
            console.info(`Upgrade case: ${ref}, ${variant}`)
            const home = join(buildRoot, `${variant}-${marker}-home`)
            const workspace = join(buildRoot, `${variant}-${marker}-workspace`)
            await mkdir(home, { mode: 0o700 })
            await mkdir(workspace)
            const scenario = async (phase: string, source: string) => {
              try {
                const result = await run(
                  process.execPath,
                  [
                    '--import',
                    'tsx',
                    'tools/upgrade/scenario.mjs',
                    phase,
                    source,
                    home,
                    workspace,
                    fake.baseUrl,
                    marker,
                  ],
                  {
                    cwd: repository,
                    env: { PATH: process.env.PATH, HOME: home, AGH_HOME: home },
                    timeout: 240_000,
                  },
                )
                await writeFile(
                  join(buildRoot, `${variant}-${marker}-${phase}.log`),
                  result.stdout + result.stderr,
                )
                console.info(result.stdout)
              } catch (error) {
                const failure = error as Error & { stdout?: string; stderr?: string }
                await writeFile(
                  join(buildRoot, `${variant}-${marker}-${phase}.log`),
                  `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
                )
                throw new Error(`Upgrade ${variant}/${phase}: ${failure.stderr ?? failure.message}`)
              }
            }
            daemon = await runtime(builds.previous, home, workspace)
            await scenario('seed', builds.oldSource)
            if (variant === 'clean') await daemon.stop()
            else await daemon.crash()
            daemon = undefined
            const receiptFile = join(home, 'profiles/local-dev/default-helpers/state.json')
            const previousReceipt = JSON.parse(await readFile(receiptFile, 'utf8'))
            assert.equal(previousReceipt.phase, 'complete', 'previous bootstrap must be finished')
            const presentations = ['goal-ui', 'interaction-ui', 'deliverables-ui'].map(
              (name) => `@agnes/${name}`,
            )
            if (!process.env.AGH_UPGRADE_PREVIOUS_REF || ref === ledgerRef)
              for (const id of presentations)
                assert.ok(!Object.hasOwn(previousReceipt.integrity, id), `${id}: must be a new default`)
            const oldSchema = JSON.parse(
              await readFile(
                join(builds.oldSource, 'packages/protocol/schema/extension-manifest.json'),
                'utf8',
              ),
            )
            if (oldSchema.$defs.PluginMetadata.properties.category) {
              const lockFile = join(home, 'profiles/local-dev/agnes-lock.json')
              const snapshotFile = join(home, 'profiles/local-dev/.agnes-runtime-snapshots.json')
              const before = await Promise.all([readFile(lockFile, 'utf8'), readFile(snapshotFile, 'utf8')])
              await assert.rejects(
                runtime(builds.current, home, workspace),
                /E_DATA_DIR_STALE|retired|clean.home|new, empty.*AGH_HOME/is,
              )
              assert.deepEqual(
                await Promise.all([readFile(lockFile, 'utf8'), readFile(snapshotFile, 'utf8')]),
                before,
              )
              // A refused worker can leave its synthetic supervisor running; stop only this home.
              await run(process.execPath, [join(builds.current, 'agnes.mjs'), 'daemon', 'stop'], {
                cwd: workspace,
                env: { PATH: process.env.PATH, HOME: home, AGH_HOME: home },
              }).catch(() => undefined)
              console.info('Retired preview home refused without converting lock, snapshots, pins or trust')
              continue
            }
            daemon = await runtime(builds.current, home, workspace)
            await scenario('verify', repository)
            const upgradedReceipt = JSON.parse(await readFile(receiptFile, 'utf8'))
            assert.equal(upgradedReceipt.version, 4)
            assert.equal(upgradedReceipt.phase, 'complete')
            for (const id of presentations)
              assert.ok(upgradedReceipt.offered.includes(id), `${id}: missing offer after upgrade`)
            await daemon.stop()
            daemon = undefined
          }
        }
      }
      passed = true
    } finally {
      try {
        await daemon?.stop()
      } finally {
        await fake.close()
        if (passed && !process.env.AGH_UPGRADE_KEEP) await rm(scratch, { recursive: true, force: true })
        else console.info(`Upgrade evidence retained: ${scratch}`)
      }
    }
  },
  1_200_000,
)

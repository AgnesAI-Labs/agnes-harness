import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { distributions, ledgerRef, previousRef, run } from './distributions.mjs'
import { provider } from './provider.mjs'
import { runtime } from './runtime.mjs'

// guards-allow-platform: Windows process identity/crash acceptance is a separate platform follow-up.
it.skipIf(process.platform === 'win32')(
  'upgrades real previous-build homes after clean shutdown and process loss',
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
          console.info(`Upgrade case: ${ref}, ${variant}`)
          const home = join(buildRoot, `${variant}-home`)
          const workspace = join(buildRoot, `${variant}-workspace`)
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
                ],
                {
                  cwd: repository,
                  env: { PATH: process.env.PATH, HOME: home, AGH_HOME: home },
                  timeout: 240_000,
                },
              )
              await writeFile(join(buildRoot, `${variant}-${phase}.log`), result.stdout + result.stderr)
              console.info(result.stdout)
            } catch (error) {
              const failure = error as Error & { stdout?: string; stderr?: string }
              await writeFile(
                join(buildRoot, `${variant}-${phase}.log`),
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
          daemon = await runtime(builds.current, home, workspace)
          try {
            await scenario('verify', repository)
          } catch (error) {
            // Native recovery can be unavailable on the first startup while defaults refresh.
            // Exercise bounded cold-start reconciliation; never edit grants or shutdown markers.
            if (!(error instanceof Error) || !error.message.includes('MANAGED_RESOURCE_NOT_RECOVERABLE'))
              throw error
            console.warn('Managed publication recovery: one current-distribution restart required')
            await daemon.stop()
            daemon = await runtime(builds.current, home, workspace)
            await scenario('managed', repository)
          }
          await daemon.stop()
          daemon = undefined
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

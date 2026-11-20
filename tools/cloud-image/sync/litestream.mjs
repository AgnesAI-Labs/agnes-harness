import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { epochPrefix, publicEnvironment } from './config.mjs'
import { atomicJson, fault, privateDirectory } from './private-files.mjs'
import { command, start, terminate } from './process.mjs'

export function createLitestream(config, { replicaOverride } = {}) {
  let process,
    current,
    signature,
    failed = false
  const socket = join(config.run, 'litestream.sock'),
    configFile = join(config.run, 'litestream.json')
  const target = (path, epoch = config.epoch) =>
    replicaOverride
      ? replicaOverride(path, epoch)
      : {
          type: 's3',
          bucket: current.bucket,
          region: current.region,
          endpoint: current.endpoint,
          path: `${epochPrefix(config, epoch)}/databases/${path.replace(/^data\//u, '')}`,
          'force-path-style': false,
          'sync-interval': '1s',
        }
  const env = () => ({
    ...publicEnvironment(),
    AWS_ACCESS_KEY_ID: current.tmp_secret_id,
    AWS_SECRET_ACCESS_KEY: current.tmp_secret_key,
    AWS_SESSION_TOKEN: current.session_token,
  })
  async function run(args, signal, timeout = 10000) {
    return command(config.litestream, args, { env: env(), signal, timeout })
  }
  return {
    async ensure(credential, paths, signal, force = false) {
      const covered = (path) =>
        path.startsWith('data/tables/') || path === 'data/artifacts/computer-use-ref-index.db'
      const next = JSON.stringify([credential, paths.filter((path) => !covered(path))])
      if (
        !force &&
        !failed &&
        process &&
        process.child.exitCode === null &&
        process.child.signalCode === null &&
        next === signature
      )
        return
      await terminate(process)
      await rm(socket, { force: true })
      current = credential
      // JSON is also valid YAML; values are never interpolated as YAML or shell fragments.
      const dbs = paths.map((path) => ({ path: join(config.home, path), replica: target(path) }))
      // Known dynamic roots are watched even when no database exists yet.
      for (const dir of ['data/tables', 'data/artifacts']) {
        await privateDirectory(join(config.home, dir))
        dbs.push({
          dir: join(config.home, dir),
          pattern: dir === 'data/tables' ? '*.db' : 'computer-use-ref-index.db',
          watch: true,
          recursive: dir === 'data/tables',
          replica: { ...target(dir), 'sync-interval': '1s' },
        })
      }
      // Avoid duplicate registration for databases covered by directory watchers.
      const staticDbs = dbs.filter(
        (row) => !row.path || !paths.some((path) => row.path === join(config.home, path) && covered(path)),
      )
      await atomicJson(configFile, {
        retention: { enabled: false },
        socket: { enabled: true, path: socket, permissions: 0o600 },
        dbs: staticDbs,
      })
      process = start(config.litestream, ['replicate', '-config', configFile], { env: env() })
      signature = next
      failed = false
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        signal?.throwIfAborted()
        if (process.child.exitCode !== null || process.child.signalCode !== null)
          throw fault('SYNC_REPLICATOR_FAILED')
        try {
          await run(['info', '-socket', socket, '-json'], signal, 1000)
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      throw fault('SYNC_REPLICATOR_UNAVAILABLE')
    },
    async sync(paths, signal) {
      const positions = []
      for (const path of paths) {
        let output
        try {
          output = await run(
            ['sync', '-socket', socket, '-wait', '-timeout', '10', '-json', join(config.home, path)],
            signal,
            12000,
          )
        } catch (error) {
          failed = true
          throw error
        }
        let value
        try {
          value = JSON.parse(output)
        } catch {
          throw fault('SYNC_CONFIRMATION_INVALID')
        }
        if (
          !Number.isSafeInteger(value.txid) ||
          value.txid < 0 ||
          !Number.isSafeInteger(value.replica_txid) ||
          value.replica_txid < value.txid
        )
          throw fault('SYNC_CONFIRMATION_INVALID')
        positions.push({ path, txid: value.txid })
      }
      return positions
    },
    async restore(credential, path, sourceEpoch, destination, signal, txid) {
      current = credential
      await atomicJson(join(config.run, 'restore.json'), {
        dbs: [{ path: destination, replica: target(path, sourceEpoch) }],
      })
      await run(
        [
          'restore',
          '-config',
          join(config.run, 'restore.json'),
          '-txid',
          txid.toString(16).padStart(16, '0'),
          destination,
        ],
        signal,
        120000,
      )
    },
    async close() {
      await terminate(process)
      process = undefined
      signature = undefined
    },
  }
}

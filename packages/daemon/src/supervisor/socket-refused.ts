import { connect, type Socket } from 'node:net'

const codeIs = (error: unknown, code: string) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code

export async function socketRefused(
  path: string,
  openSocket: (path: string) => Socket = connect,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = openSocket(path)
    const timer = setTimeout(() => finish(false), 1000)
    const finish = (value: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => finish(false))
    socket.once('error', (error) => finish(codeIs(error, 'ECONNREFUSED')))
  })
}

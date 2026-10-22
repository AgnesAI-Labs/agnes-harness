'use strict'
const http = require('node:http')
const { createHandler } = require('./src/app')
const { generate } = require('./src/signals')

// --port is the fallback for a plain deployment; under AGH the Host hands over a bound listener.
const at = process.argv.indexOf('--port')
const port = at > 0 ? Number(process.argv[at + 1]) : 5180
const server = http.createServer(createHandler(generate()))
const fd = process.env.AGH_LOOPBACK_FD
server.listen(fd ? { fd: Number(fd) } : { host: '127.0.0.1', port }, () => {
  console.log(process.env.AGH_LOOPBACK_URL ?? `http://127.0.0.1:${port}/`)
})

const http = require('node:http')
const request = http.get(`http://127.0.0.1:${process.argv[1]}/`, (response) => {
  response.setEncoding('utf8')
  response.on('data', (chunk) => process.stdout.write(chunk))
  response.on('end', () => process.exit(0))
})
request.once('error', () => process.exit(3))
request.setTimeout(500, () => process.exit(4))

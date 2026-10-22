'use strict'
const { LINES } = require('./signals')
const { PAGE } = require('./page')
const { average, describe, grade, ranking } = require('./health')

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
const bad = (res, message) => send(res, 400, { error: message })

/** Whole numbers only: 1 to 50 for the ranking limit. */
function parseLimit(value) {
  if (value === null) return 10
  if (!/^\d{1,2}$/.test(value)) return null
  const n = Number(value)
  return n >= 1 && n <= 50 ? n : null
}

function createHandler(doors) {
  const lineOf = (id) => LINES.find((line) => line.id === id)
  const withScore = (list) => ({ average: average(list), grade: grade(average(list) ?? 0) })
  return (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET' })
    const url = new URL(req.url, 'http://localhost')
    const q = url.searchParams
    switch (url.pathname) {
      case '/':
        return send(res, 200, PAGE, 'text/html; charset=utf-8')
      case '/healthz':
        return send(res, 200, { ok: true, doors: doors.length })
      case '/api/lines':
        return send(res, 200, {
          lines: LINES.map((line) => ({ ...line, ...withScore(doors.filter((d) => d.line === line.id)) })),
        })
      case '/api/trains': {
        const line = lineOf(q.get('line'))
        if (!line) return bad(res, '线路不存在')
        const trains = [...new Set(doors.filter((d) => d.line === line.id).map((d) => d.train))]
        return send(res, 200, {
          trains: trains.map((train) => ({
            train,
            ...withScore(doors.filter((d) => d.line === line.id && d.train === train)),
          })),
        })
      }
      case '/api/doors': {
        const line = lineOf(q.get('line'))
        if (!line) return bad(res, '线路不存在')
        const train = q.get('train')
        const list = doors.filter((d) => d.line === line.id && (!train || d.train === train))
        if (!list.length) return bad(res, '车辆不存在')
        return send(res, 200, { doors: list.map(describe) })
      }
      case '/api/ranking': {
        const limit = parseLimit(q.get('limit'))
        if (limit === null) return bad(res, 'limit 需为 1 到 50 的整数')
        return send(res, 200, { ranking: ranking(doors, limit) })
      }
      default:
        return send(res, 404, { error: '未找到' })
    }
  }
}

module.exports = { createHandler, parseLimit }

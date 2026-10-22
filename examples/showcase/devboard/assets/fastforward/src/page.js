'use strict'

// The single page: line, train and door level, plus the alarm ranking. Plain DOM, no libraries.
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>车门健康监测看板</title>
<style>
body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2933; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; }
table { border-collapse: collapse; min-width: 420px; } th, td { border: 1px solid #cbd2d9; padding: 4px 10px; text-align: left; }
button { cursor: pointer; } .grade-告警 { color: #b42318; } .grade-关注 { color: #b54708; } .grade-健康 { color: #067647; }
.note { color: #616e7c; font-size: 13px; }
</style>
</head>
<body>
<h1>车门健康监测看板</h1>
<p class="note" id="note">宁川装备演示数据：信号由程序生成，不来自真实车辆。</p>
<h2>线路</h2><div id="lines"></div>
<h2 id="train-title" hidden>车辆</h2><div id="trains"></div>
<h2 id="door-title" hidden>车门</h2><div id="doors"></div>
<h2>预警排行（评分最低的 10 扇门）</h2><div id="ranking"></div>
<script>
const $ = (id) => document.getElementById(id)
const api = (path) => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(path + ' ' + r.status))))
function table(rows, columns) {
  const head = '<tr>' + columns.map((c) => '<th>' + c[0] + '</th>').join('') + '</tr>'
  const body = rows.map((row) => '<tr>' + columns.map((c) => '<td>' + c[1](row) + '</td>').join('') + '</tr>').join('')
  return '<table>' + head + body + '</table>'
}
const gradeCell = (row) => '<span class="grade-' + row.grade + '">' + row.grade + '</span>'
let latest = 0
function showDoors(line, train) {
  const mine = ++latest
  api('/api/doors?line=' + line + '&train=' + train).then((data) => {
    if (mine !== latest) return
    $('door-title').hidden = false
    $('doors').innerHTML = table(data.doors, [['车门', (r) => r.id], ['评分', (r) => r.score], ['等级', gradeCell], ['预警信号', (r) => r.alarms.join('、') || '无']])
  })
}
function showTrains(line) {
  api('/api/trains?line=' + line).then((data) => {
    $('train-title').hidden = false
    $('doors').innerHTML = ''
    $('door-title').hidden = true
    $('trains').innerHTML = table(data.trains, [['车辆', (r) => '<button data-train="' + r.train + '">' + r.train + '</button>'], ['平均评分', (r) => r.average], ['等级', gradeCell]])
    $('trains').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => showDoors(line, b.dataset.train)))
  })
}
api('/api/lines').then((data) => {
  $('lines').innerHTML = table(data.lines, [['线路', (r) => '<button data-line="' + r.id + '">' + r.name + '</button>'], ['平均评分', (r) => r.average], ['等级', gradeCell]])
  $('lines').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => showTrains(b.dataset.line)))
})
api('/api/ranking?limit=10').then((data) => {
  $('ranking').innerHTML = table(data.ranking, [['车门', (r) => r.id], ['评分', (r) => r.score], ['等级', gradeCell], ['预警信号', (r) => r.alarms.join('、') || '无']])
})
</script>
</body>
</html>
`

module.exports = { PAGE }

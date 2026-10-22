'use strict'

// Health score of one door: 100 minus the weighted share of every signal that is close to its alarm limit.
const WEIGHTS = { slide: 0.25, resistance: 0.25, bufferWear: 0.2, closeTime: 0.15, motorPeak: 0.15 }
const ALARM_AT = 0.8

function clamp01(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function score(signals) {
  let penalty = 0
  for (const [name, weight] of Object.entries(WEIGHTS)) penalty += weight * clamp01(signals?.[name])
  return Math.round((1 - penalty) * 1000) / 10
}

/** 80 and above is healthy, 60 up to 80 needs attention, below 60 is an alarm. */
function grade(value) {
  if (value >= 80) return '健康'
  if (value >= 60) return '关注'
  return '告警'
}

function alarms(signals) {
  return Object.keys(WEIGHTS).filter((name) => clamp01(signals?.[name]) >= ALARM_AT)
}

function describe(door) {
  const value = score(door.signals)
  return { ...door, score: value, grade: grade(value), alarms: alarms(door.signals) }
}

/** The doors that need attention first: lowest score first, id as the tie-breaker. */
function ranking(doors, limit = 10) {
  return doors
    .map(describe)
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, limit)
}

function average(doors) {
  if (!doors.length) return null
  return Math.round((doors.reduce((sum, door) => sum + score(door.signals), 0) / doors.length) * 10) / 10
}

module.exports = { WEIGHTS, ALARM_AT, score, grade, alarms, describe, ranking, average }

'use strict'

// Simulated PHM signals of the door fleet (generated, never read from a vehicle).
// Every value is normalised: 0 is as new, 1 is the alarm limit of that signal.
const SIGNALS = ['slide', 'resistance', 'bufferWear', 'closeTime', 'motorPeak']
const LINES = [
  { id: 'L9', name: '宁川地铁 9 号线', trains: 4 },
  { id: 'L3', name: '宁川地铁 3 号线', trains: 3 },
]
const DOORS_PER_TRAIN = 8

/** Small deterministic generator, so a seed always yields the same fleet. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(seed = 20261022) {
  const rand = mulberry32(seed)
  const doors = []
  for (const line of LINES) {
    for (let t = 1; t <= line.trains; t++) {
      for (let d = 1; d <= DOORS_PER_TRAIN; d++) {
        const wear = rand() ** 3
        const signals = Object.fromEntries(
          SIGNALS.map((name) => [name, Math.round(Math.min(1, wear * (0.6 + rand() * 0.8)) * 100) / 100]),
        )
        doors.push({
          id: `${line.id}-T${String(t).padStart(2, '0')}-D${d}`,
          line: line.id,
          train: `T${String(t).padStart(2, '0')}`,
          door: `D${d}`,
          signals,
        })
      }
    }
  }
  return doors
}

module.exports = { SIGNALS, LINES, DOORS_PER_TRAIN, generate }

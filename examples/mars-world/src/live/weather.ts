import { LAYOUT } from '../base.js'
import { WEATHER_TURN } from '../devices.js'
import { placed } from './basemap.js'
import { yawOf } from './route.js'
import { every, type World, WorldDevice } from './world.js'

/** The weather station: readings once a second, and a storm warning in its state. */
export function weatherStation(world: World, log: (line: string) => void): WorldDevice {
  const dev = new WorldDevice({
    id: 'weather-01',
    kind: 'sensor',
    name: 'Weather station',
    model: 'Agnes Base simulation',
    localization: 'fixed',
    // Facing the way its instrument box faces.
    placement: placed(LAYOUT.weather, yawOf(WEATHER_TURN)),
    state: {
      storm_warning: {
        type: 'string',
        enum: ['none', 'watch', 'warning'],
        description: 'dust storm warning, from wind and dust',
      },
    },
  })
  dev.log = log
  dev.update({ storm_warning: 'none' })
  const air = dev.source('air', 'values', 'wind, pressure, temperature, dust and radiation at the base', {
    hz: 1,
    default: true,
    fields: {
      wind: { type: 'number', unit: 'm/s', min: 0, max: 40, alert: { warn: 15, bad: 25 } },
      pressure: { type: 'number', unit: 'Pa', min: 400, max: 1100 },
      temperature: { type: 'number', unit: '°C', min: -110, max: 30, role: 'temperature', of: 'air' },
      dust: {
        type: 'number',
        min: 0,
        max: 5,
        alert: { warn: 1.2, bad: 2.5 },
        description: 'optical depth (tau)',
      },
      radiation: { type: 'number', unit: 'x_ugy_per_h', min: 0, max: 100 },
    },
  })
  every(
    1000,
    () => {
      const t = performance.now() / 1000
      const wind = Math.round((6 + Math.sin(t / 30) * 2 + Math.random()) * 10) / 10
      const dust = Math.round((0.6 + Math.sin(t / 200) * 0.05) * 100) / 100
      const storm = wind > 25 || dust > 2.5 ? 'warning' : wind > 15 || dust > 1.2 ? 'watch' : 'none'
      world.weather = { wind, dust, storm }
      dev.update({ storm_warning: storm })
      if (!air.wants()) return
      air.send({
        wind,
        pressure: Math.round(728 + Math.sin(t / 90) * 4),
        temperature: Math.round((-38 + Math.sin(t / 120) * 3) * 10) / 10,
        dust,
        radiation: Math.round((24 + Math.random() * 2) * 10) / 10,
      })
    },
    log,
  )
  return dev
}

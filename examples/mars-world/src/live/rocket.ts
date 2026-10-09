/**
 * How the rocket hopper spends its propellant, in percent of a full load: plain arithmetic without
 * three.js, so it can be tested on its own. Flight time and the highest altitude both follow from
 * what is left above the landing reserve.
 */
export const ROCKET = {
  /** Percent a second to hold position in the air. */
  hoverBurn: 0.5,
  /** Extra percent a second for each m/s of horizontal speed. */
  speedBurn: 0.03,
  /** Extra percent for each metre climbed. */
  climbBurn: 0.6,
  /** Percent of propellant per metre of altitude it may reach: the climb and a controlled descent. */
  perMetre: 1.5,
  /** Percent always kept for landing. */
  reserve: 10,
  /** Percent needed to take off. */
  minTakeOff: 30,
  /** The highest it ever flies, metres above the ground. */
  ceiling: 30,
  /** Percent a second it refuels while landed on its pad. */
  refuel: 2,
}

/** Percent burned in `dt` seconds of flight at `speed` m/s, climbing `climbed` metres. */
export function burn(dt: number, speed: number, climbed: number): number {
  return (ROCKET.hoverBurn + ROCKET.speedBurn * speed) * dt + ROCKET.climbBurn * Math.max(0, climbed)
}

/** Seconds it can hover on `propellant` percent before it reaches the landing reserve. */
export function flightTimeLeft(propellant: number): number {
  return Math.max(0, Math.floor((propellant - ROCKET.reserve) / ROCKET.hoverBurn))
}

/** The highest altitude, in whole metres above the ground, that `propellant` percent allows. */
export function maxAltitude(propellant: number): number {
  return Math.max(0, Math.min(ROCKET.ceiling, Math.floor((propellant - ROCKET.reserve) / ROCKET.perMetre)))
}

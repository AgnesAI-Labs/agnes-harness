import * as THREE from 'three'

/** Times of day the world can show, by sun elevation and azimuth in degrees. */
const TIMES = {
  morning: { elevation: 24, azimuth: 118 },
  noon: { elevation: 58, azimuth: 175 },
  sunset: { elevation: 3.5, azimuth: 262 },
} as const

export type TimeOfDay = keyof typeof TIMES

/** Elevation of the sun above the horizon at `time`, in degrees. */
export const sunElevation = (time: TimeOfDay) => TIMES[time].elevation

export interface Light {
  sun: THREE.Vector3
  /** 0 at sunset, 1 in full day. */
  day: number
  horizon: THREE.Color
  zenith: THREE.Color
}

export function lightAt(time: TimeOfDay): Light {
  const { elevation, azimuth } = TIMES[time]
  const el = THREE.MathUtils.degToRad(elevation)
  const az = THREE.MathUtils.degToRad(azimuth)
  // Azimuth from north (-z), clockwise towards east (+x).
  const sun = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el))
  const day = THREE.MathUtils.smoothstep(elevation, 0, 25)
  const horizon = new THREE.Color(0.36, 0.25, 0.19).lerp(new THREE.Color(0.86, 0.6, 0.4), day)
  const zenith = new THREE.Color(0.12, 0.09, 0.08).lerp(new THREE.Color(0.48, 0.3, 0.19), day)
  return { sun, day, horizon, zenith }
}

/**
 * The Mars sky: butterscotch by day, darker towards the zenith, with the blue glow Mars shows
 * around the sun, strongest at sunset.
 */
export function buildSky(light: Light): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      sunDir: { value: light.sun },
      day: { value: light.day },
      horizon: { value: light.horizon },
      zenith: { value: light.zenith },
    },
    vertexShader: `varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform vec3 sunDir; uniform float day; uniform vec3 horizon; uniform vec3 zenith;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(horizon, zenith, pow(h, 0.5));
        float mu = max(dot(d, sunDir), 0.0);
        vec3 blue = vec3(0.32, 0.5, 0.78);
        col = mix(col, blue * (0.7 + 0.9 * (1.0 - day)), pow(mu, 10.0) * mix(0.85, 0.35, day));
        col += vec3(1.0, 0.92, 0.82) * (pow(mu, 600.0) * 3.0 + smoothstep(0.99955, 0.9998, mu) * 30.0);
        col = d.y < 0.0 ? horizon * 0.75 : col;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
  return new THREE.Mesh(new THREE.SphereGeometry(1600, 48, 24), material)
}

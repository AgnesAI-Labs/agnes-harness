// Writes assets/manifest.json: every third-party asset the world uses, with its license or usage
// terms, authors, source page, and the exact files (URL, size, md5) that tools/fetch-assets.mjs
// downloads and checks. Run it only to change the asset list: node tools/lock-assets.mjs
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

// Poly Haven, CC0.
const MODELS = ['moon_rock_01', 'moon_rock_03', 'moon_rock_05', 'moon_rock_07', 'namaqualand_boulder_02']
const TEXTURES = ['dry_ground_rocks', 'sandy_gravel_02', 'rock_face', 'metal_plate']
const MAPS = { Diffuse: 'diff', nor_gl: 'nor', Rough: 'rough' }

// NASA 3D Resources. The repository states the assets are "free and without copyright"; NASA's
// media usage guidelines still forbid using the NASA insignia and implying endorsement, so the
// world paints over every insignia these models carry when it loads them (src/assets.ts).
const NASA_REPO = 'https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models'
const NASA = [
  { id: 'perseverance', name: 'Mars 2020 Perseverance Rover', dir: 'Mars 2020 Perseverance Rover' },
  { id: 'mark3_suit', name: 'Mark III Spacesuit', dir: 'Mark III Spacesuit' },
]
const NASA_TERMS =
  'NASA 3D Resources: "free and without copyright" (repository README); NASA media usage guidelines apply: no NASA insignia, no implied endorsement'

const api = async (path) => {
  const res = await fetch(`https://api.polyhaven.com/${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}
const file = (path, f) => ({ path, url: f.url, size: f.size, md5: f.md5 })

const assets = []
async function add(id, kind, files) {
  const info = await api(`info/${id}`)
  assets.push({
    id,
    kind,
    name: info.name,
    authors: Object.keys(info.authors ?? {}),
    license: 'CC0-1.0',
    source: `https://polyhaven.com/a/${id}`,
    files,
  })
}

for (const id of MODELS) {
  const gltf = (await api(`files/${id}`)).gltf['1k'].gltf
  const files = [file(`models/${id}/${id}.gltf`, gltf)]
  for (const [rel, f] of Object.entries(gltf.include)) files.push(file(`models/${id}/${rel}`, f))
  await add(id, 'model', files)
}
for (const id of TEXTURES) {
  const all = await api(`files/${id}`)
  const files = Object.entries(MAPS).map(([key, short]) =>
    file(`textures/${id}/${short}.jpg`, all[key]['1k'].jpg),
  )
  await add(id, 'texture', files)
}
for (const n of NASA) {
  const dir = encodeURIComponent(n.dir)
  const url = `${NASA_REPO}/${dir}/${dir}.glb`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  assets.push({
    id: n.id,
    kind: 'model',
    name: n.name,
    authors: ['NASA'],
    license: NASA_TERMS,
    source: `https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/${dir}`,
    files: [
      { path: `nasa/${n.id}.glb`, url, size: buf.length, md5: createHash('md5').update(buf).digest('hex') },
    ],
  })
}

const bytes = assets.flatMap((a) => a.files).reduce((n, f) => n + f.size, 0)
writeFileSync(
  new URL('../assets/manifest.json', import.meta.url),
  `${JSON.stringify({ about: 'Third-party assets of @agnes/mars-world, fetched by tools/fetch-assets.mjs', bytes, assets }, null, 2)}\n`,
)
console.log(`${assets.length} assets, ${(bytes / 1e6).toFixed(1)} MB`)

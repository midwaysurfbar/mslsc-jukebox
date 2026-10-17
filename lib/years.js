// A song's ORIGINAL year, looked up from MusicBrainz in the background and remembered for good (Sam, 2026-10-17).
// The decade in the song picker used to come from an iTunes music-VIDEO date, which is often a re-release years later
// ("(Not Just) Knee Deep", 1979, showed as 2010s). MusicBrainz lists every release of a recording, so the earliest
// release of that song by that singer/band is the real year.
// Slow on purpose (MusicBrainz asks for about one request a second): a few thousand songs take an hour or so, only
// ever once per song, never needed for playback, and it picks up where it left off after a restart.
const fs = require('node:fs')
const path = require('node:path')
const { requireFileKey } = require('./library')

const USER_AGENT = 'MSLSCJukebox/0.30.1 (Midway Surf Life Saving Club; sdalcom@gmail.com)'
const RECHECK_MS = 60 * 24 * 3600 * 1000 // a song with no match is tried again after ~2 months

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

// The first named singer/band: "Fergie ft. Q-Tip, GoonRock" -> "fergie"; "X Cover" -> "x".
function mainArtist(artist) {
  return norm(String(artist || '').split(/\s+(?:ft|feat|featuring)\.?\s+|\s*(?:,|&|\band\b)\s*/i)[0].replace(/\s+cover$/i, ''))
}

// rows = MusicBrainz recordings. The earliest first-release year among confident matches (same title, the singer/band
// among the credited artists), or null when nothing matches well enough to trust.
function pickYear(rows, artist, title, nowYear = new Date().getFullYear()) {
  const wantTitle = norm(title)
  const wantArtist = mainArtist(artist)
  if (!wantTitle || !wantArtist) return null
  let year = 0
  for (const r of rows || []) {
    if ((Number(r.score) || 0) < 80) continue
    if (norm(r.title) !== wantTitle) continue
    const credit = norm((r['artist-credit'] || []).map((a) => `${a.name || ''}${a.joinphrase || ''}`).join(''))
    if (!credit.includes(wantArtist)) continue
    const y = parseInt(String(r['first-release-date'] || '').slice(0, 4), 10)
    if (y >= 1900 && y <= nowYear && (!year || y < year)) year = y
  }
  return year || null
}

function createYears({ store, fetchImpl = (...args) => fetch(...args), gapMs = 1200, retryMs = 15000, busyMs = 60000, onBatch = () => {}, now = () => Date.now() }) {
  const { paths, readJson, writeJson } = store
  let running = false
  let stopped = false
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const all = () => readJson(paths.years, {})
  // years.log in the Jukebox's data folder: what the background look-up is doing (kept short)
  const logFile = path.join(paths.userData, 'years.log')
  function log(message) {
    try {
      const line = `${new Date().toISOString()} ${message}\n`
      const old = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-200).join('\n') : ''
      fs.writeFileSync(logFile, old + line)
    } catch { /* logging must never stop the look-up */ }
  }

  async function lookup(artist, title) {
    const esc = (s) => String(s).replace(/[\\"]/g, ' ')
    const query = `recording:"${esc(title)}" AND artist:"${esc(String(artist).split(/\s+(?:ft|feat|featuring)\.?\s+/i)[0])}"`
    const res = await fetchImpl(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=100`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    })
    if (res.status === 503 || res.status === 429) { const e = new Error('busy'); e.busy = true; throw e }
    if (!res.ok) throw new Error(`MusicBrainz answered ${res.status}`)
    const data = await res.json()
    return pickYear(data.recordings, artist, title)
  }

  // list() -> [{ k, a, t }]: every song with the artist and title the picker shows. Songs with no artist are skipped:
  // a title on its own matches the wrong song too often.
  async function run(list) {
    if (running) return { running: true }
    running = true
    stopped = false
    let checked = 0
    try {
      const known = all()
      const t0 = now()
      const todo = (await list()).filter((s) => {
        if (!s || !s.k || !s.a || !s.t) return false
        const e = known[s.k]
        return !e || (e.y === null && t0 - e.at > RECHECK_MS)
      })
      log(`checking ${todo.length} song${todo.length === 1 ? '' : 's'}`)
      let pending = {}
      const flush = () => {
        if (!Object.keys(pending).length) return
        log(`saved ${Object.keys(pending).length} (${Object.values(pending).filter((p) => p.y).length} with a year)`)
        writeJson(paths.years, { ...all(), ...pending })
        pending = {}
        onBatch()
      }
      for (const s of todo) {
        if (stopped) break
        try { requireFileKey(s.k) } catch { continue }
        let tries = 0
        for (;;) {
          try {
            pending[s.k] = { y: await lookup(s.a, s.t), at: now() }
            checked += 1
            break
          } catch (err) {
            tries += 1
            log(`${s.a} - ${s.t}: ${err.message}${err.cause && err.cause.code ? ` (${err.cause.code})` : ''} (try ${tries})`)
            if (tries >= 3 || stopped) break // offline or busy for a while: leave it for the next run
            await wait(err.busy ? busyMs : retryMs)
          }
        }
        if (Object.keys(pending).length >= 40) flush()
        await wait(gapMs)
      }
      flush()
    } finally {
      running = false
    }
    return { checked }
  }

  return { run, get: all, stop: () => { stopped = true }, isRunning: () => running, lookup }
}

module.exports = { createYears, pickYear, mainArtist }

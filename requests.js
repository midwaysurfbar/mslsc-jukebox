// Patron song requests (Sam, 2026-09-28): a touch-screen "pick a song" page
// served by the Jukebox itself over the club network, so any touch screen
// with a browser - a monitor on the other PC, a tablet - can add songs to
// the queue. It never takes over the Jukebox: staff keep full control in
// the Control window, and this only ever ADDS to the end of the queue.
//
// Rules (agreed with Sam):
//   * Only screens that have been set up with a one-time code from the
//     Control window can use it (so phones on the club Wi-Fi can't).
//   * A manual on/off switch in Control. Off = the page says requests are
//     closed; staff can still queue as many songs as they like.
//   * On = at most 20 songs waiting; at 20 or more the page says "please
//     wait". A song can't be requested again within 10 minutes of it
//     playing, and never while it's already waiting in the queue.
//   * Requests join the END of the queue in the order they arrive, exactly
//     like a song added in Control.
//
// Staff Remote (Sam, 2026-10-09): the same server also serves /remote, a
// full staff control page for when the Jukebox's own Control window is out
// of reach (the venue PC's screen became the touch-screen kiosk + picker, so
// staff drive the music from the other PC). Remotes pair with their own
// one-time code; a song-picker screen can never use the remote commands.
// Every remote command is carried out BY the Control window (it still owns
// the queue) - this file only relays it and the answer, like requests.
//
// Bar open/closed (Sam, 2026-10-09): by default requests only open while
// the bar is open - the same open/closed state the Attendance sign-in kiosk
// and the menu board show (public-kiosk-state), checked every 30 seconds.
// While it's closed the picker shows "Bar closed" with the next opening
// (public-next-bar-opening). Staff in Control and on the Remote are never
// limited. If the check can't be made (internet down) the last answer
// stands, and before any answer the bar counts as open - a dropped
// connection must never shut the picker on a busy night.
//
// Library Manager (Sam, 2026-10-11): /library is a page for tidying the
// music library from a laptop (rename, delete, duplicates, playlists - see
// lib/library-manager.js). Laptops pair with their own code like a remote,
// and its commands only answer a paired laptop coming in over Tailscale
// (100.64.0.0/10) - never the club Wi-Fi, a touch screen or a remote.
//
// Safety: nothing here runs until requests are first switched on or a
// screen is set up (so Windows never asks about network access before
// then), every failure is caught and only reported in Control, and the
// queue itself is still owned by the Control window - this file only asks
// it to add a song and relays the answer.

const http = require('node:http')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PORT = 4610
const MAX_WAITING = 20
const REPEAT_MINUTES = 10
const PAIRING_MINUTES = 10
const PAGE_FILES = {
  '/': ['request/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['request/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['request/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['request/style.css', 'text/css; charset=utf-8'],
  '/remote': ['remote/index.html', 'text/html; charset=utf-8'],
  '/remote/': ['remote/index.html', 'text/html; charset=utf-8'],
  '/remote/remote.js': ['remote/remote.js', 'text/javascript; charset=utf-8'],
  '/remote/remote.css': ['remote/remote.css', 'text/css; charset=utf-8'],
  '/library': ['library/index.html', 'text/html; charset=utf-8'],
  '/library/': ['library/index.html', 'text/html; charset=utf-8'],
  '/library/library.js': ['library/library.js', 'text/javascript; charset=utf-8'],
  '/library/library.css': ['library/library.css', 'text/css; charset=utf-8'],
}
// the shared club "retro surf" fonts (2026-10-10), served locally so the
// touchscreen never needs the internet for them
for (const f of ['shrikhand-400', 'barlow-500', 'barlow-600', 'barlow-700', 'barlow-800', 'barlow-condensed-600', 'barlow-condensed-700', 'barlow-condensed-800']) {
  PAGE_FILES[`/fonts/${f}.woff2`] = [`request/fonts/${f}.woff2`, 'font/woff2']
}
PAGE_FILES['/fonts/surf-fonts.css'] = ['request/fonts/surf-fonts.css', 'text/css; charset=utf-8']
const KINDS = new Set(['picker', 'remote', 'library'])
const KIND_NAMES = { picker: 'Touch screen', remote: 'Remote', library: 'Laptop' }
const BAR_FN = 'https://zzfcadiphconmkeudrby.supabase.co/functions/v1/'
const BAR_KEY = 'sb_publishable_IDOXZicxdptjL667yWpVAQ_H1jB2saj' // public anon key, same as the ads
const BAR_CHECK_MS = 30000
// Commands the main process answers itself; everything else goes to Control.
const REMOTE_COMMANDS = new Set([
  'toggle', 'skip', 'previous', 'seek', 'volume', 'tv-start-hidden',
  'add', 'next', 'move', 'remove', 'play-from', 'shuffle', 'clear',
  'playlist-play', 'playlist-queue',
])

// A Tailscale address (100.64.0.0/10) - how the laptops reach the venue PC.
function isTailnet(address) {
  const m = /^(?:::ffff:)?100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(String(address || ''))
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127)
}
const isLoopback = (address) => /^(?:::ffff:)?127\.|^::1$/.test(String(address || ''))

module.exports = function setupRequests({ ipcMain, getControlWindow, userData, thumbnailsDir, readJson, writeJson, listLibrary, videoPath = () => null, appVersion = '', tv = null, port = PORT, fetchImpl = globalThis.fetch, barCheckMs = BAR_CHECK_MS, libraryManager = null, allowLocalLibrary = false }) {
  const REQUESTS_PATH = path.join(userData, 'requests.json')
  const load = () => ({ enabled: false, serverOn: false, followBar: true, devices: [], ...readJson(REQUESTS_PATH, {}) })
  let config = load()
  const save = () => writeJson(REQUESTS_PATH, config)

  let server = null
  let serverError = ''
  let pairing = null // { code, expiresAt, kind }
  let badPairAttempts = []
  let status = { nowPlaying: null, upNext: [], waiting: 0 }
  let remoteStatus = null // full snapshot for /remote, pushed by Control
  let bar = { open: null, next: null, checkedAt: 0 } // open: true/false, null = not known yet
  let barTimer = null

  async function callBarFn(name) {
    const res = await fetchImpl(BAR_FN + name, {
      method: 'POST',
      headers: { apikey: BAR_KEY, Authorization: `Bearer ${BAR_KEY}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json()
    if (!data || !data.ok) throw new Error('bar status unavailable')
    return data
  }
  // ---- song suggestions (Sam, 2026-10-10) ----
  // Songs members want that aren't in the library. Kept centrally (the
  // jukebox-suggestions function) so staff see them on the Remote and the
  // Hub. If the internet is down they wait here and go later.
  const SUGGEST_PENDING = path.join(userData, 'suggestions-pending.json')
  const SUGGEST_KEY_PATH = path.join(userData, 'suggestions.json') // { venueKey } - set on the venue PC, never in the repo
  const suggestHits = new Map() // device id -> recent suggestion times
  const cleanText = (v) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  async function callSuggest(body) {
    const res = await fetchImpl(BAR_FN + 'jukebox-suggestions', {
      method: 'POST',
      headers: { apikey: BAR_KEY, Authorization: `Bearer ${BAR_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json().catch(() => null)
    if (!data) throw new Error('no answer')
    return data
  }
  async function flushSuggestions() {
    const waiting = readJson(SUGGEST_PENDING, [])
    if (!Array.isArray(waiting) || !waiting.length) return
    const left = []
    for (const item of waiting) {
      try { await callSuggest({ action: 'add', song: item.song, artist: item.artist }) } catch { left.push(item) }
    }
    writeJson(SUGGEST_PENDING, left)
  }
  // A song that's just arrived through the New Suggestions inbox ticks off
  // the matching waiting suggestion(s) by itself (Sam, 2026-10-10). Match =
  // same song name (or one contains the other) and, if the suggestion gave
  // an artist, the same artist the same way. Never throws.
  const normWords = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
  const near = (a, b) => a && b && (a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))))
  function suggestionMatches(s, song) {
    if (!near(normWords(s.song), normWords(song.title))) return false
    const wantArtist = normWords(s.artist)
    return !wantArtist || near(wantArtist, normWords(song.artist))
  }
  async function tickSuggestions(songs) {
    const venueKey = (readJson(SUGGEST_KEY_PATH, {}) || {}).venueKey
    if (!venueKey || !songs || !songs.length) return []
    try {
      const list = await callSuggest({ action: 'list' })
      const ticked = []
      for (const s of (list && list.waiting) || []) {
        if (!songs.some((song) => suggestionMatches(s, song))) continue
        const r = await callSuggest({ action: 'set-status', id: s.id, status: 'added', venueKey })
        if (r && r.ok) ticked.push(s.song)
      }
      return ticked
    } catch {
      return []
    }
  }

  const suggestTimer = setInterval(() => { flushSuggestions().catch(() => {}) }, 60 * 1000)
  if (suggestTimer.unref) suggestTimer.unref()

  async function checkBar() {
    try {
      const open = Boolean((await callBarFn('public-kiosk-state')).session?.is_open)
      let next = null
      if (!open) {
        const b = (await callBarFn('public-next-bar-opening').catch(() => ({}))).booking
        if (b) next = { title: b.title || 'Bar opening', date: b.event_date, time: String(b.start_time || '').slice(0, 5) }
      }
      const changed = open !== bar.open || JSON.stringify(next) !== JSON.stringify(bar.next)
      bar = { open, next, checkedAt: Date.now() }
      if (changed) notifyControl()
    } catch {
      // keep the last answer - see the note at the top
    }
  }
  function startBarChecks() {
    if (barTimer || !barCheckMs) return
    checkBar()
    barTimer = setInterval(checkBar, barCheckMs)
  }
  // Requests are open to the picker when switched on AND (if following the
  // bar) the bar isn't known to be closed.
  const barAllows = () => config.followBar === false || bar.open !== false
  function barState() {
    return { followBar: config.followBar !== false, barOpen: bar.open, barAllows: barAllows(), nextOpening: bar.open === false ? bar.next : null }
  }
  let library = null
  let libraryBuiltAt = 0
  // goes up whenever the library changes, so the song picker and the
  // Remote know to fetch the song list again
  let libraryVersion = 1
  const pending = new Map() // request id -> resolve

  function addresses() {
    const out = []
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`)
    }
    return out
  }

  function publicState() {
    if (pairing && Date.now() > pairing.expiresAt) pairing = null
    return {
      enabled: config.enabled,
      serverRunning: Boolean(server),
      serverError,
      port,
      addresses: addresses(),
      devices: config.devices.map(({ id, name, pairedAt, lastSeen, kind }) => ({ id, name, pairedAt, lastSeen, kind: kind || 'picker' })),
      pairing,
      maxWaiting: MAX_WAITING,
      tailnetAddress: tailnetAddress(),
      ...barState(),
    }
  }
  function tailnetAddress() {
    const a = addresses().find((x) => isTailnet(x.replace(/^http:\/\//, '').replace(/:\d+$/, '')))
    return a ? `${a}/library` : ''
  }

  function notifyControl() {
    const win = getControlWindow()
    if (win && !win.isDestroyed()) win.webContents.send('requests:state', publicState())
  }

  // ---- HTTP ----------------------------------------------------------------
  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
  }

  const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm', '.ogv': 'video/ogg' }
  function streamVideo(req, res, file) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain')
      const type = VIDEO_TYPES[path.extname(file).toLowerCase()] || 'video/mp4'
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
      let start = 0
      let end = st.size - 1
      if (m && (m[1] || m[2])) {
        if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])) } else start = Math.max(0, st.size - Number(m[2]))
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end() }
      }
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      if (m) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
      res.writeHead(m ? 206 : 200, headers)
      if (req.method === 'HEAD') return res.end()
      const stream = fs.createReadStream(file, { start, end })
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    })
  }

  function readBody(req, limit = 4096) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk; if (data.length > limit) req.destroy() })
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
      req.on('error', () => resolve({}))
    })
  }

  function deviceFor(req, url) {
    const token = req.headers['x-device-token'] || url.searchParams.get('t') || ''
    if (!token) return null
    const device = config.devices.find((d) => d.token === token)
    if (device) {
      // lastSeen is only for the "Set up screens" list - written at most once a minute
      const now = Date.now()
      if (!device.lastSeen || now - device.lastSeen > 60000) { device.lastSeen = now; save(); notifyControl() }
    }
    return device
  }

  // Built from the Jukebox's last library scan (async - see lib/library.js),
  // and reused for 2 minutes or until the library changes.
  async function getLibrary() {
    if (!library || Date.now() - libraryBuiltAt > 2 * 60 * 1000) {
      library = await listLibrary()
      libraryBuiltAt = Date.now()
    }
    return library
  }

  // A remote command, carried out by Control (it owns the queue).
  function askControlRemote(action, args) {
    const win = getControlWindow()
    if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, error: 'The Jukebox is starting up - try again in a moment.' })
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'The Jukebox didn\'t answer - try again.' }) }, 8000)
      pending.set(id, (result) => { clearTimeout(timer); resolve(result) })
      win.webContents.send('remote:command', { id, action, args })
    })
  }

  function startPairing(kind) {
    config.serverOn = true
    save()
    startServer()
    pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), expiresAt: Date.now() + PAIRING_MINUTES * 60000, kind: KINDS.has(kind) ? kind : 'picker' }
    notifyControl()
  }

  function remoteRequestsState() {
    const st = publicState()
    return {
      enabled: st.enabled,
      waiting: status.waiting,
      maxWaiting: MAX_WAITING,
      devices: st.devices.map(({ id, name, lastSeen, kind }) => ({ id, name, lastSeen, kind })),
      pairing: st.pairing,
      ...barState(),
      address: st.addresses.find((a) => /\/\/(192\.168|10\.|172\.)/.test(a)) || st.addresses[0] || '',
      tailnetAddress: st.tailnetAddress,
    }
  }

  async function handleRemote(req, res, url, device) {
    if (req.method === 'GET' && url.pathname === '/api/remote/state') {
      return send(res, 200, { ok: true, version: appVersion, libraryVersion, you: device.id, player: remoteStatus, requests: remoteRequestsState(), tv: tv ? { visible: Boolean(tv.visible()), mode: tv.mode ? tv.mode() : (tv.visible() ? 'videos' : 'blank') } : null })
    }
    // The Remote's little muted previews of what's playing and what's next.
    if (req.method === 'GET' && url.pathname === '/api/remote/video') {
      const file = videoPath(String(url.searchParams.get('k') || '').replace(/[^a-f0-9]/gi, ''))
      if (!file) return send(res, 404, 'Not found', 'text/plain')
      return streamVideo(req, res, file)
    }
    if (req.method === 'GET' && url.pathname === '/api/remote/suggestions') {
      try { return send(res, 200, await callSuggest({ action: 'list' })) } catch { return send(res, 200, { ok: false, error: 'Can\'t reach the suggestions list right now.' }) }
    }
    if (req.method === 'POST' && url.pathname === '/api/remote/command') {
      const { action, args } = await readBody(req)
      const a = args && typeof args === 'object' ? args : {}
      if (action === 'requests-enabled') {
        config.enabled = Boolean(a.enabled)
        if (config.enabled) config.serverOn = true
        save()
        notifyControl()
        return send(res, 200, { ok: true })
      }
      if (action === 'requests-follow-bar') {
        config.followBar = Boolean(a.follow)
        save()
        notifyControl()
        return send(res, 200, { ok: true })
      }
      if (action === 'tv-show' || action === 'tv-hide' || action === 'tv-blank') {
        if (!tv) return send(res, 200, { ok: false, error: 'The TV can\'t be changed from here.' })
        if (action === 'tv-show') tv.show()
        else if (action === 'tv-blank' && tv.blank) tv.blank()
        else tv.hide()
        return send(res, 200, { ok: true })
      }
      if (action === 'suggestion-status') {
        const venueKey = (readJson(SUGGEST_KEY_PATH, {}) || {}).venueKey
        if (!venueKey) return send(res, 200, { ok: false, error: 'This Jukebox isn\'t set up to manage suggestions.' })
        try { return send(res, 200, await callSuggest({ action: 'set-status', id: String(a.id || ''), status: String(a.status || ''), venueKey })) } catch { return send(res, 200, { ok: false, error: 'Can\'t reach the suggestions list right now.' }) }
      }
      if (action === 'pair') { startPairing(a.kind); return send(res, 200, { ok: true }) }
      if (action === 'cancel-pair') { pairing = null; notifyControl(); return send(res, 200, { ok: true }) }
      if (action === 'remove-device') {
        if (a.id === device.id) return send(res, 400, { ok: false, error: 'This is the screen you\'re using - remove it from another remote or the Jukebox.' })
        config.devices = config.devices.filter((d) => d.id !== a.id)
        save()
        notifyControl()
        return send(res, 200, { ok: true })
      }
      if (!REMOTE_COMMANDS.has(action)) return send(res, 400, { ok: false, error: 'Unknown command.' })
      return send(res, 200, await askControlRemote(action, a))
    }
    return send(res, 404, { ok: false, error: 'Not found' })
  }

  function libraryAllowed(req) {
    const ip = req.socket.remoteAddress
    return isTailnet(ip) || (allowLocalLibrary && isLoopback(ip))
  }

  // ---- Library Manager (laptops on Tailscale only - see the top) ----
  async function handleLibrary(req, res, url, device) {
    const m = libraryManager
    const by = device.name
    const reply = async (fn) => {
      try { return send(res, 200, await fn()) } catch (err) { return send(res, 200, { ok: false, error: err.message || 'That didn\'t work.' }) }
    }
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /api/lib/video') {
      const file = videoPath(String(url.searchParams.get('k') || '').replace(/[^a-f0-9]/gi, ''))
      if (!file) return send(res, 404, 'Not found', 'text/plain')
      return streamVideo(req, res, file)
    }
    if (req.method === 'GET') {
      if (url.pathname === '/api/lib/songs') return reply(async () => ({ ok: true, songs: await m.list(), ...(await m.folders()), you: device.name, version: appVersion, libraryVersion }))
      if (url.pathname === '/api/lib/duplicates') return reply(async () => ({ ok: true, ...(await m.duplicates()) }))
      if (url.pathname === '/api/lib/playlists') return reply(async () => ({ ok: true, playlists: m.playlists() }))
      if (url.pathname === '/api/lib/history') return reply(async () => ({ ok: true, history: m.history() }))
      if (url.pathname === '/api/lib/sort') return reply(async () => ({ ok: true, sort: m.sortStatus() }))
      return send(res, 404, { ok: false, error: 'Not found' })
    }
    if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'Not found' })
    const body = await readBody(req, 1024 * 1024)
    switch (url.pathname) {
      case '/api/lib/edit': return reply(() => m.edit(body, by))
      case '/api/lib/move': return reply(() => m.move(body.keys, body.folder, by))
      case '/api/lib/delete': return reply(() => m.removeSongs(body.keys, by))
      case '/api/lib/undo': return reply(() => m.undo(String(body.id || ''), by))
      case '/api/lib/duplicates/resolve': return reply(() => m.resolveDuplicate(body, by))
      case '/api/lib/duplicates/exact-all': return reply(() => m.removeAllExact(by))
      case '/api/lib/duplicates/ignore': return reply(async () => m.ignoreDuplicate(body.keys))
      case '/api/lib/folder-playlists': return reply(() => m.makeFoldersNormal(body.ids, by))
      case '/api/lib/playlist': return reply(() => m.playlistAction(body, by))
      case '/api/lib/sort':
        if (body.action === 'start') return reply(async () => ({ ok: true, sort: await m.startSort(body.folders) }))
        if (body.action === 'stop') return reply(async () => ({ ok: true, sort: m.stopSort() }))
        if (body.action === 'apply') return reply(() => m.applySort(by))
        return send(res, 400, { ok: false, error: 'Unknown sort action.' })
      default: return send(res, 404, { ok: false, error: 'Not found' })
    }
  }

  function askControl(key) {
    const win = getControlWindow()
    if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, reason: 'unavailable' })
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, reason: 'busy' }) }, 5000)
      pending.set(id, (result) => { clearTimeout(timer); resolve(result) })
      win.webContents.send('requests:incoming', { id, key, maxWaiting: MAX_WAITING, repeatMinutes: REPEAT_MINUTES })
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`)

    if (req.method === 'GET' && PAGE_FILES[url.pathname]) {
      const [file, type] = PAGE_FILES[url.pathname]
      fs.readFile(path.join(__dirname, file), (err, data) => (err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, data, type)))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const now = Date.now()
      badPairAttempts = badPairAttempts.filter((t) => now - t < 60000)
      if (badPairAttempts.length >= 10) return send(res, 429, { ok: false, error: 'Too many tries - wait a minute and try again.' })
      const { code, kind: wanted, name: wantedName } = await readBody(req)
      if (!pairing || now > pairing.expiresAt || String(code || '') !== pairing.code) {
        badPairAttempts.push(now)
        return send(res, 403, { ok: false, error: 'That code isn\'t right, or has expired. Get a new one from the Jukebox.' })
      }
      // A remote's code only sets up a remote, a laptop's a laptop, and a
      // song picker's only a picker.
      const kind = KINDS.has(wanted) ? wanted : 'picker'
      if (kind !== pairing.kind) {
        badPairAttempts.push(now)
        const want = { picker: 'Set up a touch screen', remote: 'Set up a remote', library: 'Set up a laptop' }[kind]
        return send(res, 403, { ok: false, error: `That code is for a ${KIND_NAMES[pairing.kind].toLowerCase()}. On the Jukebox or the Remote choose "${want}" instead.` })
      }
      if (kind === 'library' && !libraryAllowed(req)) {
        return send(res, 403, { ok: false, error: 'Laptops can only be set up over Tailscale - turn Tailscale on and open the Tailscale address.' })
      }
      const sameKind = config.devices.filter((d) => (d.kind || 'picker') === kind).length
      const typedName = String(wantedName || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30)
      const device = {
        id: crypto.randomUUID(),
        token: crypto.randomBytes(24).toString('hex'),
        name: (kind === 'library' && typedName) || `${KIND_NAMES[kind]} ${sameKind + 1}`,
        kind,
        pairedAt: now,
        lastSeen: now,
      }
      config.devices.push(device)
      pairing = null
      save()
      notifyControl()
      return send(res, 200, { ok: true, token: device.token, name: device.name })
    }

    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain')
    const device = deviceFor(req, url)
    if (!device) return send(res, 401, { ok: false, error: 'not-paired' })
    if (url.pathname.startsWith('/api/remote/')) {
      if (device.kind !== 'remote') return send(res, 403, { ok: false, error: 'not-a-remote' })
      return handleRemote(req, res, url, device)
    }
    if (url.pathname.startsWith('/api/lib/')) {
      if (device.kind !== 'library') return send(res, 403, { ok: false, error: 'not-a-laptop' })
      if (!libraryAllowed(req)) return send(res, 403, { ok: false, error: 'The Library page only works over Tailscale.' })
      if (!libraryManager) return send(res, 503, { ok: false, error: 'The Library Manager isn\'t running on this Jukebox.' })
      return handleLibrary(req, res, url, device)
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, {
        ok: true,
        enabled: config.enabled,
        ...barState(),
        full: config.enabled && status.waiting >= MAX_WAITING,
        waiting: status.waiting,
        maxWaiting: MAX_WAITING,
        nowPlaying: status.nowPlaying,
        paused: Boolean(status.paused),
        upNext: status.upNext,
        libraryVersion,
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/library') {
      return send(res, 200, { ok: true, tracks: await getLibrary() })
    }

    if (req.method === 'GET' && url.pathname === '/api/thumb') {
      const key = (url.searchParams.get('k') || '').replace(/[^a-f0-9]/gi, '')
      if (!key) return send(res, 404, 'Not found', 'text/plain')
      fs.readFile(path.join(thumbnailsDir, `${key}.jpg`), (err, data) => {
        if (err) return send(res, 404, 'Not found', 'text/plain')
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
        res.end(data)
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/suggest') {
      const { song, artist } = await readBody(req)
      const s = cleanText(song)
      const a = cleanText(artist)
      if (s.length < 2) return send(res, 200, { ok: false, error: 'Please type the song name.' })
      const now = Date.now()
      const hits = (suggestHits.get(device.id) || []).filter((t) => now - t < 10 * 60 * 1000)
      if (hits.length >= 5) return send(res, 200, { ok: false, error: 'Thanks! That\'s plenty for now - try again in a few minutes.' })
      hits.push(now)
      suggestHits.set(device.id, hits)
      try {
        const r = await callSuggest({ action: 'add', song: s, artist: a })
        return send(res, 200, r.ok ? { ok: true, again: Boolean(r.again) } : { ok: false, error: r.error || 'That couldn\'t be sent.' })
      } catch {
        const waiting = readJson(SUGGEST_PENDING, [])
        const list = Array.isArray(waiting) ? waiting : []
        if (list.length < 200) list.push({ song: s, artist: a })
        writeJson(SUGGEST_PENDING, list)
        return send(res, 200, { ok: true, queued: true })
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/request') {
      if (!config.enabled) return send(res, 200, { ok: false, reason: 'closed' })
      if (!barAllows()) return send(res, 200, { ok: false, reason: 'bar-closed' })
      const { key } = await readBody(req)
      const clean = String(key || '').replace(/[^a-f0-9]/gi, '')
      if (!clean) return send(res, 400, { ok: false, reason: 'unavailable' })
      const result = await askControl(clean)
      return send(res, 200, result)
    }

    return send(res, 404, { ok: false, error: 'Not found' })
  }

  function startServer() {
    if (server) return
    serverError = ''
    const s = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error('[requests]', err)
        try { send(res, 500, { ok: false, error: 'Something went wrong.' }) } catch { /* connection gone */ }
      })
    })
    s.on('error', (err) => {
      serverError = err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use on this PC, so the song picker can't start.`
        : `The song picker couldn't start: ${err.message}`
      server = null
      notifyControl()
    })
    s.listen(port, '0.0.0.0', () => { server = s; notifyControl(); startBarChecks() })
  }

  // ---- IPC with Control ----------------------------------------------------
  ipcMain.handle('requests:get-state', () => publicState())
  ipcMain.handle('requests:set-enabled', (_event, enabled) => {
    config.enabled = Boolean(enabled)
    if (config.enabled) { config.serverOn = true; startServer() }
    save()
    return publicState()
  })
  ipcMain.handle('requests:start-pairing', (_event, kind) => {
    startPairing(kind)
    return publicState()
  })
  ipcMain.handle('requests:cancel-pairing', () => { pairing = null; return publicState() })
  ipcMain.handle('requests:remove-device', (_event, id) => {
    config.devices = config.devices.filter((d) => d.id !== id)
    save()
    return publicState()
  })
  ipcMain.on('requests:reply', (_event, { id, result }) => {
    const resolve = pending.get(id)
    if (resolve) { pending.delete(id); resolve(result) }
  })
  ipcMain.on('requests:status', (_event, snapshot) => { status = snapshot || status })
  ipcMain.on('remote:status', (_event, snapshot) => { remoteStatus = snapshot || remoteStatus })
  // A remote command's answer comes back on the same reply channel as requests.
  ipcMain.on('remote:reply', (_event, { id, result }) => {
    const resolve = pending.get(id)
    if (resolve) { pending.delete(id); resolve(result) }
  })
  // the library changed on disk - rebuild the page's song list next time it asks
  ipcMain.on('requests:library-changed', () => { library = null; libraryVersion += 1 })

  // Only once requests have been used before: start listening again at launch.
  if (config.serverOn) startServer()

  return {
    invalidateLibrary: () => { library = null; libraryVersion += 1 },
    setLibraryManager: (manager) => { libraryManager = manager },
    tickSuggestions,
    // tests only
    checkBar,
    close: () => new Promise((resolve) => {
      clearInterval(barTimer)
      clearInterval(suggestTimer)
      barTimer = null
      return server ? server.close(() => { server = null; resolve() }) : resolve()
    }),
  }
}

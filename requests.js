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
const PAGE_DIR = path.join(__dirname, 'request')
const PAGE_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}

module.exports = function setupRequests({ ipcMain, getControlWindow, userData, thumbnailsDir, readJson, writeJson, listLibrary }) {
  const REQUESTS_PATH = path.join(userData, 'requests.json')
  const load = () => ({ enabled: false, serverOn: false, devices: [], ...readJson(REQUESTS_PATH, {}) })
  let config = load()
  const save = () => writeJson(REQUESTS_PATH, config)

  let server = null
  let serverError = ''
  let pairing = null // { code, expiresAt }
  let badPairAttempts = []
  let status = { nowPlaying: null, upNext: [], waiting: 0 }
  let library = null
  let libraryBuiltAt = 0
  const pending = new Map() // request id -> resolve

  function addresses() {
    const out = []
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`)
    }
    return out
  }

  function publicState() {
    if (pairing && Date.now() > pairing.expiresAt) pairing = null
    return {
      enabled: config.enabled,
      serverRunning: Boolean(server),
      serverError,
      port: PORT,
      addresses: addresses(),
      devices: config.devices.map(({ id, name, pairedAt, lastSeen }) => ({ id, name, pairedAt, lastSeen })),
      pairing,
      maxWaiting: MAX_WAITING,
    }
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

  function readBody(req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk; if (data.length > 4096) req.destroy() })
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
      fs.readFile(path.join(PAGE_DIR, file), (err, data) => (err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, data, type)))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const now = Date.now()
      badPairAttempts = badPairAttempts.filter((t) => now - t < 60000)
      if (badPairAttempts.length >= 10) return send(res, 429, { ok: false, error: 'Too many tries - wait a minute and try again.' })
      const { code } = await readBody(req)
      if (!pairing || now > pairing.expiresAt || String(code || '') !== pairing.code) {
        badPairAttempts.push(now)
        return send(res, 403, { ok: false, error: 'That code isn\'t right, or has expired. Get a new one from the Jukebox.' })
      }
      const device = {
        id: crypto.randomUUID(),
        token: crypto.randomBytes(24).toString('hex'),
        name: `Touch screen ${config.devices.length + 1}`,
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

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, {
        ok: true,
        enabled: config.enabled,
        full: config.enabled && status.waiting >= MAX_WAITING,
        waiting: status.waiting,
        maxWaiting: MAX_WAITING,
        nowPlaying: status.nowPlaying,
        upNext: status.upNext,
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

    if (req.method === 'POST' && url.pathname === '/api/request') {
      if (!config.enabled) return send(res, 200, { ok: false, reason: 'closed' })
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
        ? `Port ${PORT} is already in use on this PC, so the song picker can't start.`
        : `The song picker couldn't start: ${err.message}`
      server = null
      notifyControl()
    })
    s.listen(PORT, '0.0.0.0', () => { server = s; notifyControl() })
  }

  // ---- IPC with Control ----------------------------------------------------
  ipcMain.handle('requests:get-state', () => publicState())
  ipcMain.handle('requests:set-enabled', (_event, enabled) => {
    config.enabled = Boolean(enabled)
    if (config.enabled) { config.serverOn = true; startServer() }
    save()
    return publicState()
  })
  ipcMain.handle('requests:start-pairing', () => {
    config.serverOn = true
    save()
    startServer()
    pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), expiresAt: Date.now() + PAIRING_MINUTES * 60000 }
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
  // the library changed on disk - rebuild the page's song list next time it asks
  ipcMain.on('requests:library-changed', () => { library = null })

  // Only once requests have been used before: start listening again at launch.
  if (config.serverOn) startServer()

  return { invalidateLibrary: () => { library = null } }
}

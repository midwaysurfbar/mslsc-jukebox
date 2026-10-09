// Song picker for a touch screen, served by the Jukebox (see requests.js).
// It can only do three things: set this screen up once with a code, show
// what's playing, and add a song to the end of the queue. Everything else
// stays in the Jukebox's own Control window.

const $ = (id) => document.getElementById(id)
const TOKEN_KEY = 'mslsc-jukebox-request-token'
const IDLE_MS = 60 * 1000
const PAGE = 48

let token = ''
try { token = localStorage.getItem(TOKEN_KEY) || '' } catch { /* private mode - set up every time */ }
let tracks = []
let status = null
let query = ''
let decade = ''
let letter = ''
let shown = 0
let filtered = []

// ---- server calls ---------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Device-Token': token, ...(options.headers || {}) } })
  if (res.status === 401) { forgetScreen(); throw new Error('not-paired') }
  return res.json()
}
function forgetScreen() {
  token = ''
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
  showPair()
}

// ---- set up ---------------------------------------------------------------
let code = ''
function showPair() {
  $('main').hidden = true; $('closed').hidden = true; $('idle').hidden = true; $('offline').hidden = true
  $('pair').hidden = false
  code = ''
  renderCode()
}
function renderCode() { $('pair-code').textContent = code.padEnd(6, '·') }
function buildKeypad() {
  const pad = $('pair-keypad')
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', '⌫']) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = k
    b.addEventListener('click', () => {
      if (k === 'Clear') code = ''
      else if (k === '⌫') code = code.slice(0, -1)
      else if (code.length < 6) code += k
      renderCode()
      if (code.length === 6) pairWith(code)
    })
    pad.append(b)
  }
}
async function pairWith(value) {
  $('pair-msg').textContent = 'Checking…'
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value }) })
    const data = await res.json()
    if (!data.ok) { $('pair-msg').textContent = data.error || 'That didn\'t work.'; code = ''; renderCode(); return }
    token = data.token
    try { localStorage.setItem(TOKEN_KEY, token) } catch { /* ignore */ }
    $('pair-msg').textContent = ''
    start()
  } catch {
    $('pair-msg').textContent = 'Can\'t reach the Jukebox - check this screen is on the club network.'
  }
}

// ---- library --------------------------------------------------------------
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
async function loadLibrary() {
  const data = await api('/api/library')
  if (!data.ok) return
  tracks = data.tracks.map((t) => ({ ...t, n: norm(`${t.t} ${t.a}`), first: norm(t.t).replace(/^the /, '').charAt(0) }))
  const decades = [...new Set(tracks.map((t) => t.d).filter(Boolean))].sort()
  const box = $('decades'); box.innerHTML = ''
  for (const d of ['', ...decades]) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = d || 'All songs'; b.dataset.decade = d
    b.addEventListener('click', () => { decade = d; letter = ''; applyFilters() })
    box.append(b)
  }
  const letters = $('letters'); letters.innerHTML = ''
  for (const l of ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = l; b.dataset.letter = l
    b.addEventListener('click', () => { letter = letter === l ? '' : l; applyFilters() })
    letters.append(b)
  }
  applyFilters()
}
function applyFilters() {
  const q = norm(query).trim()
  filtered = tracks.filter((t) =>
    (!decade || t.d === decade) &&
    (!letter || (letter === '#' ? !/[a-z]/.test(t.first) : t.first === letter.toLowerCase())) &&
    (!q || q.split(/\s+/).every((w) => t.n.includes(w))))
  document.querySelectorAll('#decades button').forEach((b) => b.classList.toggle('on', b.dataset.decade === decade))
  document.querySelectorAll('#letters button').forEach((b) => b.classList.toggle('on', b.dataset.letter === letter))
  $('grid').innerHTML = ''
  shown = 0
  showMore()
  $('empty').hidden = filtered.length > 0
  window.scrollTo(0, 0)
}
function showMore() {
  const grid = $('grid')
  const full = Boolean(status && status.full)
  for (const t of filtered.slice(shown, shown + PAGE)) {
    const card = document.createElement('article'); card.className = 'song'
    const thumb = document.createElement('div'); thumb.className = 'thumb'
    if (t.th) thumb.style.backgroundImage = `url("/api/thumb?k=${t.k}&t=${encodeURIComponent(token)}")`
    else thumb.textContent = '♪'
    const info = document.createElement('div'); info.className = 'info'
    const title = document.createElement('div'); title.className = 'title'; title.textContent = t.t
    const artist = document.createElement('div'); artist.className = 'artist'; artist.textContent = [t.a, t.d].filter(Boolean).join(' · ')
    info.append(title, artist)
    const add = document.createElement('button'); add.type = 'button'; add.className = 'add'; add.textContent = 'Add to queue'
    add.disabled = full
    add.addEventListener('click', () => requestSong(t, add))
    card.append(thumb, info, add)
    grid.append(card)
  }
  shown = Math.min(filtered.length, shown + PAGE)
}
// load the next batch as the list scrolls near its end
new IntersectionObserver((entries) => { if (entries[0].isIntersecting && shown < filtered.length) showMore() }, { rootMargin: '600px' }).observe($('more'))

// ---- requesting -----------------------------------------------------------
let busy = false
async function requestSong(track, button) {
  if (busy) return
  busy = true
  button.disabled = true
  try {
    const r = await api('/api/request', { method: 'POST', body: JSON.stringify({ key: track.k }) })
    if (r.ok) toast(`Added! <small>“${esc(track.t)}” is number ${r.position} in the queue.</small>`, 'ok')
    else if (r.reason === 'full') toast('The queue is full right now.<small>Please wait a few minutes, then try again.</small>', 'warn')
    else if (r.reason === 'closed') toast('Requests are closed right now.', 'warn')
    else if (r.reason === 'bar-closed') toast('The bar is closed right now.<small>Song requests open when the bar does.</small>', 'warn')
    else if (r.reason === 'queued') toast('That song is already in the queue!<small>It\'s on its way.</small>', 'warn')
    else if (r.reason === 'recent') toast(`That one played a moment ago.<small>Try it again in about ${r.minutes} minute${r.minutes === 1 ? '' : 's'}.</small>`, 'warn')
    else toast('That song can\'t be played right now.<small>Please pick another.</small>', 'warn')
    refreshStatus()
  } catch (err) {
    if (err.message !== 'not-paired') toast('Couldn\'t reach the Jukebox.<small>Please try again.</small>', 'warn')
  } finally {
    busy = false
    setTimeout(() => { button.disabled = Boolean(status && status.full) }, 1500)
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
let toastTimer
function toast(html, kind) {
  const el = $('toast')
  el.innerHTML = html; el.className = `toast ${kind}`; el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 4000)
}
$('toast').addEventListener('click', () => { $('toast').hidden = true })

// ---- status ---------------------------------------------------------------
// "Today · 17:00", "Tomorrow · 17:00" or "Saturday 11 October · 17:00"
function whenText({ date, time }) {
  const d = new Date(`${date}T00:00:00`)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((d - today) / 86400000)
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow'
    : d.toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' })
  return time ? `${day} · ${time}` : day
}
function nowText(n) { return n ? `Now playing: ${n.title}${n.artist ? ` – ${n.artist}` : ''}` : '' }
async function refreshStatus() {
  try {
    const s = await api('/api/status')
    $('offline').hidden = true
    if (!s.ok) return
    const wasFull = status && status.full
    status = s
    $('now-title').textContent = s.nowPlaying ? s.nowPlaying.title : 'Nothing playing right now'
    $('now-artist').textContent = s.nowPlaying ? s.nowPlaying.artist : 'Pick a song to get it started!'
    $('up-next').innerHTML = s.upNext.length ? `<b>Up next</b>${s.upNext.map((u) => `<span>${esc(u.title)}${u.artist ? ` – ${esc(u.artist)}` : ''}</span>`).join('')}` : ''
    const pill = $('state-pill')
    pill.textContent = s.full ? 'Queue full – please wait' : 'Requests open'
    pill.classList.toggle('full', s.full)
    $('full-banner').hidden = !s.full
    // Bar closed (requests follow the bar's open/closed state) or switched
    // off by staff - either way the picker shows the closed screen.
    const barClosed = s.enabled && s.barAllows === false
    $('closed').hidden = s.enabled && !barClosed
    $('closed-title').textContent = barClosed ? 'Bar closed' : 'Requests are closed'
    $('closed-text').textContent = barClosed ? 'Song requests open when the bar does.' : 'Enjoy the music!'
    $('closed-next').hidden = !(barClosed && s.nextOpening)
    if (barClosed && s.nextOpening) {
      $('closed-next-title').textContent = s.nextOpening.title
      $('closed-next-when').textContent = whenText(s.nextOpening)
    }
    $('closed-now').textContent = nowText(s.nowPlaying)
    $('idle-now').textContent = nowText(s.nowPlaying)
    if (Boolean(wasFull) !== Boolean(s.full)) document.querySelectorAll('.song .add').forEach((b) => { b.disabled = s.full })
  } catch (err) {
    if (err.message !== 'not-paired') $('offline').hidden = false
  }
}

// ---- on-screen keyboard ---------------------------------------------------
const ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']
function buildKeyboard() {
  const keys = $('kb-keys')
  for (const row of ROWS) {
    const r = document.createElement('div'); r.className = 'kb-row'
    for (const ch of row) r.append(key(ch, () => typeChar(ch.toLowerCase())))
    if (row.startsWith('Z')) r.append(key('⌫', () => { query = query.slice(0, -1); searchChanged() }, 'mid'))
    keys.append(r)
  }
  const last = document.createElement('div'); last.className = 'kb-row'
  last.append(key('Clear', () => { query = ''; searchChanged() }, 'mid'), key('Space', () => typeChar(' '), 'wide'), key('&', () => typeChar('&')), key("'", () => typeChar("'")))
  keys.append(last)
}
function key(label, onTap, cls) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label
  if (cls) b.className = cls
  b.addEventListener('click', onTap)
  return b
}
function typeChar(ch) { if (query.length < 40) { query += ch; searchChanged() } }
let searchTimer
function searchChanged() {
  $('kb-preview').textContent = query || 'Type a song or artist…'
  $('search-text').textContent = query || 'Search songs or artists'
  $('search-btn').classList.toggle('has-text', Boolean(query))
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    letter = ''
    applyFilters()
    // keep the matches in view above the keyboard while typing
    if (!$('keyboard').hidden) {
      const below = document.querySelector('.top').getBoundingClientRect().bottom + 8
      window.scrollBy(0, $('grid').getBoundingClientRect().top - below)
    }
  }, 250)
}
function setKeyboard(open) {
  $('keyboard').hidden = !open
  document.body.classList.toggle('kb-open', open)
}
$('search-btn').addEventListener('click', () => { setKeyboard(true); searchChanged() })
$('kb-done').addEventListener('click', () => setKeyboard(false))

// ---- idle: back to "Pick a song" after a minute untouched -----------------
let idleTimer
function resetToStart() {
  query = ''; decade = ''; letter = ''
  setKeyboard(false); $('toast').hidden = true
  searchChanged()
  applyFilters()
}
function touched() {
  $('idle').hidden = true
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { resetToStart(); $('idle').hidden = false }, IDLE_MS)
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, touched, { passive: true })
$('idle').addEventListener('pointerdown', (e) => { e.stopPropagation(); touched() })
// no right-click / long-press menus on a public screen
document.addEventListener('contextmenu', (e) => e.preventDefault())

// ---- start ----------------------------------------------------------------
let started = false
async function start() {
  $('pair').hidden = true
  $('main').hidden = false
  try {
    await refreshStatus()
    await loadLibrary()
  } catch { /* shown by refreshStatus / pairing */ }
  if (!started) {
    started = true
    setInterval(refreshStatus, 5000)
    // new songs appear by themselves - but only while nobody's mid-browse
    setInterval(() => { if (!$('idle').hidden) loadLibrary().catch(() => {}) }, 10 * 60 * 1000)
  }
  touched()
}

buildKeypad()
buildKeyboard()
if (token) start()
else showPair()

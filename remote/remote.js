// Jukebox Remote (Sam, 2026-10-09) - full staff control of the Jukebox from
// another screen. Served by the Jukebox itself (../requests.js); every
// command is carried out by the Jukebox's Control window, which still owns
// the queue. This page only shows what the Jukebox reports and asks it to do
// things. Everything shown is set as text, never as HTML.

const TOKEN_KEY = 'mslsc-jukebox-remote-token'
let token = ''
try { token = localStorage.getItem(TOKEN_KEY) || '' } catch { /* private mode - set up every time */ }

const $ = (id) => document.getElementById(id)
let state = null        // last /api/remote/state
let library = []        // [{k,t,a,d,th}]
let libraryAt = 0
let failures = 0
let busy = false

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('data-')) node.setAttribute(k, v)
    else node[k] = v
  }
  for (const c of children) if (c) node.append(c)
  return node
}
function fmtTime(s) {
  if (!s || !isFinite(s)) return '0:00'
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
function thumb(row, cls) {
  const box = el('span', { class: cls })
  if (row && row.th) box.style.backgroundImage = `url("/api/thumb?k=${encodeURIComponent(row.k)}&t=${encodeURIComponent(token)}")`
  return box
}

let toastTimer = null
function toast(message, bad = false) {
  const t = $('toast')
  t.textContent = message
  t.classList.toggle('bad', bad)
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, bad ? 5000 : 2200)
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Device-Token': token, ...(options.headers || {}) } })
  if (res.status === 401) { forget(); throw new Error('not-paired') }
  return res.json()
}
function forget() {
  token = ''
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
  showPair()
}

async function command(action, args = {}, okMessage = '') {
  try {
    const r = await api('/api/remote/command', { method: 'POST', body: JSON.stringify({ action, args }) })
    if (!r.ok) toast(r.error || 'That didn\'t work.', true)
    else if (okMessage) toast(okMessage)
    poll()
    return r
  } catch (err) {
    if (err.message !== 'not-paired') toast('Can\'t reach the Jukebox.', true)
    return { ok: false }
  }
}

// ---------------------------------------------------------------- set up
function showPair() {
  $('main').hidden = true
  $('offline').hidden = true
  $('pair').hidden = false
  $('pair-code').focus()
}
$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const code = $('pair-code').value.replace(/\D/g, '')
  if (code.length !== 6) { $('pair-msg').textContent = 'The code is 6 numbers.'; return }
  $('pair-msg').textContent = 'Checking…'
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, kind: 'remote' }) })
    const data = await res.json()
    if (!data.ok) { $('pair-msg').textContent = data.error || 'That didn\'t work.'; return }
    token = data.token
    try { localStorage.setItem(TOKEN_KEY, token) } catch { /* ignore */ }
    $('pair-code').value = ''
    $('pair-msg').textContent = ''
    start()
  } catch {
    $('pair-msg').textContent = 'Can\'t reach the Jukebox - is it running?'
  }
})

// ---------------------------------------------------------------- tabs
let tab = 'queue'
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b))
  for (const name of ['queue', 'search', 'playlists', 'screens']) $(`tab-${name}`).hidden = name !== tab
  if (tab === 'search') { loadLibrary(); renderSearch(); $('search').focus() }
  if (tab === 'playlists') renderPlaylists()
}))

// ---------------------------------------------------------------- now playing
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => command(b.dataset.cmd)))
$('bar').addEventListener('click', (e) => {
  const p = state && state.player
  if (!p || !p.duration) return
  const r = $('bar').getBoundingClientRect()
  command('seek', { fraction: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) })
})
let volumeTimer = null
let volumeHeldUntil = 0
$('volume').addEventListener('input', () => {
  $('volume-value').textContent = `${$('volume').value}%`
  volumeHeldUntil = Date.now() + 1500 // don't let a poll yank the slider back mid-drag
  clearTimeout(volumeTimer)
  volumeTimer = setTimeout(() => command('volume', { volume: Number($('volume').value) / 100 }), 150)
})

function renderNow() {
  const p = state.player
  const now = p && p.nowPlaying
  $('now-label').textContent = !p ? 'Waiting for the Jukebox…' : p.status === 'paused' ? 'Paused' : now ? 'Now playing' : 'Nothing playing'
  $('now-title').textContent = now ? now.t : 'Nothing playing'
  $('now-artist').textContent = now ? now.a : (p && p.upcomingTotal ? 'Press play to start the queue' : 'Add some songs to get started')
  const art = $('now-art')
  art.style.backgroundImage = now && now.th ? `url("/api/thumb?k=${encodeURIComponent(now.k)}&t=${encodeURIComponent(token)}")` : ''
  $('toggle').textContent = p && p.status === 'playing' ? '⏸' : '▶'
  const dur = (p && p.duration) || 0
  const pos = (p && p.elapsed) || 0
  $('time-elapsed').textContent = fmtTime(pos)
  $('time-total').textContent = fmtTime(dur)
  $('bar-fill').style.width = `${dur ? Math.min(100, (pos / dur) * 100) : 0}%`
  if (p && Date.now() > volumeHeldUntil) {
    const v = Math.round((p.volume ?? 1) * 100)
    $('volume').value = v
    $('volume-value').textContent = `${v}%`
  }
}

// ---------------------------------------------------------------- queue
let lastQueueSig = ''
function renderQueue() {
  const p = state.player
  const rows = (p && p.upcoming) || []
  const total = (p && p.upcomingTotal) || 0
  $('queue-count').textContent = total ? String(total) : ''
  const sig = JSON.stringify(rows)
  if (sig === lastQueueSig) return
  lastQueueSig = sig
  const list = $('queue-list')
  list.replaceChildren()
  if (!rows.length) list.append(el('li', { class: 'empty', text: 'Nothing waiting. Add songs or a playlist.' }))
  rows.forEach((r, n) => {
    list.append(el('li', { class: 'row' },
      el('span', { class: 'pos', text: String(n + 1) }),
      thumb(r, 'thumb'),
      el('span', { class: 'what' }, el('b', { text: r.t }), el('span', { text: r.a })),
      r.req ? el('span', { class: 'tag', text: 'Request' }) : null,
      el('span', { class: 'dur', text: fmtTime(r.dur) }),
      el('span', { class: 'acts' },
        el('button', { class: 'icon', text: '↑', title: 'Move up', disabled: !r.up, 'data-q': 'up', 'data-i': r.i, 'data-k': r.k }),
        el('button', { class: 'icon', text: '↓', title: 'Move down', disabled: !r.down, 'data-q': 'down', 'data-i': r.i, 'data-k': r.k }),
        el('button', { class: 'icon', text: '▶', title: 'Play this now', 'data-q': 'play', 'data-i': r.i, 'data-k': r.k }),
        el('button', { class: 'icon danger', text: '✕', title: 'Remove', 'data-q': 'remove', 'data-i': r.i, 'data-k': r.k }))))
  })
  $('queue-more').textContent = total > rows.length ? `…and ${total - rows.length} more after these.` : ''
}
$('queue-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-q]')
  if (!b || b.disabled) return
  const args = { index: Number(b.dataset.i), key: b.dataset.k }
  if (b.dataset.q === 'up') command('move', { ...args, direction: -1 })
  if (b.dataset.q === 'down') command('move', { ...args, direction: 1 })
  if (b.dataset.q === 'play') command('play-from', args)
  if (b.dataset.q === 'remove') command('remove', args)
})
$('clear-btn').addEventListener('click', () => {
  const n = (state && state.player && state.player.upcomingTotal) || 0
  if (!n) return
  if (confirm(`Remove all ${n} song${n === 1 ? '' : 's'} waiting? The song playing now keeps going.`)) command('clear', {}, 'Up next cleared.')
})

// ---------------------------------------------------------------- add songs
async function loadLibrary(force = false) {
  if (!force && library.length && Date.now() - libraryAt < 5 * 60000) return
  try {
    const data = await api('/api/library')
    if (data.ok) { library = data.tracks; libraryAt = Date.now(); if (tab === 'search') renderSearch() }
  } catch { /* shown by the poll */ }
}
function renderSearch() {
  const q = $('search').value.trim().toLowerCase()
  const list = $('search-list')
  list.replaceChildren()
  if (!library.length) { $('search-note').textContent = 'Loading songs…'; return }
  const words = q.split(/\s+/).filter(Boolean)
  const hits = words.length ? library.filter((s) => { const hay = `${s.t} ${s.a} ${s.d}`.toLowerCase(); return words.every((w) => hay.includes(w)) }) : []
  hits.slice(0, 60).forEach((s) => list.append(el('li', { class: 'row' },
    thumb(s, 'thumb'),
    el('span', { class: 'what' }, el('b', { text: s.t }), el('span', { text: [s.a, s.d].filter(Boolean).join(' · ') })),
    el('span', { class: 'acts' },
      el('button', { class: 'secondary', text: 'Play next', 'data-s': 'next', 'data-k': s.k }),
      el('button', { class: 'primary', text: 'Add', 'data-s': 'add', 'data-k': s.k })))))
  $('search-note').textContent = !words.length ? `Type to search ${library.length} songs.` : hits.length > 60 ? `Showing 60 of ${hits.length} - type more to narrow it down.` : hits.length ? '' : 'No songs match that.'
}
$('search').addEventListener('input', renderSearch)
$('search-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-s]')
  if (!b) return
  const song = library.find((s) => s.k === b.dataset.k)
  const name = song ? song.t : 'Song'
  if (b.dataset.s === 'next') command('next', { key: b.dataset.k }, `${name} plays next.`)
  else command('add', { key: b.dataset.k }, `${name} added.`)
})

// ---------------------------------------------------------------- playlists
let lastPlSig = ''
function renderPlaylists(force = false) {
  const all = (state && state.player && state.player.playlists) || []
  const q = $('pl-search').value.trim().toLowerCase()
  const shown = all.filter((p) => p.n && (!q || p.name.toLowerCase().includes(q)))
  const sig = JSON.stringify([q, shown])
  if (!force && sig === lastPlSig) return
  lastPlSig = sig
  const list = $('pl-list')
  list.replaceChildren()
  if (!shown.length) list.append(el('li', { class: 'empty', text: all.length ? 'No playlists match that.' : 'No playlists yet.' }))
  shown.forEach((p) => list.append(el('li', { class: 'row' },
    el('span', { class: 'what' }, el('b', { text: p.name }), el('span', { text: `${p.n} song${p.n === 1 ? '' : 's'}` })),
    el('span', { class: 'acts' },
      el('button', { class: 'secondary', text: 'Play now', 'data-p': 'play', 'data-id': p.id, 'data-n': p.name }),
      el('button', { class: 'primary', text: 'Add to queue', 'data-p': 'queue', 'data-id': p.id, 'data-n': p.name })))))
}
$('pl-search').addEventListener('input', () => renderPlaylists())
$('pl-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]')
  if (!b) return
  if (b.dataset.p === 'play') {
    if (confirm(`Play "${b.dataset.n}" now? It replaces everything in the queue.`)) command('playlist-play', { id: b.dataset.id }, `Playing ${b.dataset.n}.`)
  } else command('playlist-queue', { id: b.dataset.id }, `${b.dataset.n} added to the queue.`)
})

// ---------------------------------------------------------------- requests & screens
$('tv-hidden-toggle').addEventListener('change', () => command('tv-start-hidden', { hidden: $('tv-hidden-toggle').checked }, $('tv-hidden-toggle').checked ? 'The TV will start hidden.' : 'The TV will show at start-up.'))
$('tv-btn').addEventListener('click', () => {
  const showing = state && state.tv && state.tv.visible
  command(showing ? 'tv-hide' : 'tv-show', {}, showing ? 'TV hidden.' : 'Showing on the TV.')
})
$('bar-toggle').addEventListener('change', () => command('requests-follow-bar', { follow: $('bar-toggle').checked }, $('bar-toggle').checked ? 'Requests now follow the bar.' : 'Requests no longer follow the bar.'))
$('req-toggle').addEventListener('change', () => command('requests-enabled', { enabled: $('req-toggle').checked }, $('req-toggle').checked ? 'Song requests are on.' : 'Song requests are off.'))
document.querySelectorAll('[data-pair]').forEach((b) => b.addEventListener('click', () => command('pair', { kind: b.dataset.pair })))
$('code-done').addEventListener('click', () => command('cancel-pair'))
function timeAgo(ms) {
  if (!ms) return 'not used yet'
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 2) return 'in use now'
  if (mins < 60) return `last used ${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `last used ${hours} h ago` : `last used ${new Date(ms).toLocaleDateString()}`
}
let lastDevSig = ''
function renderTv() {
  const tv = state.tv
  $('tv-btn').hidden = !tv
  $('tv-state').textContent = !tv ? '' : tv.visible ? 'TV: showing' : 'TV: hidden'
  $('tv-btn').textContent = tv && tv.visible ? 'Hide TV' : 'Show on TV'
  if (state.player) $('tv-hidden-toggle').checked = Boolean(state.player.tvStartHidden)
}

function renderScreens() {
  const r = state.requests
  $('req-toggle').checked = r.enabled
  $('bar-toggle').checked = r.followBar
  const next = r.nextOpening ? ` Next opening: ${r.nextOpening.title}, ${r.nextOpening.date} ${r.nextOpening.time}.` : ''
  $('req-summary').textContent = !r.enabled ? 'Off - the song picker is closed. Songs added here aren\'t limited.'
    : !r.barAllows ? `On, but the bar is closed - the picker shows "Bar closed" until it opens.${next}`
    : `On - ${Math.min(r.waiting, r.maxWaiting)} of ${r.maxWaiting} places used`
  const box = $('code-box')
  box.hidden = !r.pairing
  if (r.pairing) {
    const remote = r.pairing.kind === 'remote'
    $('code-intro').textContent = remote ? 'On the new remote (another PC, phone or tablet), open this address:' : 'On the touch screen, open this address:'
    $('code-address').textContent = r.address ? (remote ? `${r.address}/remote` : r.address) : ''
    $('code').textContent = r.pairing.code
    const mins = Math.max(0, Math.ceil((r.pairing.expiresAt - Date.now()) / 60000))
    $('code-expiry').textContent = `This code works for ${mins} more minute${mins === 1 ? '' : 's'}.`
  }
  const sig = JSON.stringify([r.devices, Math.floor(Date.now() / 60000)])
  if (sig !== lastDevSig) {
    lastDevSig = sig
    const list = $('device-list')
    list.replaceChildren()
    if (!r.devices.length) list.append(el('li', { class: 'empty', text: 'No screens set up yet.' }))
    r.devices.forEach((d) => list.append(el('li', { class: 'row' },
      el('span', { class: 'what' }, el('b', { text: d.id === state.you ? `${d.name} (this one)` : d.name }), el('span', { text: `${d.kind === 'remote' ? 'Staff remote' : 'Song picker'} · ${timeAgo(d.lastSeen)}` })),
      d.id === state.you ? null : el('span', { class: 'acts' }, el('button', { class: 'danger', text: 'Remove', 'data-d': d.id, 'data-n': d.name })))))
  }
  $('version').textContent = state.version ? `Jukebox ${state.version}` : ''
}
$('device-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-d]')
  if (b && confirm(`Remove ${b.dataset.n}? It will need setting up again before it can be used.`)) command('remove-device', { id: b.dataset.d }, `${b.dataset.n} removed.`)
})

// ---------------------------------------------------------------- polling
async function poll() {
  if (!token || busy) return
  busy = true
  try {
    const data = await api('/api/remote/state')
    if (!data.ok) throw new Error(data.error || 'bad')
    failures = 0
    state = data
    $('offline').hidden = true
    $('conn').textContent = data.player ? 'Connected' : 'Jukebox starting…'
    $('conn').className = data.player ? 'pill ok' : 'pill'
    renderNow()
    renderQueue()
    if (tab === 'playlists') renderPlaylists()
    renderScreens()
    renderTv()
  } catch (err) {
    if (err.message !== 'not-paired' && ++failures >= 3) {
      $('offline').hidden = false
      $('conn').textContent = 'Offline'
      $('conn').className = 'pill bad'
    }
  } finally {
    busy = false
  }
}

let pollTimer = null
function start() {
  $('pair').hidden = true
  $('main').hidden = false
  lastQueueSig = lastPlSig = lastDevSig = ''
  poll()
  loadLibrary()
  clearInterval(pollTimer)
  pollTimer = setInterval(poll, 1000)
}

if (token) start()
else showPair()

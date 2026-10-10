// Jukebox Library (Sam, 2026-10-11) - tidy the music library from a laptop.
// Served by the Jukebox (../requests.js); every change is made by the
// Jukebox itself (../lib/library-manager.js), so the song picker, Remote and
// Control follow straight away. Only works for a paired laptop on Tailscale.
// Everything from the library is put on the page as text, never as HTML.

const TOKEN_KEY = 'mslsc-jukebox-library-token'
let token = ''
try { token = localStorage.getItem(TOKEN_KEY) || '' } catch { /* private window - set up each time */ }

const $ = (id) => document.getElementById(id)
const PAGE = 150
let songs = []          // from /api/lib/songs
let byKey = new Map()
let folderInfo = { decades: [], folders: [] }
let playlists = []
let tab = 'songs'
let selected = new Set()
let filtered = []
let shown = 0
let editing = null      // the song open in the drawer
let libraryVersion = 0

// ---------------------------------------------------------------- helpers
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'for') node.setAttribute(k, v)
    else node[k] = v
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c)
  return node
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
function fmtTime(s) {
  if (!s) return '–'
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
function fmtSize(b) {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`
}
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const folderLabel = (f) => f || 'Main folder'
const thumbUrl = (k) => `/api/thumb?k=${encodeURIComponent(k)}&t=${encodeURIComponent(token)}`
const videoUrl = (k) => `/api/lib/video?k=${encodeURIComponent(k)}&t=${encodeURIComponent(token)}`
function thumbBox(row, cls = 'thumb') {
  const box = el('span', { class: cls })
  if (row.th) box.style.backgroundImage = `url("${thumbUrl(row.k)}")`
  else box.textContent = '♪'
  return box
}
function when(ms) {
  const d = new Date(ms)
  const today = new Date()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today ${time}`
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

let toastTimer = null
let toastUndoId = null
function toast(message, { bad = false, undoId = null } = {}) {
  $('toast-text').textContent = message
  $('toast').classList.toggle('bad', bad)
  toastUndoId = undoId
  $('toast-undo').hidden = !undoId
  $('toast').hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { $('toast').hidden = true }, undoId ? 9000 : bad ? 6000 : 3000)
}
$('toast-undo').addEventListener('click', async () => {
  if (!toastUndoId) return
  const id = toastUndoId
  $('toast').hidden = true
  await act('/api/lib/undo', { id })
})

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Device-Token': token, ...(options.headers || {}) } })
  if (res.status === 401) { forget(); throw new Error('not-paired') }
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error === 'not-a-laptop' ? 'This browser is set up as something else.' : data.error || 'Not allowed.')
  }
  return res.json()
}
// A change: show the answer, offer Undo, and refresh what it touched.
async function act(path, body, { quiet = false } = {}) {
  try {
    const r = await api(path, { method: 'POST', body: JSON.stringify(body) })
    if (!r.ok) { toast(r.error || 'That didn\'t work.', { bad: true }); return null }
    if (!quiet) toast(r.message || 'Done.', { undoId: r.historyId || null })
    await refreshAfterChange()
    return r
  } catch (err) {
    if (err.message !== 'not-paired') toast(err.message === 'Failed to fetch' ? 'Can\'t reach the Jukebox.' : err.message, { bad: true })
    return null
  }
}
function forget() {
  token = ''
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
  showPair()
}

// ---------------------------------------------------------------- set up
function showPair() {
  $('app').hidden = true
  $('pair').hidden = false
  $('pair-name').focus()
}
$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const code = $('pair-code').value.replace(/\D/g, '')
  if (code.length !== 6) { $('pair-msg').textContent = 'The code is 6 numbers.'; return }
  $('pair-msg').textContent = 'Checking…'
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, kind: 'library', name: $('pair-name').value }) })
    const data = await res.json()
    if (!data.ok) { $('pair-msg').textContent = data.error || 'That didn\'t work.'; return }
    token = data.token
    try { localStorage.setItem(TOKEN_KEY, token) } catch { /* ignore */ }
    $('pair-msg').textContent = ''
    start()
  } catch {
    $('pair-msg').textContent = 'Can\'t reach the Jukebox - is Tailscale on?'
  }
})

// ---------------------------------------------------------------- tabs
function showTab(name) {
  tab = name
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name))
  for (const t of ['songs', 'dupes', 'playlists', 'sort', 'history']) $(`tab-${t}`).hidden = t !== name
  if (name === 'dupes') loadDupes()
  if (name === 'playlists') loadPlaylists()
  if (name === 'sort') loadSort()
  if (name === 'history') loadHistory()
  try { sessionStorage.setItem('lib-tab', name) } catch { /* ignore */ }
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)))

// ---------------------------------------------------------------- songs
async function loadSongs() {
  const data = await api('/api/lib/songs')
  if (!data.ok) { toast(data.error || 'Couldn\'t load the songs.', { bad: true }); return }
  songs = data.songs
  byKey = new Map(songs.map((s) => [s.k, s]))
  for (const s of songs) s.n = norm(`${s.t} ${s.a} ${s.f}`)
  folderInfo = { decades: data.decades, folders: data.folders }
  libraryVersion = data.libraryVersion
  for (const k of [...selected]) if (!byKey.has(k)) selected.delete(k)
  $('conn').textContent = data.you ? `Connected · ${data.you}` : 'Connected'
  $('conn').className = 'pill ok'
  renderStats()
  fillFolderSelects()
  fillArtistList()
  applySongFilters(false)
}
function renderStats() {
  const noArtist = songs.filter((s) => !s.a).length
  const box = $('top-stats')
  box.replaceChildren(
    el('span', {}, el('b', { text: songs.length.toLocaleString() }), 'songs'),
    el('span', {}, el('b', { text: noArtist.toLocaleString() }), 'with no singer or band'),
    el('span', {}, el('b', { text: songs.filter((s) => !s.d).length.toLocaleString() }), 'with no decade'),
  )
}
function folderOptions(select, { first, current, includeCurrent = false } = {}) {
  select.replaceChildren()
  if (first) select.append(el('option', { value: first[0], text: first[1] }))
  if (includeCurrent) select.append(el('option', { value: '__same', text: `Leave in ${folderLabel(current)}` }))
  select.append(el('option', { value: '', text: 'Main folder' }))
  const dec = el('optgroup', { label: 'Decades' })
  for (const d of folderInfo.decades) dec.append(el('option', { value: d, text: d }))
  select.append(dec)
  if (folderInfo.folders.length) {
    const other = el('optgroup', { label: 'Other folders' })
    for (const f of folderInfo.folders) other.append(el('option', { value: f, text: f }))
    select.append(other)
  }
}
function fillFolderSelects() {
  const ff = $('folder-filter')
  const was = ff.value
  ff.replaceChildren(el('option', { value: '*', text: 'Every folder' }), el('option', { value: '', text: 'Main folder (loose songs)' }))
  const counts = new Map()
  for (const s of songs) { const top = s.folder.split('/')[0]; counts.set(top, (counts.get(top) || 0) + 1) }
  for (const f of [...counts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b))) ff.append(el('option', { value: f, text: `${f} (${counts.get(f).toLocaleString()})` }))
  ff.value = ff.dataset.filled && [...ff.options].some((o) => o.value === was) ? was : '*'
  ff.dataset.filled = '1'
  const bm = $('bulk-move')
  folderOptions(bm, { first: ['__none', 'Move to…'] })
  bm.value = '__none'
}
function fillArtistList() {
  const names = [...new Set(songs.map((s) => s.a).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  $('artist-list').replaceChildren(...names.map((n) => el('option', { value: n })))
}
function playlistSelect(select, label) {
  select.replaceChildren(el('option', { value: '', text: label }))
  for (const p of playlists.filter((x) => x.kind === 'mine')) select.append(el('option', { value: p.id, text: p.name }))
  select.append(el('option', { value: '__new', text: '+ New playlist…' }))
}

let filterTimer = null
$('q').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => applySongFilters(true), 120) })
$('folder-filter').addEventListener('change', () => applySongFilters(true))
$('fix-filter').addEventListener('change', () => applySongFilters(true))

function applySongFilters(toTop) {
  const words = norm($('q').value).split(/\s+/).filter(Boolean)
  const folder = $('folder-filter').value
  const fix = $('fix-filter').value
  filtered = songs.filter((s) =>
    (folder === '*' || (folder === '' ? s.folder === '' : s.folder.split('/')[0] === folder)) &&
    (!fix || (fix === 'noartist' && !s.a) || (fix === 'guess' && s.a && !s.sure) || (fix === 'nodecade' && !s.d) || (fix === 'bad' && s.bad) || (fix === 'queued' && (s.queued || s.playing))) &&
    words.every((w) => s.n.includes(w)))
  $('result-line').textContent = filtered.length === songs.length ? `${plural(songs.length, 'song')}` : `${plural(filtered.length, 'song')} of ${songs.length.toLocaleString()}`
  const keep = toTop ? 0 : Math.max(PAGE, shown)
  $('song-rows').replaceChildren()
  shown = 0
  showMoreSongs(keep || PAGE)
  if (toTop) window.scrollTo({ top: 0 })
  renderBulk()
}
function songRow(s) {
  const check = el('input', { type: 'checkbox', checked: selected.has(s.k), 'aria-label': `Choose ${s.t}` })
  check.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(s.k, check.checked) })
  const tags = []
  if (s.playing) tags.push(el('span', { class: 'tag play', text: 'Playing' }))
  else if (s.queued) tags.push(el('span', { class: 'tag queue', text: 'In queue' }))
  if (s.bad) tags.push(el('span', { class: 'tag bad', text: 'Can\'t play' }))
  if (s.a && !s.sure) tags.push(el('span', { class: 'tag guess', text: 'Guess', title: 'The singer or band was guessed from the song name - check it' }))
  const row = el('div', { class: `song${selected.has(s.k) ? ' sel' : ''}`, role: 'row', 'data-k': s.k },
    el('span', {}, check),
    thumbBox(s),
    el('span', { class: 'name' },
      el('div', { class: 't' }, s.t, ...tags),
      el('div', { class: `a${s.a ? '' : ' missing'}`, text: s.a || 'No singer or band' }),
      el('div', { class: 'f', text: s.f })),
    el('span', { class: `decade${s.d ? '' : ' none'}`, text: s.d || '–' }),
    el('span', { class: 'folder', text: folderLabel(s.folder) }),
    el('span', { class: 'num', text: fmtTime(s.dur) }))
  row.addEventListener('click', () => openEditor(s.k))
  return row
}
function showMoreSongs(n = PAGE) {
  const box = $('song-rows')
  const frag = document.createDocumentFragment()
  for (const s of filtered.slice(shown, shown + n)) frag.append(songRow(s))
  box.append(frag)
  shown = Math.min(filtered.length, shown + n)
  $('song-more').textContent = shown < filtered.length ? `Showing ${shown.toLocaleString()} - scroll for more` : ''
  if (!filtered.length) box.append(el('p', { class: 'empty', text: 'No songs match.' }))
}
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && tab === 'songs' && shown < filtered.length) showMoreSongs()
}, { rootMargin: '600px' }).observe($('song-more'))

function toggleSelect(k, on) {
  if (on) selected.add(k)
  else selected.delete(k)
  const row = document.querySelector(`.song[data-k="${k}"]`)
  if (row) row.classList.toggle('sel', on)
  renderBulk()
}
$('check-all').addEventListener('change', () => {
  const on = $('check-all').checked
  for (const s of filtered) { if (on) selected.add(s.k); else selected.delete(s.k) }
  document.querySelectorAll('#song-rows .song').forEach((r) => {
    r.classList.toggle('sel', on)
    const c = r.querySelector('input[type=checkbox]')
    if (c) c.checked = on
  })
  renderBulk()
})
function renderBulk() {
  $('bulk').hidden = !selected.size
  $('bulk-count').textContent = `${plural(selected.size, 'song')} chosen`
  $('check-all').checked = filtered.length > 0 && filtered.every((s) => selected.has(s.k))
  playlistSelect($('bulk-playlist'), 'Add to playlist…')
}
$('bulk-clear').addEventListener('click', () => { selected.clear(); applySongFilters(false) })
$('bulk-move').addEventListener('change', async () => {
  const folder = $('bulk-move').value
  $('bulk-move').value = '__none'
  if (folder === '__none' || !selected.size) return
  if (!confirm(`Move ${plural(selected.size, 'song')} to ${folderLabel(folder)}? Their names stay the same.`)) return
  const r = await act('/api/lib/move', { keys: [...selected], folder })
  if (r) selected.clear()
})
$('bulk-playlist').addEventListener('change', async () => {
  const id = $('bulk-playlist').value
  $('bulk-playlist').value = ''
  if (!id || !selected.size) return
  if (await addToPlaylist(id, [...selected])) { selected.clear(); applySongFilters(false) }
})
$('bulk-delete').addEventListener('click', async () => {
  if (!selected.size) return
  if (!confirm(`Delete ${plural(selected.size, 'song')}?\n\nThey come out of the library, the song picker and every playlist. They can be put back from History for 30 days.`)) return
  const r = await act('/api/lib/delete', { keys: [...selected] })
  if (r) selected.clear()
})

async function addToPlaylist(id, keys) {
  if (!playlists.length) await loadPlaylistData()
  if (id === '__new') {
    const name = prompt('Name for the new playlist:')
    if (!name || !name.trim()) return false
    return Boolean(await act('/api/lib/playlist', { action: 'create', name, keys }))
  }
  const p = playlists.find((x) => x.id === id)
  if (!p) return false
  const add = keys.filter((k) => !p.keys.includes(k))
  if (!add.length) { toast(`Already in "${p.name}".`); return false }
  return Boolean(await act('/api/lib/playlist', { action: 'set-songs', id, keys: [...p.keys, ...add] }))
}

// ---------------------------------------------------------------- editor
function openEditor(k) {
  const s = byKey.get(k)
  if (!s) return
  editing = s
  $('ed-file').textContent = s.folder ? `${s.folder} / ${s.f}` : s.f
  $('ed-artist').value = s.a
  $('ed-title').value = s.t
  folderOptions($('ed-folder'), { current: s.folder, includeCurrent: true })
  $('ed-folder').value = '__same'
  playlistSelect($('ed-playlist'), 'Add to playlist…')
  const inPl = playlists.filter((p) => p.kind === 'mine' && p.keys.includes(k)).map((p) => p.name)
  $('ed-facts').replaceChildren(
    el('dt', { text: 'Length' }), el('dd', { text: fmtTime(s.dur) }),
    el('dt', { text: 'Size' }), el('dd', { text: fmtSize(s.size) }),
    el('dt', { text: 'Decade' }), el('dd', { text: s.d || 'Not known' }),
    el('dt', { text: 'Playlists' }), el('dd', { text: inPl.length ? inPl.join(', ') : 'None of yours' }),
    ...(s.playing ? [el('dt', { text: 'Now' }), el('dd', { text: 'Playing on the TV right now' })] : []),
  )
  $('ed-delete').disabled = s.playing
  $('ed-delete').title = s.playing ? 'It\'s playing right now' : ''
  const v = $('preview')
  v.src = videoUrl(k)
  updateSaveAs()
  $('drawer').hidden = false
  $('drawer-back').hidden = false
  $('ed-artist').focus()
}
function closeEditor() {
  $('drawer').hidden = true
  $('drawer-back').hidden = true
  const v = $('preview')
  v.pause()
  v.removeAttribute('src')
  v.load()
  editing = null
}
$('drawer-close').addEventListener('click', closeEditor)
$('drawer-back').addEventListener('click', closeEditor)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drawer').hidden) closeEditor() })
function updateSaveAs() {
  if (!editing) return
  const a = $('ed-artist').value.trim()
  const t = $('ed-title').value.trim()
  const ext = (editing.f.match(/\.[^.]+$/) || [''])[0]
  const folder = $('ed-folder').value === '__same' ? editing.folder : $('ed-folder').value
  $('ed-saveas').textContent = t ? `Saved as: ${folderLabel(folder)} / ${a ? `${a} - ${t}` : t}${ext}` : ''
}
for (const id of ['ed-artist', 'ed-title', 'ed-folder']) $(id).addEventListener('input', updateSaveAs)
$('ed-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  if (!editing) return
  const folder = $('ed-folder').value
  $('ed-save').disabled = true
  const r = await act('/api/lib/edit', { key: editing.k, artist: $('ed-artist').value, title: $('ed-title').value, folder: folder === '__same' ? undefined : folder })
  $('ed-save').disabled = false
  if (r) closeEditor()
})
$('ed-playlist').addEventListener('change', async () => {
  const id = $('ed-playlist').value
  $('ed-playlist').value = ''
  if (id && editing) await addToPlaylist(id, [editing.k])
})
$('ed-delete').addEventListener('click', async () => {
  if (!editing) return
  if (!confirm(`Delete "${editing.t}"?\n\nIt comes out of the library, the song picker and every playlist. It can be put back from History for 30 days.`)) return
  const r = await act('/api/lib/delete', { keys: [editing.k] })
  if (r) closeEditor()
})

// ---------------------------------------------------------------- duplicates
let dupes = null
let dupeHow = ''
let dupeShown = 0
let dupeTimer = null
const keepChoice = new Map() // group id -> key chosen to keep
async function loadDupes({ poll = false } = {}) {
  clearTimeout(dupeTimer)
  try {
    const data = await api('/api/lib/duplicates')
    if (!data.ok) { $('dupe-head').textContent = data.error || 'Couldn\'t look for copies.'; return }
    const wasProbing = dupes && dupes.probing
    const firstLoad = !dupes
    dupes = data
    // while picture sizes are being checked only the progress line changes;
    // the cards are redrawn once at the end (unless a preview is playing)
    const playingPreview = [...document.querySelectorAll('#dupe-groups video')].some((v) => !v.paused)
    if (!poll || (wasProbing && !data.probing && !playingPreview)) renderDupes(firstLoad)
    else renderDupeHeader()
    if (data.probing && tab === 'dupes') dupeTimer = setTimeout(() => loadDupes({ poll: true }), 8000)
  } catch (err) {
    if (err.message !== 'not-paired') $('dupe-head').textContent = 'Can\'t reach the Jukebox - try again in a moment.'
  }
}
function renderDupeHeader() {
  const d = dupes
  $('dupe-count').textContent = d.totals.groups ? d.totals.groups.toLocaleString() : ''
  $('dupe-head').textContent = d.totals.groups
    ? `${plural(d.totals.groups, 'song has', 'songs have')} extra copies - ${plural(d.totals.extra, 'extra file')}`
    : 'No duplicate songs found'
  $('dupe-sub').textContent = d.totals.groups ? 'For each song, the copy marked Keep is the one suggested (best picture, then a proper name). Pick a different one if you like, then delete the others. A removed copy\'s place in playlists and the queue goes to the kept one.' : 'Every song is in the library once.'
  $('dupe-probe').textContent = d.probing ? `Checking the picture quality of each copy… ${d.probing.done.toLocaleString()} of ${d.probing.total.toLocaleString()} (the suggested Keep can change when it's done)` : ''
  const exactBtn = $('exact-all')
  exactBtn.hidden = !d.totals.exact
  exactBtn.textContent = `Remove all exact copies (${plural(d.totals.exact, 'song')})`
}
function renderDupes(reset = true) {
  const d = dupes
  renderDupeHeader()

  const cf = $('copy-folders')
  cf.hidden = !d.copyFolders.length
  $('copy-folder-list').replaceChildren(...d.copyFolders.map((f) => el('label', {},
    el('input', { type: 'checkbox', checked: true, value: f.id }), el('span', { text: f.name }), el('small', { text: plural(f.n, 'song') }))))

  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.how === dupeHow))
  if (reset) { $('dupe-groups').replaceChildren(); dupeShown = 0 }
  else { $('dupe-groups').replaceChildren(); const n = dupeShown; dupeShown = 0; showMoreDupes(Math.max(n, 20)); return }
  showMoreDupes(20)
}
function dupeList() {
  return dupes.groups.filter((g) => !dupeHow || g.how === dupeHow)
}
function showMoreDupes(n = 20) {
  const list = dupeList()
  const box = $('dupe-groups')
  for (const g of list.slice(dupeShown, dupeShown + n)) box.append(groupCard(g))
  dupeShown = Math.min(list.length, dupeShown + n)
  $('dupe-more').textContent = dupeShown < list.length ? `Showing ${dupeShown} of ${list.length.toLocaleString()} - scroll for more` : ''
  if (!list.length) box.append(el('p', { class: 'empty', text: dupeHow ? 'None of these left.' : 'Nothing to tidy here.' }))
}
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && tab === 'dupes' && dupes && dupeShown < dupeList().length) showMoreDupes()
}, { rootMargin: '600px' }).observe($('dupe-more'))
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { dupeHow = b.dataset.how; renderDupes(true) }))

const HOW = { exact: ['exact', 'Exact copies'], likely: ['likely', 'Same song'], check: ['check', 'Check these'] }
function groupCard(g) {
  const keep = keepChoice.get(g.id) || g.keep
  const card = el('article', { class: 'group' })
  const name = `group-${g.id.slice(0, 12)}`
  const videoBox = el('div', { class: 'inline-video', hidden: true })
  const rows = g.items.map((it) => {
    const radio = el('input', { type: 'radio', name, value: it.k, checked: it.k === keep, 'aria-label': `Keep ${it.f}` })
    const th = thumbBox(it)
    th.title = 'Play this copy here'
    th.addEventListener('click', (e) => {
      e.stopPropagation()
      videoBox.hidden = false
      videoBox.replaceChildren(el('video', { controls: true, autoplay: true, src: videoUrl(it.k) }))
    })
    const facts = [folderLabel(it.folder), fmtTime(it.dur), fmtSize(it.size), it.h ? `${it.h}p` : null, it.named ? 'named by you' : null, it.playing ? 'playing now' : null].filter(Boolean).join(' · ')
    const row = el('div', { class: `copy${it.k === keep ? ' keep' : ''}` },
      radio, th,
      el('div', {}, el('div', { class: 'fn', text: it.f }), el('div', { class: 'meta', text: facts })),
      el('span', { class: 'verdict', text: it.k === keep ? 'Keep' : 'Delete' }))
    row.addEventListener('click', () => { radio.checked = true; choose(it.k) })
    radio.addEventListener('change', () => choose(it.k))
    return row
  })
  function choose(k) {
    keepChoice.set(g.id, k)
    rows.forEach((r, i) => {
      const isKeep = g.items[i].k === k
      r.classList.toggle('keep', isKeep)
      r.querySelector('.verdict').textContent = isKeep ? 'Keep' : 'Delete'
    })
    why.textContent = k === g.keep ? g.reason : 'Your choice'
  }
  const [cls, label] = HOW[g.how]
  const why = el('span', { class: 'why', text: keep === g.keep ? g.reason : 'Your choice' })
  const go = el('button', { class: 'primary', text: `Delete ${g.items.length - 1 === 1 ? 'the other copy' : `the other ${g.items.length - 1}`}` })
  go.addEventListener('click', async () => {
    const k = keepChoice.get(g.id) || g.keep
    go.disabled = true
    const r = await act('/api/lib/duplicates/resolve', { keep: k, remove: g.items.map((i) => i.k).filter((x) => x !== k) })
    go.disabled = false
    if (r) { keepChoice.delete(g.id); card.remove() }
  })
  const notDupe = el('button', { class: 'secondary', text: 'Not the same song' })
  notDupe.addEventListener('click', async () => {
    const r = await act('/api/lib/duplicates/ignore', { keys: g.items.map((i) => i.k) }, { quiet: true })
    if (r) { card.remove(); toast('OK - those won\'t show as duplicates again.') }
  })
  card.append(
    el('div', { class: 'group-head' }, el('h3', { text: g.title }), g.artist ? el('span', { class: 'who', text: g.artist }) : null, el('span', { class: `badge ${cls}`, text: label })),
    ...rows,
    videoBox,
    el('div', { class: 'group-foot' }, why, notDupe, go))
  return card
}
$('exact-all').addEventListener('click', async () => {
  const n = dupes.totals.exact
  if (dupes.copyFolders.length && !confirm(`${dupes.copyFolders.map((f) => f.name).join(', ')} ${dupes.copyFolders.length === 1 ? 'is' : 'are'} still playlist folders made of copies. Removing copies takes songs out of ${dupes.copyFolders.length === 1 ? 'it' : 'them'}. Carry on anyway? (Press Cancel, then "Make them normal playlists" first, to keep every song.)`)) return
  if (!confirm(`Remove the extra copies of ${plural(n, 'song')} that are exact copies (same file)?\n\nOne copy of each stays. The others can be put back from History for 30 days.`)) return
  $('exact-all').disabled = true
  await act('/api/lib/duplicates/exact-all', {})
  $('exact-all').disabled = false
})
$('copy-folders-go').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('#copy-folder-list input:checked')].map((i) => i.value)
  if (!ids.length) return
  await act('/api/lib/folder-playlists', { ids })
})

// ---------------------------------------------------------------- playlists
let openPl = null
async function loadPlaylistData() {
  const data = await api('/api/lib/playlists')
  if (data.ok) playlists = data.playlists
}
async function loadPlaylists() {
  await loadPlaylistData()
  renderPlaylistList()
  renderPlaylist()
}
$('pl-find').addEventListener('input', renderPlaylistList)
function renderPlaylistList() {
  const q = norm($('pl-find').value)
  const match = (p) => !q || norm(p.name).includes(q)
  const box = $('pl-list')
  box.replaceChildren()
  const section = (title, list, note) => {
    if (!list.length && !note) return
    box.append(el('p', { class: 'eyebrow pl-group-title', text: title }))
    if (!list.length) box.append(el('p', { class: 'note', text: note }))
    for (const p of list) {
      const b = el('button', { class: `pl-item${openPl === p.id ? ' on' : ''}` }, el('span', { text: p.name }), el('span', { class: 'n', text: p.keys.length.toLocaleString() }))
      b.addEventListener('click', () => { openPl = p.id; renderPlaylistList(); renderPlaylist() })
      box.append(b)
    }
  }
  section('Your playlists', playlists.filter((p) => p.kind === 'mine' && match(p)), q ? '' : 'None yet - make one above.')
  section('Folder playlists', playlists.filter((p) => p.kind === 'folder' && !p.hidden && match(p)))
  const artists = playlists.filter((p) => p.kind === 'artist' && match(p))
  section(`Singers & bands${q ? '' : ` (${artists.length})`}`, q ? artists : artists.slice(0, 0))
  if (!q && artists.length) box.append(el('p', { class: 'note', text: 'Type in "Find a playlist" to see a singer or band.' }))
}
function renderPlaylist() {
  const box = $('pl-detail')
  const p = playlists.find((x) => x.id === openPl)
  if (!p) { box.replaceChildren(el('p', { class: 'empty', text: 'Choose a playlist on the left, or make a new one.' })); return }
  const mine = p.kind === 'mine'
  const head = el('div', { class: 'pl-title-row' })
  if (mine) {
    const name = el('input', { value: p.name, maxLength: 60, 'aria-label': 'Playlist name' })
    const save = el('button', { class: 'secondary', text: 'Rename' })
    save.addEventListener('click', () => { if (name.value.trim() && name.value.trim() !== p.name) act('/api/lib/playlist', { action: 'rename', id: p.id, name: name.value }) })
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click() })
    const del = el('button', { class: 'danger', text: 'Delete playlist' })
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the playlist "${p.name}"? The songs stay in the library.`)) return
      if (await act('/api/lib/playlist', { action: 'delete', id: p.id })) { openPl = null; renderPlaylist() }
    })
    head.append(name, save, del)
  } else {
    head.append(el('h2', { text: p.name }))
    const copy = el('button', { class: 'secondary', text: 'Copy to my own playlist' })
    copy.addEventListener('click', async () => {
      const name = prompt('Name for your copy:', `${p.name} (copy)`)
      if (!name) return
      const r = await act('/api/lib/playlist', { action: 'copy', id: p.id, name })
      if (r) { openPl = r.id; await loadPlaylists() }
    })
    head.append(copy)
    if (p.kind === 'folder') {
      const normal = el('button', { class: 'primary', text: 'Make it a normal playlist' })
      normal.title = 'Keeps these songs as a playlist even if their copies in this folder are deleted or moved'
      normal.addEventListener('click', async () => {
        const r = await act('/api/lib/playlist', { action: 'make-normal', id: p.id })
        if (r) { await loadPlaylistData(); const made = playlists.find((x) => x.kind === 'mine' && x.name.startsWith(p.name)); openPl = made ? made.id : null; renderPlaylistList(); renderPlaylist() }
      })
      head.append(normal)
    }
  }
  const explain = el('p', { class: 'note', text: mine
    ? 'Drag songs to change the order. Changes show on the Jukebox and the Remote straight away.'
    : p.kind === 'folder' ? `Made from the songs in the "${p.folder}" folder - it changes when songs are moved in or out. Make it a normal playlist to edit it.`
    : 'Made from every song tagged with this singer or band. Copy it to edit it.' })

  const list = el('ol', { class: 'pl-songs' })
  let keys = [...p.keys]
  const render = () => {
    list.replaceChildren(...keys.map((k, i) => {
      const s = byKey.get(k)
      const li = el('li', { draggable: mine, 'data-i': i },
        el('span', { class: 'grip', text: mine ? '⋮⋮' : '' }),
        el('span', { class: 'pos', text: i + 1 }),
        el('span', {}, el('b', { text: s ? s.t : 'Song not found' }), s && s.a ? el('span', { class: 'who', text: ` - ${s.a}` }) : null),
        mine ? el('button', { class: 'x', text: '✕', 'aria-label': 'Take out of this playlist', 'data-x': i }) : el('span'))
      return li
    }))
    if (!keys.length) list.append(el('li', { class: 'empty', text: mine ? 'No songs yet - add some below, or from the Songs tab.' : 'No songs.' }))
  }
  render()
  if (mine) {
    let from = null
    list.addEventListener('dragstart', (e) => { const li = e.target.closest('li'); from = Number(li.dataset.i); li.classList.add('drag') })
    list.addEventListener('dragend', () => list.querySelectorAll('li').forEach((x) => x.classList.remove('drag', 'over')))
    list.addEventListener('dragover', (e) => { e.preventDefault(); list.querySelectorAll('li').forEach((x) => x.classList.remove('over')); const li = e.target.closest('li'); if (li) li.classList.add('over') })
    list.addEventListener('drop', async (e) => {
      e.preventDefault()
      const li = e.target.closest('li')
      if (from === null || !li) return
      const to = Number(li.dataset.i)
      if (to === from) return
      const [k] = keys.splice(from, 1)
      keys.splice(to, 0, k)
      render()
      await act('/api/lib/playlist', { action: 'set-songs', id: p.id, keys }, { quiet: true })
    })
    list.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-x]')
      if (!x) return
      keys.splice(Number(x.dataset.x), 1)
      render()
      await act('/api/lib/playlist', { action: 'set-songs', id: p.id, keys })
    })
  }
  const parts = [head, explain]
  if (mine) {
    const add = el('div', { class: 'pl-add' })
    const input = el('input', { class: 'search small', type: 'search', placeholder: 'Add a song - type its name or the singer', autocomplete: 'off' })
    const results = el('div', { class: 'pl-add-results', hidden: true })
    input.addEventListener('input', () => {
      const words = norm(input.value).split(/\s+/).filter(Boolean)
      if (!words.length) { results.hidden = true; return }
      const hits = songs.filter((s) => words.every((w) => s.n.includes(w)) && !keys.includes(s.k)).slice(0, 12)
      results.replaceChildren(...hits.map((s) => {
        const b = el('button', { type: 'button' }, s.t, el('small', { text: `  ${[s.a, s.d, folderLabel(s.folder)].filter(Boolean).join(' · ')}` }))
        b.addEventListener('click', async () => {
          keys.push(s.k)
          render()
          input.value = ''
          results.hidden = true
          await act('/api/lib/playlist', { action: 'set-songs', id: p.id, keys })
          input.focus()
        })
        return b
      }))
      if (!hits.length) results.append(el('p', { class: 'note', text: 'No songs match.', style: 'padding:8px 12px' }))
      results.hidden = false
    })
    input.addEventListener('blur', () => setTimeout(() => { results.hidden = true }, 200))
    add.append(input, results)
    parts.push(add)
  }
  parts.push(el('p', { class: 'eyebrow', text: plural(keys.length, 'song') }), list)
  box.replaceChildren(...parts)
}
$('pl-new').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = $('pl-new-name').value.trim()
  if (!name) return
  const r = await act('/api/lib/playlist', { action: 'create', name, keys: [] })
  if (r) { $('pl-new-name').value = ''; openPl = r.id; await loadPlaylists() }
})

// ---------------------------------------------------------------- sort into decades
let sortTimer = null
async function loadSort() {
  clearTimeout(sortTimer)
  const data = await api('/api/lib/sort')
  if (!data.ok) return
  renderSort(data.sort)
  if (data.sort.state === 'looking' || data.sort.state === 'moving') sortTimer = setTimeout(() => { if (tab === 'sort') loadSort() }, 4000)
}
function renderSort(st) {
  const running = st.state === 'looking' || st.state === 'moving'
  const hasResult = ['looking', 'ready', 'stopped', 'moving', 'done'].includes(st.state)
  $('sort-setup').hidden = running || (hasResult && st.state !== 'done' && !sortSetupOpen)
  $('sort-progress').hidden = !hasResult
  if (!$('sort-setup').hidden) renderSortFolders()
  if (!hasResult) return
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 100
  $('sort-meter').style.width = `${pct}%`
  const left = st.total - st.done
  const mins = Math.ceil((left * 3.4) / 60)
  $('sort-title').textContent = st.state === 'looking' ? `Looking up ${st.done.toLocaleString()} of ${st.total.toLocaleString()}…`
    : st.state === 'moving' ? 'Moving songs…'
    : st.state === 'done' ? `Done - moved ${plural(st.moved || 0, 'song')} into decade folders`
    : `Found the decade for ${plural(st.ready, 'song')}`
  $('sort-line').textContent = [
    `${st.ready.toLocaleString()} found`,
    st.noArtist ? `${st.noArtist.toLocaleString()} with no singer or band in the name (left where they are)` : '',
    st.notFound ? `${st.notFound.toLocaleString()} not found` : '',
    st.state === 'looking' && left > 20 ? `about ${mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`} to go` : '',
  ].filter(Boolean).join(' · ')
  $('sort-decades').replaceChildren(...Object.entries(st.byDecade || {}).sort().map(([d, n]) => el('span', {}, el('b', { text: d }), n.toLocaleString())))
  const apply = $('sort-apply')
  apply.hidden = !(st.ready && (st.state === 'ready' || st.state === 'stopped' || st.state === 'looking'))
  apply.disabled = st.state === 'looking'
  apply.textContent = st.state === 'looking' ? `Move ${plural(st.ready, 'song')} (when the look-up finishes, or stop it)` : `Move ${plural(st.ready, 'song')} into decade folders`
  $('sort-stop').hidden = st.state !== 'looking'
  $('sort-again').hidden = running
}
let sortSetupOpen = false
function renderSortFolders() {
  const counts = new Map()
  for (const s of songs) {
    const top = s.folder.split('/')[0]
    if (/^(19|20)\d0s$/.test(top)) continue
    counts.set(top, (counts.get(top) || 0) + 1)
  }
  const box = $('sort-folders')
  box.replaceChildren(...[...counts.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0]))).map(([f, n]) =>
    el('label', {}, el('input', { type: 'checkbox', value: f, checked: f === '' || /\d0'?s\b/i.test(f) }), el('span', { text: f ? f : 'Main folder (loose songs)' }), el('small', { text: plural(n, 'song') }))))
}
$('sort-start').addEventListener('click', async () => {
  const folders = [...document.querySelectorAll('#sort-folders input:checked')].map((i) => i.value)
  if (!folders.length) { toast('Tick at least one folder.', { bad: true }); return }
  const r = await api('/api/lib/sort', { method: 'POST', body: JSON.stringify({ action: 'start', folders }) })
  if (!r.ok) { toast(r.error, { bad: true }); return }
  sortSetupOpen = false
  loadSort()
})
$('sort-stop').addEventListener('click', async () => {
  await api('/api/lib/sort', { method: 'POST', body: JSON.stringify({ action: 'stop' }) })
  loadSort()
})
$('sort-again').addEventListener('click', () => { sortSetupOpen = true; $('sort-setup').hidden = false; renderSortFolders() })
$('sort-apply').addEventListener('click', async () => {
  if (!confirm('Move the songs into their decade folders now? Their names stay the same, and this can be undone from History.')) return
  $('sort-apply').disabled = true
  await act('/api/lib/sort', { action: 'apply' })
  loadSort()
})

// ---------------------------------------------------------------- history
async function loadHistory() {
  const data = await api('/api/lib/history')
  if (!data.ok) return
  const box = $('history-list')
  box.replaceChildren(...data.history.map((h) => {
    const undo = h.canUndo ? el('button', { class: 'secondary', text: h.type === 'delete' ? 'Put back' : 'Undo' }) : null
    if (undo) undo.addEventListener('click', async () => { undo.disabled = true; await act('/api/lib/undo', { id: h.id }); loadHistory() })
    const status = h.undone ? el('div', { class: 'done', text: `Undone${h.undoneBy ? ` by ${h.undoneBy}` : ''} ${h.undoneAt ? when(h.undoneAt) : ''}` })
      : h.expired ? el('div', { class: 'done', text: 'Deleted for good after 30 days' }) : null
    const detail = h.detail && h.detail.length > 1 ? el('details', {}, el('summary', { text: 'Which songs' }), el('ul', {}, ...h.detail.map((n) => el('li', { text: n })))) : null
    return el('li', {},
      el('time', { text: when(h.at) }),
      el('div', {}, el('b', { text: h.label }), el('div', { class: 'who', text: h.by ? `from ${h.by}` : '' }), status, detail),
      undo || el('span'))
  }))
  if (!data.history.length) box.append(el('li', { class: 'empty', text: 'No changes yet.' }))
}

// ---------------------------------------------------------------- refresh
async function refreshAfterChange() {
  await loadSongs()
  if (tab === 'playlists' || playlists.length) await loadPlaylistData()
  if (tab === 'playlists') { renderPlaylistList(); renderPlaylist() }
  if (tab === 'dupes') await loadDupes()
  if (tab === 'history') await loadHistory()
}
// someone else (another laptop, the inbox sorter) changed the library
setInterval(async () => {
  if (!token || document.hidden) return
  try {
    const r = await api('/api/status')
    if (r.ok && r.libraryVersion && libraryVersion && r.libraryVersion !== libraryVersion && $('drawer').hidden) await refreshAfterChange()
    $('conn').classList.replace('bad', 'ok')
  } catch (err) {
    if (err.message !== 'not-paired') { $('conn').textContent = 'Can\'t reach the Jukebox'; $('conn').className = 'pill bad' }
  }
}, 20000)

async function start() {
  $('pair').hidden = true
  $('app').hidden = false
  try {
    await loadSongs()
    await loadPlaylistData()
    let saved = 'songs'
    try { saved = sessionStorage.getItem('lib-tab') || 'songs' } catch { /* ignore */ }
    showTab(saved)
  } catch (err) {
    if (err.message !== 'not-paired') {
      $('conn').textContent = err.message === 'Failed to fetch' ? 'Can\'t reach the Jukebox' : err.message
      $('conn').className = 'pill bad'
    }
  }
}

if (token) start()
else showPair()

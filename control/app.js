// --- State ---
let library = []            // [{path, filename, size, mtimeMs, key, duration, thumbPath}]
let metadataCache = {}      // key -> {artist, genre, decade, confidence}
let playlists = []          // [{id, name, trackKeys: []}]
let queue = { tracks: [], currentIndex: 0 }
let settings = { mediaFolder: '', crossfadeSeconds: 3, volume: 1 }
let searchQuery = ''
let groupBy = ''

// Real filenames (and this app's own userData folder - "MSLSC Jukebox")
// are full of spaces and other characters that are invalid in a bare
// file:// URL - each path segment needs percent-encoding, not the path
// as a whole (encodeURIComponent would also mangle the / or \ separators).
function toFileUrl(filePath) {
  const sep = filePath.includes('\\') ? '\\' : '/'
  return 'file://' + filePath.split(sep).map(encodeURIComponent).join('/')
}

function trackByKey(key) { return library.find((t) => t.key === key) }
function fmtTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
function fmtBytes(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${(bytes / 1e6).toFixed(0)} MB`
}

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
  })
})

// --- Settings ---
async function loadSettings() {
  settings = await jukebox.getSettings()
  document.getElementById('settings-folder').value = settings.mediaFolder || ''
  document.getElementById('crossfade-slider').value = settings.crossfadeSeconds
  document.getElementById('crossfade-value').textContent = settings.crossfadeSeconds
  document.getElementById('volume-slider').value = Math.round(settings.volume * 100)
  document.getElementById('volume-value').textContent = Math.round(settings.volume * 100)
  document.getElementById('library-folder-label').textContent = settings.mediaFolder
    ? `Folder: ${settings.mediaFolder}`
    : 'No media folder set — go to Settings.'
}

document.getElementById('choose-folder-btn').addEventListener('click', async () => {
  const folder = await jukebox.chooseMediaFolder()
  if (folder) { await loadSettings(); await rescanLibrary() }
})

document.getElementById('crossfade-slider').addEventListener('input', async (e) => {
  const seconds = Number(e.target.value)
  document.getElementById('crossfade-value').textContent = seconds
  settings.crossfadeSeconds = seconds
  await jukebox.saveSettings(settings)
  jukebox.playerSetCrossfadeDuration(seconds)
})
document.getElementById('volume-slider').addEventListener('input', async (e) => {
  const pct = Number(e.target.value)
  document.getElementById('volume-value').textContent = pct
  settings.volume = pct / 100
  await jukebox.saveSettings(settings)
  jukebox.playerSetVolume(settings.volume)
})

// --- Library: scan, thumbnails/duration, render ---

async function generateThumbAndDuration(track) {
  const existingThumb = await jukebox.getThumbnailPath(track.key)
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.src = toFileUrl(track.path)
    video.addEventListener('loadedmetadata', () => {
      track.duration = video.duration
      if (existingThumb) { track.thumbPath = existingThumb; video.remove(); resolve(); return }
      video.currentTime = Math.min(3, video.duration / 2 || 0)
    })
    video.addEventListener('seeked', async () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 320; canvas.height = 180
        canvas.getContext('2d').drawImage(video, 0, 0, 320, 180)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
        // Awaited deliberately - rescanLibrary() re-renders the grid right
        // after this track's promise resolves, so thumbPath has to be set
        // on the track object before resolve() fires, not sometime after.
        track.thumbPath = await jukebox.saveThumbnail(track.key, dataUrl)
      } catch { /* thumbnail is a nice-to-have, never block on it */ }
      video.remove()
      resolve()
    })
    video.addEventListener('error', () => { track.duration = 0; track.error = true; video.remove(); resolve() })
  })
}

async function rescanLibrary() {
  document.getElementById('library-status').textContent = 'Scanning…'
  const files = await jukebox.listVideos()
  metadataCache = await jukebox.getMetadataCache()
  library = files
  // Thumbnails/duration are generated a few at a time, not all at once,
  // so a big library doesn't freeze the UI - re-render as each batch lands.
  document.getElementById('library-status').textContent = files.length ? '' : 'No video files found in the media folder.'
  renderLibrary()
  const BATCH = 4
  for (let i = 0; i < library.length; i += BATCH) {
    await Promise.all(library.slice(i, i + BATCH).map(generateThumbAndDuration))
    renderLibrary()
  }
}

document.getElementById('rescan-btn').addEventListener('click', rescanLibrary)

document.getElementById('enrich-btn').addEventListener('click', async () => {
  const status = document.getElementById('library-status')
  for (let i = 0; i < library.length; i++) {
    const track = library[i]
    status.textContent = `Enriching ${i + 1}/${library.length}…`
    metadataCache[track.key] = await jukebox.lookupMetadata(track.key, track.filename)
  }
  status.textContent = ''
  renderLibrary()
})

document.getElementById('library-search').addEventListener('input', (e) => { searchQuery = e.target.value.toLowerCase(); renderLibrary() })
document.getElementById('library-group-by').addEventListener('change', (e) => { groupBy = e.target.value; renderLibrary() })

function playlistPickerHtml(track) {
  const options = playlists.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')
  return `<select data-add-to-playlist="${track.key}"><option value="">+ Playlist</option>${options}</select>`
}

function renderTrackTile(track) {
  const meta = metadataCache[track.key]
  const thumbStyle = track.thumbPath ? `background-image:url('${toFileUrl(track.thumbPath)}')` : ''
  return `
    <div class="track-tile">
      <div class="track-thumb" style="${thumbStyle}">${track.thumbPath ? '' : (track.error ? '⚠ Unsupported' : '🎬')}</div>
      <div class="track-info">
        <strong title="${track.filename}">${track.filename}</strong>
        <div class="track-meta">${fmtTime(track.duration)} · ${fmtBytes(track.size)}${meta && meta.artist !== 'Unknown' ? ` · ${meta.artist}` : ''}</div>
      </div>
      <div class="track-actions">
        <button class="secondary" data-play-now="${track.key}">▶ Play</button>
        <button class="secondary" data-add-queue="${track.key}">+ Queue</button>
      </div>
      <div class="track-actions">${playlistPickerHtml(track)}</div>
    </div>`
}

function renderLibrary() {
  const grid = document.getElementById('library-grid')
  let items = library.filter((t) => t.filename.toLowerCase().includes(searchQuery))

  if (groupBy) {
    const groups = new Map()
    for (const track of items) {
      const meta = metadataCache[track.key]
      const label = (meta && meta[groupBy] && meta[groupBy] !== 'Unknown') ? meta[groupBy] : 'Unknown'
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(track)
    }
    const sortedLabels = [...groups.keys()].sort((a, b) => (a === 'Unknown' ? 1 : b === 'Unknown' ? -1 : a.localeCompare(b)))
    grid.innerHTML = sortedLabels.map((label) => `<div class="library-group">${label}</div>` + groups.get(label).map(renderTrackTile).join('')).join('')
  } else {
    items = [...items].sort((a, b) => a.filename.localeCompare(b.filename))
    grid.innerHTML = items.map(renderTrackTile).join('')
  }

  grid.querySelectorAll('[data-play-now]').forEach((el) => el.addEventListener('click', () => playNow(el.dataset.playNow)))
  grid.querySelectorAll('[data-add-queue]').forEach((el) => el.addEventListener('click', () => addToQueue(el.dataset.addQueue)))
  grid.querySelectorAll('[data-add-to-playlist]').forEach((el) => el.addEventListener('change', (e) => {
    if (e.target.value) addTrackToPlaylist(e.target.value, el.dataset.addToPlaylist)
    e.target.value = ''
  }))
}

// --- Queue ---

async function saveAndSyncQueue() {
  await jukebox.saveQueue(queue)
  renderQueue()
}

async function playNow(key) {
  queue = { tracks: [key], currentIndex: 0 }
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: [trackByKey(key)], startIndex: 0 })
}

async function addToQueue(key) {
  queue.tracks.push(key)
  await saveAndSyncQueue()
}

document.getElementById('clear-queue-btn').addEventListener('click', async () => {
  queue = { tracks: [], currentIndex: 0 }
  await saveAndSyncQueue()
})

function renderQueue() {
  const list = document.getElementById('queue-list')
  list.innerHTML = queue.tracks.map((key, i) => {
    const track = trackByKey(key)
    if (!track) return ''
    const isNowPlaying = i === queue.currentIndex && lastPlayerState && lastPlayerState.status !== 'idle'
    return `
      <li class="queue-row ${isNowPlaying ? 'now-playing' : ''}">
        <span class="queue-index">${i + 1}</span>
        <span style="flex:1">${track.filename}</span>
        <span>${fmtTime(track.duration)}</span>
        <div class="button-row">
          <button class="secondary" data-move-up="${i}">↑</button>
          <button class="secondary" data-move-down="${i}">↓</button>
          <button class="secondary" data-play-from="${i}">▶</button>
          <button class="danger" data-remove-idx="${i}">✕</button>
        </div>
      </li>`
  }).join('') || '<p class="eyebrow">Queue is empty — add tracks from the Library.</p>'

  list.querySelectorAll('[data-move-up]').forEach((el) => el.addEventListener('click', () => moveQueueItem(Number(el.dataset.moveUp), -1)))
  list.querySelectorAll('[data-move-down]').forEach((el) => el.addEventListener('click', () => moveQueueItem(Number(el.dataset.moveDown), 1)))
  list.querySelectorAll('[data-remove-idx]').forEach((el) => el.addEventListener('click', () => removeQueueItem(Number(el.dataset.removeIdx))))
  list.querySelectorAll('[data-play-from]').forEach((el) => el.addEventListener('click', () => playQueueFrom(Number(el.dataset.playFrom))))
}

async function moveQueueItem(index, direction) {
  const target = index + direction
  if (target < 0 || target >= queue.tracks.length) return
  const [item] = queue.tracks.splice(index, 1)
  queue.tracks.splice(target, 0, item)
  await saveAndSyncQueue()
}
async function removeQueueItem(index) {
  queue.tracks.splice(index, 1)
  await saveAndSyncQueue()
}
async function playQueueFrom(index) {
  queue.currentIndex = index
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: queue.tracks.map(trackByKey).filter(Boolean), startIndex: index })
}

// --- Playlists ---

document.getElementById('create-playlist-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-playlist-name')
  const name = nameInput.value.trim()
  if (!name) return
  const playlist = { id: crypto.randomUUID(), name, trackKeys: [] }
  playlists = await jukebox.savePlaylist(playlist)
  nameInput.value = ''
  renderPlaylists()
  renderLibrary() // picker dropdowns need the new playlist option
})

async function addTrackToPlaylist(playlistId, trackKey) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist || playlist.trackKeys.includes(trackKey)) return
  playlist.trackKeys.push(trackKey)
  playlists = await jukebox.savePlaylist(playlist)
  renderPlaylists()
}

async function removeTrackFromPlaylist(playlistId, trackKey) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist) return
  playlist.trackKeys = playlist.trackKeys.filter((k) => k !== trackKey)
  playlists = await jukebox.savePlaylist(playlist)
  renderPlaylists()
}

async function playPlaylistNow(playlistId) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist || playlist.trackKeys.length === 0) return
  queue = { tracks: [...playlist.trackKeys], currentIndex: 0 }
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: queue.tracks.map(trackByKey).filter(Boolean), startIndex: 0 })
}
async function appendPlaylistToQueue(playlistId) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist) return
  queue.tracks.push(...playlist.trackKeys)
  await saveAndSyncQueue()
}
async function deletePlaylist(id) {
  playlists = await jukebox.deletePlaylist(id)
  renderPlaylists()
  renderLibrary()
}

function renderPlaylists() {
  const container = document.getElementById('playlists-list')
  container.innerHTML = playlists.map((p) => `
    <div class="playlist-card">
      <div class="playlist-header">
        <strong>${p.name}</strong>
        <div class="button-row">
          <button class="primary" data-playlist-play="${p.id}">▶ Play Now</button>
          <button class="secondary" data-playlist-append="${p.id}">+ Add to Queue</button>
          <button class="danger" data-playlist-delete="${p.id}">Delete</button>
        </div>
      </div>
      <div class="playlist-tracks">
        ${p.trackKeys.map((key) => {
          const t = trackByKey(key)
          return t ? `<div class="playlist-track-row"><span>${t.filename}</span><button class="danger" data-playlist-remove-track="${p.id}::${key}">✕</button></div>` : ''
        }).join('') || '<p class="eyebrow">No tracks yet - add some from the Library.</p>'}
      </div>
    </div>`).join('') || '<p class="eyebrow">No playlists yet.</p>'

  container.querySelectorAll('[data-playlist-play]').forEach((el) => el.addEventListener('click', () => playPlaylistNow(el.dataset.playlistPlay)))
  container.querySelectorAll('[data-playlist-append]').forEach((el) => el.addEventListener('click', () => appendPlaylistToQueue(el.dataset.playlistAppend)))
  container.querySelectorAll('[data-playlist-delete]').forEach((el) => el.addEventListener('click', () => deletePlaylist(el.dataset.playlistDelete)))
  container.querySelectorAll('[data-playlist-remove-track]').forEach((el) => el.addEventListener('click', () => {
    const [playlistId, trackKey] = el.dataset.playlistRemoveTrack.split('::')
    removeTrackFromPlaylist(playlistId, trackKey)
  }))
}

// --- Now playing bar ---

let lastPlayerState = null
document.getElementById('np-previous').addEventListener('click', () => jukebox.playerPrevious())
document.getElementById('np-toggle').addEventListener('click', () => jukebox.playerTogglePlayPause())
document.getElementById('np-skip').addEventListener('click', () => jukebox.playerSkip())

jukebox.onPlayerState((state) => {
  lastPlayerState = state
  document.getElementById('np-title').textContent = state.currentTrack ? state.currentTrack.filename : 'Nothing playing'
  document.getElementById('np-time').textContent = fmtTime(state.timeElapsed)
  document.getElementById('np-duration').textContent = fmtTime(state.duration)
  const pct = state.duration ? (state.timeElapsed / state.duration) * 100 : 0
  document.getElementById('np-progress-bar').style.width = `${pct}%`
  if (state.status === 'error' && state.errorTrack) {
    document.getElementById('library-status').textContent = `"${state.errorTrack.filename}" could not be played (unsupported format) — skipped.`
  }
  // Keep the queue view's now-playing highlight and currentIndex in sync.
  if (typeof state.currentIndex === 'number' && state.currentIndex !== queue.currentIndex) {
    queue.currentIndex = state.currentIndex
    jukebox.saveQueue(queue)
  }
  renderQueue()
})

// --- Init ---

async function init() {
  await loadSettings()
  playlists = await jukebox.getPlaylists()
  queue = await jukebox.getQueue()
  renderPlaylists()
  renderQueue()
  if (settings.mediaFolder) await rescanLibrary()
}
init()

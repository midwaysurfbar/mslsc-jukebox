// Control window - The Playlists tab.
// Plain scripts loaded in order by index.html; they share one global scope.

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

// The Library grid's own picker (playlistPickerHtml above) now shows a
// track's current manual playlist as its selection, same as it already
// does for a folder or an artist tag - so picking a *different* one
// there needs to actually move it, not just pile on a second
// membership the way addTrackToPlaylist alone would (a track can still
// end up in several manual playlists some other way, e.g. via the
// Playlists tab's own "add track" controls - this only replaces
// whichever one this exact picker was just showing as current).
// Also covers a real gap the plain add-only version had: nothing here
// used to re-render the Library grid itself, so the picker wouldn't
// show the new selection until some other action happened to redraw it.
async function moveTrackToManualPlaylist(trackKey, newPlaylistId) {
  const currentManual = playlists.find(
    (p) => !p.autoFolder && !p.autoArtist && p.trackKeys.includes(trackKey),
  )
  if (currentManual && currentManual.id !== newPlaylistId) {
    await removeTrackFromPlaylist(currentManual.id, trackKey)
  }
  await addTrackToPlaylist(newPlaylistId, trackKey)
  renderLibrary()
}

async function playPlaylistNow(playlistId) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist || playlist.trackKeys.length === 0) return
  queue = { tracks: [...playlist.trackKeys], currentIndex: 0 }
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: displayQueue(), startIndex: 0 })
}
async function appendPlaylistToQueue(playlistId) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist) return
  queue.tracks.push(...playlist.trackKeys)
  await saveAndSyncQueue()
  // Display plays its own copy of the list - without this, a playlist
  // added mid-song never actually played (same fix as + Queue).
  sendQueueToDisplay()
}
async function deletePlaylist(id) {
  playlists = await jukebox.deletePlaylist(id)
  if (openPlaylistId === id) openPlaylistId = null
  renderPlaylists()
  renderLibrary()
}

// null = showing the tile grid; a playlist id = that one playlist's
// track list is open. Two-level nav rather than every card permanently
// showing its full track list, which stopped scaling once folder-synced
// playlists (auto-created per subfolder) meant there could be a lot more
// of these than the handful of manually-built ones this screen was
// originally designed around.
let openPlaylistId = null

function wirePlaylistActionButtons(container) {
  container.querySelectorAll('[data-playlist-play]').forEach((el) => el.addEventListener('click', () => playPlaylistNow(el.dataset.playlistPlay)))
  container.querySelectorAll('[data-playlist-append]').forEach((el) => el.addEventListener('click', () => appendPlaylistToQueue(el.dataset.playlistAppend)))
  container.querySelectorAll('[data-playlist-delete]').forEach((el) => el.addEventListener('click', () => deletePlaylist(el.dataset.playlistDelete)))
  container.querySelectorAll('[data-playlist-remove-track]').forEach((el) => el.addEventListener('click', () => {
    const [playlistId, trackKey] = el.dataset.playlistRemoveTrack.split('::')
    removeTrackFromPlaylist(playlistId, trackKey)
  }))
}

function renderPlaylists() {
  const container = document.getElementById('playlists-list')
  const openPlaylist = openPlaylistId && playlists.find((p) => p.id === openPlaylistId)

  if (openPlaylist) {
    const p = openPlaylist
    const isAuto = p.autoFolder || p.autoArtist
    const autoLabel = p.autoFolder ? '📁 synced from folder' : p.autoArtist ? '🎤 synced from tag' : ''
    container.className = 'playlist-detail'
    container.innerHTML = `
      <button class="secondary" id="playlist-back-btn">← Back to Playlists</button>
      <div class="playlist-card">
        <div class="playlist-header">
          <strong>${esc(p.name)}${autoLabel ? ` <span class="auto-tag">${autoLabel}</span>` : ''}</strong>
          <div class="button-row">
            <button class="primary" data-playlist-play="${p.id}">▶ Play Now</button>
            <button class="secondary" data-playlist-append="${p.id}">+ Add to Queue</button>
            ${isAuto ? '' : `<button class="danger" data-playlist-delete="${p.id}">Delete</button>`}
          </div>
        </div>
        <div class="playlist-tracks">
          ${p.trackKeys.map((key) => {
            const t = trackByKey(key)
            if (!t) return ''
            // Membership on an auto-synced playlist (folder or artist tag)
            // is recalculated on its own - no manual remove button, since
            // moving the file (or re-tagging it) is the actual "remove".
            return `<div class="playlist-track-row"><span>${esc(t.filename)}</span>${isAuto ? '' : `<button class="danger" data-playlist-remove-track="${p.id}::${key}">✕</button>`}</div>`
          }).join('') || `<p class="eyebrow">${p.autoFolder ? 'No files currently in this folder.' : p.autoArtist ? 'No tracks tagged with this artist yet.' : 'No tracks yet - add some from the Library.'}</p>`}
        </div>
      </div>`
    document.getElementById('playlist-back-btn').addEventListener('click', () => { openPlaylistId = null; renderPlaylists() })
    wirePlaylistActionButtons(container)
    return
  }

  container.className = 'playlist-tiles'
  container.innerHTML = playlists.map((p) => `
    <div class="playlist-tile" data-open-playlist="${p.id}">
      <strong>${esc(p.name)}${p.autoFolder ? ' <span class="auto-tag">📁</span>' : p.autoArtist ? ' <span class="auto-tag">🎤</span>' : ''}</strong>
      <div class="track-meta">${p.trackKeys.length} track${p.trackKeys.length === 1 ? '' : 's'}</div>
      <div class="track-actions">
        <button class="primary" data-playlist-play="${p.id}">▶ Play</button>
        <button class="secondary" data-playlist-append="${p.id}">+ Queue</button>
      </div>
    </div>`).join('') || '<p class="eyebrow">No playlists yet.</p>'

  // Opening a playlist is a click anywhere on its tile EXCEPT the two
  // action buttons, which do their own thing (play/queue) without also
  // opening the tile - checking e.target here rather than stopping
  // propagation on the buttons themselves, so their own listeners (wired
  // below, same as everywhere else) don't need to know this exists.
  container.querySelectorAll('[data-open-playlist]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return
    openPlaylistId = el.dataset.openPlaylist
    renderPlaylists()
  }))
  wirePlaylistActionButtons(container)
}

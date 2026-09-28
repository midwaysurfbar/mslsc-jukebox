// Control window - Library: the grid of video tiles - search, grouping, paging, the per-tile playlist picker, and the grid's click handling.
// Plain scripts loaded in order by index.html; they share one global scope.

// Waits for a short pause in typing before redrawing, rather than
// redrawing the whole grid on every single keystroke.
let searchDebounce = null
document.getElementById('library-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce)
  const value = e.target.value.toLowerCase()
  searchDebounce = setTimeout(() => { searchQuery = value; renderLibrary({ reset: true }) }, 200)
})
document.getElementById('library-group-by').addEventListener('change', (e) => { groupBy = e.target.value; groupFilter = null; renderLibrary({ reset: true }) })

// One picker, two different things happening underneath depending on
// what's chosen - a manual playlist just gets the track key appended
// (playlists.json), but a folder-synced one can only ever be "joined" by
// actually moving the file into its folder (folders are the source of
// truth for those, everywhere else in the app too) - same for the
// "New folder…" option, which creates one on the spot. moveTrackToFolder
// handles both of the folder cases; addTrackToPlaylist the manual one.
function playlistPickerHtml(track) {
  // Built once per renderLibrary() pass (see buildPickerContext below),
  // not once per tile - with ~2,500 tiles and ~170 playlists, redoing
  // these lookups per tile was a big part of every redraw.
  const ctx = pickerContext

  // Which option (if any) reflects where this track already lives -
  // shown as the picker's own current selection instead of always
  // resetting to "+ Playlist", so e.g. Sort Unsorted by Decade actually
  // moving a track into "1980s" shows "1980s" here afterwards, and a
  // still-unsorted one keeps showing "+ Playlist" - Sam, 2026-09-17:
  // wants to be able to tell which files haven't been sorted yet just by
  // scanning this column. Checked in this order because a track only
  // ever has one folder and one artist tag, but could sit in several
  // manual playlists at once - a single dropdown can only show one of
  // those as "current", so manual is last and just takes whichever
  // matches first.
  const meta = metadataCache[track.key]
  const folderMatch = track.folder && ctx.folderByPath.get(track.folder)
  const artistMatch = meta && ctx.artistByValue.get(meta.artist)
  const manualMatch = ctx.manualByTrack.get(track.key)
  let currentValue = ''
  let currentLabel = '+ Playlist'
  if (folderMatch) { currentValue = `folder:${folderMatch.folderPath}`; currentLabel = `📁 ${folderMatch.name}` }
  else if (artistMatch) { currentValue = `artist:${artistMatch.artistValue}`; currentLabel = `🎤 ${artistMatch.name}` }
  else if (manualMatch) { currentValue = `playlist:${manualMatch.id}`; currentLabel = manualMatch.name }

  // Only the current selection is rendered up front - the full list of
  // every playlist is filled in the moment the picker is clicked or
  // focused (fillPicker below). Rendering all ~170 options into every
  // one of ~2,500 tiles was ~430,000 <option>s on one page.
  return `
    <select data-track-picker="${track.key}" data-current="${esc(currentValue)}">
      <option value="${esc(currentValue)}" selected>${esc(currentLabel)}</option>
    </select>`
}

function buildPickerContext() {
  const manualPlaylists = playlists.filter((p) => !p.autoFolder && !p.autoArtist)
  const folderPlaylists = playlists.filter((p) => p.autoFolder)
  const artistPlaylists = playlists.filter((p) => p.autoArtist)
  const manualByTrack = new Map()
  for (const p of manualPlaylists) {
    for (const key of p.trackKeys) if (!manualByTrack.has(key)) manualByTrack.set(key, p)
  }
  const option = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`
  // "Joining" an existing artist playlist here is just a quicker way to
  // tag this track as that same artist (setManualMetadata under the
  // hood, same as the 🏷 Tag button) - no retyping a band name that's
  // already on record for another video.
  const optionsHtml =
    option('', '+ Playlist') +
    manualPlaylists.map((p) => option(`playlist:${p.id}`, p.name)).join('') +
    folderPlaylists.map((p) => option(`folder:${p.folderPath}`, `📁 ${p.name}`)).join('') +
    artistPlaylists.map((p) => option(`artist:${p.artistValue}`, `🎤 ${p.name}`)).join('') +
    option('new-folder', '📁 New folder…')
  return {
    folderByPath: new Map(folderPlaylists.map((p) => [p.folderPath, p])),
    artistByValue: new Map(artistPlaylists.map((p) => [p.artistValue, p])),
    manualByTrack,
    optionsHtml,
  }
}
let pickerContext = buildPickerContext()

function fillPicker(select) {
  if (select.dataset.filled) return
  select.dataset.filled = '1'
  select.innerHTML = pickerContext.optionsHtml
  select.value = select.dataset.current
}

function renderTrackTile(track) {
  const meta = metadataCache[track.key]
  const thumbStyle = track.thumbPath ? `background-image:url('${toFileUrl(track.thumbPath)}')` : ''
  const thumbLabel = track.converting ? '⏳ Converting…' : track.thumbPath ? '' : (track.needsConversion ? '⚠ Needs conversion' : (track.error ? '⚠ Unsupported' : '🎬'))
  return `
    <div class="track-tile">
      <div class="track-thumb" style="${thumbStyle}">${thumbLabel}</div>
      <div class="track-info">
        <strong title="${esc(track.filename)}">${esc(track.filename)}</strong>
        <div class="track-meta">${fmtTime(track.duration)} · ${fmtBytes(track.size)}${meta && meta.artist !== 'Unknown' ? ` · ${esc(meta.artist)}` : ''}${track.convertedPath ? ' · converted' : ''}</div>
      </div>
      <div class="track-actions">
        ${track.needsConversion
          ? `<button class="primary" data-convert="${track.key}" ${track.converting ? 'disabled' : ''}>${track.converting ? 'Converting…' : 'Convert'}</button>`
          : `<button class="secondary" data-play-now="${track.key}">▶ Play</button><button class="secondary" data-add-queue="${track.key}">+ Queue</button>`}
      </div>
      <div class="track-actions">
        ${playlistPickerHtml(track)}
        <button class="secondary" data-edit-tags="${track.key}" title="Tag the band/singer (and genre) - doesn't move or rename the file">🏷 Tag</button>
      </div>
      <div class="track-actions">
        <button class="danger" data-delete-file="${track.key}" title="Permanently delete this file from the drive">🗑 Delete</button>
      </div>
    </div>`
}

// The grid is drawn a page at a time - the first LIBRARY_PAGE entries
// straight away, then another page each time the bottom comes into view.
// Drawing all ~2,500 tiles in one go (and again on every search
// keystroke, tag, or move) is what made the Library feel slow.
const LIBRARY_PAGE = 120
let libraryEntries = []      // [{html: () => string}] - headers and tiles, in display order
let libraryShown = 0
const libraryGrid = document.getElementById('library-grid')
const librarySentinel = document.createElement('div')
librarySentinel.className = 'library-sentinel'
const librarySentinelObserver = new IntersectionObserver((observed) => {
  if (observed.some((o) => o.isIntersecting)) showMoreLibrary()
}, { rootMargin: '600px' })

function showMoreLibrary() {
  if (libraryShown >= libraryEntries.length) return
  const next = libraryEntries.slice(libraryShown, libraryShown + LIBRARY_PAGE)
  libraryShown += next.length
  librarySentinel.remove()
  libraryGrid.insertAdjacentHTML('beforeend', next.map((e) => e.html()).join(''))
  if (libraryShown < libraryEntries.length) libraryGrid.appendChild(librarySentinel)
}

// The observer only fires when the bottom marker *changes* between off-
// and on-screen - if a freshly added page is short enough that the marker
// is still in view, nothing new would fire. This tops up in that case.
// Skipped while the Library tab is hidden (every size reads as 0 then,
// which would otherwise look like "in view" and load everything).
function topUpLibrary() {
  requestAnimationFrame(() => {
    if (!librarySentinel.isConnected || libraryGrid.offsetParent === null) return
    if (librarySentinel.getBoundingClientRect().top < window.innerHeight + 600) {
      showMoreLibrary()
      topUpLibrary()
    }
  })
}

// `reset` (a new search, grouping, or group filter) starts back at the
// first page. Anything else - a tag, a move, a thumbnail landing - keeps
// however many tiles were already showing, so the list doesn't jump
// back to the top under whoever's scrolling it.
function renderLibrary({ reset = false } = {}) {
  const keepShown = reset ? 0 : libraryShown
  pickerContext = buildPickerContext()
  let items = searchQuery ? library.filter((t) => t.filename.toLowerCase().includes(searchQuery)) : library
  const entries = []
  const tile = (track) => ({ html: () => renderTrackTile(track) })

  if (groupBy) {
    const groups = new Map()
    for (const track of items) {
      const meta = metadataCache[track.key]
      const label = (meta && meta[groupBy] && meta[groupBy] !== 'Unknown') ? meta[groupBy] : 'Unknown'
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(track)
    }
    // A group that's disappeared since (its last track got re-tagged,
    // deleted, or the search box now excludes it) can't stay "selected".
    if (groupFilter && !groups.has(groupFilter)) groupFilter = null

    if (groupFilter) {
      entries.push({ html: () => `<button class="secondary" data-clear-group-filter>← Show every ${esc(groupBy)}</button>` })
      entries.push({ html: () => `<div class="library-group">${esc(groupFilter)}</div>` })
      entries.push(...groups.get(groupFilter).map(tile))
    } else {
      const sortedLabels = [...groups.keys()].sort((a, b) => (a === 'Unknown' ? 1 : b === 'Unknown' ? -1 : a.localeCompare(b)))
      // Clicking a group header narrows the grid to just that group - the
      // whole point of tagging a video (Sam, 2026-09-13: "sort the music
      // videos by that") is being able to jump straight to one band's
      // videos, not just see them clustered on an otherwise-long page.
      for (const label of sortedLabels) {
        const count = groups.get(label).length
        entries.push({ html: () => `<div class="library-group" data-group-filter="${esc(label)}" title="Show only ${esc(label)}">${esc(label)} <span class="group-count">${count}</span></div>` })
        entries.push(...groups.get(label).map(tile))
      }
    }
  } else {
    items = [...items].sort((a, b) => a.filename.localeCompare(b.filename))
    entries.push(...items.map(tile))
  }

  libraryEntries = entries
  libraryShown = 0
  librarySentinel.remove()
  libraryGrid.innerHTML = ''
  const firstBatch = Math.max(LIBRARY_PAGE, keepShown)
  libraryShown = Math.min(firstBatch, entries.length)
  libraryGrid.innerHTML = entries.slice(0, libraryShown).map((e) => e.html()).join('')
  if (libraryShown < entries.length) libraryGrid.appendChild(librarySentinel)
  topUpLibrary()
}

librarySentinelObserver.observe(librarySentinel)

// One set of listeners on the grid itself, instead of ~7 per tile
// re-attached on every redraw.
libraryGrid.addEventListener('click', (e) => {
  const el = e.target.closest('[data-play-now],[data-add-queue],[data-convert],[data-delete-file],[data-edit-tags],[data-group-filter],[data-clear-group-filter]')
  if (!el || !libraryGrid.contains(el)) return
  if (el.dataset.playNow) playNow(el.dataset.playNow)
  else if (el.dataset.addQueue) addToQueue(el.dataset.addQueue)
  else if (el.dataset.convert) convertTrack(el.dataset.convert)
  else if (el.dataset.deleteFile) runLibraryOp(() => deleteFile(el.dataset.deleteFile))
  else if (el.dataset.editTags) editTags(el.dataset.editTags)
  else if (el.dataset.groupFilter !== undefined) { groupFilter = el.dataset.groupFilter; renderLibrary({ reset: true }) }
  else if (el.hasAttribute('data-clear-group-filter')) { groupFilter = null; renderLibrary({ reset: true }) }
})
for (const type of ['mousedown', 'focusin']) {
  libraryGrid.addEventListener(type, (e) => {
    const select = e.target.closest('[data-track-picker]')
    if (select) fillPicker(select)
  })
}
libraryGrid.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-track-picker]')
  if (!el) return
  const trackKey = el.dataset.trackPicker
  const value = el.value
  el.value = el.dataset.current
  if (!value || value === el.dataset.current) return
  if (value.startsWith('playlist:')) moveTrackToManualPlaylist(trackKey, value.slice('playlist:'.length))
  else if (value.startsWith('folder:')) runLibraryOp(() => moveTrackToFolder(trackKey, value.slice('folder:'.length)))
  else if (value.startsWith('artist:')) assignArtist(trackKey, value.slice('artist:'.length))
  else if (value === 'new-folder') {
    const name = await askForFolderName()
    if (name) runLibraryOp(() => moveTrackToFolder(trackKey, name))
  }
})

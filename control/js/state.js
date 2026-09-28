// Control window - Shared state and small helpers every other Control script uses. Loaded first.
// Plain scripts loaded in order by index.html; they share one global scope.

// --- State ---
let library = []            // [{path, filename, size, mtimeMs, key, duration, thumbPath}]
let metadataCache = {}      // key -> {artist, genre, decade, confidence}
let playlists = []          // [{id, name, trackKeys: []}]
let queue = { tracks: [], currentIndex: 0 }
let settings = { mediaFolder: '', crossfadeSeconds: 3, volume: 1, adsEnabled: false, adsEverySongs: 4, adsSecondsPerImage: 6, introVideoEnabled: true }
let searchQuery = ''
let groupBy = ''
// Which group (artist/genre/decade label) the Library grid is narrowed
// to, when grouped - a quick "just show me this one" without leaving
// the tab. Cleared whenever groupBy itself changes.
let groupFilter = null

// Serializes every flow that reconciles a fresh main-process file listing
// into `library` (manual/auto rescan, delete, move-to-folder, decade-sort)
// so exactly one ever runs at a time. All of them freely read, reconcile,
// and reassign the same `library`/`playlists` state - and an explicit
// action (which itself touches the media folder) can trigger the live
// folder watch's own auto-rescan while it's still mid-flight. Letting two
// of these interleave is exactly how a just-moved/converted track can
// permanently lose its needsConversion/duration: whichever reconcile
// runs second sees a bare placeholder the other inserted moments earlier
// and mistakes it for "already known", skipping its thumbnail pass for
// good. Real, observed bug - not a theoretical one.
let libraryOpQueue = Promise.resolve()
function runLibraryOp(fn) {
  const run = libraryOpQueue.then(fn, fn)
  libraryOpQueue = run.catch(() => {})
  return run
}

// toFileUrl() comes from ../shared/file-url.js (loaded first).

// Indexed by key, rebuilt only when `library` is reassigned (every flow
// that changes it replaces the array rather than mutating it). A plain
// library.find() here was a full scan per lookup - fine at 50 tracks, not
// at ~2,500 with the queue calling this once per row every second.
let libraryIndex = new Map()
let libraryIndexFor = null
function trackByKey(key) {
  if (libraryIndexFor !== library) {
    libraryIndex = new Map(library.map((t) => [t.key, t]))
    libraryIndexFor = library
  }
  return libraryIndex.get(key)
}
// Every name that goes into the page as HTML - filenames, playlist and
// folder names, artist/genre tags (some come from the iTunes lookup, i.e.
// the internet) - is escaped first. Unescaped, a tag like "Weird Al"
// (with its quote marks) broke the picker's option values, and this window
// can delete and move real files, so nothing from outside may run in it.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

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

// Electron doesn't implement window.prompt() at all (it throws "prompt()
// is not supported" - window.confirm/alert are fine, prompt specifically
// isn't), so getting a folder name from the person needs this instead of
// the browser-native dialog. Resolves the trimmed name, or null on
// Cancel/Escape/an empty submit.
function askForFolderName() {
  const modal = document.getElementById('new-folder-modal')
  const input = document.getElementById('new-folder-input')
  input.value = ''
  modal.hidden = false
  input.focus()
  return new Promise((resolve) => {
    const createBtn = document.getElementById('new-folder-create')
    const cancelBtn = document.getElementById('new-folder-cancel')
    function cleanup(value) {
      modal.hidden = true
      createBtn.removeEventListener('click', onCreate)
      cancelBtn.removeEventListener('click', onCancel)
      input.removeEventListener('keydown', onKeydown)
      resolve(value)
    }
    function onCreate() { cleanup(input.value.trim() || null) }
    function onCancel() { cleanup(null) }
    function onKeydown(e) {
      if (e.key === 'Enter') onCreate()
      if (e.key === 'Escape') onCancel()
    }
    createBtn.addEventListener('click', onCreate)
    cancelBtn.addEventListener('click', onCancel)
    input.addEventListener('keydown', onKeydown)
  })
}

// Same modal-dialog approach as askForFolderName above (window.prompt()
// isn't available at all in Electron) - pre-fills with whatever's
// already tagged (auto-looked-up or previously manual) so correcting a
// wrong guess doesn't mean retyping a right genre too. Resolves the
// trimmed {artist, genre} (genre '' is fine, artist '' is not - the
// Save button is disabled until something's typed) or null on Cancel.
function askForTags(existingMeta) {
  const modal = document.getElementById('edit-tags-modal')
  const artistInput = document.getElementById('edit-tags-artist')
  const genreInput = document.getElementById('edit-tags-genre')
  artistInput.value = (existingMeta && existingMeta.artist !== 'Unknown' && existingMeta.artist) || ''
  genreInput.value = (existingMeta && existingMeta.genre !== 'Unknown' && existingMeta.genre) || ''
  modal.hidden = false
  artistInput.focus()
  return new Promise((resolve) => {
    const saveBtn = document.getElementById('edit-tags-save')
    const cancelBtn = document.getElementById('edit-tags-cancel')
    function cleanup(value) {
      modal.hidden = true
      saveBtn.removeEventListener('click', onSave)
      cancelBtn.removeEventListener('click', onCancel)
      artistInput.removeEventListener('keydown', onKeydown)
      genreInput.removeEventListener('keydown', onKeydown)
      resolve(value)
    }
    function onSave() {
      const artist = artistInput.value.trim()
      if (!artist) { artistInput.focus(); return }
      cleanup({ artist, genre: genreInput.value.trim() || 'Unknown' })
    }
    function onCancel() { cleanup(null) }
    function onKeydown(e) {
      if (e.key === 'Enter') onSave()
      if (e.key === 'Escape') onCancel()
    }
    saveBtn.addEventListener('click', onSave)
    cancelBtn.addEventListener('click', onCancel)
    artistInput.addEventListener('keydown', onKeydown)
    genreInput.addEventListener('keydown', onKeydown)
  })
}

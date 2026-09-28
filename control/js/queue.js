// Control window - The play queue. Display plays by POSITION, so every change here keeps the two windows' positions in step (rules in ../shared/queue-rules.js).
// Plain scripts loaded in order by index.html; they share one global scope.

// --- Queue ---

async function saveAndSyncQueue() {
  await jukebox.saveQueue(queue)
  renderQueue()
}

// Display only ever needs a path to play - handing it the converted
// copy's path (when one exists) under the same track shape means it
// never has to know conversion is a thing at all.
function toDisplayTrack(track) {
  return { ...track, path: playablePath(track) }
}

async function playNow(key) {
  queue = { tracks: [key], currentIndex: 0 }
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: [toDisplayTrack(trackByKey(key))], startIndex: 0 })
}

async function addToQueue(key) {
  queue.tracks.push(key)
  await saveAndSyncQueue()
  sendQueueToDisplay()
}

// Hands Display the current track list without touching playback (same as
// Shuffle). Adding to the end, or moving/removing something still to come,
// used to only update this window's list - Display kept playing its own old
// copy, so a song added with "+ Queue" mid-song never actually played.
function sendQueueToDisplay() {
  jukebox.playerUpdateQueue(displayQueue())
}

// One entry per queue position, always - see buildDisplayQueue in
// ../shared/queue-rules.js for why a missing file gets a stand-in.
function displayQueue() {
  return buildDisplayQueue(queue.tracks, trackByKey, toDisplayTrack)
}

// Whole library, shuffled - excludes anything still needing conversion,
// same rule the individual track tiles already follow (no +Queue button
// shows for those either, since Display can't actually play them yet).
document.getElementById('add-all-queue-btn').addEventListener('click', async () => {
  const keys = library.filter((t) => !t.needsConversion).map((t) => t.key)
  if (!keys.length) return
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
  }
  queue.tracks.push(...keys)
  await saveAndSyncQueue()
  sendQueueToDisplay()
})

document.getElementById('clear-queue-btn').addEventListener('click', async () => {
  queue = { tracks: [], currentIndex: 0 }
  await saveAndSyncQueue()
})

document.getElementById('reset-library-btn').addEventListener('click', async () => {
  const sure = confirm(
    'Clear every playlist, the queue, and cached thumbnails/conversions, and un-set the media folder?\n\n' +
    'Your actual video files are NOT deleted — you\'ll just need to choose the media folder again.\n\n' +
    'This cannot be undone.'
  )
  if (!sure) return

  settings = await jukebox.resetLibrary()
  library = []
  metadataCache = {}
  playlists = []
  queue = { tracks: [], currentIndex: 0 }
  document.getElementById('settings-folder').value = ''
  document.getElementById('library-folder-label').textContent = 'No media folder set — go to Settings.'
  document.getElementById('library-status').textContent = ''
  renderLibrary()
  renderPlaylists()
  renderQueue()
})

// Only this many upcoming rows are drawn - an "Add All to Queue" of the
// whole library would otherwise be ~2,500 rows rebuilt on every change.
const QUEUE_ROWS_SHOWN = 200
// What the queue list was last drawn from - the player reports its state
// every second, but the list only needs redrawing when one of these
// actually changes (see onPlayerState below).
let lastQueueSignature = ''
function queueSignature() {
  return [queue.tracks.length, queue.currentIndex, lastPlayerState && lastPlayerState.status, library.length].join('|')
}

function renderQueue() {
  lastQueueSignature = queueSignature()
  const list = document.getElementById('queue-list')
  // Already-played tracks drop off the visible list entirely (this is
  // display-only - queue.tracks/currentIndex themselves are untouched,
  // so Previous still works and the persisted queue.json stays a full
  // history+upcoming record). Once the queue reaches idle (finished, as
  // opposed to "hasn't started yet"), the last-played track drops off
  // too, since currentIndex never advances past it in that case.
  const finished = lastPlayerState && lastPlayerState.status === 'idle'
  const firstShown = queue.currentIndex + (finished ? 1 : 0)
  const lastShown = firstShown + QUEUE_ROWS_SHOWN
  const hiddenAfter = Math.max(0, queue.tracks.length - lastShown)
  list.innerHTML = queue.tracks.map((key, i) => {
    if (i < firstShown || i >= lastShown) return ''
    const track = trackByKey(key)
    if (!track) return ''
    const isNowPlaying = i === queue.currentIndex && lastPlayerState && lastPlayerState.status !== 'idle'
    // The song on screen can't be moved, and nothing can be moved above
    // it - Display is playing it by position, so shifting it would leave
    // the two windows disagreeing about what's playing.
    const active = isQueueActive()
    const canMoveUp = canMoveQueueItem(i, -1, queue.tracks.length, queue.currentIndex, active)
    const canMoveDown = canMoveQueueItem(i, 1, queue.tracks.length, queue.currentIndex, active)
    return `
      <li class="queue-row ${isNowPlaying ? 'now-playing' : ''}">
        <span class="queue-index">${i + 1}</span>
        <span style="flex:1">${esc(track.filename)}</span>
        ${requestedKeys.has(key) && i >= queue.currentIndex ? '<span class="request-tag">Request</span>' : ''}
        <span>${fmtTime(track.duration)}</span>
        <div class="button-row">
          <button class="secondary" data-move-up="${i}" ${canMoveUp ? '' : 'disabled'}>↑</button>
          <button class="secondary" data-move-down="${i}" ${canMoveDown ? '' : 'disabled'}>↓</button>
          <button class="secondary" data-play-from="${i}">▶</button>
          <button class="danger" data-remove-idx="${i}" title="${isNowPlaying ? 'Remove it and play the next song' : 'Remove from the queue'}">✕</button>
        </div>
      </li>`
  }).join('') + (hiddenAfter ? `<p class="eyebrow">…and ${hiddenAfter} more after these.</p>` : '') || '<p class="eyebrow">Queue is empty — add tracks from the Library.</p>'

  list.querySelectorAll('[data-move-up]').forEach((el) => el.addEventListener('click', () => moveQueueItem(Number(el.dataset.moveUp), -1)))
  list.querySelectorAll('[data-move-down]').forEach((el) => el.addEventListener('click', () => moveQueueItem(Number(el.dataset.moveDown), 1)))
  list.querySelectorAll('[data-remove-idx]').forEach((el) => el.addEventListener('click', () => removeQueueItem(Number(el.dataset.removeIdx))))
  list.querySelectorAll('[data-play-from]').forEach((el) => el.addEventListener('click', () => playQueueFrom(Number(el.dataset.playFrom))))
  pushRequestStatus()
}

// Something is on screen (playing or paused) - Display is holding a position.
function isQueueActive() {
  return Boolean(lastPlayerState && lastPlayerState.status !== 'idle')
}

async function moveQueueItem(index, direction) {
  // Never move the song on screen, or swap another song into its place.
  if (!canMoveQueueItem(index, direction, queue.tracks.length, queue.currentIndex, isQueueActive())) return
  const target = index + direction
  const [item] = queue.tracks.splice(index, 1)
  queue.tracks.splice(target, 0, item)
  await saveAndSyncQueue()
  // only songs still to come - moving the one on screen stays as it was
  if (Math.min(index, target) > queue.currentIndex) sendQueueToDisplay()
}
async function removeQueueItem(index) {
  const result = removeQueueItemAt(queue, index, isQueueActive())
  queue = result.queue
  await saveAndSyncQueue()
  // Removing the song that's playing moves straight on to the next one -
  // Display had it by position, so leaving it playing would put the two
  // windows one song apart for the rest of the night.
  if (result.display === 'restart') jukebox.playerLoadQueue({ tracks: displayQueue(), startIndex: index })
  else if (result.display === 'update') sendQueueToDisplay()
}
async function playQueueFrom(index) {
  queue.currentIndex = index
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: displayQueue(), startIndex: index })
}

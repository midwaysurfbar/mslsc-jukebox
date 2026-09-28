// Control window - The now-playing bar: transport buttons, seek bar, shuffle, and the player state Display reports every second.
// Plain scripts loaded in order by index.html; they share one global scope.

// --- Now playing bar ---

let lastPlayerState = null
document.getElementById('np-previous').addEventListener('click', () => jukebox.playerPrevious())
document.getElementById('np-toggle').addEventListener('click', () => jukebox.playerTogglePlayPause())
document.getElementById('np-skip').addEventListener('click', () => jukebox.playerSkip())
document.getElementById('np-shuffle').addEventListener('click', shuffleUpcoming)

// --- Seek bar ---
//
// `isSeeking` is true for the whole time the mouse/touch is down on the
// slider - the once-a-second player-state updates below must not touch
// the slider's own value while it's true, or they'd yank the handle
// back to the real playhead mid-drag. The actual seek command only goes
// out on 'change' (fires once, on release) - not 'input' (fires
// continuously while dragging) - so scrubbing doesn't spam Display with
// a seek per pixel moved.
const npSeek = document.getElementById('np-seek')
let isSeeking = false

function paintSeekFill(pct) {
  npSeek.style.background = `linear-gradient(to right, #4fb3c4 ${pct}%, #ffffff2a ${pct}%)`
}

npSeek.addEventListener('pointerdown', () => { isSeeking = true })
// A plain click with no actual drag doesn't necessarily fire 'change'
// (browsers only fire it when the value genuinely moved) - resetting
// isSeeking here on 'pointerup' unconditionally, rather than inside the
// 'change' handler, means the slider can never get stuck ignoring
// player-state updates after a click that happened not to move it.
npSeek.addEventListener('pointerup', () => { isSeeking = false })
npSeek.addEventListener('input', () => paintSeekFill(Number(npSeek.value) / 10))
npSeek.addEventListener('change', () => {
  const duration = lastPlayerState?.duration || 0
  if (duration > 0) jukebox.playerSeek((Number(npSeek.value) / 1000) * duration)
})

// Randomises everything still to come, leaving whatever's currently
// playing (and anything already played before it) exactly where it is -
// pressing Shuffle should never interrupt what's on screen right now.
// Pushed to Display via playerUpdateQueue rather than playerLoadQueue,
// which would restart the current track from 0.
async function shuffleUpcoming() {
  const nowPlaying = lastPlayerState && lastPlayerState.status !== 'idle'
  const from = nowPlaying ? queue.currentIndex + 1 : 0
  if (queue.tracks.length - from < 2) return // nothing left to shuffle

  const upcoming = queue.tracks.slice(from)
  for (let i = upcoming.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]]
  }
  queue.tracks = [...queue.tracks.slice(0, from), ...upcoming]
  await saveAndSyncQueue()
  jukebox.playerUpdateQueue(displayQueue())
}

jukebox.onPlayerState((state) => {
  lastPlayerState = state
  document.getElementById('np-title').textContent = state.currentTrack ? state.currentTrack.filename : 'Nothing playing'
  document.getElementById('np-time').textContent = fmtTime(state.timeElapsed)
  document.getElementById('np-duration').textContent = fmtTime(state.duration)
  if (!isSeeking) {
    const pct = state.duration ? (state.timeElapsed / state.duration) * 100 : 0
    npSeek.value = pct * 10
    paintSeekFill(pct)
  }
  if (state.status === 'error' && state.errorTrack) {
    document.getElementById('library-status').textContent = `"${state.errorTrack.filename}" could not be played — ${state.errorReason || 'unsupported format'} — skipped.`
  }
  // Keep the queue view's now-playing highlight and currentIndex in sync.
  if (typeof state.currentIndex === 'number' && state.currentIndex !== queue.currentIndex) {
    queue.currentIndex = state.currentIndex
    jukebox.saveQueue(queue)
  }
  if (queueSignature() !== lastQueueSignature) renderQueue()
})

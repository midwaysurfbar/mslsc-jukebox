// Crossfade playback engine. Owns real-time playback state entirely -
// given a queue + start index it plays through autonomously (including
// auto-advance and crossfade), and just reports state changes back to
// the Control window via reportState(). Skip/previous/pause/etc are the
// only things Control can push in from outside.

const deckA = document.getElementById('deckA')
const deckB = document.getElementById('deckB')
const idleOverlay = document.getElementById('idle')

let queue = []
let currentIndex = -1
let crossfadeSeconds = 3
let volume = 1
let activeDeck = deckA
let idleDeck = deckB
let isPlaying = false
let isTransitioning = false
let reportTimer = null

function otherDeck(deck) {
  return deck === deckA ? deckB : deckA
}

// Windows paths use backslashes - encodeURIComponent per-segment on a
// forward-slash split would mangle them, so split on whichever this
// path actually uses. The URL itself must always use forward slashes
// regardless of the source OS - a file:// URL with backslashes is
// invalid and silently fails to load on Windows.
// A Windows path's drive letter (e.g. "C:") must stay literal in a
// file:// URL - encodeURIComponent turns ":" into "%3A", which produces
// a URL that can't resolve to any real file. Everything AFTER the
// drive letter still needs normal per-segment encoding (spaces, etc),
// same as a POSIX path.
function fileUrl(filePath) {
  const winMatch = filePath.match(/^([A-Za-z]:)[\\/](.*)$/)
  if (winMatch) {
    const [, drive, rest] = winMatch
    const encoded = rest.split(/[\\/]/).map(encodeURIComponent).join('/')
    return `file:///${drive}/${encoded}`
  }
  return 'file://' + filePath.split('/').map(encodeURIComponent).join('/')
}

function currentTrack() {
  return queue[currentIndex] || null
}

function setDeckTransitionDuration(seconds) {
  deckA.style.transitionDuration = `${seconds}s`
  deckB.style.transitionDuration = `${seconds}s`
}

function reportState(extra = {}) {
  const track = currentTrack()
  jukebox.reportState({
    status: isPlaying ? 'playing' : (track ? 'paused' : 'idle'),
    currentIndex,
    currentTrack: track,
    timeElapsed: activeDeck.currentTime || 0,
    duration: activeDeck.duration || 0,
    queueLength: queue.length,
    ...extra,
  })
}

function showIdleOverlay(show) {
  idleOverlay.classList.toggle('hidden', !show)
}

// HTMLMediaElement's standard error codes - MEDIA_ERR_SRC_NOT_SUPPORTED
// (4) is what fires for a codec/container Chromium can't decode, which
// is the by-far-most-common failure for downloaded video files. `.message`
// is a Chromium-specific (non-standard but present) extension that often
// has genuinely useful detail (e.g. naming the codec), included whenever
// it's there.
function describeMediaError(err) {
  const reasons = {
    1: 'The download was aborted before it finished loading.',
    2: 'A network error interrupted loading this file.',
    3: 'The file appears to be corrupt, or uses a codec that failed to decode.',
    4: "This file's format or codec isn't supported (needs MP4/H.264 or WebM/VP9 - not HEVC, AV1, AVI or WMV).",
  }
  const base = reasons[err?.code] || 'Unknown playback error.'
  return err?.message ? `${base} (${err.message})` : base
}

async function loadDeck(deck, track) {
  return new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(describeMediaError(deck.error)) }
    function cleanup() {
      deck.removeEventListener('canplay', onReady)
      deck.removeEventListener('error', onError)
    }
    deck.addEventListener('canplay', onReady, { once: true })
    deck.addEventListener('error', onError, { once: true })
    deck.src = fileUrl(track.path)
    deck.load()
  })
}

async function playIndex(index) {
  if (index < 0 || index >= queue.length) {
    // The idle overlay visually covers the stage either way, but the
    // active deck was still genuinely playing (audio and all) right up
    // until this call - stop it for real, don't just paint over it.
    activeDeck.pause()
    idleDeck.pause()
    activeDeck.classList.remove('active')
    idleDeck.classList.remove('active')
    isPlaying = false
    showIdleOverlay(true)
    reportState({ status: 'idle' })
    return
  }
  currentIndex = index
  const track = queue[index]
  try {
    await loadDeck(activeDeck, track)
  } catch (reason) {
    reportState({ status: 'error', errorTrack: track, errorReason: reason })
    // Don't stall the room on one bad file - move on after a moment.
    setTimeout(() => playIndex(index + 1), 2500)
    return
  }
  activeDeck.volume = volume
  activeDeck.classList.add('active')
  otherDeck(activeDeck).classList.remove('active')
  showIdleOverlay(false)
  activeDeck.currentTime = 0
  activeDeck.play()
  isPlaying = true
  isTransitioning = false
  reportState({ status: 'playing' })
}

async function beginCrossfade() {
  if (isTransitioning) return
  const nextIndex = currentIndex + 1
  if (nextIndex >= queue.length) return // nothing to crossfade into - let it just play out and end naturally
  isTransitioning = true

  const outgoing = activeDeck
  const incoming = idleDeck
  const nextTrack = queue[nextIndex]

  try {
    await loadDeck(incoming, nextTrack)
  } catch {
    // Next track won't play - skip the crossfade, just jump straight there
    // (playIndex handles its own error path/reporting/further skip).
    isTransitioning = false
    playIndex(nextIndex)
    return
  }

  incoming.volume = 0
  incoming.currentTime = 0
  incoming.classList.add('active')
  await incoming.play()

  const steps = 30
  const stepMs = (crossfadeSeconds * 1000) / steps
  for (let i = 1; i <= steps; i++) {
    incoming.volume = Math.min(1, (i / steps) * volume)
    outgoing.volume = Math.max(0, volume - (i / steps) * volume)
    await new Promise((r) => setTimeout(r, stepMs))
  }

  outgoing.classList.remove('active')
  outgoing.pause()
  outgoing.removeAttribute('src')
  outgoing.load()

  activeDeck = incoming
  idleDeck = outgoing
  currentIndex = nextIndex
  isTransitioning = false
  reportState({ status: 'playing' })
}

function onTimeUpdate() {
  if (!isTransitioning && activeDeck.duration && activeDeck.duration - activeDeck.currentTime <= crossfadeSeconds) {
    beginCrossfade()
  }
}

function onEnded() {
  // Fallback for a clip shorter than the crossfade window, or the last
  // track in the queue - crossfade logic above should normally have
  // already handled the swap before this ever fires.
  if (isTransitioning) return
  playIndex(currentIndex + 1)
}

for (const deck of [deckA, deckB]) {
  deck.muted = false
  deck.addEventListener('timeupdate', () => { if (deck === activeDeck) onTimeUpdate() })
  deck.addEventListener('ended', () => { if (deck === activeDeck) onEnded() })
}

setInterval(() => { if (isPlaying) reportState() }, 1000)

// --- Commands from Control (via main) ---

jukebox.onLoadQueue(({ tracks, startIndex }) => {
  queue = tracks || []
  playIndex(startIndex || 0)
})
jukebox.onPlay(() => { if (currentTrack()) { activeDeck.play(); isPlaying = true; reportState() } })
jukebox.onPause(() => { activeDeck.pause(); if (isTransitioning) idleDeck.pause(); isPlaying = false; reportState() })
jukebox.onTogglePlayPause(() => {
  if (!currentTrack()) return
  if (isPlaying) { activeDeck.pause(); isPlaying = false } else { activeDeck.play(); isPlaying = true }
  reportState()
})
jukebox.onSkip(() => { if (!isTransitioning) playIndex(currentIndex + 1) })
jukebox.onPrevious(() => {
  if (isTransitioning) return
  if (activeDeck.currentTime > 3) activeDeck.currentTime = 0
  else playIndex(Math.max(0, currentIndex - 1))
})
jukebox.onSetCrossfadeDuration((seconds) => { crossfadeSeconds = seconds; setDeckTransitionDuration(seconds) })
jukebox.onSetVolume((v) => { volume = v; if (!isTransitioning) activeDeck.volume = v })
jukebox.onSettingsUpdated((settings) => {
  crossfadeSeconds = settings.crossfadeSeconds
  volume = settings.volume
  setDeckTransitionDuration(crossfadeSeconds)
})

jukebox.getSettings().then((settings) => {
  crossfadeSeconds = settings.crossfadeSeconds
  volume = settings.volume
  setDeckTransitionDuration(crossfadeSeconds)
})

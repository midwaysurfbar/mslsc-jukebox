// Control window - The staff Remote (../remote/, served by ../requests.js).
// Plain scripts loaded in order by index.html; they share one global scope.
//
// The Remote is a web page on another screen (Sam, 2026-10-09: the venue
// PC's own screen became the touch-screen kiosk, so staff drive the music
// from the other PC). This window still owns the queue: every command the
// Remote sends is carried out here with the same functions as the buttons on
// this window, and this window keeps the Remote's picture of things current.

const REMOTE_ROWS = 80 // upcoming songs sent to the Remote

function remoteTrack(key) {
  const track = trackByKey(key)
  if (!track) return null
  const d = describeTrack(key) || {}
  return { k: key, t: d.title || track.filename, a: d.artist || '', dur: track.duration || 0, th: Boolean(track.thumbPath) }
}

let lastRemoteSig = ''
function pushRemoteStatus() {
  const st = lastPlayerState
  const active = isQueueActive()
  const from = firstUpcomingIndex()
  const rows = []
  for (let i = from; i < queue.tracks.length && rows.length < REMOTE_ROWS; i++) {
    const row = remoteTrack(queue.tracks[i])
    if (!row) continue
    row.i = i
    row.req = requestedKeys.has(queue.tracks[i])
    row.up = canMoveQueueItem(i, -1, queue.tracks.length, queue.currentIndex, active)
    row.down = canMoveQueueItem(i, 1, queue.tracks.length, queue.currentIndex, active)
    rows.push(row)
  }
  const snapshot = {
    status: st ? st.status : 'idle',
    nowPlaying: active && st.currentTrack ? remoteTrack(st.currentTrack.key) : null,
    elapsed: st ? st.timeElapsed || 0 : 0,
    duration: st ? st.duration || 0 : 0,
    volume: settings.volume,
    tvStartHidden: Boolean(settings.tvStartHidden),
    upcoming: rows,
    upcomingTotal: Math.max(0, queue.tracks.length - from),
    playlists: playlists.filter((p) => !p.hidden).map((p) => ({ id: p.id, name: p.name, n: p.trackKeys.length })),
    librarySize: library.length,
  }
  const sig = JSON.stringify(snapshot)
  if (sig === lastRemoteSig) return
  lastRemoteSig = sig
  jukebox.sendRemoteStatus(snapshot)
}

// The Remote names a queue row by position AND song, so a tap made just as
// the queue moved on can't act on the wrong song.
function queueRowIs(index, key) {
  return Number.isInteger(index) && index >= 0 && index < queue.tracks.length && queue.tracks[index] === key
}
function playableKey(key) {
  const track = trackByKey(key)
  return track && !track.needsConversion && !track.error
}
const CHANGED = { ok: false, error: 'The queue just changed - have another look and try again.' }
const NOT_PLAYABLE = { ok: false, error: 'That song can\'t be played right now.' }

const remoteActions = {
  async toggle() {
    if (isQueueActive()) { jukebox.playerTogglePlayPause(); return { ok: true } }
    const start = firstUpcomingIndex()
    if (start >= queue.tracks.length) return { ok: false, error: 'The queue is empty - add some songs first.' }
    await playQueueFrom(start)
    return { ok: true }
  },
  skip() { jukebox.playerSkip(); return { ok: true } },
  previous() { jukebox.playerPrevious(); return { ok: true } },
  seek({ fraction }) {
    const duration = lastPlayerState?.duration || 0
    const f = Number(fraction)
    if (!(duration > 0) || !(f >= 0 && f <= 1)) return { ok: false, error: 'Nothing to move through.' }
    jukebox.playerSeek(f * duration)
    return { ok: true }
  },
  // Control owns settings.json (it writes its whole copy back), so the
  // setting is changed here rather than by the main process.
  async 'tv-start-hidden'({ hidden }) {
    settings.tvStartHidden = Boolean(hidden)
    await jukebox.saveSettings(settings)
    return { ok: true }
  },
  volume({ volume }) {
    const v = Math.round(Math.min(1, Math.max(0, Number(volume) || 0)) * 20) / 20 // 5% steps, like the slider here
    settings.volume = v
    document.getElementById('volume-slider').value = Math.round(v * 100)
    document.getElementById('volume-value').textContent = Math.round(v * 100)
    saveSettingsSoon()
    jukebox.playerSetVolume(v)
    return { ok: true }
  },
  // Add to the end of the queue. Nothing on screen: start with it.
  async add({ key }) {
    if (!playableKey(key)) return NOT_PLAYABLE
    const start = firstUpcomingIndex()
    queue.tracks.push(key)
    await saveAndSyncQueue()
    if (!isQueueActive()) await playQueueFrom(start)
    else sendQueueToDisplay()
    return { ok: true }
  },
  // Straight after the song that's on now.
  async next({ key }) {
    if (!playableKey(key)) return NOT_PLAYABLE
    const at = firstUpcomingIndex()
    queue.tracks.splice(at, 0, key)
    await saveAndSyncQueue()
    if (!isQueueActive()) await playQueueFrom(at)
    else sendQueueToDisplay()
    return { ok: true }
  },
  async move({ index, key, direction }) {
    if (!queueRowIs(index, key)) return CHANGED
    const dir = direction === -1 ? -1 : 1
    if (!canMoveQueueItem(index, dir, queue.tracks.length, queue.currentIndex, isQueueActive())) return { ok: false, error: 'That song can\'t move any further.' }
    await moveQueueItem(index, dir)
    return { ok: true }
  },
  async remove({ index, key }) {
    if (!queueRowIs(index, key)) return CHANGED
    await removeQueueItem(index)
    return { ok: true }
  },
  async 'play-from'({ index, key }) {
    if (!queueRowIs(index, key)) return CHANGED
    await playQueueFrom(index)
    return { ok: true }
  },
  async shuffle() { await shuffleUpcoming(); return { ok: true } },
  // Clears what's still to come - the song on screen (and what already
  // played, for Previous) stays.
  async clear() {
    queue.tracks = queue.tracks.slice(0, firstUpcomingIndex())
    await saveAndSyncQueue()
    sendQueueToDisplay()
    return { ok: true }
  },
  async 'playlist-play'({ id }) {
    const p = playlists.find((x) => x.id === id)
    if (!p || !p.trackKeys.length) return { ok: false, error: 'That playlist is empty.' }
    await playPlaylistNow(id)
    return { ok: true }
  },
  async 'playlist-queue'({ id }) {
    const p = playlists.find((x) => x.id === id)
    if (!p || !p.trackKeys.length) return { ok: false, error: 'That playlist is empty.' }
    const start = firstUpcomingIndex()
    await appendPlaylistToQueue(id)
    if (!isQueueActive()) await playQueueFrom(start)
    return { ok: true }
  },
}

jukebox.onRemoteCommand(async ({ id, action, args }) => {
  let result
  try {
    const fn = Object.prototype.hasOwnProperty.call(remoteActions, action) ? remoteActions[action] : null
    result = fn ? await fn(args || {}) : { ok: false, error: 'Unknown command.' }
  } catch (err) {
    result = { ok: false, error: 'Something went wrong on the Jukebox.' }
  }
  jukebox.replyRemote(id, result)
  pushRemoteStatus()
})

jukebox.onPlayerState(() => pushRemoteStatus())
// Playlists and settings change without the player saying anything.
setInterval(pushRemoteStatus, 3000)

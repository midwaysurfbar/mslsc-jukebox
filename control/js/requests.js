// Control window - Patron song requests (see ../requests.js) and the touch-screen set-up in Settings.
// Plain scripts loaded in order by index.html; they share one global scope.

// --- Song requests (patron touch screen - see requests.js) ---
//
// The rules are checked here because this window owns the queue: a request
// joins the END of the queue like any song added here, only while fewer
// than 20 are waiting, never while the same song is waiting or playing, and
// not within 10 minutes of it last playing. Staff adding songs here are
// never limited. Nothing in this section runs unless a request comes in.

const requestedKeys = new Map() // key -> when requested (for the "Request" tag)
const lastStarted = new Map()   // key -> when it last started playing
let lastStartedKey = null
let requestsState = null

function describeTrack(key) {
  const track = trackByKey(key)
  if (!track) return null
  const guess = guessArtistTitle(track.filename)
  const meta = metadataCache[key]
  return { title: guess.title, artist: meta && meta.artist && meta.artist !== 'Unknown' ? meta.artist : guess.artist }
}
// Index of the first song still to come (after whatever is on screen, or
// finished last).
function firstUpcomingIndex() {
  return lastPlayerState && lastPlayerState.currentTrack ? queue.currentIndex + 1 : queue.currentIndex
}
function playingKey() {
  return lastPlayerState && lastPlayerState.status !== 'idle' && lastPlayerState.currentTrack ? lastPlayerState.currentTrack.key : null
}

// What the picker shows: now playing, the next few, and how many are waiting.
let lastRequestStatus = ''
function pushRequestStatus() {
  const waiting = queue.tracks.slice(firstUpcomingIndex())
  const snapshot = {
    nowPlaying: playingKey() ? describeTrack(playingKey()) : null,
    upNext: waiting.slice(0, 3).map(describeTrack).filter(Boolean),
    waiting: waiting.length,
  }
  const sig = JSON.stringify(snapshot)
  if (sig === lastRequestStatus) return
  lastRequestStatus = sig
  jukebox.sendRequestStatus(snapshot)
  renderRequestsUi()
}

async function handleSongRequest(key, maxWaiting, repeatMinutes) {
  const start = firstUpcomingIndex()
  const verdict = checkSongRequest({
    track: trackByKey(key),
    key,
    waitingKeys: queue.tracks.slice(start),
    playingKey: playingKey(),
    lastStartedAt: lastStarted.get(key),
    now: Date.now(),
    maxWaiting,
    repeatMinutes,
  })
  if (!verdict.ok) return verdict

  queue.tracks.push(key)
  requestedKeys.set(key, Date.now())
  await jukebox.saveQueue(queue)
  // Nothing on screen (the queue had finished, or never started): start
  // with the request. Paused by staff: leave it paused, just add it.
  if (!lastPlayerState || lastPlayerState.status === 'idle') await playQueueFrom(start)
  else sendQueueToDisplay()
  renderQueue()
  return verdict
}

jukebox.onRequestIncoming(async ({ id, key, maxWaiting, repeatMinutes }) => {
  let result
  try { result = await handleSongRequest(key, maxWaiting, repeatMinutes) } catch { result = { ok: false, reason: 'busy' } }
  jukebox.replyRequest(id, result)
})

// Remember when each song starts, for the 10-minute rule; its "Request"
// tag comes off once it's playing.
jukebox.onPlayerState((state) => {
  const key = state.status === 'playing' && state.currentTrack ? state.currentTrack.key : null
  if (key && key !== lastStartedKey) {
    lastStartedKey = key
    lastStarted.set(key, Date.now())
    requestedKeys.delete(key)
    pushRequestStatus()
  } else if (!key && state.status === 'idle') {
    lastStartedKey = null
    pushRequestStatus()
  }
})

// ---- Requests on/off switch + touch screen set-up ----
const requestsToggle = document.getElementById('requests-toggle')
function waitingRequestIndexes() {
  const start = firstUpcomingIndex()
  const out = []
  queue.tracks.forEach((k, i) => { if (i >= start && requestedKeys.has(k)) out.push(i) })
  return out
}
function timeAgo(ms) {
  if (!ms) return 'not used yet'
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 2) return 'in use now'
  if (mins < 60) return `last used ${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `last used ${hours} h ago` : `last used ${new Date(ms).toLocaleDateString()}`
}
function renderRequestsUi() {
  const st = requestsState
  if (!st) return
  requestsToggle.checked = st.enabled
  const waiting = queue.tracks.slice(firstUpcomingIndex()).length
  const requests = waitingRequestIndexes().length
  document.getElementById('requests-summary').textContent = !st.enabled
    ? 'Off - the song picker is closed. Songs added here aren\'t limited.'
    : st.barAllows === false
    ? 'On, but the bar is closed - the picker shows "Bar closed" until the bar opens. Songs added here aren\'t limited.'
    : `On - ${Math.min(waiting, st.maxWaiting)} of ${st.maxWaiting} places used${waiting >= st.maxWaiting ? ' (full - the picker says please wait)' : ''}${requests ? ` · ${requests} request${requests === 1 ? '' : 's'} waiting` : ''}${st.devices.length ? '' : ' · no touch screen set up yet (see Settings)'}`
  document.getElementById('clear-requests-btn').hidden = !requests

  const list = document.getElementById('requests-devices')
  list.innerHTML = st.devices.length
    ? st.devices.map((d) => `<div class="web-ad-row"><span><b>${esc(d.name)}</b> · ${d.kind === 'remote' ? 'staff remote' : 'song picker'} · ${timeAgo(d.lastSeen)}</span><button class="danger" data-remove-device="${esc(d.id)}">Remove</button></div>`).join('')
    : '<p class="eyebrow" style="margin:0">No touch screens or remotes set up yet.</p>'
  list.querySelectorAll('[data-remove-device]').forEach((el) => el.addEventListener('click', async () => {
    if (!confirm('Remove this screen? It will need setting up again before it can be used.')) return
    requestsState = await jukebox.removeRequestDevice(el.dataset.removeDevice)
    renderRequestsUi()
  }))

  const box = document.getElementById('pairing-box')
  box.hidden = !st.pairing
  if (st.pairing) {
    const address = st.addresses.find((a) => /\/\/(192\.168|10\.|172\.)/.test(a)) || st.addresses[0] || `http://<this PC's address>:${st.port}`
    const remote = st.pairing.kind === 'remote'
    document.getElementById('pairing-intro').textContent = remote ? 'On the remote screen (another PC, phone or tablet), open this address in the browser:' : 'On the touch screen, open this address in the browser:'
    document.getElementById('pairing-address').textContent = remote ? `${address}/remote` : address
    document.getElementById('pairing-code').textContent = st.pairing.code
    const mins = Math.max(0, Math.ceil((st.pairing.expiresAt - Date.now()) / 60000))
    document.getElementById('pairing-expiry').textContent = `This code works for ${mins} more minute${mins === 1 ? '' : 's'}.`
  }
  document.getElementById('requests-message').textContent = st.serverError || ''
}
async function refreshRequestsState() {
  try {
    requestsState = await jukebox.getRequestsState()
    renderRequestsUi()
  } catch {
    // The request feature didn't load - hide its controls; the Jukebox itself is unaffected.
    document.getElementById('requests-bar').hidden = true
  }
}
requestsToggle.addEventListener('change', async () => {
  try {
    requestsState = await jukebox.setRequestsEnabled(requestsToggle.checked)
  } catch (err) {
    requestsToggle.checked = !requestsToggle.checked
  }
  renderRequestsUi()
})
document.getElementById('clear-requests-btn').addEventListener('click', async () => {
  const drop = new Set(waitingRequestIndexes())
  if (!drop.size || !confirm(`Remove the ${drop.size} waiting request${drop.size === 1 ? '' : 's'} from the queue?`)) return
  queue.tracks = queue.tracks.filter((_, i) => !drop.has(i))
  requestedKeys.clear()
  await saveAndSyncQueue()
  sendQueueToDisplay()
})
document.getElementById('pair-screen-btn').addEventListener('click', async () => {
  requestsState = await jukebox.startRequestPairing('picker')
  renderRequestsUi()
})
document.getElementById('pair-remote-btn').addEventListener('click', async () => {
  requestsState = await jukebox.startRequestPairing('remote')
  renderRequestsUi()
})
document.getElementById('cancel-pairing-btn').addEventListener('click', async () => {
  requestsState = await jukebox.cancelRequestPairing()
  renderRequestsUi()
})
jukebox.onRequestsState((state) => {
  const newDevice = requestsState && state.devices.length > requestsState.devices.length
  requestsState = state
  renderRequestsUi()
  // a pairing started from a remote shows up here too
  if (newDevice) document.getElementById('requests-message').textContent = `${state.devices[state.devices.length - 1].name} is set up and ready.`
})
// keep the code's "minutes left" and each screen's "last used" current
setInterval(renderRequestsUi, 30000)

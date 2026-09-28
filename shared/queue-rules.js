// The queue's rules as plain functions - no windows, no files - so they can
// be tested on their own (test/queue-rules.test.js). The Control window
// owns the queue and calls these; the Display window plays by POSITION, so
// every rule here keeps Control's positions and Display's in step.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else Object.assign(root, api)
})(typeof self !== 'undefined' ? self : this, function () {
  // The queue as Display gets it: exactly one entry per queue position. A
  // key whose file is gone becomes a stand-in Display skips past - leaving
  // it out would shift every later position by one.
  function buildDisplayQueue(keys, lookup, toDisplayTrack) {
    return keys.map((key) => {
      const track = lookup(key)
      return track ? toDisplayTrack(track) : { key, filename: '(file no longer in the library)', path: '', missing: true }
    })
  }

  // Can the row at `index` move one place in `direction` (-1 up, +1 down)?
  // While something is on screen (`active`), the song at currentIndex stays
  // put and nothing can move into its place.
  function canMoveQueueItem(index, direction, length, currentIndex, active) {
    const target = index + direction
    if (target < 0 || target >= length) return false
    return !active || Math.min(index, target) > currentIndex
  }

  // Returns the new queue plus what Display needs to hear about it:
  //   'restart' - the song on screen was removed: start the one now at its
  //               position (effectively a skip)
  //   'update'  - something still to come was removed: send the new list
  //   'none'    - an already-played song was removed (positions before the
  //               current one shift, so currentIndex follows)
  function removeQueueItemAt(queue, index, active) {
    const tracks = queue.tracks.slice()
    tracks.splice(index, 1)
    const onScreen = active && index === queue.currentIndex
    const currentIndex = index < queue.currentIndex ? queue.currentIndex - 1 : queue.currentIndex
    const display = onScreen ? 'restart' : index > queue.currentIndex ? 'update' : 'none'
    return { queue: { tracks, currentIndex }, display }
  }

  // A patron request (Sam, 2026-09-28): joins the END of the queue, only
  // while fewer than maxWaiting songs are waiting, never while the same
  // song is waiting or playing, and not within repeatMinutes of it last
  // starting. Returns {ok:false, reason[, minutes]} or {ok:true, position}.
  function checkSongRequest({ track, key, waitingKeys, playingKey, lastStartedAt, now, maxWaiting, repeatMinutes }) {
    if (!track || track.needsConversion || track.error) return { ok: false, reason: 'unavailable' }
    if (waitingKeys.length >= maxWaiting) return { ok: false, reason: 'full' }
    if (waitingKeys.includes(key) || playingKey === key) return { ok: false, reason: 'queued' }
    const waitMs = lastStartedAt ? lastStartedAt + repeatMinutes * 60000 - now : 0
    if (waitMs > 0) return { ok: false, reason: 'recent', minutes: Math.ceil(waitMs / 60000) }
    return { ok: true, position: waitingKeys.length + 1 }
  }

  return { buildDisplayQueue, canMoveQueueItem, removeQueueItemAt, checkSongRequest }
})

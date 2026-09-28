// Live media-folder watching: a folder or file dropped into the media
// folder while the app is open shows up on its own, without Rescan Folder.
//
// fs.watch's `recursive: true` works on Windows and macOS (the venue PC is
// Windows) but throws on Linux, where a plain 3-second poll stands in.
// Changes are debounced: a copy (or this app's own Sort/Move) fires many
// events at once, and one rescan per burst is plenty. The 400ms delay is
// the only real lag between "file lands" and "library updates", so it's
// the one knob worth keeping small.
const fs = require('node:fs')

function createMediaWatch(onChange) {
  let watcher = null
  let pollTimer = null
  let debounce = null

  function stop() {
    if (watcher) { try { watcher.close() } catch { /* already gone */ } watcher = null }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (debounce) { clearTimeout(debounce); debounce = null }
  }

  function changed() {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(onChange, 400)
  }

  function start(mediaFolder) {
    stop()
    if (!mediaFolder) return
    try {
      watcher = fs.watch(mediaFolder, { recursive: true }, changed)
      // A drive or share disappearing surfaces as an 'error' - not fatal;
      // the next successful scan picks back up normally.
      watcher.on('error', () => {})
    } catch {
      watcher = null
      pollTimer = setInterval(changed, 3000)
    }
  }

  return { start, stop }
}

module.exports = { createMediaWatch }

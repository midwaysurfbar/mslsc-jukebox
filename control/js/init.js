// Control window - Software update status, and start-up. Loaded last.
// Plain scripts loaded in order by index.html; they share one global scope.

// --- Software update (Settings tab) ---

document.getElementById('check-update-btn').addEventListener('click', async () => {
  const status = document.getElementById('update-status')
  const result = await jukebox.checkForUpdates()
  // Anything else (checking/available/not-available/downloaded/error) is
  // reported by the onUpdateStatus listener below as electron-updater's
  // real events come in - this button just kicks a check off.
  if (result.state === 'dev-mode') status.textContent = 'Auto-update only runs in the installed app, not this dev copy.'
})

jukebox.onUpdateStatus((status) => {
  const el = document.getElementById('update-status')
  if (status.state === 'checking') el.textContent = 'Checking for updates…'
  else if (status.state === 'available') el.textContent = `Update ${status.version} found - downloading…`
  else if (status.state === 'not-available') el.textContent = `You're on the latest version (${status.version}).`
  else if (status.state === 'downloaded') el.textContent = `Update ${status.version} downloaded - a popup will offer to install it.`
  else if (status.state === 'error') el.textContent = `Could not check for updates: ${status.message}`
})

// --- Init ---

// Hands the queue that survived from before the app was last closed back
// to Display, which otherwise starts fully idle/empty even though this
// window's own Queue tab still shows it - the persisted list only really
// "reappears" once Display is actually resumed on it. Full tracks array
// (not just what's left unplayed) so Previous still reaches back into
// whatever already played before the restart, same as any other resume.
function resumeQueueOnDisplay() {
  if (!queue.tracks.length || queue.currentIndex >= queue.tracks.length) return
  const tracks = displayQueue()
  if (!tracks.length) return
  jukebox.playerLoadQueue({ tracks, startIndex: queue.currentIndex })
}

jukebox.onDisplayRestarted(() => resumeQueueOnDisplay())

async function init() {
  await loadSettings()
  playlists = await jukebox.getPlaylists()
  queue = await jukebox.getQueue()
  renderPlaylists()
  renderQueue()
  if (settings.mediaFolder) await runLibraryOp(rescanLibrary)
  // rescanLibrary doesn't itself re-render the queue, so the earlier
  // renderQueue() above ran against an empty library - re-render now
  // that trackByKey can actually resolve the persisted queue's tracks.
  renderQueue()
  resumeQueueOnDisplay()
  refreshRequestsState()
  pushRequestStatus()
  document.getElementById('app-version').textContent = await jukebox.getAppVersion()
}
init()

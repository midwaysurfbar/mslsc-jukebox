// Auto-update from GitHub Releases (mirrors MSLSC Shell's proven pattern).
// Downloads in the background; once ready, a native dialog offers "Update
// Now" or "Later" - either way it installs the next time the app closes.
// Settings' "Check for Updates" shows live status through sendStatus.
const { autoUpdater } = require('electron-updater')

function createUpdates({ app, dialog, getControlWindow, sendStatus, onReady }) {
  let promptShowing = false

  async function promptToInstall(version) {
    if (promptShowing) return // a recheck landing mid-prompt shouldn't stack a second one
    promptShowing = true
    const result = await dialog.showMessageBox(getControlWindow(), {
      type: 'info',
      title: 'Update available',
      message: `MSLSC Jukebox ${version} is ready to install.`,
      detail: 'Update now (the app restarts - only takes a moment), or later, when it\'ll install automatically the next time the app closes.',
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    promptShowing = false
    if (result.response === 0) autoUpdater.quitAndInstall()
  }

  function start() {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    if (process.env.JUKEBOX_DEBUG) autoUpdater.logger = console

    autoUpdater.on('checking-for-update', () => sendStatus({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => sendStatus({ state: 'available', version: info.version }))
    autoUpdater.on('update-not-available', () => sendStatus({ state: 'not-available', version: app.getVersion() }))
    autoUpdater.on('update-downloaded', (info) => {
      onReady()
      sendStatus({ state: 'downloaded', version: info.version })
      promptToInstall(info.version)
    })
    autoUpdater.on('error', (err) => {
      if (process.env.JUKEBOX_DEBUG) console.log('AUTO-UPDATE ERROR', err)
      sendStatus({ state: 'error', message: err.message })
    })

    check()
    setInterval(check, 4 * 60 * 60 * 1000)
  }

  // Offline is normal at the venue - a failed check is reported through the
  // 'error' event above, never as an unhandled rejection.
  function check() {
    autoUpdater.checkForUpdates().catch(() => {})
  }

  function checkNow() {
    if (!app.isPackaged) return { state: 'dev-mode' }
    check()
    return { state: 'checking' }
  }

  return { start, checkNow, quitAndInstall: () => autoUpdater.quitAndInstall() }
}

module.exports = { createUpdates }

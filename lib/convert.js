// Format conversion with the bundled ffmpeg: re-encodes files Chromium
// can't decode (HEVC, AV1, AVI, WMV...) to plain H.264/AAC MP4, and - once a
// converted copy checks out - puts it in the original's place. No Electron
// here: main.js passes in the ffmpeg path and the Recycle Bin call.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { fileKey, requireFileKey, isNetworkPath } = require('./library')

// No cap on file size - a bigger source just takes longer - but capped on
// wall-clock time, so a stuck ffmpeg (corrupt source, flaky network read)
// can't leave the button on "Converting…" forever.
const CONVERT_TIMEOUT_MS = 10 * 60 * 1000

function createConverter({ store, library, ffmpegPath, trashItem }) {
  const { paths } = store

  // A file's length from ffmpeg's "Duration: hh:mm:ss.xx" line - works on
  // formats Chromium can't play, which are exactly the originals.
  function probeDuration(filePath) {
    return new Promise((resolve) => {
      let stderr = ''
      let proc
      try {
        proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath])
      } catch {
        resolve(null)
        return
      }
      const timer = setTimeout(() => { try { proc.kill() } catch { /* already gone */ } }, 60000)
      proc.stderr.on('data', (chunk) => { stderr += chunk })
      proc.on('error', () => { clearTimeout(timer); resolve(null) })
      proc.on('close', () => {
        clearTimeout(timer)
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null)
      })
    })
  }

  function convertedPathFor(key) {
    return path.join(paths.converted, `${requireFileKey(key)}.mp4`)
  }

  // The original is never touched; the result is cached under the file's
  // key, so it only ever needs converting once.
  function runConversion(key, sourcePath) {
    requireFileKey(key)
    return new Promise((resolve, reject) => {
      fs.mkdirSync(paths.converted, { recursive: true })
      const outputPath = path.join(paths.converted, `${key}.mp4`)
      const tempPath = path.join(paths.converted, `${key}.tmp.mp4`)
      const ffmpeg = spawn(ffmpegPath, [
        '-y',
        '-i', sourcePath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        tempPath,
      ])

      let stderrTail = ''
      let settled = false

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        ffmpeg.kill('SIGKILL')
        // SIGKILL doesn't release the file handle synchronously on Windows -
        // an EBUSY here once crashed the whole app live at the venue, so the
        // temp-file clean-up is best effort only.
        try { fs.rmSync(tempPath, { force: true }) } catch { /* still locked - ignore, not fatal */ }
        reject(new Error(`Conversion timed out after ${CONVERT_TIMEOUT_MS / 60000} minutes - the source may be corrupted or on a slow/unreachable network location.`))
      }, CONVERT_TIMEOUT_MS)

      ffmpeg.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000)
      })
      ffmpeg.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error(`Could not start the converter: ${err.message}`))
      })
      ffmpeg.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (code === 0) {
          // Renamed into place only on success, so a half-written file is
          // never mistaken for a finished one. Windows (or an AV scanner)
          // may still hold the file a moment - a clear error, not a crash.
          try {
            fs.renameSync(tempPath, outputPath)
            resolve(outputPath)
          } catch (err) {
            reject(new Error(`Conversion finished but the output file could not be saved: ${err.message}`))
          }
        } else {
          try { fs.rmSync(tempPath, { force: true }) } catch { /* still locked - ignore, not fatal */ }
          // The last few lines, not just the very last: ffmpeg's real
          // diagnostic is often a couple of lines before the end.
          const lastLines = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-5).join(' | ')
          console.error(`[convert] ffmpeg failed (exit ${code}) for ${sourcePath}\n${stderrTail}`)
          reject(new Error(`Conversion failed (exit code ${code}): ${lastLines || 'no ffmpeg output captured'}`))
        }
      })
    })
  }

  function canReplaceOriginals() {
    const mediaFolder = store.getSettings().mediaFolder
    return Boolean(mediaFolder) && !isNetworkPath(mediaFolder)
  }

  // Sam, 2026-09-25: keeping both the original AND a converted copy of every
  // video would eventually fill the PC. Once a converted copy checks out, it
  // goes onto the media drive in the original's place (same folder and name,
  // .mp4) and the original goes to the Recycle Bin - recoverable. Only on
  // this PC's own drive: a network share has no Recycle Bin.
  async function replaceOriginal(key, sourcePath) {
    requireFileKey(key)
    const mediaFolder = store.getSettings().mediaFolder
    if (!mediaFolder || isNetworkPath(mediaFolder)) return { replaced: false, reason: 'network' }
    if (!library.resolveInsideMediaFolder(sourcePath)) throw new Error('Refusing to touch a file outside the configured media folder.')
    const convertedPath = path.join(paths.converted, `${key}.mp4`)
    if (!fs.existsSync(convertedPath) || !fs.existsSync(sourcePath)) return { replaced: false, reason: 'missing' }

    // Same length (within 2s, or 1% for long videos) or it's left alone - a
    // conversion that got cut short must never replace the real thing.
    const [originalLength, convertedLength] = await Promise.all([probeDuration(sourcePath), probeDuration(convertedPath)])
    if (!originalLength || !convertedLength || Math.abs(originalLength - convertedLength) > Math.max(2, originalLength * 0.01)) {
      return { replaced: false, reason: 'length' }
    }

    // Copied in under a dot-name first (every scan skips dot-files), so a
    // failure part-way never leaves a half-written video in the library.
    const dir = path.dirname(sourcePath)
    const base = path.basename(sourcePath, path.extname(sourcePath))
    const tempPath = path.join(dir, `.${base}.jukebox-tmp.mp4`)
    fs.copyFileSync(convertedPath, tempPath)
    if (fs.statSync(tempPath).size !== fs.statSync(convertedPath).size) {
      fs.rmSync(tempPath, { force: true })
      throw new Error('The copy onto the media drive came out incomplete.')
    }

    try {
      await trashItem(sourcePath)
    } catch (err) {
      fs.rmSync(tempPath, { force: true })
      throw new Error(`Could not move the original to the Recycle Bin: ${err.message}`)
    }

    let finalPath = path.join(dir, `${base}.mp4`)
    for (let n = 2; fs.existsSync(finalPath); n += 1) finalPath = path.join(dir, `${base} (${n}).mp4`)
    fs.renameSync(tempPath, finalPath)

    // The cached copy now lives on the drive as the video itself. If it's
    // playing, Windows won't let go yet; a later scan's clean-up gets it.
    try { fs.rmSync(convertedPath, { force: true }) } catch { /* cleaned up on a later scan */ }

    const newKey = fileKey(finalPath, fs.statSync(finalPath).size)
    library.remapFileKeys(new Map([[key, newKey]]))
    store.loadTrackInfo()[newKey] = { duration: convertedLength, error: false, needsConversion: false }
    store.scheduleTrackInfoWrite()

    const files = library.attachKnownInfo(await library.scanMediaFolder(mediaFolder))
    const playlists = library.syncAllAutoPlaylists(files)
    return { replaced: true, newKey, files, playlists, queue: store.getQueue() }
  }

  return { probeDuration, runConversion, replaceOriginal, canReplaceOriginals, convertedPathFor }
}

module.exports = { createConverter, CONVERT_TIMEOUT_MS }

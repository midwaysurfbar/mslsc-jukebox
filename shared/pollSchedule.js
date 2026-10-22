// How often the bar open/closed check runs (Sam, 2026-10-22: the bar is only open on a Friday and the odd Sunday, so
// checking every 30 seconds all week was wasted server calls, and the free plan counts every one). Same rules as the
// Attendance kiosk and the menu board (src/utils/pollSchedule.js there) - kept in step by hand.
//   open  - the bar is open now (or not known yet): every 30 seconds
//   soon  - closed, but an opening is booked within 3 hours (or started up to 8 hours ago): every minute
//   quiet - closed and nothing booked soon: every 5 minutes
const HOUR = 3600 * 1000

// opening: { eventDate: 'YYYY-MM-DD', startTime: 'HH:MM[:SS]' } in club time (the club PCs run on NZ time) or null
function barMode({ isOpen, opening, now = new Date() }) {
  if (isOpen) return 'open'
  const [y, mo, d] = String((opening && opening.eventDate) || '').split('-').map(Number)
  const [h, mi] = String((opening && opening.startTime) || '').split(':').map(Number)
  if (!y || !mo || !d) return 'quiet'
  const start = new Date(y, mo - 1, d, h || 0, mi || 0)
  const ahead = start - now
  return ahead <= 3 * HOUR && ahead >= -8 * HOUR ? 'soon' : 'quiet'
}

function refreshDelayMs(mode, base) {
  if (mode === 'open') return base
  if (mode === 'soon') return Math.max(base, 60 * 1000)
  return Math.max(base, 5 * 60 * 1000)
}

module.exports = { barMode, refreshDelayMs }

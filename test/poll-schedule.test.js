const test = require('node:test')
const assert = require('node:assert/strict')
const { barMode, refreshDelayMs } = require('../shared/pollSchedule')

const opening = { eventDate: '2026-10-23', startTime: '17:00:00' } // a Friday 5pm booking

test('open or not yet known: every 30 seconds', () => {
  assert.equal(barMode({ isOpen: true, opening: null, now: new Date(2026, 9, 23, 19, 0) }), 'open')
  assert.equal(refreshDelayMs('open', 30000), 30000)
})

test('closed with an opening booked within 3 hours before to 8 hours after its start: every minute', () => {
  assert.equal(barMode({ isOpen: false, opening, now: new Date(2026, 9, 23, 14, 0) }), 'soon')
  assert.equal(barMode({ isOpen: false, opening, now: new Date(2026, 9, 23, 18, 0) }), 'soon')
  assert.equal(refreshDelayMs('soon', 30000), 60000)
})

test('closed and nothing booked soon: every 5 minutes', () => {
  assert.equal(barMode({ isOpen: false, opening, now: new Date(2026, 9, 21, 12, 0) }), 'quiet')
  assert.equal(barMode({ isOpen: false, opening, now: new Date(2026, 9, 23, 13, 0) }), 'quiet')
  assert.equal(barMode({ isOpen: false, opening, now: new Date(2026, 9, 24, 4, 0) }), 'quiet')
  assert.equal(barMode({ isOpen: false, opening: null, now: new Date(2026, 9, 21, 12, 0) }), 'quiet')
  assert.equal(refreshDelayMs('quiet', 30000), 300000)
})

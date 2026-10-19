const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTimeToMinutes,
  isTimeWithinWindow,
  getSudanTime,
  isAutoDispatchActive,
  DEFAULT_AUTO_DISPATCH_CONFIG
} = require('./dist/services/orderDispatchService.js');

test('Sudan Time (Africa/Khartoum UTC+2) calculation', () => {
  // Test reference UTC time: 10:00:00 UTC should be 12:00:00 in Khartoum
  const utcDate = new Date('2026-10-19T10:00:00Z');
  const sudan = getSudanTime(utcDate);

  assert.equal(sudan.hours, 12, '10:00 UTC must be 12:00 in Sudan (UTC+2)');
  assert.equal(sudan.minutes, 0);
  assert.equal(sudan.timeStr, '12:00');
  assert.equal(sudan.currentMinutes, 12 * 60);

  // Test midnight in UTC: 22:00:00 UTC should be 00:00:00 in Khartoum
  const midnightUtc = new Date('2026-10-19T22:00:00Z');
  const sudanMidnight = getSudanTime(midnightUtc);
  assert.equal(sudanMidnight.hours, 0, '22:00 UTC must be 00:00 (midnight) in Sudan');
  assert.equal(sudanMidnight.minutes, 0);
  assert.equal(sudanMidnight.timeStr, '00:00');
  assert.equal(sudanMidnight.currentMinutes, 0);
});

test('parseTimeToMinutes converts HH:MM accurately', () => {
  assert.equal(parseTimeToMinutes('00:00'), 0);
  assert.equal(parseTimeToMinutes('09:30'), 9 * 60 + 30);
  assert.equal(parseTimeToMinutes('14:45'), 14 * 60 + 45);
  assert.equal(parseTimeToMinutes('23:59'), 23 * 60 + 59);
  assert.equal(parseTimeToMinutes(''), 0);
  assert.equal(parseTimeToMinutes(null), 0);
});

test('isTimeWithinWindow daytime range (e.g. 09:00 - 17:00)', () => {
  const start = parseTimeToMinutes('09:00'); // 540
  const end = parseTimeToMinutes('17:00');   // 1020

  // Before start
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('08:59'), start, end), false);
  // Exactly at start
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('09:00'), start, end), true);
  // Inside window
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('12:30'), start, end), true);
  // Exactly at end
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('17:00'), start, end), true);
  // After end
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('17:01'), start, end), false);
  // Late night
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('23:00'), start, end), false);
});

test('isTimeWithinWindow overnight range (e.g. 22:00 - 06:00)', () => {
  const start = parseTimeToMinutes('22:00'); // 1320
  const end = parseTimeToMinutes('06:00');   // 360

  // Late night inside window (22:30)
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('22:30'), start, end), true);
  // Exactly at start (22:00)
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('22:00'), start, end), true);
  // At midnight (00:00)
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('00:00'), start, end), true);
  // Early morning inside window (03:15)
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('03:15'), start, end), true);
  // Exactly at end (06:00)
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('06:00'), start, end), true);
  // Just after end (06:01)
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('06:01'), start, end), false);
  // Middle of day (14:00)
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('14:00'), start, end), false);
  // Just before start (21:59)
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('21:59'), start, end), false);
});

test('isTimeWithinWindow 24-hour range (start === end)', () => {
  const start = parseTimeToMinutes('00:00');
  const end = parseTimeToMinutes('00:00');

  assert.equal(isTimeWithinWindow(parseTimeToMinutes('04:00'), start, end), true);
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('12:00'), start, end), true);
  assert.equal(isTimeWithinWindow(parseTimeToMinutes('23:59'), start, end), true);
});

test('isAutoDispatchActive checks enabled flag and schedule modes', () => {
  // 1. When disabled
  const disabledConfig = {
    ...DEFAULT_AUTO_DISPATCH_CONFIG,
    enabled: false
  };
  const disabledStatus = isAutoDispatchActive(disabledConfig, new Date('2026-10-19T10:00:00Z'));
  assert.equal(disabledStatus.active, false);
  assert.match(disabledStatus.reason, /معطل/);

  // 2. When enabled with always 24/7 mode
  const alwaysConfig = {
    ...DEFAULT_AUTO_DISPATCH_CONFIG,
    enabled: true,
    scheduleMode: 'always'
  };
  const alwaysStatus = isAutoDispatchActive(alwaysConfig, new Date('2026-10-19T02:00:00Z'));
  assert.equal(alwaysStatus.active, true);
  assert.match(alwaysStatus.reason, /24 ساعة/);

  // 3. When enabled with scheduled window (09:00 - 18:00 Sudan Time)
  const scheduledConfig = {
    ...DEFAULT_AUTO_DISPATCH_CONFIG,
    enabled: true,
    scheduleMode: 'scheduled',
    startTime: '09:00',
    endTime: '18:00'
  };

  // 10:00 UTC = 12:00 Sudan -> inside window
  const insideStatus = isAutoDispatchActive(scheduledConfig, new Date('2026-10-19T10:00:00Z'));
  assert.equal(insideStatus.active, true);
  assert.equal(insideStatus.sudanTime, '12:00');
  assert.match(insideStatus.reason, /مفعل ويعمل حالياً/);

  // 18:00 UTC = 20:00 Sudan -> outside window
  const outsideStatus = isAutoDispatchActive(scheduledConfig, new Date('2026-10-19T18:00:00Z'));
  assert.equal(outsideStatus.active, false);
  assert.equal(outsideStatus.sudanTime, '20:00');
  assert.match(outsideStatus.reason, /خارج ساعات العمل/);
});

test('saveAutoDispatchConfig and getAutoDispatchConfig persistence', async () => {
  const { prisma } = require('./dist/utils/prisma');
  const dbStore = {};

  prisma.setting = {
    findUnique: async ({ where }) => {
      const val = dbStore[where.key];
      return val ? { key: where.key, value: val } : null;
    },
    upsert: async ({ where, update, create }) => {
      const val = update?.value || create?.value;
      dbStore[where.key] = val;
      return { key: where.key, value: val };
    }
  };

  const {
    getAutoDispatchConfig,
    saveAutoDispatchConfig
  } = require('./dist/services/orderDispatchService.js');

  // Default when empty
  const initial = await getAutoDispatchConfig();
  assert.equal(initial.enabled, false);
  assert.equal(initial.timezone, 'Africa/Khartoum');

  // Save updated config
  const saved = await saveAutoDispatchConfig({
    enabled: true,
    scheduleMode: 'scheduled',
    startTime: '10:30',
    endTime: '22:45',
    includeWebOrders: true,
    includeApiOrders: false,
    notifyOnFailure: true
  }, 'superadmin');

  assert.equal(saved.enabled, true);
  assert.equal(saved.scheduleMode, 'scheduled');
  assert.equal(saved.startTime, '10:30');
  assert.equal(saved.endTime, '22:45');
  assert.equal(saved.includeWebOrders, true);
  assert.equal(saved.includeApiOrders, false);
  assert.equal(saved.updatedBy, 'superadmin');

  // Fetch back
  const fetched = await getAutoDispatchConfig();
  assert.equal(fetched.enabled, true);
  assert.equal(fetched.startTime, '10:30');
  assert.equal(fetched.includeApiOrders, false);
});


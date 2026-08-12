/**
 * Fires a callback once a day at a fixed wall-clock time in a named timezone.
 *
 * Deliberately not a cron library: the app needs exactly one daily trigger, and
 * a dependency that parses cron expressions is a larger surface than the ~40
 * lines below.
 */

const DEFAULT_TIME = "10:00";
const DEFAULT_TZ = "Asia/Kolkata";
const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimeOfDay(raw) {
  const value = String(raw ?? "").trim();
  if (!value || value.toLowerCase() === "off") return null;

  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid refresh time, expected HH:MM (24h): ${JSON.stringify(raw)}`);

  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid refresh time, out of range: ${JSON.stringify(raw)}`);
  }
  return { hour, minute };
}

function assertTimeZone(timeZone) {
  // Throws RangeError on an unknown IANA name.
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  return timeZone;
}

// h23 rather than hour12:false — the latter can render midnight as hour 24 and
// silently shift the arithmetic by a day.
function zonedClock(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

/**
 * Milliseconds from `now` until the next `hour:minute` in `timeZone`.
 *
 * Computed from the wall-clock difference and recomputed after every fire, so a
 * DST shift self-corrects on the following day rather than accumulating. India
 * has no DST, so for the default timezone this is always exact.
 */
function msUntilNext(now, { hour, minute }, timeZone) {
  const clock = zonedClock(now, timeZone);
  const nowMs =
    ((clock.hour * 60 + clock.minute) * 60 + clock.second) * 1000 + now.getMilliseconds();
  const targetMs = (hour * 60 + minute) * 60 * 1000;
  const delta = targetMs - nowMs;
  return delta > 0 ? delta : delta + DAY_MS;
}

function formatNext(now, at, timeZone) {
  return new Date(now.getTime() + msUntilNext(now, at, timeZone)).toISOString();
}

/**
 * @param {object}   opts
 * @param {string}   opts.time      "HH:MM" 24h, or "" / "off" to disable.
 * @param {string}   opts.timeZone  IANA name, e.g. "Asia/Kolkata".
 * @param {Function} opts.onFire    async; rejection triggers a bounded retry.
 * @param {number}   opts.retryMs   delay before retrying a failed run.
 * @param {number}   opts.maxRetries retries before giving up until tomorrow.
 * @returns {{stop: Function, nextRunAt: Function}|null} null when disabled.
 */
function startScheduler({
  time = DEFAULT_TIME,
  timeZone = DEFAULT_TZ,
  onFire,
  retryMs = 10 * 60 * 1000,
  maxRetries = 3,
  logger = console,
} = {}) {
  let at;
  try {
    at = parseTimeOfDay(time);
    if (at) assertTimeZone(timeZone);
  } catch (err) {
    // A typo in the schedule must not take down a working dashboard. Fall back
    // to the TTL path, which still refreshes, just not on a fixed clock.
    logger.error(`[scheduler] disabled — ${err.message}`);
    return null;
  }
  if (!at) {
    logger.warn("[scheduler] disabled — no daily refresh time configured");
    return null;
  }

  let timer = null;
  let stopped = false;
  let attempt = 0;

  const armDaily = () => {
    if (stopped) return;
    const now = new Date();
    const delay = msUntilNext(now, at, timeZone);
    logger.log(
      `[scheduler] next refresh ${formatNext(now, at, timeZone)} ` +
        `(${time} ${timeZone}, in ${Math.round(delay / 60000)} min)`
    );
    timer = setTimeout(run, delay);
  };

  const run = async () => {
    if (stopped) return;
    try {
      await onFire();
      attempt = 0;
      armDaily();
    } catch (err) {
      attempt += 1;
      if (attempt <= maxRetries) {
        logger.error(
          `[scheduler] refresh failed (attempt ${attempt}/${maxRetries}), ` +
            `retrying in ${Math.round(retryMs / 60000)} min: ${err.message}`
        );
        timer = setTimeout(run, retryMs);
      } else {
        logger.error(
          `[scheduler] refresh failed ${attempt} times, giving up until tomorrow: ${err.message}`
        );
        attempt = 0;
        armDaily();
      }
    }
  };

  armDaily();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    nextRunAt() {
      return stopped ? null : formatNext(new Date(), at, timeZone);
    },
  };
}

module.exports = {
  startScheduler,
  parseTimeOfDay,
  msUntilNext,
  DEFAULT_TIME,
  DEFAULT_TZ,
};

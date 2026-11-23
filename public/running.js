// When a race is running (DESIGN 9.22 M9, O37): ONE rule for the control panel (public/app.js isRunning: the Races list,
// Start a new meet, the output lights) and for Split Relay itself (src/meet.js raceRunning: main.js refuses Start a new
// meet under it, a load's preview says it), so the panel never offers what the server then treats as a running race.
// It lives in public\ because the panel can load only what is there; the server imports it from here. Pure: no DOM.

/** A race runs while its clock is under 30 minutes (a gun typed a moment ago, before the first split)... */
export const RUNNING_CLOCK_MS = 30 * 60_000;
/** ...or while reads keep arriving: one in the last 20 minutes. */
export const RUNNING_READ_MS = 20 * 60_000;

/**
 * The race clock is between the gun and 30 minutes after it. A gun that can't be read (NaN) counts too; no gun (null)
 * does not, nor a negative clock (a gun later in the day than now: an earlier day's).
 * @param {number|null|undefined} clockMs this PC's time of day minus the gun, wrapped at midnight as race times are
 */
export const clockRunning = (clockMs) => clockMs !== null && clockMs !== undefined &&
  (Number.isNaN(clockMs) || (clockMs >= 0 && clockMs < RUNNING_CLOCK_MS));

/**
 * Whether a race is running now: Active with a gun, and its clock under 30 minutes or a read in the last 20 minutes,
 * whatever its clock says (reads still arriving under a gun typed later in the day are a race being timed). A gun left
 * from an earlier day with no reads since, or from a race long over, is not running.
 * @param {{ active?: boolean, gun: boolean, clockMs: number|null|undefined, lastReadAt: number|null|undefined }} race
 *   gun: it has a gun time; clockMs: see clockRunning; lastReadAt: when its last read arrived (ms)
 * @param {number} now ms
 */
export function runningNow({ active, gun, clockMs, lastReadAt }, now) {
  if (active === false || !gun) return false;
  if (clockRunning(clockMs)) return true;
  return Number.isFinite(lastReadAt) && now - lastReadAt < RUNNING_READ_MS;
}

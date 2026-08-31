/**
 * Date Utilities for InternNetra LMS
 * 
 * Provides strict calendar-month arithmetic with month-end clamping
 * while preserving the exact time-of-day (hours, minutes, seconds, milliseconds).
 */

/**
 * Adds a specified number of calendar months to a given date.
 * 
 * Examples:
 * - 31 Aug 2026 12:00:00 -> 28 Feb 2027 12:00:00
 * - 30 Aug 2026 12:00:00 -> 28 Feb 2027 12:00:00
 * - 15 Sep 2026 10:30:00 -> 15 Mar 2027 10:30:00
 * - 31 Oct 2026 09:00:00 -> 30 Apr 2027 09:00:00
 * 
 * @param {string|number|Date} dateInput - Initial access start timestamp
 * @param {number} [months=6] - Number of calendar months to add (default: 6)
 * @returns {Date} - Calculated expiry date
 */
function addCalendarMonths(dateInput, months = 6) {
  if (!dateInput) {
    throw new Error('Valid dateInput is required for addCalendarMonths');
  }

  const d = new Date(dateInput);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date provided to addCalendarMonths: ${dateInput}`);
  }

  const startDay = d.getUTCDate();
  const startMonth = d.getUTCMonth();
  const startYear = d.getUTCFullYear();
  const startHours = d.getUTCHours();
  const startMinutes = d.getUTCMinutes();
  const startSeconds = d.getUTCSeconds();
  const startMs = d.getUTCMilliseconds();

  // Target month index
  const targetMonthIndex = startMonth + months;
  const targetYear = startYear + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  // Total days in the target month (handles leap years like Feb in 2028 vs 2027)
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  // Clamp the day to the last valid day of the target month
  const targetDay = Math.min(startDay, daysInTargetMonth);

  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    startHours,
    startMinutes,
    startSeconds,
    startMs
  ));
}

/**
 * Checks whether an enrollment access period has expired.
 * 
 * @param {string|number|Date} expiryDate - The enrollment access_expiry_date
 * @param {Date} [currentDate=new Date()] - Reference date (defaults to now)
 * @returns {boolean} - true if current time >= expiryDate
 */
function isAccessExpired(expiryDate, currentDate = new Date()) {
  if (!expiryDate) return false;
  const exp = new Date(expiryDate);
  if (isNaN(exp.getTime())) return false;
  return currentDate.getTime() >= exp.getTime();
}

module.exports = {
  addCalendarMonths,
  isAccessExpired
};

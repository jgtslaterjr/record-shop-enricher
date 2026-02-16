/**
 * Normalize hours strings to ensure consistent AM/PM indicators.
 * 
 * When a time range has only one AM/PM indicator, the missing one is
 * inferred from the present one. For example:
 *   "1:00 - 5:00 PM"  → "1:00 PM - 5:00 PM"
 *   "10:00 AM - 6:00" → "10:00 AM - 6:00 AM"
 * 
 * This matches how hours are typically listed (e.g. Google Maps)
 * where the AM/PM is omitted when both times share the same period.
 */

function normalizeHoursString(hoursStr) {
  if (!hoursStr || typeof hoursStr !== 'string') return hoursStr;
  
  // Match time ranges like "1:00 - 5:00 PM" or "10:00 AM – 6:00"
  return hoursStr.replace(
    /(\d{1,2}:\d{2})\s*(AM|PM)?\s*([–\-])\s*(\d{1,2}:\d{2})\s*(AM|PM)?/gi,
    (match, t1, ampm1, sep, t2, ampm2) => {
      // Infer missing AM/PM from the one that's present
      if (!ampm1 && ampm2) ampm1 = ampm2;
      if (!ampm2 && ampm1) ampm2 = ampm1;
      
      const p1 = ampm1 ? ` ${ampm1.toUpperCase()}` : '';
      const p2 = ampm2 ? ` ${ampm2.toUpperCase()}` : '';
      return `${t1}${p1} ${sep} ${t2}${p2}`;
    }
  );
}

/**
 * Normalize an hours object (day → time string) or array of strings.
 */
function normalizeHours(hours) {
  if (!hours) return hours;
  
  if (Array.isArray(hours)) {
    return hours.map(h => normalizeHoursString(h));
  }
  
  if (typeof hours === 'object') {
    const normalized = {};
    for (const [day, time] of Object.entries(hours)) {
      normalized[day] = normalizeHoursString(time);
    }
    return normalized;
  }
  
  return hours;
}

module.exports = { normalizeHours, normalizeHoursString };

import type { DayMetadata, HikeEntry, StayEntry, DriveEntry, JournalEntry } from './types';

// ─── Regexes ──────────────────────────────────────────────────────────────────

const DAY_HEADER  = /^\s*(\d{2})\/(\d{2})\/(\d{4})\s*\|\s*(.*)/;
const TYPED_LINE  = /^\s*(Hike|Walk|Cycle|Stay|Driving|Drive|Activity|Sight|Sights)\s*:\s*(.*)/i;

function toDateKey(dd: string, mm: string, yyyy: string): string {
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns the "stat" portion of a pipe-field — everything up to the first
 * sentence-ending period that is NOT part of a decimal number.
 * e.g.  "4 hours. Made it to hut in 1.5hrs"  →  "4 hours"
 *        "10.4km. Weeds, muddy"                →  "10.4km"
 *        "1.5 hours (total)"                   →  "1.5 hours (total)"
 */
/**
 * Returns the free-text notes that follow the last stat in a pipe-delimited
 * entry — i.e. everything after the first non-decimal period in the final field
 * (or in the whole raw string if there are no pipes).
 * Returns undefined when there are no notes.
 */
function notesPart(raw: string): string | undefined {
  // Find the last pipe segment; if none, use the whole string.
  const lastPipeIdx = raw.lastIndexOf('|');
  const tail = lastPipeIdx >= 0 ? raw.slice(lastPipeIdx + 1) : raw;
  // A non-decimal period ends the stats and starts the notes.
  const m = tail.match(/[^.]*(?:\.)(?!\d)(.+)$/);
  const notes = m ? m[1]!.trim() : undefined;
  return notes || undefined;
}

function statPart(field: string): string {
  // Non-dot chars, then optionally (. + digit + non-dot chars) — handles decimals
  const m = field.match(/^([^.]*(?:\.\d+[^.]*)*)/);
  return (m ? m[1]! : field).trim();
}

// ─── Entry parsers ────────────────────────────────────────────────────────────

function parseHikeValue(raw: string): HikeEntry {
  const starred = raw.includes('⭐');
  const text    = raw.replace(/⭐/g, '').trim();
  const parts   = text.split('|').map(s => s.trim());

  const name = (parts[0] ?? '').trim();
  let distanceKm: string | undefined;
  let elevationM: string | undefined;
  let duration:   string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const stat = statPart(parts[i]!);

    if (/flat/i.test(stat)) { elevationM = '0m'; continue; }

    const km = stat.match(/(\~?\d+\.?\d*)\s*km/i);
    if (km) { distanceKm = (km[1]!) + 'km'; continue; }

    // elevation: digits + m NOT followed by a word char (avoids matching km/min)
    const elev = stat.match(/(\d+)\s*m(?!\w)/i);
    if (elev) { elevationM = (elev[1]!) + 'm'; continue; }

    const hrs  = stat.match(/(\d+\.?\d*)\s*h(?:ours?|rs?)\b/i);
    const mins = stat.match(/(\d+\.?\d*)\s*min/i);
    if (hrs) {
      duration = `${hrs[1]}h`;
    } else if (mins) {
      duration = `${mins[1]}min`;
    }
  }

  const notes = notesPart(raw.replace(/⭐/g, ''));
  return { name, distanceKm, elevationM, duration, starred, notes };
}

function parseStayValue(raw: string): StayEntry {
  // Rating — last "N/5" in the string
  const ratingMatches = [...raw.matchAll(/\b([1-5])\/5\b/g)];
  const rating = ratingMatches.length > 0
    ? parseInt(ratingMatches[ratingMatches.length - 1]![1]!)
    : undefined;

  // Cost — first $NNN or $NNN-NNN
  const costMatch = raw.match(/\$(\d[\d,]*)(?:-\d+)?/);
  const costNzd = costMatch ? costMatch[0] : undefined;

  // Name — strip pipe-and-after, parenthetical costs, inline costs, "Cost: $X", ratings
  const cleaned = raw
    .replace(/\s*\|[\s\S]*$/, '')                     // strip from first |
    .replace(/\s*\(\$\d[\d,]*(?:-\d+)?\)/g, '')       // strip (cost) / (cost-range)
    .replace(/\s*\$\d[\d,]*(?:-\d+)?/g, '')           // strip bare $cost
    .replace(/\s*Cost:\s*\$\d[\d,]*/gi, '')           // strip "Cost: $X"
    .replace(/\b[1-5]\/5\b\.?/g, '')                  // strip ratings
    .replace(/\s{2,}/g, ' ')
    .trim();

  const dotIdx = cleaned.indexOf('.');
  const name   = (dotIdx >= 0 ? cleaned.slice(0, dotIdx) : cleaned).trim();

  // Notes: text after the rating, stripping the period that terminated it.
  const ratingPeriodIdx = raw.search(/\b[1-5]\/5\b\.?/);
  let notes: string | undefined;
  if (ratingPeriodIdx >= 0) {
    const afterRating = raw.slice(ratingPeriodIdx).replace(/^[1-5]\/5\.?/, '').trim();
    notes = afterRating || undefined;
  }

  return { name, costNzd, rating, notes };
}

function parseDriveValue(raw: string): DriveEntry {
  const parts = raw.split('|').map(s => s.trim());
  const route = (parts[0] ?? raw).replace(/\.$/, '').trim();
  let distanceKm: string | undefined;
  let duration:   string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const stat = statPart(parts[i]!);
    const km   = stat.match(/(\d+\.?\d*)\s*km/i);
    if (km) { distanceKm = (km[1]!) + 'km'; continue; }

    const hrs  = stat.match(/(\d+\.?\d*)\s*h(?:ours?|rs?)\b/i);
    const mins = stat.match(/(\d+\.?\d*)\s*min/i);
    if (hrs) {
      duration = `${hrs[1]}h`;
    } else if (mins) {
      duration = `${mins[1]}min`;
    }
  }

  const notes = notesPart(raw);
  return { route, distanceKm, duration, notes };
}

// ─── Main export ──────────────────────────────────────────────────────────────

function makeDayMetadata(location: string): DayMetadata {
  return { location, entries: [], hikes: [], stays: [], drives: [], activities: [] };
}

export function parseMetadata(text: string): Map<string, DayMetadata> {
  const result = new Map<string, DayMetadata>();
  const lines  = text.split(/\r?\n/);

  let currentKey: string | null   = null;
  let current:    DayMetadata | null = null;

  function flush(): void {
    if (currentKey && current) result.set(currentKey, current);
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Day header: "DD/MM/YYYY | Location"
    const header = line.match(DAY_HEADER);
    if (header) {
      flush();
      const [, dd, mm, yyyy, loc] = header as [string, string, string, string, string];
      currentKey = toDateKey(dd, mm, yyyy);
      current    = makeDayMetadata(loc.trim());
      continue;
    }

    if (!current || line.trim() === '') continue;

    // Typed entry: "Hike: …", "Stay: …", "Driving: …", etc.
    const typed = line.match(TYPED_LINE);
    if (typed) {
      const [, prefix, value] = typed as [string, string, string];
      const p = prefix.toLowerCase();
      if (p === 'hike' || p === 'walk' || p === 'cycle') {
        const entry = parseHikeValue(value.trim());
        current.entries.push({ kind: 'hike', entry });
        current.hikes.push(entry);
      } else if (p === 'stay') {
        const entry = parseStayValue(value.trim());
        current.entries.push({ kind: 'stay', entry });
        current.stays.push(entry);
      } else if (p === 'driving' || p === 'drive') {
        const entry = parseDriveValue(value.trim());
        current.entries.push({ kind: 'drive', entry });
        current.drives.push(entry);
      } else {
        // Activity / Sight / Sights
        const entry = value.trim();
        current.entries.push({ kind: 'activity', entry });
        current.activities.push(entry);
      }
    }
    // Untyped diary notes are intentionally ignored
  }

  flush();
  return result;
}

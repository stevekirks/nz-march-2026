import type {
  RawTimeline,
  RawSegment,
  RawActivitySegment,
  RawVisitSegment,
  RawTimelinePathSegment,
  LatLng,
  TrackPoint,
  TrackSegment,
  ParsedVisit,
  ParsedActivity,
  ParsedDay,
  ParsedTimeline,
  ActivityType,
  DayMetadata,
} from './types';
import { buildPathPointSourceId } from './timelineEdits';

// ─── Type guards ─────────────────────────────────────────────────────────────

function isPathSeg(s: RawSegment): s is RawTimelinePathSegment {
  return 'timelinePath' in s && Array.isArray((s as RawTimelinePathSegment).timelinePath);
}

function isActivitySeg(s: RawSegment): s is RawActivitySegment {
  return 'activity' in s;
}

function isVisitSeg(s: RawSegment): s is RawVisitSegment {
  return 'visit' in s;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse "-44.8954804°, 168.0787931°" → { lat, lng } */
export function parseLatLng(s: string): LatLng {
  const cleaned = s.replace(/°/g, '');
  const comma = cleaned.indexOf(',');
  return {
    lat: parseFloat(cleaned.slice(0, comma).trim()),
    lng: parseFloat(cleaned.slice(comma + 1).trim()),
  };
}

/**
 * Extract a local-date key ("2026-03-10") from an ISO timestamp that has
 * an embedded UTC offset, e.g. "2026-03-10T14:30:00.000+13:00".
 * We parse the wall-clock date from the string directly rather than via
 * Date.prototype to avoid UTC re-interpretation.
 */
function localDateKey(isoString: string): string {
  // First 10 chars are always "YYYY-MM-DD" for the local date portion
  return isoString.slice(0, 10);
}

function localDateLabel(dateKey: string): string {
  // dateKey: "2026-03-10"
  const [yearStr, monthStr, dayStr] = dateKey.split('-');
  if (!yearStr || !monthStr || !dayStr) return dateKey;
  const d = new Date(
    parseInt(yearStr),
    parseInt(monthStr) - 1,
    parseInt(dayStr),
  );
  return d.toLocaleDateString('en-NZ', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** Distribute hues evenly around 360° for N days */
function assignHues(dateKeys: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const n = dateKeys.length;
  dateKeys.forEach((key, i) => {
    // Start at 200° (blue) so the first day isn't an ugly red
    map.set(key, (200 + (i * 360) / n) % 360);
  });
  return map;
}

/**
 * Resolve the activity type for a single GPS point by binary-searching the
 * (start-time-sorted) activity interval list for the interval that contains
 * this exact timestamp.  O(log n) per point.
 */
function resolveActivityTypeAtTime(
  pointMs: number,
  activities: Array<{ start: number; end: number; type: ActivityType }>,
): ActivityType {
  // Binary search: find the rightmost activity whose start <= pointMs
  let lo = 0;
  let hi = activities.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (activities[mid]!.start <= pointMs) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx >= 0 && activities[idx]!.end >= pointMs) {
    return activities[idx]!.type;
  }
  return 'UNKNOWN_ACTIVITY_TYPE';
}

/** Split an array of TrackPoints into contiguous segments of the same activity type */
function splitByActivity(points: TrackPoint[]): TrackSegment[] {
  if (points.length === 0) return [];
  const segments: TrackSegment[] = [];
  let current: TrackPoint[] = [points[0]!];
  let currentType = points[0]!.activityType;

  for (let i = 1; i < points.length; i++) {
    const pt = points[i]!;
    if (pt.activityType === currentType) {
      current.push(pt);
    } else {
      segments.push({ points: current, activityType: currentType });
      current = [pt];
      currentType = pt.activityType;
    }
  }
  segments.push({ points: current, activityType: currentType });
  return segments;
}

// ─── Main parser ─────────────────────────────────────────────────────────────

export function parseTimeline(raw: RawTimeline, metadataMap?: Map<string, DayMetadata>): ParsedTimeline {
  const segs = raw.semanticSegments;

  // 1. Extract activity segments and sort by start time for binary search
  const activityIntervals: Array<{ start: number; end: number; type: ActivityType }> = [];
  for (const seg of segs) {
    if (isActivitySeg(seg)) {
      activityIntervals.push({
        start: new Date(seg.startTime).getTime(),
        end: new Date(seg.endTime).getTime(),
        type: seg.activity.topCandidate.type,
      });
    }
  }
  activityIntervals.sort((a, b) => a.start - b.start);

  // 2. Collect raw GPS points per local date, resolve activity types
  const pointsByDay = new Map<string, TrackPoint[]>();
  const visitsByDay = new Map<string, ParsedVisit[]>();
  const activitiesByDay = new Map<string, ParsedActivity[]>();

  for (const seg of segs) {
    if (isPathSeg(seg)) {
      for (const rawPt of seg.timelinePath) {
        const dateKey = localDateKey(rawPt.time);
        const time = new Date(rawPt.time);
        // Resolve activity type per-point, not per-segment, so a 2-hour
        // timelinePath block with mixed activities colours correctly.
        const type = resolveActivityTypeAtTime(time.getTime(), activityIntervals);
        const { lat, lng } = parseLatLng(rawPt.point);
        const pt: TrackPoint = {
          lat,
          lng,
          time,
          activityType: type,
          sourceId: buildPathPointSourceId(seg, rawPt),
        };
        const arr = pointsByDay.get(dateKey) ?? [];
        arr.push(pt);
        pointsByDay.set(dateKey, arr);
      }
    } else if (isVisitSeg(seg)) {
      const loc = seg.visit.topCandidate.placeLocation;
      if (!loc) continue;
      const startTime = new Date(seg.startTime);
      const dateKey = localDateKey(seg.startTime);
      const visit: ParsedVisit = {
        startTime,
        endTime: new Date(seg.endTime),
        location: parseLatLng(loc.latLng),
        semanticType: seg.visit.topCandidate.semanticType,
        placeId: seg.visit.topCandidate.placeId,
        visitId: seg.visit.topCandidate.visitId,
        visitName: seg.visit.topCandidate.visitName,
        hierarchyLevel: seg.visit.hierarchyLevel ?? 0,
      };
      const arr = visitsByDay.get(dateKey) ?? [];
      arr.push(visit);
      visitsByDay.set(dateKey, arr);
    } else if (isActivitySeg(seg)) {
      const dateKey = localDateKey(seg.startTime);
      const activity: ParsedActivity = {
        startTime: new Date(seg.startTime),
        endTime: new Date(seg.endTime),
        start: parseLatLng(seg.activity.start.latLng),
        end: parseLatLng(seg.activity.end.latLng),
        distanceMeters: seg.activity.distanceMeters,
        activityType: seg.activity.topCandidate.type,
      };
      const arr = activitiesByDay.get(dateKey) ?? [];
      arr.push(activity);
      activitiesByDay.set(dateKey, arr);
    }
  }

  // 3. Sort date keys chronologically
  const dateKeys = Array.from(
    new Set([...pointsByDay.keys(), ...visitsByDay.keys(), ...activitiesByDay.keys()])
  ).sort();

  // 4. Assign hues
  const hues = assignHues(dateKeys);

  // 5. Build ParsedDay[] and flat allPoints list
  const days: ParsedDay[] = [];
  const allPoints: TrackPoint[] = [];

  for (const dateKey of dateKeys) {
    const pts = pointsByDay.get(dateKey) ?? [];
    // Sort points chronologically within day
    pts.sort((a, b) => a.time.getTime() - b.time.getTime());
    allPoints.push(...pts);

    days.push({
      dateKey,
      label: localDateLabel(dateKey),
      hue: hues.get(dateKey) ?? 0,
      segments: splitByActivity(pts),
      visits: visitsByDay.get(dateKey) ?? [],
      activities: activitiesByDay.get(dateKey) ?? [],
    });
  }

  // 6. Attach diary metadata if provided
  if (metadataMap) {
    for (const day of days) {
      const meta = metadataMap.get(day.dateKey);
      if (meta) day.metadata = meta;
    }
  }

  // 7. Global time bounds
  allPoints.sort((a, b) => a.time.getTime() - b.time.getTime());
  const startTime = allPoints[0]?.time ?? new Date(0);
  const endTime = allPoints[allPoints.length - 1]?.time ?? new Date(0);

  return { days, allPoints, startTime, endTime };
}

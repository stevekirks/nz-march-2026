// ─── Raw JSON shapes ─────────────────────────────────────────────────────────

export interface RawTimelinePoint {
  point: string; // "-44.8954804°, 168.0787931°"
  time: string;  // ISO 8601 with offset
}

export interface RawTimelinePathSegment {
  startTime: string;
  endTime: string;
  timelinePath: RawTimelinePoint[];
  // activity / visit absent
  startTimeTimezoneUtcOffsetMinutes?: number;
}

export interface RawActivitySegment {
  startTime: string;
  endTime: string;
  startTimeTimezoneUtcOffsetMinutes?: number;
  endTimeTimezoneUtcOffsetMinutes?: number;
  activity: {
    start: { latLng: string };
    end:   { latLng: string };
    distanceMeters: number;
    probability: number;
    topCandidate: {
      type: ActivityType;
      probability: number;
    };
  };
}

export interface RawVisitSegment {
  startTime: string;
  endTime: string;
  startTimeTimezoneUtcOffsetMinutes?: number;
  endTimeTimezoneUtcOffsetMinutes?: number;
  visit: {
    hierarchyLevel?: number;
    probability: number;
    topCandidate: {
      visitId?: string;
      visitName?: string;
      placeId?: string;
      semanticType: SemanticType;
      probability: number;
      placeLocation?: { latLng: string };
    };
    isTimelessVisit?: boolean;
  };
}

export type RawSegment = RawTimelinePathSegment | RawActivitySegment | RawVisitSegment;

export interface RawTimeline {
  semanticSegments: RawSegment[];
}

// ─── Activity types ──────────────────────────────────────────────────────────

export type ActivityType =
  | 'IN_PASSENGER_VEHICLE'
  | 'IN_BUS'
  | 'IN_FERRY'
  | 'IN_TRAIN'
  | 'IN_SUBWAY'
  | 'IN_TRAM'
  | 'WALKING'
  | 'RUNNING'
  | 'CYCLING'
  | 'FLYING'
  | 'SAILING'
  | 'SKIING'
  | 'UNKNOWN_ACTIVITY_TYPE'
  | string;

export type SemanticType = 'HOME' | 'WORK' | 'UNKNOWN' | string;

// ─── Parsed / processed shapes ───────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

/** A single GPS point with a timestamp and resolved activity type */
export interface TrackPoint extends LatLng {
  time: Date;
  activityType: ActivityType;
  sourceId?: string;
}

/** A polyline segment of consecutive TrackPoints sharing the same activity type */
export interface TrackSegment {
  points: TrackPoint[];
  activityType: ActivityType;
}

/** A labelled stop/visit */
export interface ParsedVisit {
  startTime: Date;
  endTime: Date;
  location: LatLng;
  semanticType: SemanticType;
  placeId?: string;
  visitId?: string;
  visitName?: string;
  hierarchyLevel: number;
}

/** A labelled activity (movement) with resolved type */
export interface ParsedActivity {
  startTime: Date;
  endTime: Date;
  start: LatLng;
  end: LatLng;
  distanceMeters: number;
  activityType: ActivityType;
}

/** All data for a single calendar day (local time at the location) */
export interface ParsedDay {
  dateKey: string; // "2026-03-10"
  label: string;   // "Wed 10 Mar"
  hue: number;     // 0-360 HSL hue unique to this day
  segments: TrackSegment[];
  visits: ParsedVisit[];
  activities: ParsedActivity[];
  metadata?: DayMetadata;
}

/** All parsed data returned by the parser */
export interface ParsedTimeline {
  days: ParsedDay[];
  allPoints: TrackPoint[]; // chronologically sorted, all days, for animation
  startTime: Date;
  endTime: Date;
}

// ─── Metadata (from diary text file) ─────────────────────────────────────────

export interface HikeEntry {
  name: string;
  distanceKm?: string;  // e.g. "11km"
  elevationM?: string;  // e.g. "600m"
  duration?: string;    // e.g. "4h" or "30min"
  starred: boolean;
  notes?: string;       // free-text after the stats
}

export interface StayEntry {
  name: string;
  costNzd?: string;  // e.g. "$25"
  rating?: number;   // 1–5
  notes?: string;    // free-text after rating
}

export interface DriveEntry {
  route: string;       // e.g. "Christchurch to Arthur's Pass"
  distanceKm?: string; // e.g. "150km"
  duration?: string;   // e.g. "2h"
  notes?: string;      // free-text after the stats
}

/** A single typed diary entry in original file order */
export type JournalEntry =
  | { kind: 'hike';     entry: HikeEntry }
  | { kind: 'stay';     entry: StayEntry }
  | { kind: 'drive';    entry: DriveEntry }
  | { kind: 'activity'; entry: string };

export interface DayMetadata {
  location: string;
  /** Entries in the order they appear in the journal. */
  entries: JournalEntry[];
  // Convenience accessors (derived from entries):
  hikes: HikeEntry[];
  stays: StayEntry[];
  drives: DriveEntry[];
  activities: string[];
}

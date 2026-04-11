import type {
  RawTimeline,
  RawSegment,
  RawTimelinePathSegment,
  RawTimelinePoint,
  RawVisitSegment,
} from './types';

export interface StoredTimelineEdits {
  deletedVisitKeys: Set<string>;
  deletedPathPointIds: Set<string>;
  labelsByVisitKey: Record<string, string>;
  slugsByVisitKey: Record<string, string>;
  createdVisitsByVisitKey: Record<string, RawVisitSegment>;
}

function isVisitSeg(segment: RawSegment): segment is RawVisitSegment {
  return 'visit' in segment;
}

function isPathSeg(segment: RawSegment): segment is RawTimelinePathSegment {
  return 'timelinePath' in segment && Array.isArray(segment.timelinePath);
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function toVisitStorageKey(startTime: string | Date): string {
  return (typeof startTime === 'string' ? new Date(startTime) : startTime).toISOString();
}

export function buildPathPointSourceId(
  segment: Pick<RawTimelinePathSegment, 'startTime' | 'endTime'>,
  point: Pick<RawTimelinePoint, 'time' | 'point'>,
): string {
  return JSON.stringify([segment.startTime, segment.endTime, point.time, point.point]);
}

export function applyTimelineEdits(
  rawTimeline: RawTimeline,
  edits: StoredTimelineEdits,
  options: { applyVisitMetadata?: boolean } = {},
): RawTimeline {
  const semanticSegments: RawSegment[] = [];

  for (const segment of rawTimeline.semanticSegments) {
    if (isVisitSeg(segment)) {
      const visitKey = toVisitStorageKey(segment.startTime);
      if (edits.deletedVisitKeys.has(visitKey)) {
        continue;
      }

      const nextSegment = cloneValue(segment);
      if (options.applyVisitMetadata) {
        const nextSlug = edits.slugsByVisitKey[visitKey]?.trim();
        const nextName = edits.labelsByVisitKey[visitKey]?.trim();

        if (nextSlug) {
          nextSegment.visit.topCandidate.visitId = nextSlug;
        }
        if (nextName) {
          nextSegment.visit.topCandidate.visitName = nextName;
        }
      }

      semanticSegments.push(nextSegment);
      continue;
    }

    if (isPathSeg(segment)) {
      const keptPoints = segment.timelinePath.filter((point) => {
        const pointId = buildPathPointSourceId(segment, point);
        return !edits.deletedPathPointIds.has(pointId);
      });

      if (keptPoints.length === 0) {
        continue;
      }

      const nextSegment = cloneValue(segment);
      nextSegment.timelinePath = keptPoints.map((point) => cloneValue(point));
      semanticSegments.push(nextSegment);
      continue;
    }

    semanticSegments.push(cloneValue(segment));
  }

  for (const [visitKey, createdVisit] of Object.entries(edits.createdVisitsByVisitKey)) {
    if (edits.deletedVisitKeys.has(visitKey)) {
      continue;
    }

    const nextSegment = cloneValue(createdVisit);
    if (options.applyVisitMetadata) {
      const nextSlug = edits.slugsByVisitKey[visitKey]?.trim();
      const nextName = edits.labelsByVisitKey[visitKey]?.trim();

      if (nextSlug) {
        nextSegment.visit.topCandidate.visitId = nextSlug;
      }
      if (nextName) {
        nextSegment.visit.topCandidate.visitName = nextName;
      }
    }

    semanticSegments.push(nextSegment);
  }

  semanticSegments.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  return { semanticSegments };
}
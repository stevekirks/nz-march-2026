import L from 'leaflet';
import type { ParsedDay, ParsedVisit, TrackSegment, ActivityType, LatLng, DayMetadata } from './types';
import type { TrackPoint } from './types';

// ─── Activity type → style ────────────────────────────────────────────────────

interface PathStyle {
  dashArray: string | undefined;
  weight: number;
  opacity: number;
  baseHue: number; // HSL hue to blend with day hue
}

const ACTIVITY_STYLES: Record<string, PathStyle> = {
  IN_PASSENGER_VEHICLE: { dashArray: undefined,      weight: 4, opacity: 0.85, baseHue: 210 },
  IN_BUS:               { dashArray: undefined,      weight: 4, opacity: 0.85, baseHue: 195 },
  IN_FERRY:             { dashArray: '10,5',          weight: 4, opacity: 0.85, baseHue: 185 },
  IN_TRAIN:             { dashArray: '16,4',          weight: 5, opacity: 0.90, baseHue: 240 },
  IN_SUBWAY:            { dashArray: '16,4',          weight: 5, opacity: 0.90, baseHue: 255 },
  IN_TRAM:              { dashArray: '10,4',          weight: 4, opacity: 0.85, baseHue: 220 },
  WALKING:              { dashArray: '4,6',           weight: 2, opacity: 0.85, baseHue: 120 },
  RUNNING:              { dashArray: '4,4',           weight: 2, opacity: 0.85, baseHue: 80  },
  CYCLING:              { dashArray: '8,4,2,4',       weight: 3, opacity: 0.85, baseHue: 35  },
  FLYING:               { dashArray: '20,8',          weight: 3, opacity: 0.75, baseHue: 270 },
  SAILING:              { dashArray: '12,6',          weight: 3, opacity: 0.75, baseHue: 175 },
  SKIING:               { dashArray: '6,3',           weight: 2, opacity: 0.80, baseHue: 180 },
  UNKNOWN_ACTIVITY_TYPE:{ dashArray: '2,8',           weight: 2, opacity: 0.55, baseHue: 0   },
};

const DEFAULT_STYLE: PathStyle = { dashArray: '2,8', weight: 2, opacity: 0.55, baseHue: 0 };

const PATH_PANE = 'path-pane';
const PATH_ARROW_PANE = 'path-arrow-pane';
const PATH_POINT_PANE = 'path-point-pane';
const VISIT_PANE = 'visit-pane';
const VISIT_MEDIA_PANE = 'visit-media-pane';

function getStyle(type: ActivityType): PathStyle {
  return ACTIVITY_STYLES[type] ?? DEFAULT_STYLE;
}

/**
 * Path color is determined solely by activity type so the legend is unambiguous.
 * UNKNOWN / unresolved segments get a fixed neutral grey.
 * Day hue is NOT blended in here — it is used only for visit markers in the sidebar.
 */
function activityColor(activityType: ActivityType): string {
  if (activityType === 'UNKNOWN_ACTIVITY_TYPE') {
    return 'hsl(220, 12%, 58%)';
  }
  const style = getStyle(activityType);
  return `hsl(${style.baseHue}, 72%, 48%)`;
}

// ─── Bearing / arrow helpers ─────────────────────────────────────────────────

function bearing(a: LatLng, b: LatLng): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function arrowIcon(angleDeg: number, color: string): L.DivIcon {
  // A filled triangle SVG rotated to point in direction of travel
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
    <polygon points="6,0 12,12 6,9 0,12" fill="${color}" transform="rotate(${angleDeg},6,6)"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

/** Place an arrow every ~ARROW_EVERY_N points along a polyline */
const ARROW_EVERY_N = 8;

function addArrows(
  group: L.LayerGroup,
  points: Array<LatLng>,
  color: string,
): void {
  if (points.length < 2) return;
  for (let i = ARROW_EVERY_N - 1; i < points.length - 1; i += ARROW_EVERY_N) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const mid: LatLng = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const angle = bearing(a, b);
    L.marker([mid.lat, mid.lng], {
      icon: arrowIcon(angle, color),
      interactive: false,
      pane: PATH_ARROW_PANE,
    }).addTo(group);
  }
}

// ─── Layer builders ───────────────────────────────────────────────────────────

function buildSegmentLayer(seg: TrackSegment, _dayHue: number): L.LayerGroup {
  const group = L.layerGroup();
  if (seg.points.length < 2) return group;

  const color = activityColor(seg.activityType);
  const style = getStyle(seg.activityType);
  const latlngs = seg.points.map<[number, number]>(p => [p.lat, p.lng]);

  L.polyline(latlngs, {
    color,
    weight: style.weight,
    opacity: style.opacity,
    dashArray: style.dashArray,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false,
    pane: PATH_PANE,
  }).addTo(group);

  addArrows(group, seg.points, color);

  return group;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mediaHtml(visitId: string, files: string[]): string {
  if (files.length === 0) return '';
  const items = files.map(file => {
    const url = `${import.meta.env.BASE_URL}media/${encodeURIComponent(visitId)}/${encodeURIComponent(file)}`;
    if (/\.(mp4|mov|webm)$/i.test(file)) {
      return `<div class="popup-media-item">
        <video class="popup-media-video" controls preload="metadata">
          <source src="${escAttr(url)}">
        </video>
      </div>`;
    }
    return `<div class="popup-media-item">
      <a href="${escAttr(url)}" target="_blank" rel="noopener">
        <img class="popup-media-thumb" src="${escAttr(url)}" alt="${escAttr(file)}">
      </a>
    </div>`;
  }).join('');
  return `<div class="popup-media-grid">${items}</div>`;
}

function visitPopupHtml(v: ParsedVisit, mediaFiles: string[]): string {
  const start = v.startTime.toLocaleString('en-NZ', { timeStyle: 'short', dateStyle: 'short' });
  const end = v.endTime.toLocaleString('en-NZ', { timeStyle: 'short', dateStyle: 'short' });
  const duration = Math.round((v.endTime.getTime() - v.startTime.getTime()) / 60000);
  const durationStr = duration >= 60
    ? `${Math.floor(duration / 60)}h ${duration % 60}m`
    : `${duration}m`;

  // Translate raw semantic type into a readable label
  const rawType = v.semanticType ?? 'UNKNOWN';
  const typeLabel = v.visitName
    ? v.visitName
    : rawType === 'UNKNOWN' || rawType === 'UNKNOWN_TYPE' || rawType === ''
      ? 'Stop'
      : rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase().replace(/_/g, ' ');

  const coord = `${v.location.lat.toFixed(7)}°, ${v.location.lng.toFixed(7)}°`;

  return `<div class="popup-visit">
    <strong>${typeLabel}</strong><br/>
    <span class="popup-coord">${coord}</span><br/>
    <span>${start} → ${end}</span><br/>
    <span>${durationStr}</span>
    ${mediaHtml(v.visitId ?? '', mediaFiles)}
  </div>`;
}

/** Build the HTML content for a visit — used by the right-side visit panel. */
export function buildVisitPanelContent(v: ParsedVisit, mediaFiles: string[]): string {
  return visitPopupHtml(v, mediaFiles);
}

/** Callback fired when a visit marker is clicked. */
export type VisitClickHandler = (
  visit: ParsedVisit,
  mediaFiles: string[],
  dateKey: string,
  dayLabel: string,
  meta: DayMetadata | undefined,
  marker: L.CircleMarker,
) => void;

export type PathPointClickHandler = (
  point: TrackPoint,
  dateKey: string,
  dayLabel: string,
  marker: L.CircleMarker,
) => void;

// Fixed colours for visit markers — not day-dependent
const VISIT_FILL   = 'hsl(45, 90%, 62%)';
const VISIT_STROKE = 'hsl(38, 70%, 38%)';
const VISIT_MEDIA_CLASS = 'visit-marker--has-media';

function buildVisitMarker(
  visit: ParsedVisit,
  dateKey: string,
  dayLabel: string,
  mediaFiles: string[],
  onVisitClick: VisitClickHandler,
  editMode: boolean,
  meta?: DayMetadata,
): L.CircleMarker {
  const hasMedia = mediaFiles.length > 0;
  const isMobile = window.matchMedia('(pointer: coarse)').matches;
  const baseRadius = visit.hierarchyLevel >= 1
    ? (editMode ? 11 : 8)
    : (editMode ? 8 : 5);
  const radius = hasMedia && isMobile ? Math.max(baseRadius, 14) : baseRadius;
  const marker = L.circleMarker([visit.location.lat, visit.location.lng], {
    radius,
    color: VISIT_STROKE,
    weight: 2,
    fillColor: VISIT_FILL,
    fillOpacity: 0.90,
    className: hasMedia ? `visit-marker ${VISIT_MEDIA_CLASS}` : 'visit-marker',
    pane: hasMedia ? VISIT_MEDIA_PANE : VISIT_PANE,
  });
  marker.on('click', (e: L.LeafletMouseEvent) => {
    // Stop both DOM and Leaflet's internal event propagation so the map's
    // own 'click' handler (which closes the panel) does not fire.
    L.DomEvent.stop(e.originalEvent);
    onVisitClick(visit, mediaFiles, dateKey, dayLabel, meta, marker);
  });
  return marker;
}

function buildPathPointMarker(
  point: TrackPoint,
  dateKey: string,
  dayLabel: string,
  onPathPointClick: PathPointClickHandler,
): L.CircleMarker {
  const marker = L.circleMarker([point.lat, point.lng], {
    radius: 4,
    color: 'hsl(8, 72%, 34%)',
    weight: 2,
    fillColor: 'hsl(14, 100%, 73%)',
    fillOpacity: 0.95,
    className: 'edit-path-point-marker',
    pane: PATH_POINT_PANE,
  });
  marker.on('click', (e: L.LeafletMouseEvent) => {
    L.DomEvent.stop(e.originalEvent);
    onPathPointClick(point, dateKey, dayLabel, marker);
  });
  return marker;
}

/** Mapping from day dateKey → { layerGroup, day } for toggle control */
export interface DayLayer {
  group: L.LayerGroup;
  day: ParsedDay;
  visitMarkers: Map<string, L.CircleMarker>;
}

export function buildDayLayers(
  days: ParsedDay[],
  mediaManifest: Record<string, string[]> = {},
  onVisitClick?: VisitClickHandler,
  onPathPointClick?: PathPointClickHandler,
  editMode = false,
): DayLayer[] {
  return days.map(day => {
    const group = L.layerGroup();
    const visitMarkers = new Map<string, L.CircleMarker>();

    // GPS track segments
    for (const seg of day.segments) {
      buildSegmentLayer(seg, day.hue).addTo(group);
    }

    // Visit markers
    for (const visit of day.visits) {
      const mediaFiles = (visit.visitId ? (mediaManifest[visit.visitId] ?? []) : []);
      if (onVisitClick) {
        const m = buildVisitMarker(visit, day.dateKey, day.label, mediaFiles, onVisitClick, editMode, day.metadata);
        m.addTo(group);
        if (visit.visitId) visitMarkers.set(visit.visitId, m);
      }
    }

    if (onPathPointClick) {
      for (const seg of day.segments) {
        for (const point of seg.points) {
          if (!point.sourceId) continue;
          buildPathPointMarker(point, day.dateKey, day.label, onPathPointClick).addTo(group);
        }
      }
    }

    return { group, day, visitMarkers };
  });
}

/** Compute lat/lng bounds of all visible data */
export function computeBounds(layers: DayLayer[]): L.LatLngBounds | null {
  let bounds: L.LatLngBounds | null = null;
  for (const { day } of layers) {
    for (const seg of day.segments) {
      for (const pt of seg.points) {
        const ll = L.latLng(pt.lat, pt.lng);
        if (!bounds) bounds = L.latLngBounds(ll, ll);
        else bounds.extend(ll);
      }
    }
    for (const visit of day.visits) {
      const ll = L.latLng(visit.location.lat, visit.location.lng);
      if (!bounds) bounds = L.latLngBounds(ll, ll);
      else bounds.extend(ll);
    }
  }
  return bounds;
}

/** Create and return the Leaflet map instance */
export function initMap(containerId: string): L.Map {
  const map = L.map(containerId, {
    center: [-41.5, 172.0], // Centre of New Zealand
    zoom: 5,
    zoomControl: true,
  });

  map.createPane(PATH_PANE);
  map.getPane(PATH_PANE)!.style.zIndex = '410';
  map.createPane(PATH_ARROW_PANE);
  map.getPane(PATH_ARROW_PANE)!.style.zIndex = '420';
  map.createPane(PATH_POINT_PANE);
  map.getPane(PATH_POINT_PANE)!.style.zIndex = '430';
  map.createPane(VISIT_PANE);
  map.getPane(VISIT_PANE)!.style.zIndex = '440';
  map.createPane(VISIT_MEDIA_PANE);
  map.getPane(VISIT_MEDIA_PANE)!.style.zIndex = '450';

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  return map;
}

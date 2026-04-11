/**
 * editMode.ts — temporary browser-based edit mode for visit popups.
 *
 * Activated by the URL parameter ?edit=1.
 * All edits are persisted to localStorage and can be exported as .txt / .json.
 * This module has NO effect when isEditMode() returns false.
 */

import type { ParsedVisit, ParsedDay, DayMetadata, RawTimeline, RawVisitSegment, JournalEntry } from './types';
import { applyTimelineEdits, type StoredTimelineEdits } from './timelineEdits';

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function isEditMode(): boolean {
  return new URLSearchParams(location.search).has('edit');
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

const LABELS_KEY = 'nz2026_visit_labels'; // Record<startTimeKey, visitName>
const DIARY_KEY  = 'nz2026_diary_days';   // Record<dateKey, string>
const IDS_KEY    = 'nz2026_visit_ids';    // Record<startTimeKey, customSlug>
const DELETED_VISITS_KEY = 'nz2026_deleted_visits';
const DELETED_PATH_POINTS_KEY = 'nz2026_deleted_path_points';
const CREATED_VISITS_KEY = 'nz2026_created_visits';
const PENDING_SELECTED_DAY_KEY = 'nz2026_pending_selected_day';

function readJson<T extends object>(key: string): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as T;
  } catch {
    return {} as T;
  }
}

/** Stable unique ID for a visit — its startTime in UTC ISO format. */
export function getVisitId(visit: ParsedVisit): string {
  return visit.startTime.toISOString();
}

export function setPendingSelectedDay(dateKey: string | null): void {
  if (dateKey) {
    sessionStorage.setItem(PENDING_SELECTED_DAY_KEY, dateKey);
    return;
  }
  sessionStorage.removeItem(PENDING_SELECTED_DAY_KEY);
}

export function consumePendingSelectedDay(): string | null {
  const dateKey = sessionStorage.getItem(PENDING_SELECTED_DAY_KEY);
  if (dateKey) {
    sessionStorage.removeItem(PENDING_SELECTED_DAY_KEY);
  }
  return dateKey;
}

function readSet(key: string): Set<string> {
  return new Set(Object.keys(readJson<Record<string, true>>(key)));
}

function writeSet(key: string, values: Set<string>): void {
  const record: Record<string, true> = {};
  for (const value of values) {
    record[value] = true;
  }
  localStorage.setItem(key, JSON.stringify(record));
}

export function getStoredLabel(visitId: string): string {
  return (readJson<Record<string, string>>(LABELS_KEY))[visitId] ?? '';
}

export function setStoredLabel(visitId: string, value: string): void {
  const map = readJson<Record<string, string>>(LABELS_KEY);
  map[visitId] = value;
  localStorage.setItem(LABELS_KEY, JSON.stringify(map));
}

function deleteStoredLabel(visitId: string): void {
  const map = readJson<Record<string, string>>(LABELS_KEY);
  delete map[visitId];
  localStorage.setItem(LABELS_KEY, JSON.stringify(map));
}

function getStoredVisitIdSlug(startTimeKey: string): string {
  return (readJson<Record<string, string>>(IDS_KEY))[startTimeKey] ?? '';
}

function setStoredVisitIdSlug(startTimeKey: string, slug: string): void {
  const map = readJson<Record<string, string>>(IDS_KEY);
  map[startTimeKey] = slug;
  localStorage.setItem(IDS_KEY, JSON.stringify(map));
}

function deleteStoredVisitIdSlug(startTimeKey: string): void {
  const map = readJson<Record<string, string>>(IDS_KEY);
  delete map[startTimeKey];
  localStorage.setItem(IDS_KEY, JSON.stringify(map));
}

export function setVisitDeleted(visitId: string, deleted: boolean): void {
  const deletedVisits = readSet(DELETED_VISITS_KEY);
  if (deleted) deletedVisits.add(visitId);
  else deletedVisits.delete(visitId);
  writeSet(DELETED_VISITS_KEY, deletedVisits);
}

export function isVisitDeleted(visitId: string): boolean {
  return readSet(DELETED_VISITS_KEY).has(visitId);
}

export function setPathPointDeleted(pointId: string, deleted: boolean): void {
  const deletedPointIds = readSet(DELETED_PATH_POINTS_KEY);
  if (deleted) deletedPointIds.add(pointId);
  else deletedPointIds.delete(pointId);
  writeSet(DELETED_PATH_POINTS_KEY, deletedPointIds);
}

export function isPathPointDeleted(pointId: string): boolean {
  return readSet(DELETED_PATH_POINTS_KEY).has(pointId);
}

function getStoredCreatedVisits(): Record<string, RawVisitSegment> {
  return readJson<Record<string, RawVisitSegment>>(CREATED_VISITS_KEY);
}

function setStoredCreatedVisit(visitId: string, visit: RawVisitSegment): void {
  const map = getStoredCreatedVisits();
  map[visitId] = visit;
  localStorage.setItem(CREATED_VISITS_KEY, JSON.stringify(map));
}

function deleteStoredCreatedVisit(visitId: string): void {
  const map = getStoredCreatedVisits();
  delete map[visitId];
  localStorage.setItem(CREATED_VISITS_KEY, JSON.stringify(map));
}

function getStoredCreatedVisitIds(): string[] {
  return Object.keys(getStoredCreatedVisits());
}

function readStoredTimelineEdits(): StoredTimelineEdits {
  return {
    deletedVisitKeys: readSet(DELETED_VISITS_KEY),
    deletedPathPointIds: readSet(DELETED_PATH_POINTS_KEY),
    labelsByVisitKey: readJson<Record<string, string>>(LABELS_KEY),
    slugsByVisitKey: readJson<Record<string, string>>(IDS_KEY),
    createdVisitsByVisitKey: getStoredCreatedVisits(),
  };
}

export function applyStoredTimelineEdits(rawTimeline: RawTimeline): RawTimeline {
  return applyTimelineEdits(rawTimeline, readStoredTimelineEdits());
}

/** Convert a human-readable name to a URL-safe slug. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u2018\u2019'`]/g, '')   // remove apostrophes
    .replace(/[^a-z0-9]+/g, '-')        // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '');           // trim leading/trailing hyphens
}

/**
 * Generate a slug from `name` that is unique among all stored slugs,
 * excluding the entry for `excludeStartKey` (so re-saving the same visit
 * doesn't conflict with itself).
 */
function generateUniqueSlug(name: string, excludeStartKey: string): string {
  const base = slugify(name);
  if (!base) return '';
  const allSlugs = new Set(
    Object.entries(readJson<Record<string, string>>(IDS_KEY))
      .filter(([k]) => k !== excludeStartKey)
      .map(([, v]) => v),
  );
  if (!allSlugs.has(base)) return base;
  let n = 2;
  while (allSlugs.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function getStoredDiaryText(dateKey: string): string | null {
  return (readJson<Record<string, string>>(DIARY_KEY))[dateKey] ?? null;
}

export function setStoredDiaryText(dateKey: string, value: string): void {
  const map = readJson<Record<string, string>>(DIARY_KEY);
  map[dateKey] = value;
  localStorage.setItem(DIARY_KEY, JSON.stringify(map));
}

// ─── Diary text reconstruction ────────────────────────────────────────────────

/** Convert "YYYY-MM-DD" to "DD/MM/YYYY" for the diary header format. */
function dateKeyToDDMMYYYY(dateKey: string): string {
  const [y, m, d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Reconstruct the diary .txt format for a day from its parsed metadata,
 * preserving original entry order and all free-text notes.
 * If there is no metadata, just the date header is returned.
 */
export function buildDefaultDiaryText(dateKey: string, meta?: DayMetadata): string {
  const ddmmyyyy = dateKeyToDDMMYYYY(dateKey);
  const header = meta?.location ? `${ddmmyyyy} | ${meta.location}` : ddmmyyyy;
  const lines: string[] = [header];

  if (!meta) return lines.join('\n');

  for (const item of meta.entries) {
    lines.push(formatJournalEntry(item));
  }

  return lines.join('\n');
}

function formatJournalEntry(item: JournalEntry): string {
  switch (item.kind) {
    case 'hike': {
      const h = item.entry;
      const parts: string[] = [h.name];
      if (h.distanceKm) parts.push(h.distanceKm);
      if (h.elevationM) parts.push(`${h.elevationM} Elevation`);
      if (h.duration)   parts.push(h.duration);
      const star  = h.starred ? ' ⭐' : '';
      const notes = h.notes   ? `. ${h.notes}` : '';
      return `Hike: ${parts.join(' | ')}${star}${notes}`;
    }
    case 'stay': {
      const s = item.entry;
      const cost   = s.costNzd ? ` (${s.costNzd})` : '';
      const rating = s.rating != null ? ` ${s.rating}/5` : '';
      const notes  = s.notes ? ` ${s.notes}` : '';
      return `Stay: ${s.name}${cost}.${rating}.${notes}`.replace(/\.\./, '.');
    }
    case 'drive': {
      const d = item.entry;
      const parts: string[] = [d.route];
      if (d.distanceKm) parts.push(d.distanceKm);
      if (d.duration)   parts.push(d.duration);
      const notes = d.notes ? `. ${d.notes}` : '';
      return `Driving: ${parts.join(' | ')}${notes}`;
    }
    case 'activity':
      return `Activity: ${item.entry}`;
  }
}

// ─── Popup data type ──────────────────────────────────────────────────────────

export interface EditPopupData {
  visitId: string;
  dateKey: string;
  /** Human-readable day label, e.g. "Wed 15 Mar". */
  dayLabel: string;
  meta?: DayMetadata;
}

export interface PathPointEditData {
  pointId: string;
  dateKey: string;
  dayLabel: string;
  activityType: string;
  pointTime: Date;
  lat: number;
  lng: number;
}

export interface NewVisitEditData {
  dateKey: string;
  dayLabel: string;
  lat: number;
  lng: number;
  timezoneUtcOffsetMinutes: number;
  existingVisitIds: string[];
}

// ─── Popup HTML builder ───────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

function formatCoord(lat: number, lng: number): string {
  return `${lat.toFixed(7)}°, ${lng.toFixed(7)}°`;
}

function buildUtcDateForLocalTime(
  dateKey: string,
  timeValue: string,
  offsetMinutes: number,
): Date | null {
  const [yearStr, monthStr, dayStr] = dateKey.split('-');
  const [hourStr, minuteStr] = timeValue.split(':');
  if (!yearStr || !monthStr || !dayStr || !hourStr || !minuteStr) return null;

  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const day = Number.parseInt(dayStr, 10);
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);
  if ([year, month, day, hour, minute].some(Number.isNaN)) return null;

  return new Date(Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60000);
}

function formatIsoWithOffset(value: Date, offsetMinutes: number): string {
  const local = new Date(value.getTime() + offsetMinutes * 60000);
  const year = local.getUTCFullYear();
  const month = pad2(local.getUTCMonth() + 1);
  const day = pad2(local.getUTCDate());
  const hour = pad2(local.getUTCHours());
  const minute = pad2(local.getUTCMinutes());
  const second = pad2(local.getUTCSeconds());
  const ms = pad3(local.getUTCMilliseconds());
  const absOffset = Math.abs(offsetMinutes);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offsetHour = pad2(Math.floor(absOffset / 60));
  const offsetMinute = pad2(absOffset % 60);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${sign}${offsetHour}:${offsetMinute}`;
}

function buildCreatedVisitSegment(
  data: NewVisitEditData,
  name: string,
  startTime: Date,
  durationMinutes: number,
  visitId: string,
): RawVisitSegment {
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  const coord = formatCoord(data.lat, data.lng);
  return {
    startTime: formatIsoWithOffset(startTime, data.timezoneUtcOffsetMinutes),
    endTime: formatIsoWithOffset(endTime, data.timezoneUtcOffsetMinutes),
    startTimeTimezoneUtcOffsetMinutes: data.timezoneUtcOffsetMinutes,
    endTimeTimezoneUtcOffsetMinutes: data.timezoneUtcOffsetMinutes,
    visit: {
      hierarchyLevel: 0,
      probability: 1,
      topCandidate: {
        visitId,
        visitName: name,
        semanticType: 'UNKNOWN',
        probability: 1,
        placeLocation: { latLng: coord },
      },
    },
  };
}

function resolveUniqueVisitStart(
  requestedStart: Date,
  takenVisitIds: Iterable<string>,
): Date {
  const usedIds = new Set(takenVisitIds);
  let candidate = new Date(requestedStart);
  while (usedIds.has(candidate.toISOString())) {
    candidate = new Date(candidate.getTime() + 1000);
  }
  return candidate;
}

export function buildNewVisitPanelHtml(data: NewVisitEditData): string {
  return `<div class="popup-visit popup-visit--edit">
  <strong>New visit</strong><br/>
  <span class="popup-coord">${escHtml(formatCoord(data.lat, data.lng))}</span><br/>
  <span>${escHtml(data.dayLabel)} · ${escHtml(data.dateKey)}</span>

  <div class="popup-edit-section popup-edit-section--stacked">
    <label class="popup-edit-field">
      <span class="popup-edit-field-label">Name</span>
      <input
        id="edit-new-visit-name"
        class="popup-edit-heading-input"
        type="text"
        placeholder="Stop name"
      />
    </label>

    <div class="popup-edit-grid">
      <label class="popup-edit-field">
        <span class="popup-edit-field-label">Start time</span>
        <input
          id="edit-new-visit-start"
          class="popup-edit-input"
          type="time"
          value="12:00"
          step="60"
        />
      </label>

      <label class="popup-edit-field">
        <span class="popup-edit-field-label">Duration (min)</span>
        <input
          id="edit-new-visit-duration"
          class="popup-edit-input"
          type="number"
          min="1"
          step="1"
          value="30"
        />
      </label>
    </div>

    <div class="popup-edit-actions popup-edit-actions--spread">
      <button id="edit-create-visit-btn" class="popup-edit-save">Create visit</button>
      <span id="edit-create-visit-confirm" class="popup-edit-saved-confirm" aria-live="polite"></span>
    </div>
  </div>
</div>`;
}

export function buildNewVisitDisabledPanelHtml(): string {
  return `<div class="popup-visit popup-visit--edit">
  <strong>New visit</strong><br/>
  <div class="popup-edit-section popup-edit-section--stacked">
    <span class="popup-edit-help">Select a single day in the sidebar, then click the map again to add a visit for that day.</span>
  </div>
</div>`;
}

/**
 * Build the HTML for a visit popup in edit mode.
 * Static element IDs (edit-label-input, etc.) are safe because only
 * one panel is ever shown at a time.
 */
export function buildEditPanelHtml(visit: ParsedVisit, data: EditPopupData): string {
  // ── Read-only GPS display (same logic as the normal popup) ──
  const start = visit.startTime.toLocaleString('en-NZ', { timeStyle: 'short', dateStyle: 'short' });
  const end   = visit.endTime.toLocaleString('en-NZ', { timeStyle: 'short', dateStyle: 'short' });
  const durationMin = Math.round((visit.endTime.getTime() - visit.startTime.getTime()) / 60000);
  const durationStr = durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`;

  const rawType = visit.semanticType ?? 'UNKNOWN';
  const typeLabel =
    rawType === 'UNKNOWN' || rawType === 'UNKNOWN_TYPE' || rawType === ''
      ? 'Stop'
      : rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase().replace(/_/g, ' ');

  const coord = `${visit.location.lat.toFixed(7)}°, ${visit.location.lng.toFixed(7)}°`;

  // ── Pre-fill the heading with stored name, falling back to derived typeLabel ──
  const storedLabel = getStoredLabel(data.visitId);
  const headingValue = storedLabel || typeLabel;
  // Show the custom slug if one has been generated, otherwise the raw startTime key
  const displayVisitId = getStoredVisitIdSlug(data.visitId) || data.visitId;

  return `<div class="popup-visit">
  <input
    id="edit-label-input"
    class="popup-edit-heading-input"
    type="text"
    placeholder="${escAttr(typeLabel)}"
    value="${escAttr(headingValue)}"
    title="Edit stop name"
  />
  <span class="popup-coord">${escHtml(coord)}</span><br/>
  <span>${escHtml(start)} → ${escHtml(end)}</span><br/>
  <span>${escHtml(durationStr)}</span>

  <div class="popup-edit-section">
    <div class="popup-edit-id-row">
      <span class="popup-edit-id-label">Visit ID (for JSON export):</span>
      <code class="popup-edit-id">${escHtml(displayVisitId)}</code>
    </div>
    <div class="popup-edit-actions">
      <button id="edit-save-btn" class="popup-edit-save">Save name</button>
      <button id="edit-delete-visit-btn" class="popup-edit-delete">Delete visit</button>
      <span id="edit-saved-confirm" class="popup-edit-saved-confirm" aria-live="polite"></span>
    </div>
  </div>
</div>`;
}

function activityLabel(rawType: string): string {
  return rawType === 'UNKNOWN_ACTIVITY_TYPE' || rawType === ''
    ? 'Unknown activity'
    : rawType.charAt(0) + rawType.slice(1).toLowerCase().replace(/_/g, ' ');
}

export function buildPathPointEditPanelHtml(data: PathPointEditData): string {
  const timeLabel = data.pointTime.toLocaleString('en-NZ', { timeStyle: 'short', dateStyle: 'short' });
  const coord = `${data.lat.toFixed(7)}°, ${data.lng.toFixed(7)}°`;

  return `<div class="popup-visit">
  <strong>Path vertex</strong><br/>
  <span class="popup-coord">${escHtml(coord)}</span><br/>
  <span>${escHtml(timeLabel)}</span><br/>
  <span>${escHtml(activityLabel(data.activityType))}</span>

  <div class="popup-edit-section">
    <div class="popup-edit-id-row">
      <span class="popup-edit-id-label">Point source ID:</span>
      <code class="popup-edit-id">${escHtml(data.pointId)}</code>
    </div>
    <div class="popup-edit-actions">
      <button id="edit-delete-point-btn" class="popup-edit-delete">Delete vertex</button>
      <span id="edit-point-confirm" class="popup-edit-saved-confirm" aria-live="polite"></span>
    </div>
  </div>
</div>`;
}

// ─── Panel event wiring ──────────────────────────────────────────────────────

export function wireEditPanelEvents(popupEl: HTMLElement, data: EditPopupData): void {
  const saveBtn   = popupEl.querySelector<HTMLButtonElement>('#edit-save-btn');
  const deleteBtn = popupEl.querySelector<HTMLButtonElement>('#edit-delete-visit-btn');
  const labelEl   = popupEl.querySelector<HTMLInputElement>('#edit-label-input');
  const confirmEl = popupEl.querySelector<HTMLElement>('#edit-saved-confirm');
  const idCodeEl  = popupEl.querySelector<HTMLElement>('.popup-edit-id');
  if (!saveBtn || !labelEl || !confirmEl) return;

  saveBtn.addEventListener('click', () => {
    const name = labelEl.value.trim();
    setStoredLabel(data.visitId, name);

    if (name) {
      // Generate a slug from the name, ensure uniqueness, store and display it
      const slug = generateUniqueSlug(name, data.visitId);
      setStoredVisitIdSlug(data.visitId, slug);
      if (idCodeEl) idCodeEl.textContent = slug;
    }

    confirmEl.textContent = 'Saved ✓';
    saveBtn.disabled = true;
    setTimeout(() => {
      confirmEl.textContent = '';
      saveBtn.disabled = false;
    }, 2000);
  });

  deleteBtn?.addEventListener('click', () => {
    const confirmed = window.confirm('Delete this visit from the exported timeline?');
    if (!confirmed) return;

    setPendingSelectedDay(data.dateKey);
    setVisitDeleted(data.visitId, true);
    deleteStoredCreatedVisit(data.visitId);
    deleteStoredLabel(data.visitId);
    deleteStoredVisitIdSlug(data.visitId);
    confirmEl.textContent = 'Deleting…';
    saveBtn.disabled = true;
    deleteBtn.disabled = true;
    location.reload();
  });
}

export function wireNewVisitPanelEvents(popupEl: HTMLElement, data: NewVisitEditData): void {
  const nameEl = popupEl.querySelector<HTMLInputElement>('#edit-new-visit-name');
  const startEl = popupEl.querySelector<HTMLInputElement>('#edit-new-visit-start');
  const durationEl = popupEl.querySelector<HTMLInputElement>('#edit-new-visit-duration');
  const saveBtn = popupEl.querySelector<HTMLButtonElement>('#edit-create-visit-btn');
  const confirmEl = popupEl.querySelector<HTMLElement>('#edit-create-visit-confirm');
  if (!nameEl || !startEl || !durationEl || !saveBtn || !confirmEl) return;

  saveBtn.addEventListener('click', () => {
    const name = nameEl.value.trim();
    const durationMinutes = Number.parseInt(durationEl.value, 10);
    const requestedStart = buildUtcDateForLocalTime(data.dateKey, startEl.value, data.timezoneUtcOffsetMinutes);

    if (!name) {
      confirmEl.textContent = 'Name is required';
      return;
    }
    if (!requestedStart) {
      confirmEl.textContent = 'Pick a valid start time';
      return;
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1) {
      confirmEl.textContent = 'Duration must be at least 1 minute';
      return;
    }

    const uniqueStart = resolveUniqueVisitStart(
      requestedStart,
      [...data.existingVisitIds, ...getStoredCreatedVisitIds()],
    );
    const visitId = uniqueStart.toISOString();
    const slug = generateUniqueSlug(name, visitId);
    const segment = buildCreatedVisitSegment(data, name, uniqueStart, durationMinutes, slug);

    setPendingSelectedDay(data.dateKey);
    setStoredCreatedVisit(visitId, segment);
    setStoredLabel(visitId, name);
    if (slug) {
      setStoredVisitIdSlug(visitId, slug);
    }
    setVisitDeleted(visitId, false);

    confirmEl.textContent = 'Creating…';
    saveBtn.disabled = true;
    location.reload();
  });
}

export function wirePathPointEditPanelEvents(popupEl: HTMLElement, data: PathPointEditData): void {
  const deleteBtn = popupEl.querySelector<HTMLButtonElement>('#edit-delete-point-btn');
  const confirmEl = popupEl.querySelector<HTMLElement>('#edit-point-confirm');
  if (!deleteBtn || !confirmEl) return;

  deleteBtn.addEventListener('click', () => {
    const confirmed = window.confirm('Delete this path vertex from the exported timeline?');
    if (!confirmed) return;

    setPendingSelectedDay(data.dateKey);
    setPathPointDeleted(data.pointId, true);
    confirmEl.textContent = 'Deleting…';
    deleteBtn.disabled = true;
    location.reload();
  });
}

// ─── Export bar ───────────────────────────────────────────────────────────────

export function addExportBar(rawTimeline: RawTimeline, days: ParsedDay[]): void {
  const bar = document.createElement('div');
  bar.id = 'edit-export-bar';
  bar.innerHTML = `
    <span class="edit-mode-badge">EDIT MODE</span>
    <button id="edit-export-diary-btn" class="edit-bar-btn">Export diary .txt</button>
    <button id="edit-export-json-btn" class="edit-bar-btn">Export timeline .json</button>
    <span class="edit-bar-hint">Edits are auto-saved to browser storage</span>
  `;
  document.body.appendChild(bar);

  // The fixed export bar overlays the bottom of the viewport, hiding the last
  // day item in the sidebar. Add padding so it can scroll fully into view.
  const dayList = document.getElementById('day-list');
  if (dayList) dayList.style.paddingBottom = `${bar.offsetHeight || 52}px`;

  bar.querySelector('#edit-export-diary-btn')!
    .addEventListener('click', () => exportDiary(days));
  bar.querySelector('#edit-export-json-btn')!
    .addEventListener('click', () => exportJson(rawTimeline));
}

// ─── Export functions ─────────────────────────────────────────────────────────

function triggerDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportDiary(days: ParsedDay[]): void {
  const sorted = [...days].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const blocks = sorted.map(day =>
    getStoredDiaryText(day.dateKey) ?? buildDefaultDiaryText(day.dateKey, day.metadata),
  );
  triggerDownload('journal-NZ2026.txt', blocks.join('\n\n'), 'text/plain');
}

function exportJson(rawTimeline: RawTimeline): void {
  const output = applyTimelineEdits(rawTimeline, readStoredTimelineEdits(), {
    applyVisitMetadata: true,
  });
  triggerDownload('Timeline-NZ2026.json', `${JSON.stringify(output, null, 2)}\n`, 'application/json');
}

// ─── Sidebar diary editors ────────────────────────────────────────────────────

/**
 * For each day in the sidebar, inject a small ✏️ button into the day item header.
 * Clicking it toggles an inline diary editor panel below that day's row.
 * Must be called after buildSidebar() has rendered the day list.
 */
export function addSidebarDiaryEditors(days: ParsedDay[]): void {
  for (const day of days) {
    const li = document.querySelector<HTMLElement>(
      `#day-list li[data-date-key="${CSS.escape(day.dateKey)}"]`,
    );
    if (!li) continue;

    const header = li.querySelector<HTMLElement>('.day-item-header');
    if (!header) continue;

    // ── Edit toggle button ──
    const editBtn = document.createElement('button');
    editBtn.className = 'day-diary-edit-btn';
    editBtn.title = `Edit diary for ${day.label}`;
    editBtn.setAttribute('aria-label', `Edit diary for ${day.label}`);
    editBtn.textContent = '✏';
    header.appendChild(editBtn);

    // ── Diary editor panel (hidden initially via inline style — avoids CSS display:flex override) ──
    const panel = document.createElement('div');
    panel.className = 'day-diary-panel';
    panel.style.display = 'none';

    const textarea = document.createElement('textarea');
    textarea.className = 'day-diary-textarea';
    textarea.rows = 8;
    textarea.spellcheck = false;

    const actions = document.createElement('div');
    actions.className = 'day-diary-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'day-diary-save-btn';
    saveBtn.textContent = 'Save';

    const confirmSpan = document.createElement('span');
    confirmSpan.className = 'day-diary-confirm';
    confirmSpan.setAttribute('aria-live', 'polite');

    actions.append(saveBtn, confirmSpan);
    panel.append(textarea, actions);
    li.appendChild(panel);

    // ── Wire toggle: ✏ button opens/closes the panel ──
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent day selection toggling
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? '' : 'none';
      if (isHidden) {
        // Refresh textarea with latest stored value each time panel opens
        textarea.value = getStoredDiaryText(day.dateKey)
          ?? buildDefaultDiaryText(day.dateKey, day.metadata);
        textarea.focus();
      }
    });

    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setStoredDiaryText(day.dateKey, textarea.value);
      confirmSpan.textContent = 'Saved ✓';
      saveBtn.disabled = true;
      setTimeout(() => {
        confirmSpan.textContent = '';
        saveBtn.disabled = false;
      }, 2000);
    });
  }
}


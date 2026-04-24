import 'leaflet/dist/leaflet.css';
import './style.css';

import L from 'leaflet';
import type { RawTimeline } from './types';
import mediaManifest from 'virtual:media-manifest';
import { parseTimeline } from './parser';
import { parseMetadata } from './metadataParser';
import { initMap, buildDayLayers, computeBounds, buildVisitPanelContent, getVisitTypeLabel } from './layers';
import type { VisitClickHandler } from './layers';
import { buildSidebar, buildDayDetail, showLoading, hideLoading, wireResponsiveShell, isPhoneLayout } from './ui';
import type { SidebarSelectionOptions } from './ui';
import {
  isEditMode,
  getVisitId,
  applyStoredTimelineEdits,
  consumePendingSelectedDay,
  getPendingDeletionChangeEventName,
  getPendingPathPointDeletionIds,
  getPendingVisitDeletionIds,
  isPathPointPendingDeletion,
  isVisitPendingDeletion,
  buildEditPanelHtml,
  buildNewVisitPanelHtml,
  buildNewVisitDisabledPanelHtml,
  buildPathPointEditPanelHtml,
  wireEditPanelEvents,
  wireNewVisitPanelEvents,
  wirePathPointEditPanelEvents,
  addExportBar,
  addSidebarDiaryEditors,
  type EditPopupData,
  type NewVisitEditData,
  type PathPointEditData,
} from './editMode';
import type { ParsedVisit, DayMetadata } from './types';

// ─── Fix Leaflet's default icon paths when bundled by Vite ────────────────────
// (Leaflet uses a runtime URL resolution that doesn't work with bundlers)
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });

function parseIsoOffsetMinutes(isoString: string): number | null {
  const match = isoString.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number.parseInt(match[2]!, 10) * 60 + Number.parseInt(match[3]!, 10));
}

function getSegmentOffsetMinutes(segment: RawTimeline['semanticSegments'][number]): number | null {
  if (typeof segment.startTimeTimezoneUtcOffsetMinutes === 'number') {
    return segment.startTimeTimezoneUtcOffsetMinutes;
  }
  return parseIsoOffsetMinutes(segment.startTime);
}

function buildDateOffsetMap(rawTimeline: RawTimeline): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const segment of rawTimeline.semanticSegments) {
    const dateKey = segment.startTime.slice(0, 10);
    if (offsets.has(dateKey)) continue;
    const offset = getSegmentOffsetMinutes(segment);
    if (offset != null) offsets.set(dateKey, offset);
  }
  return offsets;
}

function buildAppUrl(pathname: string): string {
  return new URL(pathname, window.location.origin + import.meta.env.BASE_URL).toString();
}

interface VisitNavigationTarget {
  visit: ParsedVisit;
  dateKey: string;
  dayLabel: string;
  marker?: L.CircleMarker;
  mediaFiles: string[];
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  showLoading('Loading timeline data…');

  // 1. Fetch & parse
  let rawTimeline: RawTimeline;
  try {
    const resp = await fetch(buildAppUrl('Timeline-NZ2026.json'));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    showLoading('Parsing timeline data…');
    rawTimeline = await resp.json() as RawTimeline;
  } catch (err) {
    showLoading(`Error loading data: ${String(err)}`);
    return;
  }

  // 1b. Fetch & parse diary metadata (optional — failures are silently ignored)
  let metadataMap: Map<string, import('./types').DayMetadata> | undefined;
  try {
    const metaResp = await fetch(buildAppUrl('journal-NZ2026.txt'));
    if (metaResp.ok) {
      metadataMap = parseMetadata(await metaResp.text());
    }
  } catch { /* metadata is optional */ }

  showLoading('Building map layers…');
  const timelineSource = isEditMode() ? applyStoredTimelineEdits(rawTimeline) : rawTimeline;
  const timeline = parseTimeline(timelineSource, metadataMap);
  const dayOffsets = buildDateOffsetMap(rawTimeline);
  const initialSelectedDayKey = isEditMode() ? consumePendingSelectedDay() : null;
  const pendingDeletionChangeEventName = getPendingDeletionChangeEventName();

  // 2. Init map
  const map = initMap('map');
  const appShell = document.getElementById('app')!;
  const mapArea = document.getElementById('map-area')!;
  const mobileTopbar = document.getElementById('mobile-topbar')!;
  const mobileTopbarTitle = document.getElementById('mobile-topbar-title')!;
  const mobileDaySummary = document.getElementById('mobile-day-summary')!;
  const mobileDayLabel = document.getElementById('mobile-day-label')!;
  const mobileDayMeta = document.getElementById('mobile-day-meta')!;
  const mobileDayNotes = document.getElementById('mobile-day-notes')!;
  const mobileDayNotesToggle = document.getElementById('mobile-day-notes-toggle') as HTMLButtonElement;
  const mobileDayNotesSummary = document.getElementById('mobile-day-notes-summary')!;
  const mobileDayNotesPanel = document.getElementById('mobile-day-notes-panel')!;
  const mobileNextDayButton = document.getElementById('mobile-next-day') as HTMLButtonElement;
  const mobileShowAllButton = document.getElementById('mobile-show-all') as HTMLButtonElement;
  const mobileBackToMapButton = document.getElementById('mobile-back-to-map') as HTMLButtonElement;
  const showAllDaysButton = document.getElementById('btn-show-all') as HTMLButtonElement;

  // ── Visit panel ────────────────────────────────────────────────────
  const visitPanel        = document.getElementById('visit-panel')!;
  const visitPanelTitle   = document.getElementById('visit-panel-title')!;
  const visitPanelContent = document.getElementById('visit-panel-content')!;
  const visitPanelNavigation = document.getElementById('visit-panel-navigation')!;
  const visitPanelPrevious = document.getElementById('visit-panel-previous') as HTMLButtonElement;
  const visitPanelCollapse = document.getElementById('visit-panel-collapse')!;
  const visitPanelNext = document.getElementById('visit-panel-next') as HTMLButtonElement;

  const invalidateMapSize = (): void => {
    window.requestAnimationFrame(() => {
      map.invalidateSize();
    });
  };

  const { closeSidebarDrawer } = wireResponsiveShell(() => {
    invalidateMapSize();
  });

  let activeMarker: L.CircleMarker | null = null;
  let selectedDay: import('./types').ParsedDay | null = null;
  let activeEditPanel:
    | { kind: 'visit'; visit: ParsedVisit; data: EditPopupData; marker: L.CircleMarker }
    | { kind: 'path-point'; data: PathPointEditData; marker: L.CircleMarker }
    | { kind: 'new-visit'; data: NewVisitEditData }
    | { kind: 'new-visit-disabled' }
    | { kind: 'readonly'; visit: ParsedVisit; dateKey: string; dayLabel: string; marker?: L.CircleMarker }
    | null = null;
  let mobileNotesExpanded = false;
  let mobileNotesPreferenceExpanded = true;
  let mobileButtonStateFrame = 0;
  // Tracks whether the "Back to map" button is currently showing, so we can
  // debounce the revert to "Next day / Show all" and avoid scroll-inertia stutter.
  let mobileShowingBackToMap = false;
  let mobileRevertTimer = 0;

  function isVisitSectionInView(): boolean {
    if (!isPhoneLayout() || !visitPanel.classList.contains('visit-panel--open')) {
      return false;
    }
    const topbarRect = mobileTopbar.getBoundingClientRect();
    const visitPanelRect = visitPanel.getBoundingClientRect();
    return visitPanelRect.top <= topbarRect.bottom + 8;
  }

  // immediate=true → apply synchronously (used for known state changes: panel open/close, day change).
  // immediate=false (default) → debounce the "Back to map → Next/ShowAll" transition to absorb
  //   scroll inertia, which would otherwise cause rapid button flickering as the threshold
  //   is crossed back and forth.
  function updateMobileActionButtons(immediate = false): void {
    const hasSingleDay = selectedDay !== null;
    const inView = isVisitSectionInView();
    const showAllLabel = hasSingleDay ? 'Show all' : 'First day';
    const showAllTitle = hasSingleDay ? 'Show all days' : 'Show first day';

    mobileShowAllButton.textContent = showAllLabel;
    mobileShowAllButton.setAttribute('aria-label', showAllTitle);
    mobileShowAllButton.title = showAllTitle;

    if (inView) {
      // Entering "Back to map": always immediate; cancel any pending revert.
      clearTimeout(mobileRevertTimer);
      mobileRevertTimer = 0;
      mobileShowingBackToMap = true;
    } else if (mobileShowingBackToMap && !immediate) {
      // Leaving "Back to map" via scroll: debounce to let inertia settle.
      if (mobileRevertTimer === 0) {
        mobileRevertTimer = window.setTimeout(() => {
          mobileRevertTimer = 0;
          mobileShowingBackToMap = false;
          const hasSingleDayNow = selectedDay !== null;
          mobileNextDayButton.hidden = !hasSingleDayNow;
          mobileShowAllButton.hidden = false;
          mobileBackToMapButton.hidden = true;
        }, 150);
      }
      return; // DOM update deferred to the timer callback
    } else {
      // Immediate reset (panel closed, day changed, etc.).
      clearTimeout(mobileRevertTimer);
      mobileRevertTimer = 0;
      mobileShowingBackToMap = false;
    }

    mobileNextDayButton.hidden = !hasSingleDay || mobileShowingBackToMap;
    mobileShowAllButton.hidden = mobileShowingBackToMap;
    mobileBackToMapButton.hidden = !mobileShowingBackToMap;
  }

  function scheduleMobileActionButtonsUpdate(): void {
    if (mobileButtonStateFrame !== 0) return;
    mobileButtonStateFrame = window.requestAnimationFrame(() => {
      mobileButtonStateFrame = 0;
      updateMobileActionButtons(); // non-immediate: debounce applies for the revert direction
    });
  }

  function setMobileNotesExpanded(expanded: boolean): void {
    mobileNotesExpanded = expanded;
    mobileDayNotesToggle.setAttribute('aria-expanded', String(expanded));
    mobileDayNotesPanel.hidden = !expanded;
  }

  function updateMobileJournalNotes(day: import('./types').ParsedDay | null): void {
    const meta = day?.metadata;
    const hasEntries = Boolean(meta && meta.entries.length > 0);

    mobileDayNotes.hidden = !hasEntries;
    mobileDayNotesPanel.replaceChildren();

    if (!hasEntries || !meta) {
      mobileDayNotesSummary.textContent = '';
      mobileDayNotesToggle.setAttribute('aria-expanded', 'false');
      mobileDayNotesPanel.hidden = true;
      mobileNotesExpanded = false;
      return;
    }

    mobileDayNotesSummary.textContent = `${meta.entries.length} item${meta.entries.length === 1 ? '' : 's'}`;
    mobileDayNotesPanel.appendChild(buildDayDetail(meta, 'mobile-day-detail'));
    setMobileNotesExpanded(mobileNotesPreferenceExpanded);
  }

  mobileDayNotesToggle.addEventListener('click', () => {
    if (mobileDayNotes.hidden) return;
    const nextExpanded = !mobileNotesExpanded;
    mobileNotesPreferenceExpanded = nextExpanded;
    setMobileNotesExpanded(nextExpanded);
  });

  function updateMobileTopbar(day: import('./types').ParsedDay | null): void {
    const hasSingleDay = day !== null;
    mobileTopbarTitle.hidden = hasSingleDay;
    mobileDaySummary.hidden = !hasSingleDay;

    if (!day) {
      mobileDayLabel.textContent = '';
      mobileDayMeta.textContent = '';
      mobileNextDayButton.disabled = true;
      updateMobileJournalNotes(null);
      updateMobileActionButtons(true);
      return;
    }

    const dayIndex = dayLayers.findIndex(({ day: candidate }) => candidate.dateKey === day.dateKey);
    mobileDayLabel.textContent = day.label;
    mobileDayMeta.textContent = day.metadata?.location ?? `${day.visits.length} stop${day.visits.length === 1 ? '' : 's'}`;
    mobileNextDayButton.disabled = dayIndex === -1 || dayIndex >= dayLayers.length - 1;
    updateMobileJournalNotes(day);
    updateMobileActionButtons(true);
  }

  function scrollToVisitSection(): void {
    if (!isPhoneLayout()) return;
    visitPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function scrollToMapSection(): void {
    if (!isPhoneLayout()) return;
    mapArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function getVisitMarker(dayLayer: import('./layers').DayLayer | undefined, visit: ParsedVisit): L.CircleMarker | undefined {
    if (!dayLayer) return undefined;
    if (visit.visitId) {
      const marker = dayLayer.visitMarkers.get(visit.visitId);
      if (marker) return marker;
    }
    return dayLayer.visitMarkersByStorageKey.get(visit.startTime.toISOString());
  }

  function getVisitMediaFiles(visit: ParsedVisit): string[] {
    return visit.visitId ? (mediaManifest[visit.visitId] ?? []) : [];
  }

  function getFirstVisitWithMediaTarget(): VisitNavigationTarget | null {
    for (const dayLayer of dayLayers) {
      const visit = dayLayer.day.visits.find(candidate => getVisitMediaFiles(candidate).length > 0);
      if (!visit) continue;
      const mediaFiles = getVisitMediaFiles(visit);
      return {
        visit,
        dateKey: dayLayer.day.dateKey,
        dayLabel: dayLayer.day.label,
        marker: getVisitMarker(dayLayer, visit),
        mediaFiles,
      };
    }

    return null;
  }

  function getVisitNavigationTarget(visit: ParsedVisit, dateKey: string, direction: 'previous' | 'next'): VisitNavigationTarget | null {
    const currentDayIndex = dayLayers.findIndex(({ day }) => day.dateKey === dateKey);
    if (currentDayIndex === -1) return null;

    const dayIndexStep = direction === 'next' ? 1 : -1;
    for (
      let dayIndex = currentDayIndex;
      dayIndex >= 0 && dayIndex < dayLayers.length;
      dayIndex += dayIndexStep
    ) {
      const dayLayer = dayLayers[dayIndex]!;
      const currentVisitIndex = dayLayer.day.visits.findIndex(
        candidate => candidate.startTime.getTime() === visit.startTime.getTime(),
      );
      const visitStartIndex = dayIndex === currentDayIndex
        ? direction === 'next'
          ? currentVisitIndex + 1
          : currentVisitIndex - 1
        : direction === 'next'
          ? 0
          : dayLayer.day.visits.length - 1;

      if (dayIndex === currentDayIndex && currentVisitIndex === -1) {
        continue;
      }

      let destinationVisit: ParsedVisit | undefined;
      if (direction === 'next') {
        destinationVisit = dayLayer.day.visits.find((candidate, candidateIndex) => {
          if (candidateIndex < visitStartIndex) return false;
          return getVisitMediaFiles(candidate).length > 0;
        });
      } else {
        for (let candidateIndex = visitStartIndex; candidateIndex >= 0; candidateIndex -= 1) {
          const candidate = dayLayer.day.visits[candidateIndex]!;
          if (getVisitMediaFiles(candidate).length === 0) continue;
          destinationVisit = candidate;
          break;
        }
      }

      if (!destinationVisit) continue;
      const mediaFiles = getVisitMediaFiles(destinationVisit);
      return {
        visit: destinationVisit,
        dateKey: dayLayer.day.dateKey,
        dayLabel: dayLayer.day.label,
        marker: getVisitMarker(dayLayer, destinationVisit),
        mediaFiles,
      };
    }

    return null;
  }

  function updateVisitPanelNavigationButtons(): void {
    const isReadonlyVisit = activeEditPanel?.kind === 'readonly';
    const showNavigation = isReadonlyVisit || isPhoneLayout();

    visitPanelNavigation.hidden = !showNavigation;

    if (!showNavigation) {
      visitPanelPrevious.disabled = true;
      visitPanelNext.disabled = true;
      return;
    }

    if (!isReadonlyVisit) {
      visitPanelPrevious.disabled = true;
      visitPanelNext.disabled = selectedDay !== null || getFirstVisitWithMediaTarget() === null;
      return;
    }

    const readonlyPanel = activeEditPanel as Extract<NonNullable<typeof activeEditPanel>, { kind: 'readonly' }>;
    visitPanelPrevious.disabled = getVisitNavigationTarget(readonlyPanel.visit, readonlyPanel.dateKey, 'previous') === null;
    visitPanelNext.disabled = getVisitNavigationTarget(readonlyPanel.visit, readonlyPanel.dateKey, 'next') === null;
  }

  function showReadonlyVisit(target: VisitNavigationTarget, options?: { scrollToVisit?: boolean }): void {
    showVisitPanel(buildVisitPanelContent(target.visit, target.mediaFiles), target.marker, options, getVisitTypeLabel(target.visit));
    activeEditPanel = {
      kind: 'readonly',
      visit: target.visit,
      dateKey: target.dateKey,
      dayLabel: target.dayLabel,
      marker: target.marker,
    };
    updateVisitPanelNavigationButtons();
  }

  function showVisitPanel(html: string, marker?: L.CircleMarker, opts?: { scrollToVisit?: boolean }, title = 'Visit details'): void {
    // Remove animation from the previously active marker
    if (activeMarker) {
      activeMarker.getElement()?.classList.remove('visit-marker--active');
    }
    // Animate the newly clicked marker
    activeMarker = marker ?? null;
    if (activeMarker) {
      activeMarker.getElement()?.classList.add('visit-marker--active');
    }
    visitPanelTitle.textContent = title;
    visitPanelContent.innerHTML = html;
    visitPanelContent.scrollTop = 0;
    visitPanel.classList.add('visit-panel--open');
    visitPanel.setAttribute('aria-hidden', 'false');
    invalidateMapSize();
    updateMobileActionButtons(true);
    // Defer scroll until after the browser has processed the display:none→flex
    // change and the invalidateMapSize rAF, so the layout is stable.
    if (opts?.scrollToVisit !== false) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          scrollToVisitSection();
        });
      });
    }
  }

  function hideVisitPanel(options?: { scrollToMap?: boolean }): void {
    if (activeMarker) {
      activeMarker.getElement()?.classList.remove('visit-marker--active');
      activeMarker = null;
    }
    visitPanel.classList.remove('visit-panel--open');
    visitPanel.setAttribute('aria-hidden', 'true');
    visitPanelContent.innerHTML = '';
    activeEditPanel = null;
    updateVisitPanelNavigationButtons();
    invalidateMapSize();
    updateMobileActionButtons(true);
    if (options?.scrollToMap) {
      scrollToMapSection();
    }
  }

  function refreshActiveEditPanel(): void {
    if (!activeEditPanel || !visitPanel.classList.contains('visit-panel--open')) return;

    if (activeEditPanel.kind === 'visit') {
      activeEditPanel.data.pendingDeletion = isVisitPendingDeletion(activeEditPanel.data.visitId);
      showVisitPanel(buildEditPanelHtml(activeEditPanel.visit, activeEditPanel.data), activeEditPanel.marker, { scrollToVisit: false });
      updateVisitPanelNavigationButtons();
      wireEditPanelEvents(visitPanelContent, activeEditPanel.data);
      return;
    }

    if (activeEditPanel.kind === 'path-point') {
      activeEditPanel.data.pendingDeletion = isPathPointPendingDeletion(activeEditPanel.data.pointId);
      showVisitPanel(buildPathPointEditPanelHtml(activeEditPanel.data), activeEditPanel.marker, { scrollToVisit: false });
      updateVisitPanelNavigationButtons();
      wirePathPointEditPanelEvents(visitPanelContent, activeEditPanel.data);
      return;
    }

    if (activeEditPanel.kind === 'new-visit') {
      showVisitPanel(buildNewVisitPanelHtml(activeEditPanel.data), undefined, { scrollToVisit: false });
      updateVisitPanelNavigationButtons();
      wireNewVisitPanelEvents(visitPanelContent, activeEditPanel.data);
      return;
    }

    if (activeEditPanel.kind === 'new-visit-disabled') {
      showVisitPanel(buildNewVisitDisabledPanelHtml(), undefined, { scrollToVisit: false });
      updateVisitPanelNavigationButtons();
      return;
    }

    if (activeEditPanel.kind === 'readonly') {
      updateVisitPanelNavigationButtons();
      return;
    }
  }

  function syncPendingDeletionStyles(): void {
    const pendingVisitIds = getPendingVisitDeletionIds();
    const pendingPathPointIds = getPendingPathPointDeletionIds();
    for (const dayLayer of dayLayers) {
      for (const [visitId, marker] of dayLayer.visitMarkersByStorageKey) {
        marker.getElement()?.classList.toggle('visit-marker--pending-delete', pendingVisitIds.has(visitId));
      }
      for (const [pointId, marker] of dayLayer.pathPointMarkers) {
        marker.getElement()?.classList.toggle('edit-path-point-marker--pending-delete', pendingPathPointIds.has(pointId));
      }
    }
    refreshActiveEditPanel();
  }

  document.getElementById('visit-panel-close')!.addEventListener('click', () => hideVisitPanel({ scrollToMap: isPhoneLayout() }));
  visitPanelCollapse.addEventListener('click', () => hideVisitPanel({ scrollToMap: true }));
  const navigateToAdjacentVisit = (direction: 'previous' | 'next'): void => {
    let target: VisitNavigationTarget | null = null;

    if (activeEditPanel?.kind === 'readonly') {
      target = getVisitNavigationTarget(activeEditPanel.visit, activeEditPanel.dateKey, direction);
    } else if (selectedDay === null && direction === 'next') {
      target = getFirstVisitWithMediaTarget();
    }

    if (!target) return;

    if (selectedDay === null || selectedDay.dateKey !== target.dateKey) {
      sidebar.selectDayByKey(target.dateKey, { fitBounds: true, source: 'next-visit' });
    }

    showReadonlyVisit(target, { scrollToVisit: false });
  };

  visitPanelPrevious.addEventListener('click', () => {
    navigateToAdjacentVisit('previous');
  });
  visitPanelNext.addEventListener('click', () => {
    navigateToAdjacentVisit('next');
  });

  // Marker clicks set this flag so the map's click handler knows to ignore the event.
  // Necessary because Leaflet fires map 'click' even when a marker is clicked.
  let suppressNextMapClick = false;

  // Close on map click (marker clicks set suppressNextMapClick to prevent double-firing)
  map.on('click', (event: L.LeafletMouseEvent) => {
    if (suppressNextMapClick) { suppressNextMapClick = false; return; }
    if (isEditMode()) {
      if (!selectedDay) {
        showVisitPanel(buildNewVisitDisabledPanelHtml());
        activeEditPanel = { kind: 'new-visit-disabled' };
        updateVisitPanelNavigationButtons();
        return;
      }

      const data: NewVisitEditData = {
        dateKey: selectedDay.dateKey,
        dayLabel: selectedDay.label,
        lat: event.latlng.lat,
        lng: event.latlng.lng,
        timezoneUtcOffsetMinutes: dayOffsets.get(selectedDay.dateKey) ?? 13 * 60,
        existingVisitIds: timeline.days.flatMap((day) => day.visits.map((visit) => getVisitId(visit))),
      };
      showVisitPanel(buildNewVisitPanelHtml(data));
      activeEditPanel = { kind: 'new-visit', data };
      updateVisitPanelNavigationButtons();
      wireNewVisitPanelEvents(visitPanelContent, data);
      return;
    }
    closeSidebarDrawer();
    hideVisitPanel();
  });
  // Close when the user intentionally drags the map
  map.on('dragstart', () => {
    closeSidebarDrawer();
    hideVisitPanel();
  });

  const onVisitClick: VisitClickHandler = (visit, mediaFiles, dateKey, dayLabel, meta, marker) => {
    suppressNextMapClick = true;
    if (isEditMode()) {
      const visitId = getVisitId(visit);
      const data: EditPopupData = {
        visitId,
        dateKey,
        dayLabel,
        pendingDeletion: isVisitPendingDeletion(visitId),
        meta,
      };
      showVisitPanel(buildEditPanelHtml(visit, data), marker);
      activeEditPanel = { kind: 'visit', visit, data, marker };
      updateVisitPanelNavigationButtons();
      wireEditPanelEvents(visitPanelContent, data);
    } else {
      showReadonlyVisit({ visit, mediaFiles, dateKey, dayLabel, marker });
    }
  };

  const onPathPointClick = (point: import('./types').TrackPoint, dateKey: string, dayLabel: string, marker: L.CircleMarker): void => {
    if (!isEditMode() || !point.sourceId) return;
    suppressNextMapClick = true;
    const data: PathPointEditData = {
      pointId: point.sourceId,
      dateKey,
      dayLabel,
      activityType: point.activityType,
      pointTime: point.time,
      lat: point.lat,
      lng: point.lng,
      pendingDeletion: isPathPointPendingDeletion(point.sourceId),
    };
    showVisitPanel(buildPathPointEditPanelHtml(data), marker);
    activeEditPanel = { kind: 'path-point', data, marker };
    updateVisitPanelNavigationButtons();
    wirePathPointEditPanelEvents(visitPanelContent, data);
  };

  // 3. Build day layers
  const dayLayers = buildDayLayers(
    timeline.days,
    mediaManifest,
    onVisitClick,
    isEditMode() ? onPathPointClick : undefined,
    isEditMode(),
    getPendingVisitDeletionIds(),
    getPendingPathPointDeletionIds(),
  );

  if (isEditMode()) {
    window.addEventListener(pendingDeletionChangeEventName, syncPendingDeletionStyles);
  }

  // 3b. Edit mode — export bar only (popup interception replaced by visit panel)
  if (isEditMode()) {
    addExportBar(rawTimeline, timeline.days);
  }

  mobileBackToMapButton.addEventListener('click', () => {
    closeSidebarDrawer();
    hideVisitPanel({ scrollToMap: true });
  });

  // 5. Sidebar
  const sidebar = buildSidebar(
    dayLayers,
    map,
    (_dateKey, _visible) => { /* visibility handled by onDaySelected */ },
    (day, options: Required<SidebarSelectionOptions>) => {
      const prevDay = selectedDay;
      selectedDay = day;
      updateMobileTopbar(day);
      updateVisitPanelNavigationButtons();
      if (options.source === 'next-visit') {
        return;
      }
      // If a visit panel is open and the user switched to a different day,
      // show the first visit with media on the new day (if any), else hide;
      // always scroll back up to the map.
      if (
        !isEditMode() &&
        (prevDay === null || day?.dateKey !== prevDay.dateKey) &&
        visitPanel.classList.contains('visit-panel--open')
      ) {
        const firstMediaVisit = day?.visits.find(
          v => v.visitId && (mediaManifest[v.visitId]?.length ?? 0) > 0,
        );
        if (firstMediaVisit) {
          const dayLayer = dayLayers.find(dl => dl.day.dateKey === day?.dateKey);
          showReadonlyVisit({
            visit: firstMediaVisit,
            dateKey: day!.dateKey,
            dayLabel: day!.label,
            marker: getVisitMarker(dayLayer, firstMediaVisit),
            mediaFiles: mediaManifest[firstMediaVisit.visitId!] ?? [],
          }, { scrollToVisit: false });
        } else {
          hideVisitPanel();
        }
        scrollToMapSection();
      }
    },
    initialSelectedDayKey,
  );

  mobileNextDayButton.addEventListener('click', () => {
    if (!selectedDay) return;
    const dayIndex = dayLayers.findIndex(({ day }) => day.dateKey === selectedDay!.dateKey);
    const nextDay = dayIndex >= 0 ? dayLayers[dayIndex + 1]?.day ?? null : null;
    if (!nextDay) return;
    sidebar.selectDayByKey(nextDay.dateKey); // triggers onDaySelected which handles visit panel + scroll
    closeSidebarDrawer();
  });

  mobileShowAllButton.addEventListener('click', () => {
    if (selectedDay) {
      showAllDaysButton.click();
      closeSidebarDrawer();
      hideVisitPanel({ scrollToMap: isPhoneLayout() });
      return;
    }

    const firstDay = dayLayers[0]?.day;
    if (!firstDay) return;
    sidebar.selectDayByKey(firstDay.dateKey);
    closeSidebarDrawer();
  });

  appShell.addEventListener('scroll', scheduleMobileActionButtonsUpdate, { passive: true });
  window.addEventListener('resize', scheduleMobileActionButtonsUpdate);
  window.addEventListener('resize', updateVisitPanelNavigationButtons);

  // 5b. Sidebar diary editors (must run after buildSidebar has created the day-list DOM)
  if (isEditMode()) {
    addSidebarDiaryEditors(timeline.days);
  }

  // 6. Fit bounds
  const bounds = computeBounds(dayLayers);
  if (bounds && initialSelectedDayKey === null) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  invalidateMapSize();
  updateVisitPanelNavigationButtons();
  updateMobileActionButtons(true);

  hideLoading();

  // 7. Hint text — dismiss after 5 s or on first user interaction.
  // Wait for the fitBounds animation to finish (moveend) before registering
  // dismiss listeners, otherwise the zoom triggered by fitBounds instantly
  // hides the hint before the user ever sees it.
  const mapHint = document.getElementById('map-hint')!;
  const dismissHint = (): void => {
    if (mapHint.classList.contains('map-hint--hidden')) return;
    mapHint.classList.add('map-hint--hidden');
    map.off('zoomstart', dismissHint);
    map.off('dragstart', dismissHint);
    map.off('click', dismissHint);
  };
  map.once('moveend', () => {
    setTimeout(dismissHint, 5000);
    map.on('zoomstart', dismissHint);
    map.on('dragstart', dismissHint);
    map.on('click', dismissHint);
  });
}

main().catch(console.error);

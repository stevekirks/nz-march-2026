import 'leaflet/dist/leaflet.css';
import './style.css';

import L from 'leaflet';
import type { RawTimeline } from './types';
import mediaManifest from 'virtual:media-manifest';
import { parseTimeline } from './parser';
import { parseMetadata } from './metadataParser';
import { initMap, buildDayLayers, computeBounds, buildVisitPanelContent } from './layers';
import type { VisitClickHandler } from './layers';
import { buildSidebar, buildDayDetail, showLoading, hideLoading, wireResponsiveShell, isPhoneLayout } from './ui';
import {
  isEditMode,
  getVisitId,
  applyStoredTimelineEdits,
  consumePendingSelectedDay,
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
  const visitPanelContent = document.getElementById('visit-panel-content')!;
  const visitPanelCollapse = document.getElementById('visit-panel-collapse')!;

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
  let mobileNotesExpanded = false;
  let mobileNotesPreferenceExpanded = false;
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

  function showVisitPanel(html: string, marker?: L.CircleMarker, opts?: { scrollToVisit?: boolean }): void {
    // Remove animation from the previously active marker
    if (activeMarker) {
      activeMarker.getElement()?.classList.remove('visit-marker--active');
    }
    // Animate the newly clicked marker
    activeMarker = marker ?? null;
    if (activeMarker) {
      activeMarker.getElement()?.classList.add('visit-marker--active');
    }
    visitPanelContent.innerHTML = html;
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
    invalidateMapSize();
    updateMobileActionButtons(true);
    if (options?.scrollToMap) {
      scrollToMapSection();
    }
  }

  document.getElementById('visit-panel-close')!.addEventListener('click', () => hideVisitPanel({ scrollToMap: isPhoneLayout() }));
  visitPanelCollapse.addEventListener('click', () => hideVisitPanel({ scrollToMap: true }));

  // Marker clicks set this flag so the map's click handler knows to ignore the event.
  // Necessary because Leaflet fires map 'click' even when a marker is clicked.
  let suppressNextMapClick = false;

  // Close on map click (marker clicks set suppressNextMapClick to prevent double-firing)
  map.on('click', (event: L.LeafletMouseEvent) => {
    if (suppressNextMapClick) { suppressNextMapClick = false; return; }
    if (isEditMode()) {
      if (!selectedDay) {
        showVisitPanel(buildNewVisitDisabledPanelHtml());
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
      const data: EditPopupData = { visitId, dateKey, dayLabel, meta };
      showVisitPanel(buildEditPanelHtml(visit, data), marker);
      wireEditPanelEvents(visitPanelContent, data);
    } else {
      showVisitPanel(buildVisitPanelContent(visit, mediaFiles), marker);
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
    };
    showVisitPanel(buildPathPointEditPanelHtml(data), marker);
    wirePathPointEditPanelEvents(visitPanelContent, data);
  };

  // 3. Build day layers
  const dayLayers = buildDayLayers(
    timeline.days,
    mediaManifest,
    onVisitClick,
    isEditMode() ? onPathPointClick : undefined,
    isEditMode(),
  );

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
    (day) => {
      const prevDay = selectedDay;
      selectedDay = day;
      updateMobileTopbar(day);
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
          const mediaFiles = mediaManifest[firstMediaVisit.visitId!] ?? [];
          const dayLayer = dayLayers.find(dl => dl.day.dateKey === day?.dateKey);
          const marker = firstMediaVisit.visitId ? dayLayer?.visitMarkers.get(firstMediaVisit.visitId) : undefined;
          showVisitPanel(buildVisitPanelContent(firstMediaVisit, mediaFiles), marker, { scrollToVisit: false });
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

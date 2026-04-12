import L from 'leaflet';
import { computeBounds } from './layers';
import type { DayLayer } from './layers';
import type { LatLng, DayMetadata, ParsedDay, JournalEntry } from './types';

export interface SidebarSelectionOptions {
  fitBounds?: boolean;
  source?: 'default' | 'next-visit';
}

export const PHONE_LAYOUT_MEDIA_QUERY = '(max-width: 767px)';

export function isPhoneLayout(): boolean {
  return window.matchMedia(PHONE_LAYOUT_MEDIA_QUERY).matches;
}

export function wireResponsiveShell(onLayoutChange?: () => void): { closeSidebarDrawer: () => void } {
  const app = document.getElementById('app');
  const backdrop = document.getElementById('mobile-backdrop');
  const sidebarToggle = document.getElementById('mobile-sidebar-toggle');

  if (!app || !backdrop || !sidebarToggle) {
    return { closeSidebarDrawer: () => undefined };
  }

  const phoneMediaQuery = window.matchMedia(PHONE_LAYOUT_MEDIA_QUERY);

  const closeSidebarDrawer = (): void => {
    app.classList.remove('app--sidebar-open');
  };

  const invalidateLayout = (): void => {
    closeSidebarDrawer();
    onLayoutChange?.();
  };

  sidebarToggle.addEventListener('click', () => {
    if (!phoneMediaQuery.matches) return;
    app.classList.toggle('app--sidebar-open');
    onLayoutChange?.();
  });

  backdrop.addEventListener('click', closeSidebarDrawer);
  phoneMediaQuery.addEventListener('change', invalidateLayout);
  window.addEventListener('resize', onLayoutChange ?? (() => undefined));

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeSidebarDrawer();
  });

  return { closeSidebarDrawer };
}

// ─── Legend ───────────────────────────────────────────────────────────────────

interface LegendEntry {
  label: string;
  color: string;
  dashArray?: string;
  weight: number;
  isVisit?: boolean;
  hasMedia?: boolean;
  visitRadius?: number; // px, only when isVisit = true
}

const LEGEND_ENTRIES: LegendEntry[] = [
  { label: 'Vehicle / Bus',       color: 'hsl(210,72%,48%)', weight: 4 },
  { label: 'Ferry',               color: 'hsl(185,72%,48%)', dashArray: '10,5', weight: 4 },
  { label: 'Train',               color: 'hsl(240,72%,48%)', dashArray: '16,4', weight: 5 },
  { label: 'Walking',             color: 'hsl(120,72%,48%)', dashArray: '4,6',  weight: 2 },
  { label: 'Running',             color: 'hsl(80,72%,48%)',  dashArray: '4,4',  weight: 2 },
  { label: 'Cycling',             color: 'hsl(35,72%,48%)',  dashArray: '8,4,2,4', weight: 3 },
  { label: 'Flying',              color: 'hsl(270,72%,48%)', dashArray: '20,8', weight: 3 },
  { label: 'Unknown',             color: 'hsl(220,12%,58%)', dashArray: '2,8',  weight: 2 },
  { label: 'Stop (brief)',        color: 'hsl(45,90%,62%)',  weight: 0, isVisit: true, visitRadius: 5 },
  { label: 'Stop (significant)',  color: 'hsl(45,90%,62%)',  weight: 0, isVisit: true, visitRadius: 8 },
  { label: 'Stop with photos',    color: 'hsl(45,90%,62%)',  weight: 0, isVisit: true, hasMedia: true, visitRadius: 8 },
];

function buildLegend(): void {
  const legendList  = document.getElementById('legend-list')!;
  const toggleBtn   = document.getElementById('legend-toggle')!;
  const legendPanel = document.getElementById('legend-panel')!;

  for (const entry of LEGEND_ENTRIES) {
    const li = document.createElement('li');
    li.className = 'legend-item';

    if (entry.isVisit) {
      const r = entry.visitRadius ?? 5;
      const cx = 16; // centre of the 32-wide viewBox
      const cy = 11;
      const circleClass = entry.hasMedia ? 'legend-visit-circle legend-visit-circle--has-media' : 'legend-visit-circle';
      li.innerHTML = `
        <svg class="legend-line" width="32" height="22" viewBox="0 0 32 22">
          <circle cx="${cx}" cy="${cy}" r="${r}" class="${circleClass}"
            fill="hsl(45,90%,62%)" stroke="hsl(38,70%,38%)" stroke-width="2"/>
        </svg>
        <span class="legend-label">${entry.label}</span>
      `;
    } else {
      // Build an inline SVG line sample
      const dash = entry.dashArray ? `stroke-dasharray="${entry.dashArray}"` : '';
      const w = entry.weight;
      const y = 8;
      li.innerHTML = `
        <svg class="legend-line" width="32" height="16" viewBox="0 0 32 16">
          <line x1="2" y1="${y}" x2="30" y2="${y}" stroke="${entry.color}" stroke-width="${w}" ${dash} stroke-linecap="round"/>
        </svg>
        <span class="legend-label">${entry.label}</span>
      `;
    }
    legendList.appendChild(li);
  }

  // Collapse / expand
  toggleBtn.addEventListener('click', () => {
    const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    toggleBtn.setAttribute('aria-expanded', String(!expanded));
    legendPanel.style.display = expanded ? 'none' : '';
  });
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

/** Build the expandable metadata detail panel for a day item */
export function buildDayDetail(meta: DayMetadata, className = 'day-detail'): HTMLElement {
  const detail = document.createElement('div');
  detail.className = className;

  for (const item of meta.entries) {
    buildEntryRow(item, detail);
  }

  return detail;
}

function buildEntryRow(item: JournalEntry, container: HTMLElement): void {
  switch (item.kind) {
    case 'hike': {
      const hike = item.entry;
      const row = document.createElement('div');
      row.className = 'detail-row';

      const icon = document.createElement('span');
      icon.className = 'detail-icon';
      icon.textContent = '\uD83E\uDD7E'; // 🥾

      const nameSpan = document.createElement('span');
      nameSpan.className = 'detail-name';
      nameSpan.textContent = hike.name + (hike.starred ? ' \u2B50' : '');
      nameSpan.title = nameSpan.textContent;

      const statParts: string[] = [];
      if (hike.distanceKm) statParts.push(hike.distanceKm);
      if (hike.elevationM && hike.elevationM !== '0m') statParts.push('\u2191' + hike.elevationM);
      if (hike.duration) statParts.push(hike.duration);

      const statsSpan = document.createElement('span');
      statsSpan.className = 'detail-stats';
      statsSpan.textContent = statParts.join(' \xB7 ');

      row.append(icon, nameSpan, statsSpan);
      container.appendChild(row);

      if (hike.notes) {
        container.appendChild(makeNotesRow(hike.notes));
      }
      break;
    }
    case 'stay': {
      const stay = item.entry;
      const row = document.createElement('div');
      row.className = 'detail-row';

      const icon = document.createElement('span');
      icon.className = 'detail-icon';
      icon.textContent = '\uD83C\uDFD5'; // 🏕

      const nameSpan = document.createElement('span');
      nameSpan.className = 'detail-name';
      nameSpan.textContent = stay.name;
      nameSpan.title = stay.name;

      const statParts: string[] = [];
      if (stay.costNzd) statParts.push(stay.costNzd);
      if (stay.rating != null) {
        statParts.push('\u2605'.repeat(stay.rating) + '\u2606'.repeat(5 - stay.rating));
      }

      const statsSpan = document.createElement('span');
      statsSpan.className = 'detail-stats';
      statsSpan.textContent = statParts.join(' \xB7 ');

      row.append(icon, nameSpan, statsSpan);
      container.appendChild(row);

      if (stay.notes) {
        container.appendChild(makeNotesRow(stay.notes));
      }
      break;
    }
    case 'drive': {
      const drive = item.entry;
      const row = document.createElement('div');
      row.className = 'detail-row';

      const icon = document.createElement('span');
      icon.className = 'detail-icon';
      icon.textContent = '\uD83D\uDE97'; // 🚗

      const nameSpan = document.createElement('span');
      nameSpan.className = 'detail-name';
      nameSpan.textContent = drive.route;
      nameSpan.title = drive.route;

      const statParts: string[] = [];
      if (drive.distanceKm) statParts.push(drive.distanceKm);
      if (drive.duration) statParts.push(drive.duration);

      const statsSpan = document.createElement('span');
      statsSpan.className = 'detail-stats';
      statsSpan.textContent = statParts.join(' \xB7 ');

      row.append(icon, nameSpan, statsSpan);
      container.appendChild(row);

      if (drive.notes) {
        container.appendChild(makeNotesRow(drive.notes));
      }
      break;
    }
    case 'activity': {
      const row = document.createElement('div');
      row.className = 'detail-row';

      const icon = document.createElement('span');
      icon.className = 'detail-icon';
      icon.textContent = '\uD83D\uDCCC'; // 📌

      const nameSpan = document.createElement('span');
      nameSpan.className = 'detail-name';
      nameSpan.textContent = item.entry;
      nameSpan.title = item.entry;

      row.append(icon, nameSpan);
      container.appendChild(row);
      break;
    }
  }
}

function makeNotesRow(notes: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'detail-row detail-notes-row';

  const spacer = document.createElement('span');
  spacer.className = 'detail-icon'; // keeps indent aligned

  const notesSpan = document.createElement('span');
  notesSpan.className = 'detail-notes';
  notesSpan.textContent = notes;

  row.append(spacer, notesSpan);
  return row;
}

export function buildSidebar(
  dayLayers: DayLayer[],
  map: L.Map,
  onVisibilityChange: (dateKey: string, visible: boolean) => void,
  onDaySelected?: (day: ParsedDay | null, options: Required<SidebarSelectionOptions>) => void,
  initialSelectedKey: string | null = null,
): { selectDayByKey: (dateKey: string | null, options?: SidebarSelectionOptions) => void } {
  buildLegend();

  const list = document.getElementById('day-list')!;
  list.innerHTML = '';

  // "All days" is the default selection state
  let selectedKey: string | null = null; // null = show all

  function applySelection(key: string | null, options: SidebarSelectionOptions = {}): void {
    const resolvedOptions: Required<SidebarSelectionOptions> = {
      fitBounds: options.fitBounds ?? true,
      source: options.source ?? 'default',
    };
    selectedKey = key;
    const visibleLayers: DayLayer[] = [];
    dayLayers.forEach(dl => {
      const show = key === null || key === dl.day.dateKey;
      if (show) { dl.group.addTo(map); visibleLayers.push(dl); }
      else dl.group.remove();
      onVisibilityChange(dl.day.dateKey, show);
    });
    // Highlight selected row
    list.querySelectorAll<HTMLLIElement>('.day-item').forEach(li => {
      li.classList.toggle('day-item--active', li.dataset['dateKey'] === key);
    });
    const btnAll = document.getElementById('btn-show-all')!;
    btnAll.classList.toggle('btn-all--active', key === null);
    // Zoom to the visible data
    const bounds = computeBounds(visibleLayers);
    if (bounds && resolvedOptions.fitBounds) map.fitBounds(bounds, { padding: [30, 30], animate: true });
    // Notify about the selected day (null = all days)
    if (onDaySelected) {
      const selectedDay = key !== null ? dayLayers.find(dl => dl.day.dateKey === key)?.day ?? null : null;
      onDaySelected(selectedDay, resolvedOptions);
    }
  }

  dayLayers.forEach(({ day, group }) => {
    const li = document.createElement('li');
    li.className = 'day-item';
    li.dataset['dateKey'] = day.dateKey;

    const ptCount    = day.segments.reduce((s, seg) => s + seg.points.length, 0);
    const visitCount  = day.visits.length;
    const meta        = day.metadata;

    // Meta line: location + hike count if available, else GPS summary
    const hikeCount = meta?.hikes.length ?? 0;
    const metaText  = meta?.location
      ? meta.location + (hikeCount > 0 ? ` \xB7 ${hikeCount} hike${hikeCount > 1 ? 's' : ''}` : '')
      : `${ptCount} pts${visitCount ? ` \xB7 ${visitCount} stops` : ''}`;

    // Build header using innerHTML (no user-controlled data in template)
    li.innerHTML = `
      <div class="day-item-header">
        <span class="day-dot" style="background:hsl(${day.hue},70%,50%)"></span>
        <span class="day-text">
          <span class="day-name">${day.label}</span>
          <span class="day-meta"></span>
        </span>
      </div>
    `;
    // Set meta text via textContent to safely handle any special chars
    li.querySelector('.day-meta')!.textContent = metaText;

    // Append metadata detail panel using DOM methods (avoids innerHTML + user text)
    if (meta && meta.entries.length > 0) {
      li.appendChild(buildDayDetail(meta));
    }

    li.addEventListener('click', () => {
      // Clicking the already-selected day goes back to all
      applySelection(selectedKey === day.dateKey ? null : day.dateKey);
      if (isPhoneLayout()) {
        document.getElementById('app')?.classList.remove('app--sidebar-open');
      }
    });

    // Add to map by default
    group.addTo(map);
    list.appendChild(li);
  });

  document.getElementById('btn-show-all')!.addEventListener('click', () => {
    applySelection(null);
    if (isPhoneLayout()) {
      document.getElementById('app')?.classList.remove('app--sidebar-open');
    }
  });

  // Start with all days shown and "All" button highlighted
  const nextSelectedKey = initialSelectedKey !== null && dayLayers.some(({ day }) => day.dateKey === initialSelectedKey)
    ? initialSelectedKey
    : null;
  applySelection(nextSelectedKey);

  return {
    selectDayByKey: applySelection,
  };
}

// ─── Loading overlay ─────────────────────────────────────────────────────────

export function showLoading(text: string): void {
  const overlay = document.getElementById('loading-overlay')!;
  const textEl = document.getElementById('loading-text')!;
  overlay.style.display = 'flex';
  textEl.textContent = text;
}

export function hideLoading(): void {
  const overlay = document.getElementById('loading-overlay')!;
  overlay.style.display = 'none';
}

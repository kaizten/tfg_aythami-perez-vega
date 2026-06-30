import { Component, OnDestroy, OnInit } from '@angular/core';
import { interval, Subscription } from 'rxjs';
import { startWith } from 'rxjs/operators';
import {
  BerthCall,
  OptimizationApiResult,
  OptimizationAssignment,
  TransformApiResponse,
} from '../../../../core/models/api.models';
import { OptimizationResultStoreService } from '../../../../core/services/optimization-result-store.service';
import { TransformationStoreService } from '../../../../core/services/transformation-store.service';

interface PhaseSegment {
  widthPct: string;
  colorClass: string;
  name: string;
}

interface GanttVessel {
  name: string;
  left: string;
  width: string;
  top: string;
  colorClass: string;
  clippedLeft: boolean;
  clippedRight: boolean;
  phaseSegments?: PhaseSegment[];
  /* Computed - fondeo (anchorage) duration in hours shown as anchor badge when visible */
  fondeoH?: number;
  /* Computed - true when the operation is past its scheduled end but within the 5 h grace window */
  showWarning?: boolean;
  /* Computed - total delay applied to this vessel in hours, drives the red delay segment */
  delayH?: number;
}

interface GanttBerth {
  name: string;
  vessels: GanttVessel[];
  laneCount: number;
}

/* Fixed - pixel height of each swim lane row in the Gantt chart */
const LANE_PX = 44;
/* Fixed - number of milliseconds in one day used for percentage calculations */
const DAY_MS = 24 * 3_600_000;

/* Fixed - ordered list of Tailwind color classes cycled for CSV-mode vessel bars */
const VESSEL_COLORS = [
  'bg-teal-500/90', 'bg-indigo-500/90', 'bg-amber-500/90',
  'bg-violet-500/90', 'bg-sky-500/90', 'bg-rose-500/90',
];

/* Fixed - map from phase name to Tailwind background color class used in optimizer mode */
const PHASE_COLORS: Record<string, string> = {
  delay:                'bg-red-500',
  fondeo:               'bg-amber-400',
  fondeo_resource_wait: 'bg-orange-400',
  atraque:              'bg-sky-500',
  ejecucion:            'bg-emerald-500',
  desatraque:           'bg-violet-500',
  waiting_undock:       'bg-violet-300',
};

/* Fixed - two-hour interval labels for the 24-hour timeline axis */
const HOUR_LABELS = [
  '00:00', '02:00', '04:00', '06:00', '08:00', '10:00',
  '12:00', '14:00', '16:00', '18:00', '20:00', '22:00',
];

/*
 * Assigns each vessel interval to a swim lane so that overlapping bars do not collide.
 * @param vessels - Array of objects with startMs and endMs timestamps (required)
 * @returns Array of lane indices, one per input element
 */
function assignLanes(vessels: { startMs: number; endMs: number }[]): number[] {
  const laneEndMs: number[] = [];
  return vessels.map(v => {
    const free = laneEndMs.findIndex(t => t <= v.startMs);
    const lane = free === -1 ? laneEndMs.length : free;
    if (free === -1) laneEndMs.push(0);
    laneEndMs[lane] = v.endMs;
    return lane;
  });
}

/*
 * Truncates a timestamp to midnight of the same calendar day in local time.
 * @param ms - Unix timestamp in milliseconds (required)
 * @returns Unix timestamp of midnight for the given day
 */
function floorToDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/*
 * Derives a deterministic Tailwind color class for a vessel call by hashing its ID.
 * @param callId - Unique call identifier string (required)
 * @returns A Tailwind background color class from the VESSEL_COLORS palette
 */
function vesselColor(callId: string): string {
  let hash = 0;
  for (let i = 0; i < callId.length; i++) {
    hash = (hash * 31 + callId.charCodeAt(i)) & 0xffffffff;
  }
  return VESSEL_COLORS[Math.abs(hash) % VESSEL_COLORS.length];
}

/*
 * Converts a fractional hour value to an HH:MM string.
 * @param h - Duration or time of day in decimal hours (required)
 * @returns Zero-padded time string in HH:MM format
 */
function hoursToHHMM(h: number): string {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

@Component({
  selector: 'app-berth-timeline',
  standalone: false,
  templateUrl: './berth-timeline.component.html',
  styleUrl: './berth-timeline.component.scss',
})
export class BerthTimelineComponent implements OnInit, OnDestroy {
  /* Fixed - hour labels array used to render the timeline axis ticks */
  readonly hourLabels = HOUR_LABELS;
  /* Fixed - reference to the hoursToHHMM utility exposed to the template */
  readonly hoursToHHMM = hoursToHHMM;
  /* Computed - list of Gantt berth rows rendered by the current day view */
  ganttBerths: GanttBerth[] = [];

  /* Computed - human-readable date labels for all days that contain vessel calls */
  availableDays: string[] = [];
  /* Computed - index into availableDays / dayStartsMs pointing to the currently displayed day */
  selectedDayIndex = 0;

  /* Computed - true when the currently displayed day is today */
  isToday = false;
  /* Computed - CSS left offset string for the current-time indicator line */
  currentTimeLeft = '';
  /* Computed - true when the view is sourced from optimizer assignments rather than raw CSV data */
  isOptimizerMode = false;

  /* Computed - midnight timestamps for each day that has vessel activity */
  private dayStartsMs: number[] = [];
  /* Computed - full list of berth calls from the transformation store */
  private allCalls: BerthCall[] = [];
  /* Computed - optimizer assignments filtered to only those with status 'assigned' */
  private allAssignments: OptimizationAssignment[] = [];
  /* Computed - last transformation result snapshot used to restore CSV view when optimizer is cleared */
  private lastTransformResult: TransformApiResponse | null = null;
  /* Computed - collection of all active RxJS subscriptions */
  private subs: Subscription[] = [];

  constructor(
    private transformStore: TransformationStoreService,
    private optimizerResultStore: OptimizationResultStoreService,
  ) {}

  /*
   * Subscribes to transformation store, optimization store, and a 60-second clock tick to keep the timeline current.
   */
  ngOnInit(): void {
    this.subs.push(
      this.transformStore.result$.subscribe(r => {
        this.lastTransformResult = r;
        if (!this.isOptimizerMode) {
          if (r) this.buildView(r);
          else this.clearView();
        }
      }),
      this.optimizerResultStore.result$.subscribe(r => {
        if (r) {
          this.isOptimizerMode = true;
          this.allAssignments = r.assignments.filter(a => a.status === 'assigned');
          this.buildViewFromAssignments();
        } else {
          this.isOptimizerMode = false;
          this.allAssignments = [];
          if (this.lastTransformResult) this.buildView(this.lastTransformResult);
          else this.clearView();
        }
      }),
      interval(60_000).pipe(startWith(0)).subscribe(() => this.updateNowLine()),
    );
  }

  /*
   * Returns the human-readable label for the currently selected day.
   * @returns Localized date string for the selected day, or empty string if no days are available
   */
  get selectedDayLabel(): string {
    return this.availableDays[this.selectedDayIndex] ?? '';
  }

  /*
   * Computes the CSS height string for a berth swim lane area based on the number of lanes.
   * @param laneCount - Number of parallel swim lanes required for the berth (required)
   * @returns CSS height string in pixels
   */
  laneHeight(laneCount: number): string {
    return `${Math.max(laneCount, 1) * LANE_PX}px`;
  }

  /*
   * Navigates to the previous day if one is available and refreshes the view.
   */
  prevDay(): void {
    if (this.selectedDayIndex > 0) {
      this.selectedDayIndex--;
      this.isOptimizerMode ? this.buildOptimizerDayView() : this.buildDayView();
      this.updateNowLine();
    }
  }

  /*
   * Navigates to the next day if one is available and refreshes the view.
   */
  nextDay(): void {
    if (this.selectedDayIndex < this.availableDays.length - 1) {
      this.selectedDayIndex++;
      this.isOptimizerMode ? this.buildOptimizerDayView() : this.buildDayView();
      this.updateNowLine();
    }
  }

  /*
   * Jumps to today's date in the day selector and refreshes the view.
   */
  goToday(): void {
    const todayMs = floorToDay(Date.now());
    const idx = this.dayStartsMs.indexOf(todayMs);
    if (idx >= 0) {
      this.selectedDayIndex = idx;
      this.isOptimizerMode ? this.buildOptimizerDayView() : this.buildDayView();
      this.updateNowLine();
    }
  }

  /*
   * Initializes the day list and selects the current day from a transformation API response, then builds the day view.
   * @param r - Transformation API response containing the berth call records (required)
   */
  private buildView(r: TransformApiResponse): void {
    this.allCalls = r.data;
    if (!this.allCalls.length) { this.clearView(); return; }

    const daySet = new Set<number>();
    for (const c of this.allCalls) {
      const s = floorToDay(new Date(c.arrival_time).getTime());
      const e = floorToDay(new Date(c.departure_time).getTime());
      for (let d = s; d <= e; d += DAY_MS) daySet.add(d);
    }

    this.dayStartsMs = Array.from(daySet).sort((a, b) => a - b);
    this.availableDays = this.dayStartsMs.map(ms =>
      new Date(ms).toLocaleDateString('es-ES', {
        weekday: 'short', day: 'numeric', month: 'short',
      }),
    );

    const todayMs = floorToDay(Date.now());
    const todayIdx = this.dayStartsMs.indexOf(todayMs);
    this.selectedDayIndex = todayIdx >= 0 ? todayIdx : this.dayStartsMs.length - 1;

    this.buildDayView();
    this.updateNowLine();
  }

  /*
   * Filters the full call list to the selected day and builds the Gantt berth rows for CSV mode.
   */
  private buildDayView(): void {
    if (!this.allCalls.length || !this.dayStartsMs.length) return;

    const dayStart = this.dayStartsMs[this.selectedDayIndex];
    const dayEnd = dayStart + DAY_MS;

    const dayCalls = this.allCalls.filter(c => {
      const s = new Date(c.arrival_time).getTime();
      const e = new Date(c.departure_time).getTime();
      return s < dayEnd && e > dayStart;
    });

    const berthMap = new Map<string, BerthCall[]>();
    for (const c of dayCalls) {
      if (!berthMap.has(c.berth_id)) berthMap.set(c.berth_id, []);
      berthMap.get(c.berth_id)!.push(c);
    }

    const berths: GanttBerth[] = [];
    for (const [berthId, calls] of berthMap) {
      const sorted = [...calls].sort((a, b) =>
        new Date(a.arrival_time).getTime() - new Date(b.arrival_time).getTime(),
      );

      const clampedTimings = sorted.map(c => ({
        startMs: Math.max(new Date(c.arrival_time).getTime(), dayStart),
        endMs:   Math.min(new Date(c.departure_time).getTime(), dayEnd),
      }));
      const lanes = assignLanes(clampedTimings);

      const vessels: GanttVessel[] = sorted.map((call, i) => {
        const rawS = new Date(call.arrival_time).getTime();
        const rawE = new Date(call.departure_time).getTime();
        const clippedLeft  = rawS < dayStart;
        const clippedRight = rawE > dayEnd;
        const visStart = clampedTimings[i].startMs;
        const visEnd   = clampedTimings[i].endMs;

        const left = (visStart - dayStart) / DAY_MS * 100;
        const rawW = (visEnd - visStart) / DAY_MS * 100;

        return {
          name:       call.call_id,
          left:       left.toFixed(2) + '%',
          width:      Math.max(rawW, 0.5).toFixed(2) + '%',
          top:        `${lanes[i] * LANE_PX}px`,
          colorClass: vesselColor(call.call_id),
          clippedLeft,
          clippedRight,
        };
      });

      berths.push({ name: berthId, vessels, laneCount: Math.max(...lanes) + 1 });
    }

    this.ganttBerths = berths;
  }

  /*
   * Recomputes the current-time indicator position and updates the isToday flag.
   */
  private updateNowLine(): void {
    const todayMs    = floorToDay(Date.now());
    const selectedMs = this.dayStartsMs[this.selectedDayIndex];
    this.isToday     = selectedMs === todayMs;

    if (this.isToday) {
      const ratio = (Date.now() - todayMs) / DAY_MS;
      this.currentTimeLeft = `calc(${(ratio * 100).toFixed(4)}% + ${((1 - ratio) * 7).toFixed(4)}rem)`;
    }
  }

  /*
   * Returns the bar-start timestamp for an optimizer assignment, always equal to the first phase start.
   * @param a - Optimization assignment object (required)
   * @returns Unix timestamp in milliseconds for the start of the first phase (original ETA)
   */
  private fondeoStartMs(a: OptimizationAssignment): number {
    if (a.phases?.length) return new Date(a.phases[0].start).getTime();
    return new Date(a.scheduled_start).getTime() - a.waiting_time_h * 3_600_000;
  }

  /*
   * Initializes the day list from optimizer assignments and builds the first optimizer day view.
   */
  private buildViewFromAssignments(): void {
    if (!this.allAssignments.length) { this.clearView(); return; }

    const daySet = new Set<number>();
    for (const a of this.allAssignments) {
      const s = floorToDay(this.fondeoStartMs(a));
      const e = floorToDay(new Date(a.scheduled_end).getTime());
      for (let d = s; d <= e; d += DAY_MS) daySet.add(d);
    }

    this.dayStartsMs = Array.from(daySet).sort((a, b) => a - b);
    this.availableDays = this.dayStartsMs.map(ms =>
      new Date(ms).toLocaleDateString('es-ES', {
        weekday: 'short', day: 'numeric', month: 'short',
      }),
    );

    const todayMs = floorToDay(Date.now());
    const todayIdx = this.dayStartsMs.indexOf(todayMs);
    this.selectedDayIndex = todayIdx >= 0 ? todayIdx : 0;

    this.buildOptimizerDayView();
    this.updateNowLine();
  }

  /*
   * Filters optimizer assignments to the selected day and builds the Gantt berth rows with phase segments.
   */
  private buildOptimizerDayView(): void {
    if (!this.allAssignments.length || !this.dayStartsMs.length) return;

    const dayStart = this.dayStartsMs[this.selectedDayIndex];
    const dayEnd   = dayStart + DAY_MS;
    const nowMs    = Date.now();

    const dayAssignments = this.allAssignments.filter(a => {
      const s = this.fondeoStartMs(a);
      const e = new Date(a.scheduled_end).getTime();
      return s < dayEnd && e > dayStart;
    });

    const berthMap = new Map<string, OptimizationAssignment[]>();
    for (const a of dayAssignments) {
      if (!berthMap.has(a.berth_id)) berthMap.set(a.berth_id, []);
      berthMap.get(a.berth_id)!.push(a);
    }

    const berths: GanttBerth[] = [];
    for (const [berthId, assigns] of berthMap) {
      const sorted = [...assigns].sort((x, y) =>
        this.fondeoStartMs(x) - this.fondeoStartMs(y),
      );

      const clampedTimings = sorted.map(a => ({
        startMs: Math.max(this.fondeoStartMs(a), dayStart),
        endMs:   Math.min(new Date(a.scheduled_end).getTime(), dayEnd),
      }));
      const lanes = assignLanes(clampedTimings);

      const vessels: GanttVessel[] = sorted.map((a, i) => {
        const delayH = a.delay_h ?? 0;
        const rawS   = this.fondeoStartMs(a);
        const rawE   = new Date(a.scheduled_end).getTime();
        const clippedLeft  = rawS < dayStart;
        const clippedRight = rawE > dayEnd;
        const visStart = clampedTimings[i].startMs;
        const visEnd   = clampedTimings[i].endMs;
        const visDur   = visEnd - visStart;

        const showWarning = rawE <= nowMs && nowMs < rawE + 5 * 3_600_000;

        let phaseSegments: PhaseSegment[] | undefined;
        if (a.phases?.length && visDur > 0) {
          const resourceWaitH = Math.max(a.pilot_wait_h ?? 0, a.tug_wait_h ?? 0);
          const segments: PhaseSegment[] = [];
          for (const phase of a.phases) {
            if (phase.duration_h <= 0) continue;
            const ps = new Date(phase.start).getTime();
            const pe = new Date(phase.end).getTime();

            if (phase.name === 'fondeo' && resourceWaitH > 0.01) {
              const resStartMs = pe - resourceWaitH * 3_600_000;

              const bVS = Math.max(ps, visStart);
              const bVE = Math.min(resStartMs, visEnd);
              if (bVE > bVS) {
                segments.push({
                  widthPct:   `${((bVE - bVS) / visDur * 100).toFixed(2)}%`,
                  colorClass: 'bg-amber-400',
                  name: 'fondeo',
                });
              }

              const rVS = Math.max(resStartMs, visStart);
              const rVE = Math.min(pe, visEnd);
              if (rVE > rVS) {
                segments.push({
                  widthPct:   `${((rVE - rVS) / visDur * 100).toFixed(2)}%`,
                  colorClass: 'bg-orange-400',
                  name: 'fondeo_resource_wait',
                });
              }
            } else {
              const visPhaseStart = Math.max(ps, visStart);
              const visPhaseEnd   = Math.min(pe, visEnd);
              if (visPhaseEnd > visPhaseStart) {
                segments.push({
                  widthPct:   `${((visPhaseEnd - visPhaseStart) / visDur * 100).toFixed(2)}%`,
                  colorClass: PHASE_COLORS[phase.name] ?? 'bg-slate-400',
                  name: phase.name,
                });
              }
            }
          }
          if (segments.length) phaseSegments = segments;
        }

        let fondeoH: number | undefined;
        const fondeoPhase = a.phases?.find(p => p.name === 'fondeo');
        if (fondeoPhase && fondeoPhase.duration_h > 0) {
          const fStart = new Date(fondeoPhase.start).getTime();
          const fEnd   = new Date(fondeoPhase.end).getTime();
          if (fStart < dayEnd && fEnd > dayStart) {
            fondeoH = fondeoPhase.duration_h;
          }
        }

        return {
          name:         a.vessel_id,
          left:         ((visStart - dayStart) / DAY_MS * 100).toFixed(2) + '%',
          width:        Math.max((visEnd - visStart) / DAY_MS * 100, 0.5).toFixed(2) + '%',
          top:          `${lanes[i] * LANE_PX}px`,
          colorClass:   'bg-teal-500/90',
          clippedLeft,
          clippedRight,
          phaseSegments,
          fondeoH,
          showWarning,
          delayH: delayH > 0 ? delayH : undefined,
        };
      });

      berths.push({ name: berthId, vessels, laneCount: Math.max(...lanes) + 1 });
    }

    this.ganttBerths = berths;
  }

  /*
   * Resets all view state, collapsing the timeline to an empty state.
   */
  private clearView(): void {
    this.allCalls        = [];
    this.availableDays   = [];
    this.dayStartsMs     = [];
    this.selectedDayIndex = 0;
    this.ganttBerths     = [];
    this.isToday         = false;
  }

  /*
   * Unsubscribes from all active subscriptions to prevent memory leaks.
   */
  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}

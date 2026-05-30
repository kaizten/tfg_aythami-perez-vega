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

// ── Interfaces ──────────────────────────────────────────────────────────────────

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
  /** Fondeo (anchorage) duration in hours — shown as anchor badge when visible. */
  fondeoH?: number;
  /** True when the operation is past its scheduled end but within the 5 h grace window. */
  showWarning?: boolean;
  /** Total delay applied to this vessel (hours). Drives the red delay segment. */
  delayH?: number;
}

interface GanttBerth {
  name: string;
  vessels: GanttVessel[];
  laneCount: number;
}

// ── Constants ───────────────────────────────────────────────────────────────────

const LANE_PX = 44;
const DAY_MS = 24 * 3_600_000;

const VESSEL_COLORS = [
  'bg-teal-500/90', 'bg-indigo-500/90', 'bg-amber-500/90',
  'bg-violet-500/90', 'bg-sky-500/90', 'bg-rose-500/90',
];

const PHASE_COLORS: Record<string, string> = {
  delay:                'bg-red-500',
  fondeo:               'bg-amber-400',
  fondeo_resource_wait: 'bg-orange-400',
  atraque:              'bg-sky-500',
  ejecucion:            'bg-emerald-500',
  desatraque:           'bg-violet-500',
  waiting_undock:       'bg-violet-300',
};

const HOUR_LABELS = [
  '00:00', '02:00', '04:00', '06:00', '08:00', '10:00',
  '12:00', '14:00', '16:00', '18:00', '20:00', '22:00',
];

// ── Helpers ─────────────────────────────────────────────────────────────────────

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

function floorToDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function vesselColor(callId: string): string {
  let hash = 0;
  for (let i = 0; i < callId.length; i++) {
    hash = (hash * 31 + callId.charCodeAt(i)) & 0xffffffff;
  }
  return VESSEL_COLORS[Math.abs(hash) % VESSEL_COLORS.length];
}

function hoursToHHMM(h: number): string {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ── Component ───────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-berth-timeline',
  standalone: false,
  templateUrl: './berth-timeline.component.html',
  styleUrl: './berth-timeline.component.scss',
})
export class BerthTimelineComponent implements OnInit, OnDestroy {
  readonly hourLabels = HOUR_LABELS;
  readonly hoursToHHMM = hoursToHHMM;
  ganttBerths: GanttBerth[] = [];

  availableDays: string[] = [];
  selectedDayIndex = 0;

  isToday = false;
  currentTimeLeft = '';
  isOptimizerMode = false;

  private dayStartsMs: number[] = [];
  private allCalls: BerthCall[] = [];
  private allAssignments: OptimizationAssignment[] = [];
  private lastTransformResult: TransformApiResponse | null = null;
  private subs: Subscription[] = [];

  constructor(
    private transformStore: TransformationStoreService,
    private optimizerResultStore: OptimizationResultStoreService,
  ) {}

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

  get selectedDayLabel(): string {
    return this.availableDays[this.selectedDayIndex] ?? '';
  }

  laneHeight(laneCount: number): string {
    return `${Math.max(laneCount, 1) * LANE_PX}px`;
  }

  prevDay(): void {
    if (this.selectedDayIndex > 0) {
      this.selectedDayIndex--;
      this.isOptimizerMode ? this.buildOptimizerDayView() : this.buildDayView();
      this.updateNowLine();
    }
  }

  nextDay(): void {
    if (this.selectedDayIndex < this.availableDays.length - 1) {
      this.selectedDayIndex++;
      this.isOptimizerMode ? this.buildOptimizerDayView() : this.buildDayView();
      this.updateNowLine();
    }
  }

  goToday(): void {
    const todayMs = floorToDay(Date.now());
    const idx = this.dayStartsMs.indexOf(todayMs);
    if (idx >= 0) {
      this.selectedDayIndex = idx;
      this.isOptimizerMode ? this.buildOptimizerDayView() : this.buildDayView();
      this.updateNowLine();
    }
  }

  // ── View builders ─────────────────────────────────────────────────────────

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

  private updateNowLine(): void {
    const todayMs    = floorToDay(Date.now());
    const selectedMs = this.dayStartsMs[this.selectedDayIndex];
    this.isToday     = selectedMs === todayMs;

    if (this.isToday) {
      const ratio = (Date.now() - todayMs) / DAY_MS;
      // Label column is w-28 = 7rem; chart fills the rest of the container
      this.currentTimeLeft = `calc(${(ratio * 100).toFixed(4)}% + ${((1 - ratio) * 7).toFixed(4)}rem)`;
    }
  }

  /**
   * Returns the bar-start timestamp for an assignment.
   *
   * Always equals `phases[0].start` when phases are present:
   *   - no delay        → phases[0] = fondeo  → vessel's original ETA
   *   - arrival delay   → phases[0] = delay   → original ETA (before delay)
   *   - operation delay → phases[0] = fondeo  → vessel's ETA (unchanged)
   */
  private fondeoStartMs(a: OptimizationAssignment): number {
    if (a.phases?.length) return new Date(a.phases[0].start).getTime();
    return new Date(a.scheduled_start).getTime() - a.waiting_time_h * 3_600_000;
  }

  private buildViewFromAssignments(): void {
    if (!this.allAssignments.length) { this.clearView(); return; }

    const daySet = new Set<number>();
    for (const a of this.allAssignments) {
      // fondeoStartMs returns phases[0].start which is already the original ETA
      // (the 'delay' phase, if any, is phases[0] for arrival delays).
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

  private buildOptimizerDayView(): void {
    if (!this.allAssignments.length || !this.dayStartsMs.length) return;

    const dayStart = this.dayStartsMs[this.selectedDayIndex];
    const dayEnd   = dayStart + DAY_MS;
    const nowMs    = Date.now();

    // Include any assignment whose full range (original ETA → scheduled_end) overlaps
    // this 24h window. fondeoStartMs returns phases[0].start = original ETA.
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
      // Sort by fondeo start so swim-lane assignment is consistent
      const sorted = [...assigns].sort((x, y) =>
        this.fondeoStartMs(x) - this.fondeoStartMs(y),
      );

      const clampedTimings = sorted.map(a => ({
        startMs: Math.max(this.fondeoStartMs(a), dayStart),  // phases[0].start = original ETA
        endMs:   Math.min(new Date(a.scheduled_end).getTime(), dayEnd),
      }));
      const lanes = assignLanes(clampedTimings);

      const vessels: GanttVessel[] = sorted.map((a, i) => {
        const delayH = a.delay_h ?? 0;
        const rawS   = this.fondeoStartMs(a);  // phases[0].start = original ETA
        const rawE   = new Date(a.scheduled_end).getTime();
        const clippedLeft  = rawS < dayStart;
        const clippedRight = rawE > dayEnd;
        const visStart = clampedTimings[i].startMs;
        const visEnd   = clampedTimings[i].endMs;
        const visDur   = visEnd - visStart;

        // ⚠ Warning: operation has passed its end but is within the 5 h grace window
        const showWarning = rawE <= nowMs && nowMs < rawE + 5 * 3_600_000;

        // Phase segments — backend inserts 'delay' phase at the right position:
        //   arrival delay  → [delay, fondeo, atraque, ejecucion, desatraque]
        //   operation delay→ [fondeo, atraque, ejecucion, delay, desatraque]
        // Just iterate a.phases in order and clip each to [visStart, visEnd].
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

        // Fondeo badge: only when the fondeo phase is visible in this window
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

  private clearView(): void {
    this.allCalls        = [];
    this.availableDays   = [];
    this.dayStartsMs     = [];
    this.selectedDayIndex = 0;
    this.ganttBerths     = [];
    this.isToday         = false;
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}

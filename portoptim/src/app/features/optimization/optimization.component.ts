import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import {
  BerthCall,
  OperationPhase,
  OptimizationApiRequest,
  OptimizationApiResult,
  OptimizationAssignment,
  TransformApiResponse,
} from '../../core/models/api.models';
import { LanguageService } from '../../core/services/language.service';
import { OptimizationParamsStoreService } from '../../core/services/optimization-params-store.service';
import { OptimizationResultStoreService } from '../../core/services/optimization-result-store.service';
import { OptimizationRunnerService } from '../../core/services/optimization-runner.service';
import { TransformationStoreService } from '../../core/services/transformation-store.service';
import { VesselDetail } from './components/vessel-detail-panel/vessel-detail-panel.component';

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface Kpi { label: string; value: string; sub: string; icon: string; positive: boolean; }

interface PhaseSegment {
  widthPct: string;
  colorClass: string;
  name: string;
}

interface GanttVessel {
  name: string;
  left: string;
  width: string;
  /** Pixel offset from top of the berth row (swim-lane position). */
  top: string;
  colorClass: string;
  /** True when the vessel's end time exceeds the window right edge. */
  clipped: boolean;
  call?: BerthCall;
  assignment?: OptimizationAssignment;
  /** Colored phase segments (atraque / ejecucion / desatraque) when optimizer data has phases. */
  phaseSegments?: PhaseSegment[];
  /** Fondeo (anchorage) duration in hours; only set in optimizer mode when phases are available. */
  fondeoH?: number;
  /** True when the operation is past its scheduled end but within the 5 h grace window (not yet completed). */
  showWarning?: boolean;
  /** True when the bar starts before this window (continues from the previous window). */
  carryOver?: boolean;
}

interface GanttBerth {
  name: string;
  vessels: GanttVessel[];
  /** Number of concurrent swim lanes needed for this berth in the current window. */
  laneCount: number;
}

interface WindowGantt {
  berths: GanttBerth[];
  /** Day-label strings for the time axis (one per day in the window). */
  hours: string[];
  /** Human-readable range label shown in the navigation bar. */
  windowLabel: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Number of days shown per Gantt window. */
const WINDOW_DAYS = 5;
/** Height in pixels for each swim-lane row inside a berth. */
const LANE_PX = 44;

const VESSEL_COLORS = [
  'bg-teal-500/90', 'bg-indigo-500/90', 'bg-amber-500/90',
  'bg-violet-500/90', 'bg-sky-500/90', 'bg-rose-500/90',
];

const PHASE_COLORS: Record<string, string> = {
  fondeo:    'bg-amber-400',
  atraque:   'bg-sky-500',
  ejecucion: 'bg-emerald-500',
  desatraque:'bg-violet-500',
};

const SOURCE_LABELS: Record<string, string> = {
  rate_model: 'Rate model',
  statistical_model: 'Statistical',
  provided: 'Provided',
  default: 'Default',
};

const DAY_MS = 24 * 3600 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Assign each vessel to a swim lane using earliest-free-lane algorithm. */
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

/** Floor a timestamp to midnight (local). */
function floorToDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-optimization',
  standalone: false,
  templateUrl: './optimization.component.html',
  styleUrl: './optimization.component.scss',
})
export class OptimizationComponent implements OnInit, OnDestroy {
  // ── State ────────────────────────────────────────────────────────────────

  hasData = false;
  isPanelOpen = false;
  selectedVessel: VesselDetail | null = null;

  // isRunning and optimizerError are surfaced as getters from the runner service
  // so the run continues even when the user navigates away from this page.
  get isRunning(): boolean       { return this.runner.isRunning; }
  get optimizerError(): string | null { return this.runner.error; }

  kpis: Kpi[] = [];
  ganttBerths: GanttBerth[] = [];
  ganttHours: string[] = [];
  optimizerResult: OptimizationApiResult | null = null;

  // ── Window navigation ─────────────────────────────────────────────────────

  /** Window labels shown in the navigation bar (e.g. "1 ene – 5 ene"). */
  availableDates: string[] = [];
  selectedDateIndex = 0;
  private ganttWindows: WindowGantt[] = [];

  private transformResult: TransformApiResponse | null = null;
  private subs: Subscription[] = [];
  private vesselStatusOverrides = new Map<string, string>();
  private vesselDelayHours      = new Map<string, number>();

  constructor(
    private transformStore: TransformationStoreService,
    private paramsStore: OptimizationParamsStoreService,
    private resultStore: OptimizationResultStoreService,
    private lang: LanguageService,
    readonly runner: OptimizationRunnerService,
  ) {}

  ngOnInit(): void {
    // Dismiss the completion toast when the user navigates back to this page.
    this.runner.dismissNotification();

    this.subs.push(
      this.transformStore.result$.subscribe(r => {
        this.transformResult = r;
        this.hasData = !!r;
        if (r && !this.optimizerResult) this.buildHistoricalView(r);
      }),
      this.resultStore.result$.subscribe(r => {
        this.optimizerResult = r;
        if (r) {
          this.buildOptimizerView(r);
        } else if (this.transformResult) {
          this.buildHistoricalView(this.transformResult);
        }
      }),
    );
  }

  // ── Window navigation getters ─────────────────────────────────────────────

  get selectedDate(): string | null {
    return this.availableDates[this.selectedDateIndex] ?? null;
  }

  get filteredGanttBerths(): GanttBerth[] {
    return this.ganttWindows[this.selectedDateIndex]?.berths ?? this.ganttBerths;
  }

  get filteredGanttHours(): string[] {
    return this.ganttWindows[this.selectedDateIndex]?.hours ?? this.ganttHours;
  }

  get vesselCountForDate(): number {
    return this.filteredGanttBerths.reduce((sum, b) => sum + b.vessels.length, 0);
  }

  /** Pixel height for a berth row based on its swim-lane count. */
  laneHeight(laneCount: number): string {
    return `${Math.max(laneCount, 1) * LANE_PX}px`;
  }

  prevDay(): void {
    if (this.selectedDateIndex > 0) this.selectedDateIndex--;
  }

  nextDay(): void {
    if (this.selectedDateIndex < this.availableDates.length - 1) this.selectedDateIndex++;
  }

  // ── Other getters ─────────────────────────────────────────────────────────

  get paramsValidationErrors(): string[] {
    const p = this.paramsStore.snapshot;
    if (!p) return [this.lang.t('opt.params_err.no_params')];
    const errors: string[] = [];
    if (p.num_pilots === null || p.num_pilots === undefined || (p.num_pilots as unknown as string) === '' || p.num_pilots < 1) {
      errors.push(this.lang.t('di.params.err.pilots'));
    }
    if (p.num_tugs === null || p.num_tugs === undefined || (p.num_tugs as unknown as string) === '' || p.num_tugs < 1) {
      errors.push(this.lang.t('di.params.err.tugs'));
    }
    for (const zone of p.mooring_zones) {
      if (zone.bap_type === 'continuous' && (zone.noray_max === null || zone.noray_max === undefined || zone.noray_max < 1)) {
        errors.push(`${this.lang.t('di.params.err.zone_noray')} "${zone.berth_id}"`);
      }
      if (zone.bap_type === 'discrete' && (zone.capacity === null || zone.capacity === undefined || zone.capacity < 1)) {
        errors.push(`${this.lang.t('di.params.err.zone_capacity')} "${zone.berth_id}"`);
      }
    }
    return errors;
  }

  get canRunOptimizer(): boolean {
    return this.hasData && !this.isRunning && this.paramsValidationErrors.length === 0;
  }

  get utilizationEntries(): { berth: string; pct: number }[] {
    if (!this.optimizerResult) return [];
    return Object.entries(this.optimizerResult.kpis.berth_utilization)
      .map(([berth, pct]) => ({ berth, pct }))
      .sort((a, b) => b.pct - a.pct);
  }

  get sourceBreakdownEntries(): { label: string; count: number }[] {
    if (!this.optimizerResult) return [];
    return Object.entries(this.optimizerResult.kpis.duration_source_breakdown)
      .map(([src, count]) => ({ label: SOURCE_LABELS[src] ?? src, count }));
  }

  // ── Run optimizer ─────────────────────────────────────────────────────────

  runOptimization(): void {
    const params = this.paramsStore.snapshot;
    const result = this.transformResult;
    if (!params || !result) return;

    // Build the request and hand it off to the singleton runner service.
    // The HTTP subscription lives in the service — it survives navigation.
    const request: OptimizationApiRequest = {
      vessels: result.data.map(call => ({
        id: call.call_id,
        eta: call.arrival_time,
        eslora: call.vessel_length,
        gt: call.vessel_gt,
        target_berth: call.berth_id,
        operations: [{
          tipo_operacion: call.operation_type,
          grupo_mercancia: call.cargo_group,
          cantidad: call.quantity,
        }],
        estimated_duration_h: null,
      })),
      config: {
        num_pilots: params.num_pilots ?? 3,
        num_tugs: params.num_tugs ?? 2,
        default_duration_h: 48,
        overlap_factor: 0.70,
        mooring_zones: params.mooring_zones,
      },
    };

    this.runner.run(request);
  }

  resetOptimizer(): void {
    this.runner.cancelRun();
    this.resultStore.clear();
    this.runner.clearError();
    this.vesselStatusOverrides.clear();
    this.vesselDelayHours.clear();
  }

  applyDelay(delayHours: number): void {
    const vessel = this.selectedVessel;
    if (!vessel || !this.optimizerResult) return;

    const current = this.vesselDelayHours.get(vessel.name) ?? 0;
    this.vesselDelayHours.set(vessel.name, current + delayHours);

    // Rebuild gantt with new delay applied
    this.buildOptimizerView(this.optimizerResult);

    // Re-open the detail panel for the same vessel with updated times
    const updated = this.filteredGanttBerths.flatMap(b => b.vessels).find(v => v.name === vessel.name)
                 ?? this.ganttWindows.flatMap(w => w.berths).flatMap(b => b.vessels).find(v => v.name === vessel.name);
    if (updated) this.openOptimizerDetail(updated);
  }

  confirmOperation(): void {
    const vessel = this.selectedVessel;
    if (!vessel) return;

    const current = vessel.status;
    let next: string;
    let nextColor: string;

    if (current === 'vessel.status.on_the_way') {
      next = 'vessel.status.in_progress';
      nextColor = 'bg-amber-500';
    } else if (current === 'vessel.status.in_progress') {
      next = 'vessel.status.completed';
      nextColor = 'bg-green-500';
    } else {
      return;
    }

    this.vesselStatusOverrides.set(vessel.name, next);
    this.selectedVessel = { ...vessel, status: next, statusColor: nextColor };
  }

  // ── View builders ─────────────────────────────────────────────────────────

  private buildHistoricalView(result: TransformApiResponse): void {
    this.kpis = this.historicalKpis(result.data, result);
    // Gantt is only built after the optimizer runs — reset any stale windows
    this.ganttWindows = [];
    this.availableDates = [];
    this.selectedDateIndex = 0;
    this.ganttHours  = [];
    this.ganttBerths = [];
  }

  private buildOptimizerView(result: OptimizationApiResult): void {
    const kpis = result.kpis;

    const assigned = result.assignments.filter(a => a.status === 'assigned');
    const totalFondeo = assigned.reduce((sum, a) => {
      const fondeo = a.phases?.find(p => p.name === 'fondeo');
      return sum + (fondeo?.duration_h ?? a.waiting_time_h);
    }, 0);
    const avgFondeo = assigned.length ? totalFondeo / assigned.length : 0;

    this.kpis = [
      { label: 'opt.kpi.total_wait',   value: `${totalFondeo.toFixed(1)} h`, sub: 'opt.kpi.total_wait_sub',   icon: 'anchor', positive: totalFondeo < 1 },
      { label: 'opt.kpi.avg_wait',     value: `${avgFondeo.toFixed(1)} h`,   sub: 'opt.kpi.avg_wait_sub',     icon: 'anchor', positive: avgFondeo < 1 },
      { label: 'opt.kpi.improvement',  value: `${kpis.improvement_vs_greedy_pct.toFixed(1)} %`, sub: 'opt.kpi.improvement_sub', icon: 'trending_up', positive: kpis.improvement_vs_greedy_pct >= 0 },
      { label: 'opt.kpi.unresolved',   value: String(kpis.unresolved_vessels),              sub: 'opt.kpi.unresolved_sub',   icon: 'warning',         positive: kpis.unresolved_vessels === 0 },
    ];
    this.ganttWindows = [];
    this.availableDates = [];
    this.selectedDateIndex = 0;
    this.buildOptimizerGantt(result.assignments);
  }

  // ── Gantt builders ─────────────────────────────────────────────────────────

  private buildHistoricalGantt(calls: BerthCall[]): void {
    if (!calls.length) return;

    const startTimes = calls.map(c => new Date(c.arrival_time).getTime());
    const windows = this.computeWindows(startTimes);

    let colorIdx = 0;
    for (const win of windows) {
      // Vessels that START within this window
      const winCalls = calls.filter(c => {
        const t = new Date(c.arrival_time).getTime();
        return t >= win.startMs && t < win.endMs;
      });
      if (!winCalls.length) continue;

      // Group by berth
      const berthMap = new Map<string, BerthCall[]>();
      for (const c of winCalls) {
        if (!berthMap.has(c.berth_id)) berthMap.set(c.berth_id, []);
        berthMap.get(c.berth_id)!.push(c);
      }

      const berths: GanttBerth[] = [];
      for (const [berthId, bCalls] of berthMap) {
        const sorted = [...bCalls].sort((a, b) =>
          new Date(a.arrival_time).getTime() - new Date(b.arrival_time).getTime()
        );
        const timings = sorted.map(c => ({
          startMs: new Date(c.arrival_time).getTime(),
          endMs:   new Date(c.departure_time).getTime(),
        }));
        const lanes = assignLanes(timings);

        const vessels: GanttVessel[] = sorted.map((call, i) => {
          const s = timings[i].startMs;
          const e = timings[i].endMs;
          const clipped = e > win.endMs;
          const left  = (s - win.startMs) / win.durationMs * 100;
          const rawW  = (Math.min(e, win.endMs) - s) / win.durationMs * 100;
          return {
            name: call.call_id,
            left: left.toFixed(2) + '%',
            width: Math.max(rawW, 0.8).toFixed(2) + '%',
            top: `${lanes[i] * LANE_PX}px`,
            colorClass: VESSEL_COLORS[colorIdx++ % VESSEL_COLORS.length],
            clipped,
            call,
          };
        });

        berths.push({ name: berthId, vessels, laneCount: Math.max(...lanes) + 1 });
      }

      this.ganttWindows.push({ berths, hours: win.labels, windowLabel: win.label });
      this.availableDates.push(win.label);
    }

    const first = this.ganttWindows[0];
    this.ganttHours  = first?.hours ?? [];
    this.ganttBerths = first?.berths ?? [];
  }

  /**
   * Returns the CSS classes for a Gantt bar's background and border-radius.
   * - Neither edge clipped → rounded-lg (all corners)
   * - Only right edge clipped → rounded-l-lg (left corners only)
   * - Only left edge clipped (carry-over) → rounded-r-lg (right corners only)
   * - Both edges clipped → no rounding (rectangular)
   */
  ganttBarClass(vessel: GanttVessel): string {
    const bg = vessel.phaseSegments ? '' : vessel.colorClass;
    let rounding: string;
    if (!vessel.clipped && !vessel.carryOver) rounding = 'rounded-lg';
    else if (vessel.clipped && !vessel.carryOver)  rounding = 'rounded-l-lg';
    else if (!vessel.clipped && vessel.carryOver)   rounding = 'rounded-r-lg';
    else rounding = '';
    return bg ? `${bg} ${rounding}` : rounding;
  }

  /** Converts a decimal hour value to "HH:MM" string (e.g. 1.75 → "01:45"). */
  hoursToHHMM(h: number): string {
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /**
   * Vertical grid lines for the Gantt content area.
   * Returns one entry per line, ordered left-to-right:
   *   noon = true  → dashed lighter line at midday of each day
   *   noon = false → solid line at each midnight (day boundary)
   */
  get ganttGridLines(): { left: string; noon: boolean }[] {
    const lines: { left: string; noon: boolean }[] = [];
    for (let d = 0; d < WINDOW_DAYS; d++) {
      // Midday of day d
      lines.push({ left: `${((d + 0.5) / WINDOW_DAYS * 100).toFixed(2)}%`, noon: true });
      // Midnight between day d and d+1 (skip the very last — it's the right edge)
      if (d < WINDOW_DAYS - 1) {
        lines.push({ left: `${((d + 1) / WINDOW_DAYS * 100).toFixed(2)}%`, noon: false });
      }
    }
    return lines;
  }

  /** Returns the fondeo start (vessel arrival time) for an assignment.
   *  Falls back to scheduled_start − waiting_time_h when phases are absent. */
  private fondeoStartMs(a: OptimizationAssignment): number {
    const fondeoPhase = a.phases?.find(p => p.name === 'fondeo');
    if (fondeoPhase) return new Date(fondeoPhase.start).getTime();
    return new Date(a.scheduled_start).getTime() - a.waiting_time_h * 3_600_000;
  }

  private buildOptimizerGantt(assignments: OptimizationAssignment[]): void {
    const visible = assignments.filter(a => a.status !== 'invalid_berth');
    if (!visible.length) return;

    // Windows are anchored to vessel arrival (fondeo start).
    const startTimes = visible.map(a => this.fondeoStartMs(a));
    const windows = this.computeWindows(startTimes);

    // Assign stable colors by vessel_id so carry-over bars keep the same color
    // across windows (otherwise a second-window bar would get a different hue).
    const vesselColorMap = new Map<string, string>();
    let colorIdx = 0;
    for (const a of visible) {
      if (a.status === 'assigned' && !vesselColorMap.has(a.vessel_id)) {
        vesselColorMap.set(a.vessel_id, VESSEL_COLORS[colorIdx++ % VESSEL_COLORS.length]);
      }
    }

    for (const win of windows) {
      const nowMs = Date.now();

      // Include vessels that OVERLAP with this window (not just those whose
      // fondeo start falls inside it), so that long operations split across
      // window boundaries appear in both the current and the next window.
      const winAssigns = visible.filter(a => {
        const delayMs = (this.vesselDelayHours.get(a.vessel_id) ?? 0) * 3_600_000;
        const s = this.fondeoStartMs(a) + delayMs;
        const e = new Date(a.scheduled_end).getTime() + delayMs;
        return s < win.endMs && e > win.startMs;
      });
      if (!winAssigns.length) continue;

      const berthMap = new Map<string, OptimizationAssignment[]>();
      for (const a of winAssigns) {
        if (!berthMap.has(a.berth_id)) berthMap.set(a.berth_id, []);
        berthMap.get(a.berth_id)!.push(a);
      }

      const berths: GanttBerth[] = [];
      for (const [berthId, bAssigns] of berthMap) {
        const sorted = [...bAssigns].sort((a, b) =>
          this.fondeoStartMs(a) - this.fondeoStartMs(b)
        );
        const timings = sorted.map(a => {
          const delayMs = (this.vesselDelayHours.get(a.vessel_id) ?? 0) * 3_600_000;
          return {
            startMs: this.fondeoStartMs(a) + delayMs,
            endMs:   new Date(a.scheduled_end).getTime() + delayMs,
          };
        });
        const lanes = assignLanes(timings);

        const vessels: GanttVessel[] = sorted.map((a, i) => {
          const delayMs = (this.vesselDelayHours.get(a.vessel_id) ?? 0) * 3_600_000;
          const s = timings[i].startMs;
          const e = timings[i].endMs;

          // Does the bar start before / end after this window?
          const carryOver = s < win.startMs;
          const clipped   = e > win.endMs;

          // Visible portion of the bar within this window
          const visStart    = Math.max(s, win.startMs);
          const visEnd      = Math.min(e, win.endMs);
          const barVisualMs = visEnd - visStart;

          const left = (visStart - win.startMs) / win.durationMs * 100;
          const rawW = barVisualMs / win.durationMs * 100;
          // Warning fires when the operation has passed its scheduled end
          // but is still within the 5 h grace window before "completed" status.
          const showWarning = e <= nowMs && nowMs < e + 5 * 3_600_000;

          // ── Phase segments: clip each phase to [visStart, visEnd] ──────────
          let phaseSegments: PhaseSegment[] | undefined;
          if (a.status === 'assigned' && a.phases?.length >= 4 && barVisualMs > 0) {
            const segs: PhaseSegment[] = [];
            for (const p of a.phases) {
              if (p.duration_h <= 0) continue;
              const phaseStartMs = new Date(p.start).getTime() + delayMs;
              const phaseEndMs   = new Date(p.end).getTime()   + delayMs;
              const pVisStart = Math.max(phaseStartMs, visStart);
              const pVisEnd   = Math.min(phaseEndMs,   visEnd);
              if (pVisEnd <= pVisStart) continue; // phase entirely outside this window
              segs.push({
                widthPct:   `${((pVisEnd - pVisStart) / barVisualMs * 100).toFixed(2)}%`,
                colorClass: PHASE_COLORS[p.name] ?? 'bg-slate-400',
                name:       p.name,
              });
            }
            if (segs.length) phaseSegments = segs;
          }

          // ── Fondeo badge: only when the fondeo phase is visible here ────────
          let fondeoH: number | undefined;
          const fondeoPhase = a.phases?.find(p => p.name === 'fondeo');
          if (fondeoPhase && fondeoPhase.duration_h > 0) {
            const fStartMs = new Date(fondeoPhase.start).getTime() + delayMs;
            const fEndMs   = new Date(fondeoPhase.end).getTime()   + delayMs;
            if (fStartMs < win.endMs && fEndMs > win.startMs) {
              fondeoH = fondeoPhase.duration_h;
            }
          }

          return {
            name: a.vessel_id,
            left:  left.toFixed(2) + '%',
            width: Math.max(rawW, 0.8).toFixed(2) + '%',
            top:   `${lanes[i] * LANE_PX}px`,
            colorClass: a.status === 'assigned'
              ? (vesselColorMap.get(a.vessel_id) ?? 'bg-slate-500')
              : 'bg-red-400/70',
            clipped,
            carryOver,
            assignment: a,
            phaseSegments,
            fondeoH,
            showWarning,
          };
        });

        berths.push({ name: berthId, vessels, laneCount: Math.max(...lanes) + 1 });
      }

      this.ganttWindows.push({ berths, hours: win.labels, windowLabel: win.label });
      this.availableDates.push(win.label);
    }

    const first = this.ganttWindows[0];
    this.ganttHours  = first?.hours ?? [];
    this.ganttBerths = first?.berths ?? [];
  }

  // ── Window computation ────────────────────────────────────────────────────

  private computeWindows(startTimes: number[]): {
    startMs: number; endMs: number; durationMs: number; label: string; labels: string[];
  }[] {
    if (!startTimes.length) return [];

    const firstDayMs = floorToDay(Math.min(...startTimes));
    const lastStartMs = Math.max(...startTimes);

    const windows = [];
    let cursor = firstDayMs;

    while (cursor <= lastStartMs) {
      const winStartMs = cursor;
      const winEndMs   = cursor + WINDOW_DAYS * DAY_MS;
      const durationMs = WINDOW_DAYS * DAY_MS;

      // Day labels for the time axis (one per day in the window)
      const labels: string[] = [];
      for (let d = 0; d < WINDOW_DAYS; d++) {
        const day = new Date(winStartMs + d * DAY_MS);
        labels.push(day.toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }));
      }

      // Navigation label: "1 ene – 5 ene"
      const fmt = (ms: number) =>
        new Date(ms).toLocaleString('es-ES', { day: 'numeric', month: 'short' });
      const label = `${fmt(winStartMs)} – ${fmt(winEndMs - DAY_MS)}`;

      windows.push({ startMs: winStartMs, endMs: winEndMs, durationMs, label, labels });
      cursor += WINDOW_DAYS * DAY_MS;
    }

    return windows;
  }

  // ── KPI helpers ────────────────────────────────────────────────────────────

  private historicalKpis(calls: BerthCall[], result: TransformApiResponse): Kpi[] {
    const uniqueBerths = new Set(calls.map(c => c.berth_id)).size;
    const avgDuration  = calls.length ? calls.reduce((s, c) => s + c.duration_hours, 0) / calls.length : 0;
    const skipped = result.transformation_summary.skipped_rows;
    return [
      { label: 'opt.hist.vessels', value: String(calls.length),            sub: 'opt.hist.vessels_sub', icon: 'directions_boat', positive: true },
      { label: 'opt.hist.berths',  value: String(uniqueBerths),            sub: 'opt.hist.berths_sub',  icon: 'dock',            positive: true },
      { label: 'opt.hist.avg_dur', value: `${avgDuration.toFixed(1)} h`,   sub: 'opt.hist.avg_dur_sub', icon: 'timer',           positive: true },
      { label: 'opt.hist.skipped', value: String(skipped), sub: skipped === 0 ? 'opt.hist.skipped_ok' : 'opt.hist.skipped_warn', icon: 'warning', positive: skipped === 0 },
    ];
  }

  // ── Detail panel ──────────────────────────────────────────────────────────

  openHistoricalDetail(vessel: GanttVessel): void {
    const c = vessel.call!;
    const started = new Date(c.arrival_time) <= new Date();
    this.selectedVessel = {
      name: c.call_id,
      imo: `Berth: ${c.berth_id}`,
      status: started ? 'vessel.status.in_progress' : 'vessel.status.on_the_way',
      statusColor: started ? 'bg-amber-500' : 'bg-blue-400',
      priority: c.operation_type,
      type: c.operation_type,
      loa: `${c.vessel_length} m`,
      gt: c.vessel_gt.toLocaleString(),
      operation: c.operation_type,
      berth: c.berth_id,
      eta: new Date(c.arrival_time).toLocaleString('es-ES'),
      etd: new Date(c.departure_time).toLocaleString('es-ES'),
      cargo: [{ icon: 'inventory_2', type: c.cargo_group || 'N/A', quantity: c.quantity !== null ? String(c.quantity) : 'N/A', unit: c.cargo_nature || '' }],
    };
    this.isPanelOpen = true;
  }

  openOptimizerDetail(vessel: GanttVessel): void {
    const a = vessel.assignment!;
    const override    = this.vesselStatusOverrides.get(a.vessel_id);
    const now         = Date.now();
    const delayMs     = (this.vesselDelayHours.get(a.vessel_id) ?? 0) * 3_600_000;
    // fondeoMs = vessel arrival at port (start of anchorage waiting)
    const fondeoMs    = this.fondeoStartMs(a) + delayMs;
    const endMs       = new Date(a.scheduled_end).getTime() + delayMs;
    const started     = fondeoMs <= now;          // vessel has arrived at port
    const departed    = endMs + 5 * 3_600_000 <= now;

    const autoStatus = departed
      ? 'vessel.status.completed'
      : started
        ? 'vessel.status.in_progress'
        : 'vessel.status.on_the_way';

    const status = override ?? autoStatus;
    const statusColor =
      status === 'vessel.status.completed'   ? 'bg-green-500' :
      status === 'vessel.status.in_progress' ? 'bg-amber-500' : 'bg-blue-400';

    // Look up original BerthCall for vessel properties not stored in the assignment
    const call = this.transformResult?.data.find(c => c.call_id === a.vessel_id);

    // canAddDelay: any vessel that hasn't been marked completed yet (on_the_way,
    // in_progress, or inside the 5 h grace window after scheduled_end).
    const canAddDelay = !departed;
    const accumulatedDelay = this.vesselDelayHours.get(a.vessel_id);

    this.selectedVessel = {
      name: a.vessel_id,
      imo: `Berth: ${a.berth_id}`,
      status,
      statusColor,
      priority: 'GT Priority',
      type: a.duration_source,
      loa:       call ? `${call.vessel_length} m` : '—',
      gt:        call ? call.vessel_gt.toLocaleString() : '—',
      operation: call ? call.operation_type : '—',
      berth: a.berth_id,
      eta: new Date(fondeoMs).toLocaleString('es-ES'),   // vessel arrival (fondeo start)
      etd: new Date(endMs).toLocaleString('es-ES'),
      cargo: call
        ? [{ icon: 'inventory_2', type: call.cargo_group || 'N/A', quantity: call.quantity != null ? String(call.quantity) : 'N/A', unit: call.cargo_nature || '' }]
        : [],
      waitingTime:       `${a.waiting_time_h.toFixed(2)} h`,
      durationEstimated: `${a.duration_estimated_h.toFixed(1)} h`,
      durationSource:    SOURCE_LABELS[a.duration_source] ?? a.duration_source,
      pilotAssigned:     a.pilot_assigned,
      tugsRequired:      a.tugs_required,
      tugsAssigned:      a.tugs_assigned,
      optimizerStatus:   a.status,
      phases:            a.phases?.length ? a.phases : undefined,
      canAddDelay,
      delayHours:        accumulatedDelay,
    };
    this.isPanelOpen = true;
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}

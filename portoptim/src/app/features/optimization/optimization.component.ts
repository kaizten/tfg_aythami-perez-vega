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
import { EarlyCompleteInfo, OptimizationRunnerService } from '../../core/services/optimization-runner.service';
import { TransformationStoreService } from '../../core/services/transformation-store.service';
import { VesselDetail } from './components/vessel-detail-panel/vessel-detail-panel.component';

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
  top: string;
  colorClass: string;
  clipped: boolean;
  call?: BerthCall;
  assignment?: OptimizationAssignment;
  phaseSegments?: PhaseSegment[];
  fondeoH?: number;
  showWarning?: boolean;
  showArrivalWarning?: boolean;
  carryOver?: boolean;
  delayH?: number;
}

interface GanttBerth {
  name: string;
  vessels: GanttVessel[];
  laneCount: number;
}

interface WindowGantt {
  berths: GanttBerth[];
  hours: string[];
  windowLabel: string;
  startMs: number;
  endMs: number;
}

/* Fixed - number of days displayed per Gantt window */
const WINDOW_DAYS = 5;
/* Fixed - pixel height for each swim-lane row inside a berth */
const LANE_PX = 44;

/* Fixed - ordered list of Tailwind color classes cycled through vessel bars */
const VESSEL_COLORS = [
  'bg-teal-500/90', 'bg-indigo-500/90', 'bg-amber-500/90',
  'bg-violet-500/90', 'bg-sky-500/90', 'bg-rose-500/90',
];

/* Fixed - mapping from operation phase name to its Tailwind background color class */
const PHASE_COLORS: Record<string, string> = {
  delay:                 'bg-red-500',
  fondeo:                'bg-amber-400',
  fondeo_resource_wait:  'bg-orange-400',
  atraque:               'bg-sky-500',
  ejecucion:             'bg-emerald-500',
  desatraque:            'bg-violet-500',
  waiting_undock:        'bg-violet-300',
};

/* Fixed - mapping from duration source identifier to human-readable label */
const SOURCE_LABELS: Record<string, string> = {
  rate_model: 'Rate model',
  statistical_model: 'Statistical',
  provided: 'Provided',
  default: 'Default',
};

/* Fixed - milliseconds in one day */
const DAY_MS = 24 * 3600 * 1000;

/*
 * Assigns each vessel to the earliest available swim lane to avoid overlapping bars.
 * @param vessels - Array of objects with startMs and endMs timestamps
 * @returns Array of lane indices parallel to the input array
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
 * Floors a Unix timestamp to the local midnight of its calendar day.
 * @param ms - Unix timestamp in milliseconds
 * @returns Unix timestamp of the start of the day (00:00:00 local time)
 */
function floorToDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

@Component({
  selector: 'app-optimization',
  standalone: false,
  templateUrl: './optimization.component.html',
  styleUrl: './optimization.component.scss',
})
export class OptimizationComponent implements OnInit, OnDestroy {
  /* Computed - true when transformation data is available to display */
  hasData = false;
  /* Computed - controls visibility of the vessel detail side panel */
  isPanelOpen = false;
  /* Computed - the vessel currently shown in the detail panel, or null if none */
  selectedVessel: VesselDetail | null = null;

  /* Computed - whether the optimizer HTTP request is currently in flight */
  get isRunning(): boolean              { return this.runner.isRunning; }
  /* Computed - last error message from the optimizer run, or null */
  get optimizerError(): string | null   { return this.runner.error; }
  /* Computed - whether a replan HTTP request is currently in flight */
  get isReplanning(): boolean           { return this.runner.isReplanning; }
  /* Computed - last error message from the replan run, or null */
  get replanError(): string | null      { return this.runner.replanError; }
  /* Computed - whether an early-completion replan is currently in flight */
  get isEarlyCompleting(): boolean                  { return this.runner.isEarlyCompleting;  }
  /* Computed - last error message from the early-completion replan, or null */
  get earlyCompleteError(): string | null           { return this.runner.earlyCompleteError; }
  /* Computed - metadata returned by the last early-completion replan, or null */
  get earlyCompleteInfo(): EarlyCompleteInfo | null { return this.runner.earlyCompleteInfo;  }

  /* Computed - KPI cards shown in the summary section */
  kpis: Kpi[] = [];
  /* Computed - berth rows rendered in the currently selected Gantt window */
  ganttBerths: GanttBerth[] = [];
  /* Computed - day-label strings for the time axis of the current window */
  ganttHours: string[] = [];
  /* Computed - last optimization result received from the API, or null */
  optimizerResult: OptimizationApiResult | null = null;
  /* Computed - list of vessels that could not be assigned to a berth */
  unresolvedVessels: { id: string; eta: string }[] = [];
  /* Computed - controls expansion of the unresolved vessels list */
  showUnresolvedList = false;
  /* Computed - when false the Gantt rows are clipped to a fixed-height scroll area */
  ganttExpanded = false;

  /* Computed - optimization quality metrics recalculated whenever a new result is loaded */
  qualityStats: {
    csvAvgDuration:    number;
    optAvgDuration:    number;
    avgStayImprovePct: number;
    zeroWaitPct:       number;
    maxWaitH:          number;
  } | null = null;

  /* Computed - human-readable window range labels shown in the navigation bar */
  availableDates: string[] = [];
  /* Computed - index of the currently displayed Gantt window */
  selectedDateIndex = 0;
  /* Computed - all pre-built Gantt windows covering the full dataset time range */
  private ganttWindows: WindowGantt[] = [];

  /* Computed - last transformation result received from the transformation store */
  private transformResult: TransformApiResponse | null = null;
  /* Computed - active RxJS subscriptions cleaned up on destroy */
  private subs: Subscription[] = [];
  /* Computed - map from vessel_id to manually overridden status string */
  private vesselStatusOverrides = new Map<string, string>();

  constructor(
    private transformStore: TransformationStoreService,
    private paramsStore: OptimizationParamsStoreService,
    private resultStore: OptimizationResultStoreService,
    private lang: LanguageService,
    readonly runner: OptimizationRunnerService,
  ) {}

  /*
   * Subscribes to the transformation and optimization result stores and builds
   * the initial Gantt view when data becomes available.
   */
  ngOnInit(): void {
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

  /* Computed - human-readable label for the currently selected date window */
  get selectedDate(): string | null {
    return this.availableDates[this.selectedDateIndex] ?? null;
  }

  /* Computed - berth rows for the currently selected Gantt window */
  get filteredGanttBerths(): GanttBerth[] {
    return this.ganttWindows[this.selectedDateIndex]?.berths ?? this.ganttBerths;
  }

  /* Computed - day-label strings for the currently selected Gantt window */
  get filteredGanttHours(): string[] {
    return this.ganttWindows[this.selectedDateIndex]?.hours ?? this.ganttHours;
  }

  /* Computed - total number of vessels visible in the current Gantt window */
  get vesselCountForDate(): number {
    return this.filteredGanttBerths.reduce((sum, b) => sum + b.vessels.length, 0);
  }

  /*
   * Returns the CSS pixel height for a berth row based on its swim-lane count.
   * @param laneCount - Number of concurrent swim lanes in the berth row
   * @returns CSS pixel string (e.g. "88px")
   */
  laneHeight(laneCount: number): string {
    return `${Math.max(laneCount, 1) * LANE_PX}px`;
  }

  /*
   * Navigates to the previous Gantt window if one exists.
   */
  prevDay(): void {
    if (this.selectedDateIndex > 0) {
      this.selectedDateIndex--;
      this.resultStore.ganttWindowIndex = this.selectedDateIndex;
    }
  }

  /*
   * Navigates to the next Gantt window if one exists.
   */
  nextDay(): void {
    if (this.selectedDateIndex < this.availableDates.length - 1) {
      this.selectedDateIndex++;
      this.resultStore.ganttWindowIndex = this.selectedDateIndex;
    }
  }

  /*
   * Toggles the expanded/collapsed state of the Gantt chart rows.
   */
  toggleGanttExpanded(): void {
    this.ganttExpanded = !this.ganttExpanded;
  }

  /* Computed - list of i18n-keyed validation error messages for the current optimization parameters */
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

  /* Computed - true when data is loaded, optimizer is idle, and all params are valid */
  get canRunOptimizer(): boolean {
    return this.hasData && !this.isRunning && this.paramsValidationErrors.length === 0;
  }

  /*
   * Builds the optimization request from the current transformation result and
   * params snapshot and delegates execution to the runner service.
   */
  runOptimization(): void {
    const params = this.paramsStore.snapshot;
    const result = this.transformResult;
    if (!params || !result) return;

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

  /*
   * Cancels any in-flight optimization run, clears stored results and errors,
   * and resets all vessel delays and status overrides.
   */
  resetOptimizer(): void {
    this.runner.cancelRun();
    this.resultStore.clear();
    this.runner.clearError();
    this.runner.resetDelays();
    this.vesselStatusOverrides.clear();
  }

  /*
   * Applies a delay to the currently selected vessel and triggers a replan.
   * @param delayHours - Number of hours to delay the vessel (required)
   */
  applyDelay(delayHours: number): void {
    const vessel = this.selectedVessel;
    if (!vessel) return;
    this.isPanelOpen = false;
    const ARRIVAL_THRESHOLD_MS = 3 * 3_600_000;
    const now             = Date.now();
    const schedStartMs    = vessel.scheduledStartMs ?? now;
    const delayType: 'arrival' | 'operation' =
      now < schedStartMs + ARRIVAL_THRESHOLD_MS ? 'arrival' : 'operation';
    this.runner.applyDelay(vessel.name, delayHours, delayType);
  }

  /*
   * Advances the selected vessel's status to the next stage and triggers a
   * replan if the vessel arrived early or completed its operation ahead of schedule.
   */
  confirmOperation(): void {
    const vessel = this.selectedVessel;
    if (!vessel) return;

    const current = vessel.status;

    if (current === 'vessel.status.on_the_way') {
      this.vesselStatusOverrides.set(vessel.name, 'vessel.status.in_progress');

      const now    = Date.now();
      const etaMs  = vessel.etaMs ?? now;
      const earlyH = (etaMs - now) / 3_600_000;

      if (earlyH > 0.1) {
        this.isPanelOpen = false;
        this.runner.applyEarlyArrival(vessel.name, Math.round(earlyH * 10) / 10);
      } else {
        this.selectedVessel = { ...vessel, status: 'vessel.status.in_progress', statusColor: 'bg-amber-500' };
      }

    } else if (current === 'vessel.status.in_progress') {
      this.isPanelOpen = false;
      this.vesselStatusOverrides.set(vessel.name, 'vessel.status.completed');
      this.runner.earlyComplete(vessel.name, this.localNow());
    }
  }

  /*
   * Returns the current local wall-clock time as a naive ISO-8601 string
   * without a UTC offset, matching the implicit timezone of backend scheduler data.
   * @returns Naive local datetime string in format YYYY-MM-DDTHH:MM:SS
   */
  private localNow(): string {
    const d   = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
           `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /*
   * Builds KPI cards from the historical transformation result and clears any
   * stale Gantt window state when no optimizer result is present.
   * @param result - The transformation API response to render (required)
   */
  private buildHistoricalView(result: TransformApiResponse): void {
    this.kpis = this.historicalKpis(result.data, result);
    this.ganttWindows = [];
    this.availableDates = [];
    this.selectedDateIndex = 0;
    this.ganttHours  = [];
    this.ganttBerths = [];
  }

  /*
   * Builds KPI cards, quality stats, unresolved vessel list, and the optimizer
   * Gantt windows from the given optimization API result.
   * @param result - The optimization API result to render (required)
   */
  private buildOptimizerView(result: OptimizationApiResult): void {
    const kpis = result.kpis;

    const assigned = result.assignments.filter(a => a.status === 'assigned');
    const totalFondeo = assigned.reduce((sum, a) => {
      const fondeo = a.phases?.find(p => p.name === 'fondeo');
      return sum + (fondeo?.duration_h ?? a.waiting_time_h);
    }, 0);
    const avgFondeo = assigned.length ? totalFondeo / assigned.length : 0;

    this.kpis = [
      { label: 'opt.kpi.total_wait',  value: this.formatHours(totalFondeo), sub: 'opt.kpi.total_wait_sub',  icon: 'anchor',  positive: totalFondeo < 1 },
      { label: 'opt.kpi.avg_wait',    value: this.formatHours(avgFondeo),   sub: 'opt.kpi.avg_wait_sub',    icon: 'anchor',  positive: avgFondeo < 1 },
      { label: 'opt.kpi.unresolved',  value: String(kpis.unresolved_vessels), sub: 'opt.kpi.unresolved_sub', icon: 'warning', positive: kpis.unresolved_vessels === 0 },
    ];

    const csvCalls = this.transformResult?.data ?? [];
    const csvAvgDuration = csvCalls.length
      ? csvCalls.reduce((s, c) => s + c.duration_hours, 0) / csvCalls.length
      : 0;
    const optAvgDuration = assigned.length
      ? assigned.reduce((s, a) => {
          const totalH = a.phases?.length
            ? a.phases.reduce((ph, p) => ph + p.duration_h, 0)
            : a.waiting_time_h + a.duration_estimated_h;
          return s + totalH;
        }, 0) / assigned.length
      : 0;
    const avgStayImprovePct = csvAvgDuration > 0
      ? (csvAvgDuration - optAvgDuration) / csvAvgDuration * 100
      : 0;
    const zeroWaitPct = assigned.length
      ? assigned.filter(a => a.waiting_time_h < 0.01).length / assigned.length * 100
      : 0;
    const maxWaitH = assigned.length
      ? Math.max(...assigned.map(a => a.waiting_time_h))
      : 0;
    this.qualityStats = { csvAvgDuration, optAvgDuration, avgStayImprovePct, zeroWaitPct, maxWaitH };

    const callMap = new Map<string, BerthCall>();
    for (const c of this.transformResult?.data ?? []) callMap.set(c.call_id, c);
    this.unresolvedVessels = result.assignments
      .filter(a => a.status !== 'assigned')
      .map(a => ({
        id:  a.vessel_id,
        eta: callMap.has(a.vessel_id)
          ? new Date(callMap.get(a.vessel_id)!.arrival_time).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '—',
      }));
    this.showUnresolvedList = false;

    this.ganttWindows = [];
    this.availableDates = [];
    this.selectedDateIndex = 0;
    this.buildOptimizerGantt(result.assignments);
  }

  /*
   * Formats a decimal hour value into a compact human-readable string such as "1d 3h 20m".
   * @param h - Duration in hours (required)
   * @returns Formatted duration string, or "0m" when the value rounds to zero
   */
  formatHours(h: number): string {
    const totalMinutes = Math.round(h * 60);
    const years   = Math.floor(totalMinutes / 525_600);
    const days    = Math.floor((totalMinutes % 525_600) / 1440);
    const hours   = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];
    if (years > 0)   parts.push(`${years}y`);
    if (days > 0)    parts.push(`${days}d`);
    if (hours > 0)   parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    return parts.length ? parts.join(' ') : '0m';
  }

  /*
   * Builds the historical Gantt windows from raw berth call records and
   * restores the previously selected window index.
   * @param calls - Array of berth call records from the transformation result (required)
   */
  private buildHistoricalGantt(calls: BerthCall[]): void {
    if (!calls.length) return;

    const startTimes = calls.map(c => new Date(c.arrival_time).getTime());
    const windows = this.computeWindows(startTimes);

    let colorIdx = 0;
    for (const win of windows) {
      const winCalls = calls.filter(c => {
        const t = new Date(c.arrival_time).getTime();
        return t >= win.startMs && t < win.endMs;
      });
      if (!winCalls.length) continue;

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

      this.ganttWindows.push({ berths, hours: win.labels, windowLabel: win.label, startMs: win.startMs, endMs: win.endMs });
      this.availableDates.push(win.label);
    }

    const stored = this.resultStore.ganttWindowIndex;
    this.selectedDateIndex = (stored >= 0 && stored < this.ganttWindows.length)
      ? stored
      : this._todayWindowIndex();
    this.resultStore.ganttWindowIndex = this.selectedDateIndex;

    const sel = this.ganttWindows[this.selectedDateIndex];
    this.ganttHours  = sel?.hours ?? [];
    this.ganttBerths = sel?.berths ?? [];
  }

  /*
   * Returns the combined Tailwind CSS classes for a Gantt bar's background and
   * border-radius, accounting for carry-over and clipped edges.
   * @param vessel - The Gantt vessel entry whose bar is being styled (required)
   * @returns Space-separated Tailwind class string
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

  /*
   * Converts a decimal hour value to a zero-padded "HH:MM" time string.
   * @param h - Duration in hours (required)
   * @returns Formatted string such as "01:45"
   */
  hoursToHHMM(h: number): string {
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /* Computed - vertical grid line descriptors for the Gantt content area, one per midday and midnight within the window */
  get ganttGridLines(): { left: string; noon: boolean }[] {
    const lines: { left: string; noon: boolean }[] = [];
    for (let d = 0; d < WINDOW_DAYS; d++) {
      lines.push({ left: `${((d + 0.5) / WINDOW_DAYS * 100).toFixed(2)}%`, noon: true });
      if (d < WINDOW_DAYS - 1) {
        lines.push({ left: `${((d + 1) / WINDOW_DAYS * 100).toFixed(2)}%`, noon: false });
      }
    }
    return lines;
  }

  /*
   * Returns the bar-start timestamp for an optimizer assignment, always equal to
   * phases[0].start when phases are present and falling back to scheduled_start minus waiting time.
   * @param a - The optimizer assignment record (required)
   * @returns Unix timestamp in milliseconds for the start of the vessel's Gantt bar
   */
  private fondeoStartMs(a: OptimizationAssignment): number {
    if (a.phases?.length) return new Date(a.phases[0].start).getTime();
    return new Date(a.scheduled_start).getTime() - a.waiting_time_h * 3_600_000;
  }

  /*
   * Builds all optimizer Gantt windows from the full assignment list, computing
   * phase segments, swim lanes, and warning flags for each vessel bar.
   * @param assignments - Full list of optimizer assignments including unresolved ones (required)
   */
  private buildOptimizerGantt(assignments: OptimizationAssignment[]): void {
    const visible = assignments.filter(a => a.status !== 'invalid_berth');
    if (!visible.length) return;

    const startTimes = visible.map(a => this.fondeoStartMs(a));
    const windows = this.computeWindows(startTimes);

    const vesselColorMap = new Map<string, string>();
    let colorIdx = 0;
    for (const a of visible) {
      if (a.status === 'assigned' && !vesselColorMap.has(a.vessel_id)) {
        vesselColorMap.set(a.vessel_id, VESSEL_COLORS[colorIdx++ % VESSEL_COLORS.length]);
      }
    }

    for (const win of windows) {
      const nowMs = Date.now();

      const winAssigns = visible.filter(a => {
        const s = this.fondeoStartMs(a);
        const e = new Date(a.scheduled_end).getTime();
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
        const timings = sorted.map(a => ({
          startMs: this.fondeoStartMs(a),
          endMs:   new Date(a.scheduled_end).getTime(),
        }));
        const lanes = assignLanes(timings);

        const vessels: GanttVessel[] = sorted.map((a, i) => {
          const delayH = a.delay_h ?? 0;

          const s = timings[i].startMs;
          const e = timings[i].endMs;

          const carryOver = s < win.startMs;
          const clipped   = e > win.endMs;

          const visStart    = Math.max(s, win.startMs);
          const visEnd      = Math.min(e, win.endMs);
          const barVisualMs = visEnd - visStart;

          const left = (visStart - win.startMs) / win.durationMs * 100;
          const rawW = barVisualMs / win.durationMs * 100;
          const schedEndMs  = new Date(a.scheduled_end).getTime();
          const isCompleted = this.vesselStatusOverrides.get(a.vessel_id) === 'vessel.status.completed';
          const showWarning = !isCompleted && schedEndMs <= nowMs && nowMs < schedEndMs + 5 * 3_600_000;
          const etaMs = timings[i].startMs;
          const showArrivalWarning =
            !isCompleted &&
            nowMs >= etaMs - 1 * 3_600_000 &&
            nowMs <  etaMs + 3 * 3_600_000;

          let phaseSegments: PhaseSegment[] | undefined;
          if (a.status === 'assigned' && a.phases?.length && barVisualMs > 0) {
            const resourceWaitH = Math.max(a.pilot_wait_h ?? 0, a.tug_wait_h ?? 0);
            const segs: PhaseSegment[] = [];
            for (const p of a.phases) {
              if (p.duration_h <= 0) continue;
              const phaseStartMs = new Date(p.start).getTime();
              const phaseEndMs   = new Date(p.end).getTime();

              if (p.name === 'fondeo' && resourceWaitH > 0.01) {
                const resStartMs = phaseEndMs - resourceWaitH * 3_600_000;

                const bVS = Math.max(phaseStartMs, visStart);
                const bVE = Math.min(resStartMs,   visEnd);
                if (bVE > bVS) {
                  segs.push({
                    widthPct:   `${((bVE - bVS) / barVisualMs * 100).toFixed(2)}%`,
                    colorClass: 'bg-amber-400',
                    name:       'fondeo',
                  });
                }

                const rVS = Math.max(resStartMs,  visStart);
                const rVE = Math.min(phaseEndMs,  visEnd);
                if (rVE > rVS) {
                  segs.push({
                    widthPct:   `${((rVE - rVS) / barVisualMs * 100).toFixed(2)}%`,
                    colorClass: 'bg-orange-400',
                    name:       'fondeo_resource_wait',
                  });
                }
              } else {
                const pVisStart = Math.max(phaseStartMs, visStart);
                const pVisEnd   = Math.min(phaseEndMs,   visEnd);
                if (pVisEnd <= pVisStart) continue;
                segs.push({
                  widthPct:   `${((pVisEnd - pVisStart) / barVisualMs * 100).toFixed(2)}%`,
                  colorClass: PHASE_COLORS[p.name] ?? 'bg-slate-400',
                  name:       p.name,
                });
              }
            }
            if (segs.length) phaseSegments = segs;
          }

          let fondeoH: number | undefined;
          const fondeoPhase = a.phases?.find(p => p.name === 'fondeo');
          if (fondeoPhase && fondeoPhase.duration_h > 0) {
            const fStartMs = new Date(fondeoPhase.start).getTime();
            const fEndMs   = new Date(fondeoPhase.end).getTime();
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
            showArrivalWarning,
            delayH: delayH > 0 ? delayH : undefined,
          };
        });

        berths.push({ name: berthId, vessels, laneCount: Math.max(...lanes) + 1 });
      }

      this.ganttWindows.push({ berths, hours: win.labels, windowLabel: win.label, startMs: win.startMs, endMs: win.endMs });
      this.availableDates.push(win.label);
    }

    const stored = this.resultStore.ganttWindowIndex;
    this.selectedDateIndex = (stored >= 0 && stored < this.ganttWindows.length)
      ? stored
      : this._todayWindowIndex();
    this.resultStore.ganttWindowIndex = this.selectedDateIndex;

    const sel = this.ganttWindows[this.selectedDateIndex];
    this.ganttHours  = sel?.hours ?? [];
    this.ganttBerths = sel?.berths ?? [];
  }

  /*
   * Returns the index of the Gantt window whose time range contains today, falling
   * back to the first or last window when today is outside the dataset range.
   * @returns Zero-based index into ganttWindows
   */
  private _todayWindowIndex(): number {
    if (!this.ganttWindows.length) return 0;
    const nowMs = Date.now();
    const idx = this.ganttWindows.findIndex(
      w => nowMs >= w.startMs && nowMs < w.endMs
    );
    if (idx !== -1) return idx;
    if (nowMs >= this.ganttWindows[this.ganttWindows.length - 1].endMs) {
      return this.ganttWindows.length - 1;
    }
    return 0;
  }

  /*
   * Divides a list of vessel start timestamps into consecutive WINDOW_DAYS-wide
   * windows, each with display labels for navigation and the time axis.
   * @param startTimes - Array of Unix timestamps representing vessel start times (required)
   * @returns Array of window descriptors ordered chronologically
   */
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

      const labels: string[] = [];
      for (let d = 0; d < WINDOW_DAYS; d++) {
        const day = new Date(winStartMs + d * DAY_MS);
        labels.push(day.toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }));
      }

      const fmt = (ms: number) =>
        new Date(ms).toLocaleString('es-ES', { day: 'numeric', month: 'short' });
      const label = `${fmt(winStartMs)} – ${fmt(winEndMs - DAY_MS)}`;

      windows.push({ startMs: winStartMs, endMs: winEndMs, durationMs, label, labels });
      cursor += WINDOW_DAYS * DAY_MS;
    }

    return windows;
  }

  /*
   * Computes the three KPI cards shown in the historical (pre-optimizer) view.
   * @param calls - Array of berth call records (required)
   * @param result - Full transformation API response for skipped-row count (required)
   * @returns Array of three Kpi objects
   */
  private historicalKpis(calls: BerthCall[], result: TransformApiResponse): Kpi[] {
    const uniqueBerths = new Set(calls.map(c => c.berth_id)).size;
    const skipped = result.transformation_summary.skipped_rows;
    return [
      { label: 'opt.hist.vessels', value: String(calls.length), sub: 'opt.hist.vessels_sub', icon: 'directions_boat', positive: true },
      { label: 'opt.hist.berths',  value: String(uniqueBerths), sub: 'opt.hist.berths_sub',  icon: 'dock',            positive: true },
      { label: 'opt.hist.skipped', value: String(skipped), sub: skipped === 0 ? 'opt.hist.skipped_ok' : 'opt.hist.skipped_warn', icon: 'warning', positive: skipped === 0 },
    ];
  }

  /*
   * Populates selectedVessel with historical BerthCall data and opens the detail panel.
   * @param vessel - The Gantt vessel entry that was clicked (required)
   */
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

  /*
   * Populates selectedVessel with optimizer assignment data, computes live status
   * and delay information, and opens the detail panel.
   * @param vessel - The Gantt vessel entry that was clicked (required)
   */
  openOptimizerDetail(vessel: GanttVessel): void {
    const a = vessel.assignment!;
    const override    = this.vesselStatusOverrides.get(a.vessel_id);
    const now         = Date.now();
    const fondeoMs    = this.fondeoStartMs(a);
    const endMs       = new Date(a.scheduled_end).getTime();
    const started     = fondeoMs <= now;
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

    const call = this.transformResult?.data.find(c => c.call_id === a.vessel_id);

    const canAddDelay = !departed && override !== 'vessel.status.completed';
    const rawDelay = a.delay_h ?? this.runner.getVesselDelay(a.vessel_id);
    const accumulatedDelay = rawDelay > 0 ? rawDelay : undefined;

    const fondeoPhase = a.phases?.find(p => p.name === 'fondeo');
    const plannedEtaMs = fondeoPhase
      ? new Date(fondeoPhase.start).getTime()
      : fondeoMs;

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
      eta: new Date(fondeoMs).toLocaleString('es-ES'),
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
      pilotWaitH:        (a.pilot_wait_h ?? 0) > 0.01 ? a.pilot_wait_h : undefined,
      tugWaitH:          (a.tug_wait_h   ?? 0) > 0.01 ? a.tug_wait_h   : undefined,
      optimizerStatus:   a.status,
      phases:            a.phases?.length ? a.phases : undefined,
      canAddDelay,
      delayHours:        accumulatedDelay,
      scheduledStartMs:  new Date(a.scheduled_start).getTime(),
      etaMs:             plannedEtaMs,
    };
    this.isPanelOpen = true;
  }

  /*
   * Unsubscribes from all active RxJS subscriptions to prevent memory leaks.
   */
  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}

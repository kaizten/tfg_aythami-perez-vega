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
  /** True when the vessel's ETA is within [−1 h, +3 h] of now (approaching or recently arrived). */
  showArrivalWarning?: boolean;
  /** True when the bar starts before this window (continues from the previous window). */
  carryOver?: boolean;
  /** Total delay applied to this vessel (hours). Drives the red delay segment. */
  delayH?: number;
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
  /** Unix timestamp for the start of this window — used to find the today window. */
  startMs: number;
  /** Unix timestamp for the end of this window. */
  endMs: number;
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
  delay:                 'bg-red-500',
  fondeo:                'bg-amber-400',
  fondeo_resource_wait:  'bg-orange-400',   // fondeo time caused by pilot/tug unavailability
  atraque:               'bg-sky-500',
  ejecucion:             'bg-emerald-500',
  desatraque:            'bg-violet-500',
  waiting_undock:        'bg-violet-300',
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

  // isRunning, optimizerError, isReplanning and replanError are surfaced as
  // getters from the runner service so state survives component navigation.
  get isRunning(): boolean              { return this.runner.isRunning; }
  get optimizerError(): string | null   { return this.runner.error; }
  get isReplanning(): boolean           { return this.runner.isReplanning; }
  get replanError(): string | null      { return this.runner.replanError; }
  get isEarlyCompleting(): boolean                  { return this.runner.isEarlyCompleting;  }
  get earlyCompleteError(): string | null           { return this.runner.earlyCompleteError; }
  get earlyCompleteInfo(): EarlyCompleteInfo | null { return this.runner.earlyCompleteInfo;  }

  kpis: Kpi[] = [];
  ganttBerths: GanttBerth[] = [];
  ganttHours: string[] = [];
  optimizerResult: OptimizationApiResult | null = null;
  unresolvedVessels: { id: string; eta: string }[] = [];
  showUnresolvedList = false;
  /** When false, the Gantt rows are clipped to a fixed-height scroll area. */
  ganttExpanded = false;

  /** Optimization-quality metrics — computed whenever a new result is loaded. */
  qualityStats: {
    csvAvgDuration:    number;   // avg port-call duration from the CSV baseline
    optAvgDuration:    number;   // avg total port-call duration from the optimizer
    avgStayImprovePct: number;   // (csvAvg − optAvg) / csvAvg × 100
    zeroWaitPct:       number;   // % assigned vessels with waiting_time_h ≈ 0
    maxWaitH:          number;   // worst-case waiting time (h)
  } | null = null;

  // ── Window navigation ─────────────────────────────────────────────────────

  /** Window labels shown in the navigation bar (e.g. "1 ene – 5 ene"). */
  availableDates: string[] = [];
  selectedDateIndex = 0;
  private ganttWindows: WindowGantt[] = [];

  private transformResult: TransformApiResponse | null = null;
  private subs: Subscription[] = [];
  private vesselStatusOverrides = new Map<string, string>();

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
    if (this.selectedDateIndex > 0) {
      this.selectedDateIndex--;
      this.resultStore.ganttWindowIndex = this.selectedDateIndex;
    }
  }

  nextDay(): void {
    if (this.selectedDateIndex < this.availableDates.length - 1) {
      this.selectedDateIndex++;
      this.resultStore.ganttWindowIndex = this.selectedDateIndex;
    }
  }

  toggleGanttExpanded(): void {
    this.ganttExpanded = !this.ganttExpanded;
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
    this.runner.resetDelays();
    this.vesselStatusOverrides.clear();
  }

  applyDelay(delayHours: number): void {
    const vessel = this.selectedVessel;
    if (!vessel) return;
    // Close the panel while the replan HTTP call is in flight
    this.isPanelOpen = false;
    // Determine delay type by comparing now against the scheduled berth start:
    //   now < scheduled_start + 3 h → vessel is still in fondeo (or approaching)
    //                                  → arrival delay (may be absorbed by fondeo slack)
    //   now >= scheduled_start + 3 h → vessel is well into its berth operation
    //                                  → operation delay (extends ejecucion)
    const ARRIVAL_THRESHOLD_MS = 3 * 3_600_000;
    const now             = Date.now();
    const schedStartMs    = vessel.scheduledStartMs ?? now;
    const delayType: 'arrival' | 'operation' =
      now < schedStartMs + ARRIVAL_THRESHOLD_MS ? 'arrival' : 'operation';
    this.runner.applyDelay(vessel.name, delayHours, delayType);
  }

  confirmOperation(): void {
    const vessel = this.selectedVessel;
    if (!vessel) return;

    const current = vessel.status;

    if (current === 'vessel.status.on_the_way') {
      // Vessel has arrived — mark in_progress locally, then check for early arrival.
      this.vesselStatusOverrides.set(vessel.name, 'vessel.status.in_progress');

      // If the vessel arrived before its planned ETA, trigger an early-arrival replan.
      // Any remaining wait before the berth is free is shown as extended fondeo (anchorage).
      const now    = Date.now();
      const etaMs  = vessel.etaMs ?? now;
      const earlyH = (etaMs - now) / 3_600_000;

      if (earlyH > 0.1) {
        this.isPanelOpen = false;
        // Round to one decimal place for a cleaner value
        this.runner.applyEarlyArrival(vessel.name, Math.round(earlyH * 10) / 10);
      } else {
        this.selectedVessel = { ...vessel, status: 'vessel.status.in_progress', statusColor: 'bg-amber-500' };
      }

    } else if (current === 'vessel.status.in_progress') {
      // Cargo operation finished early — trigger early-completion replan
      this.isPanelOpen = false;
      // Mark as completed locally so the panel no longer shows the confirm button
      this.vesselStatusOverrides.set(vessel.name, 'vessel.status.completed');
      // Use LOCAL time (no Z suffix) so the backend compares against the same
      // implicit timezone as the stored assignment datetimes (which are naive
      // local time from the input data, not UTC).
      this.runner.earlyComplete(vessel.name, this.localNow());
    }
  }

  /**
   * Returns the current local wall-clock time as a naive ISO-8601 string
   * (format: `YYYY-MM-DDTHH:MM:SS`) — **no** trailing `Z` and no UTC offset.
   *
   * All datetimes stored by the backend are naive local-time strings, so this
   * matches the implicit timezone of the scheduler data regardless of the
   * server's own clock zone.
   */
  private localNow(): string {
    const d   = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
           `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
      { label: 'opt.kpi.total_wait',  value: this.formatHours(totalFondeo), sub: 'opt.kpi.total_wait_sub',  icon: 'anchor',  positive: totalFondeo < 1 },
      { label: 'opt.kpi.avg_wait',    value: this.formatHours(avgFondeo),   sub: 'opt.kpi.avg_wait_sub',    icon: 'anchor',  positive: avgFondeo < 1 },
      { label: 'opt.kpi.unresolved',  value: String(kpis.unresolved_vessels), sub: 'opt.kpi.unresolved_sub', icon: 'warning', positive: kpis.unresolved_vessels === 0 },
    ];

    // ── Quality stats ────────────────────────────────────────────────────────
    // CSV baseline: avg of raw duration_hours from the transformation result.
    const csvCalls = this.transformResult?.data ?? [];
    const csvAvgDuration = csvCalls.length
      ? csvCalls.reduce((s, c) => s + c.duration_hours, 0) / csvCalls.length
      : 0;
    // Optimizer avg: sum of all phase durations per vessel (fondeo + atraque + ejecucion + desatraque).
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

    // Build unresolved vessel list for detail panel
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

      this.ganttWindows.push({ berths, hours: win.labels, windowLabel: win.label, startMs: win.startMs, endMs: win.endMs });
      this.availableDates.push(win.label);
    }

    // Restore previously-selected window, or fall back to the window containing today.
    const stored = this.resultStore.ganttWindowIndex;
    this.selectedDateIndex = (stored >= 0 && stored < this.ganttWindows.length)
      ? stored
      : this._todayWindowIndex();
    // Persist so that a re-build (e.g. re-entry after navigation) keeps the same window.
    this.resultStore.ganttWindowIndex = this.selectedDateIndex;

    const sel = this.ganttWindows[this.selectedDateIndex];
    this.ganttHours  = sel?.hours ?? [];
    this.ganttBerths = sel?.berths ?? [];
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

  /**
   * Returns the bar-start timestamp for an assignment.
   *
   * Always equals `phases[0].start` when phases are present:
   *   - no delay        → phases[0] = fondeo  → vessel's original ETA
   *   - arrival delay   → phases[0] = delay   → original ETA (before delay)
   *   - operation delay → phases[0] = fondeo  → vessel's ETA (unchanged)
   *
   * Falls back to scheduled_start − waiting_time_h when phases are absent.
   */
  private fondeoStartMs(a: OptimizationAssignment): number {
    if (a.phases?.length) return new Date(a.phases[0].start).getTime();
    return new Date(a.scheduled_start).getTime() - a.waiting_time_h * 3_600_000;
  }

  private buildOptimizerGantt(assignments: OptimizationAssignment[]): void {
    const visible = assignments.filter(a => a.status !== 'invalid_berth');
    if (!visible.length) return;

    // Windows are anchored to vessel arrival.
    // fondeoStartMs(a) returns phases[0].start which is already the original
    // ETA for delayed vessels (the 'delay' phase is prepended by the backend).
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
        const s = this.fondeoStartMs(a);  // phases[0].start = original ETA
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
          startMs: this.fondeoStartMs(a),              // phases[0].start = original ETA
          endMs:   new Date(a.scheduled_end).getTime(),
        }));
        const lanes = assignLanes(timings);

        const vessels: GanttVessel[] = sorted.map((a, i) => {
          const delayH = a.delay_h ?? 0;

          const s = timings[i].startMs;   // bar start = phases[0].start = original ETA
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
          // Suppressed when the vessel has been explicitly marked as completed
          // (via confirmOperation / early-complete) — no uncertainty in that case.
          const schedEndMs  = new Date(a.scheduled_end).getTime();
          const isCompleted = this.vesselStatusOverrides.get(a.vessel_id) === 'vessel.status.completed';
          const showWarning = !isCompleted && schedEndMs <= nowMs && nowMs < schedEndMs + 5 * 3_600_000;
          // Arrival warning: vessel approaching or arrived within last 3 h.
          const etaMs = timings[i].startMs;  // phases[0].start = original ETA
          const showArrivalWarning =
            !isCompleted &&
            nowMs >= etaMs - 1 * 3_600_000 &&
            nowMs <  etaMs + 3 * 3_600_000;

          // ── Phase segments ──────────────────────────────────────────────────
          // The backend already inserts a 'delay' phase at the correct position:
          //   arrival delay  → phases[0] = delay, phases[1] = fondeo, …
          //   operation delay→ fondeo, atraque, ejecucion, delay, desatraque
          // We just iterate a.phases in order and clip each to [visStart, visEnd].
          let phaseSegments: PhaseSegment[] | undefined;
          if (a.status === 'assigned' && a.phases?.length && barVisualMs > 0) {
            const resourceWaitH = Math.max(a.pilot_wait_h ?? 0, a.tug_wait_h ?? 0);
            const segs: PhaseSegment[] = [];
            for (const p of a.phases) {
              if (p.duration_h <= 0) continue;
              const phaseStartMs = new Date(p.start).getTime();
              const phaseEndMs   = new Date(p.end).getTime();

              if (p.name === 'fondeo' && resourceWaitH > 0.01) {
                // Split fondeo into berth-wait (amber) + resource-wait (orange at the end).
                // The resource wait occupies the last `resourceWaitH` hours of fondeo.
                const resStartMs = phaseEndMs - resourceWaitH * 3_600_000;

                // Berth-wait portion
                const bVS = Math.max(phaseStartMs, visStart);
                const bVE = Math.min(resStartMs,   visEnd);
                if (bVE > bVS) {
                  segs.push({
                    widthPct:   `${((bVE - bVS) / barVisualMs * 100).toFixed(2)}%`,
                    colorClass: 'bg-amber-400',
                    name:       'fondeo',
                  });
                }

                // Resource-wait portion
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

          // ── Fondeo badge: only when fondeo phase is visible here ────────────
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

    // Restore previously-selected window, or fall back to the window containing today.
    const stored = this.resultStore.ganttWindowIndex;
    this.selectedDateIndex = (stored >= 0 && stored < this.ganttWindows.length)
      ? stored
      : this._todayWindowIndex();
    this.resultStore.ganttWindowIndex = this.selectedDateIndex;

    const sel = this.ganttWindows[this.selectedDateIndex];
    this.ganttHours  = sel?.hours ?? [];
    this.ganttBerths = sel?.berths ?? [];
  }

  // ── Window helpers ────────────────────────────────────────────────────────

  /**
   * Returns the index in `ganttWindows` whose time range contains today.
   *
   * Fallback rules:
   *  - Today is before the first window → index 0 (show earliest data).
   *  - Today is after the last window   → last index (show most recent data).
   *  - No windows at all                → 0.
   */
  private _todayWindowIndex(): number {
    if (!this.ganttWindows.length) return 0;
    const nowMs = Date.now();
    const idx = this.ganttWindows.findIndex(
      w => nowMs >= w.startMs && nowMs < w.endMs
    );
    if (idx !== -1) return idx;
    // Today is past every window → show the last one.
    if (nowMs >= this.ganttWindows[this.ganttWindows.length - 1].endMs) {
      return this.ganttWindows.length - 1;
    }
    // Today is before every window → show the first one.
    return 0;
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
    const skipped = result.transformation_summary.skipped_rows;
    return [
      { label: 'opt.hist.vessels', value: String(calls.length), sub: 'opt.hist.vessels_sub', icon: 'directions_boat', positive: true },
      { label: 'opt.hist.berths',  value: String(uniqueBerths), sub: 'opt.hist.berths_sub',  icon: 'dock',            positive: true },
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
    // After a replan, delay is baked into the assignment's phases.
    // fondeoMs = vessel arrival at port (start of anchorage waiting, post-delay)
    const fondeoMs    = this.fondeoStartMs(a);
    const endMs       = new Date(a.scheduled_end).getTime();
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

    // canAddDelay: vessel hasn't been marked completed (time-based OR explicit
    // operator confirmation via confirmOperation / early-complete).
    const canAddDelay = !departed && override !== 'vessel.status.completed';
    const rawDelay = a.delay_h ?? this.runner.getVesselDelay(a.vessel_id);
    const accumulatedDelay = rawDelay > 0 ? rawDelay : undefined;

    // etaMs: the planned fondeo (ETA) start — used by confirmOperation() to detect early arrival.
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

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}

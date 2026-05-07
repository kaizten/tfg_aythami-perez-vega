import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import {
  BerthCall,
  OptimizationApiRequest,
  OptimizationApiResult,
  OptimizationAssignment,
  TransformApiResponse,
} from '../../core/models/api.models';
import { LanguageService } from '../../core/services/language.service';
import { OptimizationParamsStoreService } from '../../core/services/optimization-params-store.service';
import { OptimizationResultStoreService } from '../../core/services/optimization-result-store.service';
import { PortOptimApiService } from '../../core/services/portoptim-api.service';
import { TransformationStoreService } from '../../core/services/transformation-store.service';
import { VesselDetail } from './components/vessel-detail-panel/vessel-detail-panel.component';

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface Kpi { label: string; value: string; sub: string; icon: string; positive: boolean; }

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
  isRunning = false;
  optimizerError: string | null = null;
  isPanelOpen = false;
  selectedVessel: VesselDetail | null = null;

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

  constructor(
    private transformStore: TransformationStoreService,
    private paramsStore: OptimizationParamsStoreService,
    private resultStore: OptimizationResultStoreService,
    private api: PortOptimApiService,
    private lang: LanguageService,
  ) {}

  ngOnInit(): void {
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

    this.isRunning = true;
    this.optimizerError = null;
    this.resultStore.clear();

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

    const sub = this.api.runOptimization(request).subscribe({
      next: res => {
        this.resultStore.set(res);
        this.isRunning = false;
      },
      error: (err: Error) => {
        this.optimizerError = err.message;
        this.isRunning = false;
      },
    });
    this.subs.push(sub);
  }

  resetOptimizer(): void {
    this.resultStore.clear();
    this.optimizerError = null;
  }

  // ── View builders ─────────────────────────────────────────────────────────

  private buildHistoricalView(result: TransformApiResponse): void {
    this.kpis = this.historicalKpis(result.data, result);
    this.ganttWindows = [];
    this.availableDates = [];
    this.selectedDateIndex = 0;
    this.buildHistoricalGantt(result.data);
  }

  private buildOptimizerView(result: OptimizationApiResult): void {
    const kpis = result.kpis;
    this.kpis = [
      { label: 'opt.kpi.total_wait',   value: `${kpis.total_waiting_time_h.toFixed(1)} h`, sub: 'opt.kpi.total_wait_sub',   icon: 'hourglass_empty', positive: kpis.total_waiting_time_h < 1 },
      { label: 'opt.kpi.avg_wait',     value: `${kpis.avg_waiting_time_h.toFixed(1)} h`,   sub: 'opt.kpi.avg_wait_sub',     icon: 'avg_pace',        positive: kpis.avg_waiting_time_h < 1 },
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

  private buildOptimizerGantt(assignments: OptimizationAssignment[]): void {
    const visible = assignments.filter(a => a.status !== 'invalid_berth');
    if (!visible.length) return;

    const startTimes = visible.map(a => new Date(a.scheduled_start).getTime());
    const windows = this.computeWindows(startTimes);

    let colorIdx = 0;
    for (const win of windows) {
      const winAssigns = visible.filter(a => {
        const t = new Date(a.scheduled_start).getTime();
        return t >= win.startMs && t < win.endMs;
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
          new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime()
        );
        const timings = sorted.map(a => ({
          startMs: new Date(a.scheduled_start).getTime(),
          endMs:   new Date(a.scheduled_end).getTime(),
        }));
        const lanes = assignLanes(timings);

        const vessels: GanttVessel[] = sorted.map((a, i) => {
          const s = timings[i].startMs;
          const e = timings[i].endMs;
          const clipped = e > win.endMs;
          const left  = (s - win.startMs) / win.durationMs * 100;
          const rawW  = (Math.min(e, win.endMs) - s) / win.durationMs * 100;
          return {
            name: a.vessel_id,
            left: left.toFixed(2) + '%',
            width: Math.max(rawW, 0.8).toFixed(2) + '%',
            top: `${lanes[i] * LANE_PX}px`,
            colorClass: a.status === 'assigned'
              ? VESSEL_COLORS[colorIdx++ % VESSEL_COLORS.length]
              : 'bg-red-400/70',
            clipped,
            assignment: a,
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
    const started = new Date(a.scheduled_start) <= new Date();
    const statusColor = started ? 'bg-amber-500' : 'bg-blue-400';
    this.selectedVessel = {
      name: a.vessel_id,
      imo: `Berth: ${a.berth_id}`,
      status: started ? 'vessel.status.in_progress' : 'vessel.status.on_the_way',
      statusColor,
      priority: 'GT Priority',
      type: a.duration_source,
      loa: a.noray_start != null ? `Norays ${a.noray_start}–${a.noray_end}` : '—',
      gt: '—',
      operation: a.duration_source,
      berth: a.berth_id,
      eta: new Date(a.scheduled_start).toLocaleString('es-ES'),
      etd: new Date(a.scheduled_end).toLocaleString('es-ES'),
      cargo: [],
      waitingTime: `${a.waiting_time_h.toFixed(2)} h`,
      durationEstimated: `${a.duration_estimated_h.toFixed(1)} h`,
      durationSource: SOURCE_LABELS[a.duration_source] ?? a.duration_source,
      pilotAssigned: a.pilot_assigned,
      tugsRequired: a.tugs_required,
      tugsAssigned: a.tugs_assigned,
      optimizerStatus: a.status,
    };
    this.isPanelOpen = true;
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}

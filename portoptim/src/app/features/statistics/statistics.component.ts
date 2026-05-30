import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { BerthCall, OptimizationApiResult, OptimizationAssignment, TransformApiResponse } from '../../core/models/api.models';
import { LanguageService } from '../../core/services/language.service';
import { OptimizationResultStoreService } from '../../core/services/optimization-result-store.service';
import { TransformationStoreService } from '../../core/services/transformation-store.service';

// ── Interfaces ──────────────────────────────────────────────────────────────

interface BerthOccupancy {
  berth: string;
  hours: number;
  pct: number;
  barPct: number;
  vesselCount: number;
}

interface OpBreakdown {
  type: string;
  count: number;
  pct: number;
}

interface CargoBreakdown {
  group: string;
  count: number;
  pct: number;
}

interface ArrivalHour {
  hour: number;
  arrivalCount:   number;
  departureCount: number;
  arrivalPct:     number;
  departurePct:   number;
}

interface MonthStat {
  key: string;
  year: number;
  month: number;
  vesselCount: number;
  avgDuration: number;
  totalQuantity: number;
  quantityRecords: number;
  berthOccupancy: BerthOccupancy[];
  opBreakdown: OpBreakdown[];
  cargoBreakdown: CargoBreakdown[];
}

interface KpiCard {
  label: string;
  value: string;
  sub: string;
  icon: string;
}

// ── Optimizer-specific stat interfaces ──────────────────────────────────────

/** Optimizer monthly stat — mirrors MonthStat for the CSV view. */
interface OptiMonthStat {
  key: string;
  year: number;
  month: number;
  vesselCount: number;
  avgDuration: number;
  totalQuantity: number;
  quantityRecords: number;
  berthOccupancy: BerthOccupancy[];
  opBreakdown: OpBreakdown[];
  cargoBreakdown: CargoBreakdown[];
  // FTE estimate: total work-hours / available hours per pilot (8 h/day, 40 h/week, ceil per manoeuvre)
  pilotsNeededFte: number;
  tugsNeededFte: number;
  // Resource wait totals
  pilotWaitH: number;
  tugWaitH: number;
  waitUndockH: number;
  // Constrained peak (≤ configured fleet)
  peakPilots: number;
  peakTugs: number;
  // Peak + simultaneous waiters (minimum for coverage)
  trueMinPilots: number;
  trueMinTugs: number;
  // Final minimum = max(trueMin, FTE) — shown in the bars
  finalMinPilots: number;
  finalMinTugs: number;
}

interface PhaseStat {
  name: string;
  totalH: number;
  avgH: number;
  barPct: number;
  colorClass: string;
}

/** One bucket in the waiting-time vertical bar chart. */
interface WaitBucket {
  labelKey: string;   // translation key for label
  shortLabel: string; // short label shown under the bar
  count: number;
  barPct: number;
}

/** Anchorage (fondeo) hours aggregated per berth. */
interface BerthAnchorageStat {
  berth: string;
  totalFondeoH: number;
  avgFondeoH: number;
  vesselCount: number;   // vessels that had fondeo > 0
  barPct: number;
}

interface DurSourceStat {
  labelKey: string;
  count: number;
  pct: number;
}

/**
 * Counts of vessels affected by each kind of schedule-change event.
 * A single vessel can appear in more than one category.
 */
interface ReplanChangeStat {
  /** Vessels with a berth-operation delay (delay phase inserted after ejecucion). */
  operationDelay: number;
  /** Vessels where the user confirmed early cargo completion (early_complete === true). */
  earlyComplete: number;
  /** Vessels with a scheduling-induced undock resource wait (waiting_undock, NOT user early-complete). */
  undockWait: number;
  /** Vessels with an arrival delay (delay phase prepended before fondeo). */
  arrivalDelay: number;
  /** Vessels that arrived earlier than their scheduled ETA (early_arrival_h set). */
  earlyArrival: number;
  /** Total assigned vessels — used as denominator for percentages. */
  totalAssigned: number;
}

/** Per-hour counts for the docking/undocking phase-start distribution chart. */
interface PhaseHourStat {
  hour: number;
  atraqueCount: number;
  desatraqueCount: number;
  atraquePct: number;    // height % relative to max across both series
  desatraquePct: number;
}

/** Yearly peak resource requirement — aggregated from monthly stats. */
interface OptiYearResource {
  year: number;
  totalWaitUndockH: number;
  finalMinPilots: number;    // max over months of max(trueMinPilots, pilotsNeededFte)
  finalMinTugs: number;
  totalPilotWaitH: number;
  totalTugWaitH: number;
}


// ── Constants ───────────────────────────────────────────────────────────────

const DUR_WINDOW = 6;

const OP_TYPE_KEY: Record<string, string> = {
  'Desembarque': 'op.type.desembarque',
  'Embarque':    'op.type.embarque',
  'Trasbordo':   'op.type.trasbordo',
  'Residuos':    'op.type.residuos',
};

const CARGO_GROUP_KEY: Record<string, string> = {
  'Abonos':                      'cargo.group.abonos',
  'Agro-Ganadero y Alimentario': 'cargo.group.agro_ganadero',
  'Energético':                  'cargo.group.energetico',
  'Materiales de construcción':  'cargo.group.materiales_construccion',
  'Minerales no metálicos':      'cargo.group.minerales_no_metalicos',
  'Otras mercancías':            'cargo.group.otras_mercancias',
  'Químicos':                    'cargo.group.quimicos',
  'REVISAR':                     'cargo.group.revisar',
  'SIN CLASIFICAR':              'cargo.group.sin_clasificar',
  'Siderometalúrgico':           'cargo.group.siderometalurgico',
  'Vehículos y transporte':      'cargo.group.vehiculos_transporte',
};

const LANG_LOCALE: Record<string, string> = {
  en: 'en-GB',
  es: 'es-ES',
  de: 'de-DE',
  fr: 'fr-FR',
};

// ── Component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-statistics',
  standalone: false,
  templateUrl: './statistics.component.html',
  styleUrl: './statistics.component.scss',
})
export class StatisticsComponent implements OnInit, OnDestroy {
  // ── CSV state ──────────────────────────────────────────────────────────────
  hasData = false;
  kpis: KpiCard[] = [];
  months: MonthStat[] = [];
  arrivalHours: ArrivalHour[] = [];

  readonly DUR_WINDOW = DUR_WINDOW;
  durWindowStart = 0;
  selectedMonthIndex = 0;

  // ── Data-source toggle ─────────────────────────────────────────────────────
  dataSource: 'csv' | 'optimizer' = 'csv';
  hasOptimizerResult = false;

  // ── Optimizer stats state ──────────────────────────────────────────────────
  // Monthly grouping (mirrors CSV structure)
  optiKpis: KpiCard[]             = [];
  optiMonths: OptiMonthStat[]     = [];
  optiMonthWindowStart            = 0;
  optiSelectedMonthIndex          = 0;
  optiScheduledHours: PhaseHourStat[] = [];
  // Optimizer-specific extras
  optiPhases: PhaseStat[]          = [];
  optiWaitBuckets: WaitBucket[]    = [];
  optiBerthAnchorage: BerthAnchorageStat[] = [];
  optiDurSources: DurSourceStat[]  = [];
  optiReplanChanges: ReplanChangeStat | null = null;
  optiAvgWaitH = 0;
  // Resource allocation 6-month window (independent from dur+cargo window)
  optiResourceWindowStart = 0;
  optiYearResources: OptiYearResource[] = [];

  private cachedResult: TransformApiResponse | null = null;
  private cachedOptiResult: OptimizationApiResult | null = null;
  private subs: Subscription[] = [];

  constructor(
    private transformStore: TransformationStoreService,
    private optimizerStore: OptimizationResultStoreService,
    private lang: LanguageService,
  ) {}

  ngOnInit(): void {
    this.subs.push(
      this.transformStore.result$.subscribe(r => {
        this.cachedResult = r;
        this.hasData = !!r;
        if (r) this.buildStats(r);
        else this.clearStats();
      }),
      this.optimizerStore.result$.subscribe(r => {
        this.cachedOptiResult = r;
        this.hasOptimizerResult = !!r;
        if (r) this.buildOptimizerStats(r);
        else {
          // Optimizer was reset → fall back to CSV view
          this.dataSource = 'csv';
          this.optiKpis = []; this.optiMonths = [];
          this.optiMonthWindowStart = 0; this.optiSelectedMonthIndex = 0;
          this.optiResourceWindowStart = 0;
          this.optiYearResources = [];
          this.optiScheduledHours = [];
          this.optiPhases = []; this.optiWaitBuckets = []; this.optiBerthAnchorage = [];
          this.optiDurSources = [];
          this.optiReplanChanges = null;
          this.optiAvgWaitH = 0;
        }
      }),
      this.lang.lang$.subscribe(() => {
        if (this.cachedResult) this.buildKpis(this.cachedResult);
      }),
    );
  }

  setDataSource(src: 'csv' | 'optimizer'): void {
    this.dataSource = src;
  }

  // ── Optimizer: month window navigation (mirrors CSV dur-window) ─────────

  get optiMonthWindow(): OptiMonthStat[] {
    return this.optiMonths.slice(this.optiMonthWindowStart, this.optiMonthWindowStart + DUR_WINDOW);
  }

  get optiMonthWindowLabel(): string {
    const w = this.optiMonthWindow;
    if (!w.length) return '';
    const first = this.monthLabel(w[0].year, w[0].month);
    return w.length === 1 ? first : `${first} – ${this.monthLabel(w[w.length - 1].year, w[w.length - 1].month)}`;
  }

  get optiMonthWindowEnd(): number {
    return Math.min(this.optiMonthWindowStart + DUR_WINDOW, this.optiMonths.length);
  }

  get maxOptiDurValue(): number {
    return Math.max(...this.optiMonthWindow.map(m => m.avgDuration), 1);
  }

  get maxOptiCargoValue(): number {
    return Math.max(...this.optiMonthWindow.map(m => m.totalQuantity), 1);
  }

  prevOptiMonthWindow(): void {
    this.optiMonthWindowStart = Math.max(0, this.optiMonthWindowStart - DUR_WINDOW);
  }

  nextOptiMonthWindow(): void {
    if (this.optiMonthWindowStart + DUR_WINDOW < this.optiMonths.length)
      this.optiMonthWindowStart = Math.min(this.optiMonths.length - 1, this.optiMonthWindowStart + DUR_WINDOW);
  }

  // ── Optimizer: month navigation for detail panel (mirrors CSV) ───────────

  get optiSelectedMonth(): OptiMonthStat | null {
    return this.optiMonths[this.optiSelectedMonthIndex] ?? null;
  }

  prevOptiMonth(): void {
    if (this.optiSelectedMonthIndex > 0) this.optiSelectedMonthIndex--;
  }

  nextOptiMonth(): void {
    if (this.optiSelectedMonthIndex < this.optiMonths.length - 1) this.optiSelectedMonthIndex++;
  }

  // ── Optimizer: resource-allocation window navigation (independent) ────────

  get optiResourceWindow(): OptiMonthStat[] {
    return this.optiMonths.slice(this.optiResourceWindowStart, this.optiResourceWindowStart + DUR_WINDOW);
  }

  get optiResourceWindowLabel(): string {
    const w = this.optiResourceWindow;
    if (!w.length) return '';
    const first = this.monthLabel(w[0].year, w[0].month);
    return w.length === 1 ? first : `${first} – ${this.monthLabel(w[w.length - 1].year, w[w.length - 1].month)}`;
  }

  get optiResourceWindowEnd(): number {
    return Math.min(this.optiResourceWindowStart + DUR_WINDOW, this.optiMonths.length);
  }

  get maxOptiResourcePilots(): number {
    return Math.max(...this.optiResourceWindow.map(m => m.finalMinPilots), 1);
  }

  get maxOptiResourceTugs(): number {
    return Math.max(...this.optiResourceWindow.map(m => m.finalMinTugs), 1);
  }

  /** Max count across all replan-change categories — used to scale bar widths. */
  get optiReplanMaxCount(): number {
    if (!this.optiReplanChanges) return 1;
    const { operationDelay, earlyComplete, undockWait, arrivalDelay, earlyArrival } = this.optiReplanChanges;
    return Math.max(operationDelay, earlyComplete, undockWait, arrivalDelay, earlyArrival, 1);
  }

  /** Percentage of assigned vessels for a given replan-change count. */
  replanPct(count: number): number {
    if (!this.optiReplanChanges || this.optiReplanChanges.totalAssigned === 0) return 0;
    return count / this.optiReplanChanges.totalAssigned * 100;
  }

  get optiTotalAtraque(): number {
    return this.optiScheduledHours.reduce((s, h) => s + h.atraqueCount, 0);
  }

  get optiTotalDesatraque(): number {
    return this.optiScheduledHours.reduce((s, h) => s + h.desatraqueCount, 0);
  }

  /** Hour-of-day with the most docking (atraque) starts. */
  get optiPeakAtraqueHour(): number {
    if (!this.optiScheduledHours.length) return 0;
    return this.optiScheduledHours.reduce((best, h) =>
      h.atraqueCount > best.atraqueCount ? h : best
    ).hour;
  }

  /** Hour-of-day with the most undocking (desatraque) starts. */
  get optiPeakDesatraqueHour(): number {
    if (!this.optiScheduledHours.length) return 0;
    return this.optiScheduledHours.reduce((best, h) =>
      h.desatraqueCount > best.desatraqueCount ? h : best
    ).hour;
  }

  prevOptiResourceWindow(): void {
    this.optiResourceWindowStart = Math.max(0, this.optiResourceWindowStart - DUR_WINDOW);
  }

  nextOptiResourceWindow(): void {
    if (this.optiResourceWindowStart + DUR_WINDOW < this.optiMonths.length)
      this.optiResourceWindowStart = Math.min(this.optiMonths.length - 1, this.optiResourceWindowStart + DUR_WINDOW);
  }

  // ── Duration + Cargo window navigation ───────────────────────────────────

  get durWindowMonths(): MonthStat[] {
    return this.months.slice(this.durWindowStart, this.durWindowStart + DUR_WINDOW);
  }

  get durWindowLabel(): string {
    const w = this.durWindowMonths;
    if (!w.length) return '';
    const first = this.monthLabel(w[0].year, w[0].month);
    return w.length === 1 ? first : `${first} – ${this.monthLabel(w[w.length - 1].year, w[w.length - 1].month)}`;
  }

  get durWindowEnd(): number {
    return Math.min(this.durWindowStart + DUR_WINDOW, this.months.length);
  }

  get maxDurValue(): number {
    return Math.max(...this.durWindowMonths.map(m => m.avgDuration), 1);
  }

  get maxCargoValue(): number {
    return Math.max(...this.durWindowMonths.map(m => m.totalQuantity), 1);
  }

  prevDurWindow(): void {
    if (this.durWindowStart > 0) {
      this.durWindowStart = Math.max(0, this.durWindowStart - DUR_WINDOW);
    }
  }

  nextDurWindow(): void {
    if (this.durWindowStart + DUR_WINDOW < this.months.length) {
      this.durWindowStart = Math.min(this.months.length - 1, this.durWindowStart + DUR_WINDOW);
    }
  }

  // ── Month navigation (detail panel) ──────────────────────────────────────

  get selectedMonth(): MonthStat | null {
    return this.months[this.selectedMonthIndex] ?? null;
  }

  prevMonth(): void {
    if (this.selectedMonthIndex > 0) this.selectedMonthIndex--;
  }

  nextMonth(): void {
    if (this.selectedMonthIndex < this.months.length - 1) this.selectedMonthIndex++;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  monthLabel(year: number, month: number): string {
    const locale = LANG_LOCALE[this.lang.current] ?? 'es-ES';
    return new Date(year, month - 1, 1).toLocaleDateString(locale, {
      month: 'short',
      year: 'numeric',
    });
  }

  formatQuantity(q: number): string {
    if (q >= 1_000_000) return `${(q / 1_000_000).toFixed(1)}M`;
    if (q >= 1_000)     return `${(q / 1_000).toFixed(0)}k`;
    return q.toFixed(0);
  }

  /** Convert decimal hours to "hh:mm" string, e.g. 24.5 → "24:30". */
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

  padHour(h: number): string {
    return h.toString().padStart(2, '0');
  }

  // ── Stats builder ─────────────────────────────────────────────────────────

  private buildKpis(result: TransformApiResponse): void {
    const calls = result.data;
    const uniqueBerths = new Set(calls.map(c => c.berth_id)).size;
    const avgDuration = calls.reduce((s, c) => s + c.duration_hours, 0) / calls.length;
    const timestamps = calls.map(c => new Date(c.arrival_time).getTime());
    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    const locale = LANG_LOCALE[this.lang.current] ?? 'es-ES';
    const fmt = (d: Date) => d.toLocaleDateString(locale, { month: 'short', year: 'numeric' });

    this.kpis = [
      { label: 'stats.kpi.total_vessels', value: String(calls.length),               sub: 'stats.kpi.vessels_sub',    icon: 'directions_boat' },
      { label: 'stats.kpi.total_berths',  value: String(uniqueBerths),                sub: 'stats.kpi.berths_sub',     icon: 'dock' },
      { label: 'stats.kpi.avg_duration',  value: this.formatHours(avgDuration),       sub: 'stats.kpi.duration_sub',   icon: 'timer' },
      { label: 'stats.kpi.date_range',    value: `${fmt(minDate)} – ${fmt(maxDate)}`, sub: 'stats.kpi.date_range_sub', icon: 'calendar_month' },
    ];
  }

  private buildStats(result: TransformApiResponse): void {
    const calls = result.data;
    if (!calls.length) { this.clearStats(); return; }

    this.buildKpis(result);
    this.months = this.computeMonths(calls);
    this.arrivalHours = this.computeArrivalHours(calls);

    this.durWindowStart    = 0;
    this.selectedMonthIndex = 0;
  }

  private computeMonths(calls: BerthCall[]): MonthStat[] {
    const monthMap = new Map<string, BerthCall[]>();
    for (const call of calls) {
      const d = new Date(call.arrival_time);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthMap.has(key)) monthMap.set(key, []);
      monthMap.get(key)!.push(call);
    }

    return Array.from(monthMap.keys())
      .sort()
      .map(key => {
        const [yearStr, monthStr] = key.split('-');
        const year  = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10);
        const mCalls = monthMap.get(key)!;

        const avgDuration    = mCalls.reduce((s, c) => s + c.duration_hours, 0) / mCalls.length;
        const totalQuantity  = mCalls.reduce((s, c) => s + (c.quantity ?? 0), 0);
        const quantityRecords = mCalls.filter(c => c.quantity !== null).length;

        return {
          key, year, month,
          vesselCount: mCalls.length,
          avgDuration,
          totalQuantity,
          quantityRecords,
          berthOccupancy: this.computeBerthOccupancy(mCalls, year, month),
          opBreakdown:    this.computeOpBreakdown(mCalls),
          cargoBreakdown: this.computeCargoBreakdown(mCalls),
        };
      });
  }

  private computeBerthOccupancy(calls: BerthCall[], year: number, month: number): BerthOccupancy[] {
    const monthStartMs = new Date(year, month - 1, 1).getTime();
    const monthEndMs   = new Date(year, month,     1).getTime();
    const hoursInMonth = (monthEndMs - monthStartMs) / 3600000;

    const berthHoursMap = new Map<string, number>();
    const berthCountMap = new Map<string, number>();
    for (const call of calls) {
      const arrMs = new Date(call.arrival_time).getTime();
      const depMs = new Date(call.departure_time).getTime();
      const h = Math.max(0, Math.min(depMs, monthEndMs) - Math.max(arrMs, monthStartMs)) / 3600000;
      berthHoursMap.set(call.berth_id, (berthHoursMap.get(call.berth_id) ?? 0) + h);
      berthCountMap.set(call.berth_id, (berthCountMap.get(call.berth_id) ?? 0) + 1);
    }

    const entries = Array.from(berthHoursMap.entries())
      .map(([berth, hours]) => ({
        berth, hours,
        pct: hours / hoursInMonth * 100,
        barPct: 0,
        vesselCount: berthCountMap.get(berth) ?? 0,
      }))
      .sort((a, b) => b.pct - a.pct);

    const maxPct = Math.max(...entries.map(e => e.pct), 1);
    for (const e of entries) e.barPct = e.pct / maxPct * 100;
    return entries;
  }

  private computeOpBreakdown(calls: BerthCall[]): OpBreakdown[] {
    const opMap = new Map<string, number>();
    for (const call of calls) {
      const parts = (call.operation_type || 'N/A')
        .split(' y ').map(p => p.trim()).filter(p => p.length > 0);
      for (const part of parts) {
        const key = OP_TYPE_KEY[part] ?? part;
        opMap.set(key, (opMap.get(key) ?? 0) + 1);
      }
    }
    const total = Array.from(opMap.values()).reduce((s, n) => s + n, 0);
    return Array.from(opMap.entries())
      .map(([type, count]) => ({ type, count, pct: count / total * 100 }))
      .sort((a, b) => b.count - a.count);
  }

  private computeCargoBreakdown(calls: BerthCall[]): CargoBreakdown[] {
    const groupMap = new Map<string, number>();
    for (const call of calls) {
      const raw = call.cargo_group || 'N/A';
      const key = CARGO_GROUP_KEY[raw] ?? raw;
      groupMap.set(key, (groupMap.get(key) ?? 0) + 1);
    }
    const total = calls.length;
    return Array.from(groupMap.entries())
      .map(([group, count]) => ({ group, count, pct: count / total * 100 }))
      .sort((a, b) => b.count - a.count);
  }

  private computeArrivalHours(calls: BerthCall[]): ArrivalHour[] {
    const arrivals   = new Array(24).fill(0);
    const departures = new Array(24).fill(0);
    for (const call of calls) {
      arrivals[new Date(call.arrival_time).getHours()]++;
      departures[new Date(call.departure_time).getHours()]++;
    }
    const maxVal = Math.max(...arrivals, ...departures, 1);
    return arrivals.map((arrivalCount, hour) => ({
      hour,
      arrivalCount,
      departureCount: departures[hour],
      arrivalPct:     arrivalCount   / maxVal * 100,
      departurePct:   departures[hour] / maxVal * 100,
    }));
  }

  get peakArrivalHour(): number {
    if (!this.arrivalHours.length) return 0;
    return this.arrivalHours.reduce((best, h) =>
      h.arrivalCount > best.arrivalCount ? h : best
    ).hour;
  }

  get peakDepartureHour(): number {
    if (!this.arrivalHours.length) return 0;
    return this.arrivalHours.reduce((best, h) =>
      h.departureCount > best.departureCount ? h : best
    ).hour;
  }

  // ── Optimizer stats builder ───────────────────────────────────────────────

  private buildOptimizerStats(result: OptimizationApiResult): void {
    const { assignments, kpis } = result;
    const assigned     = assignments.filter(a => a.status === 'assigned');
    const uniqueBerths = new Set(assigned.map(a => a.berth_id)).size;
    // Total stay = fondeo + atraque + ejecucion + desatraque (sum of all phases).
    // Falls back to waiting_time_h + duration_estimated_h when phases are absent.
    const avgDuration = assigned.length
      ? assigned.reduce((s, a) => {
          const totalH = a.phases?.length
            ? a.phases.reduce((ph, p) => ph + p.duration_h, 0)
            : a.waiting_time_h + a.duration_estimated_h;
          return s + totalH;
        }, 0) / assigned.length
      : 0;

    // Join assignments → BerthCalls for cargo/op-type info
    const callMap = new Map<string, BerthCall>(
      (this.cachedResult?.data ?? []).map(c => [c.call_id, c])
    );

    // ── KPIs (same 4-card layout as CSV) ─────────────────────────────────
    this.optiKpis = [
      { label: 'stats.opt.kpi.assigned',    value: `${assigned.length} / ${assignments.length}`, sub: 'stats.opt.kpi.assigned_sub',    icon: 'directions_boat' },
      { label: 'stats.opt.kpi.berths',      value: String(uniqueBerths),                          sub: 'stats.opt.kpi.berths_sub',      icon: 'dock'            },
      { label: 'stats.opt.kpi.avg_duration', value: this.formatHours(avgDuration),                  sub: 'stats.opt.kpi.avg_duration_sub', icon: 'timer'          },
      { label: 'stats.opt.kpi.improvement', value: `${kpis.improvement_vs_greedy_pct >= 0 ? '+' : ''}${kpis.improvement_vs_greedy_pct.toFixed(1)}%`, sub: 'stats.opt.kpi.improvement_sub', icon: 'trending_up' },
    ];

    // ── Monthly grouping (mirrors CSV MonthStat structure) ───────────────
    const monthMap = new Map<string, typeof assigned>();
    for (const a of assigned) {
      const d = new Date(a.scheduled_start);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthMap.has(key)) monthMap.set(key, []);
      monthMap.get(key)!.push(a);
    }
    this.optiMonths = Array.from(monthMap.keys()).sort().map(key => {
      const [yearStr, monthStr] = key.split('-');
      const year  = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);
      const mAssigns = monthMap.get(key)!;
      const mCalls   = mAssigns.map(a => callMap.get(a.vessel_id)).filter((c): c is BerthCall => !!c);
      // Total stay = fondeo + atraque + ejecucion + desatraque (sum of all phases).
      // Falls back to waiting_time_h + (scheduled_end − scheduled_start) when phases absent.
      const avgDuration = mAssigns.length
        ? mAssigns.reduce((s, a) => {
            const totalH = a.phases?.length
              ? a.phases.reduce((ph, p) => ph + p.duration_h, 0)
              : a.waiting_time_h + (new Date(a.scheduled_end).getTime() - new Date(a.scheduled_start).getTime()) / 3_600_000;
            return s + totalH;
          }, 0) / mAssigns.length
        : 0;
      const totalQuantity   = mCalls.reduce((s, c) => s + (c.quantity ?? 0), 0);
      const quantityRecords = mCalls.filter(c => c.quantity !== null).length;
      const fteRes  = this._computeMonthFteResources(mAssigns, year, month);
      const waitRes = this._computeMonthResourceWaits(mAssigns);
      return {
        key, year, month,
        vesselCount: mAssigns.length,
        avgDuration,
        totalQuantity,
        quantityRecords,
        berthOccupancy: this.computeOptiMonthBerthOcc(mAssigns, year, month),
        opBreakdown:    this.computeOpBreakdown(mCalls),
        cargoBreakdown: this.computeCargoBreakdown(mCalls),
        ...fteRes,
        ...waitRes,
        // Combined minimum: coverage (peak + waiters) vs capacity (work-hours / FTE)
        finalMinPilots: Math.max(waitRes.trueMinPilots, fteRes.pilotsNeededFte),
        finalMinTugs:   Math.max(waitRes.trueMinTugs,   fteRes.tugsNeededFte),
      };
    });
    this.optiSelectedMonthIndex  = 0;
    this.optiMonthWindowStart    = 0;
    this.optiResourceWindowStart = 0;

    // ── Yearly minimum staffing (max of monthly finalMin values) ─────────
    const yearSet = new Set(this.optiMonths.map(m => m.year));
    this.optiYearResources = Array.from(yearSet).sort().map(year => {
      const yearMonths = this.optiMonths.filter(m => m.year === year);
      return {
        year,
        totalWaitUndockH: yearMonths.reduce((s, m) => s + m.waitUndockH,      0),
        finalMinPilots:   Math.max(...yearMonths.map(m => m.finalMinPilots), 0),
        finalMinTugs:     Math.max(...yearMonths.map(m => m.finalMinTugs),   0),
        totalPilotWaitH:  yearMonths.reduce((s, m) => s + m.pilotWaitH,       0),
        totalTugWaitH:    yearMonths.reduce((s, m) => s + m.tugWaitH,         0),
      };
    });

    // ── Docking / undocking phase-start distribution ─────────────────────
    // atraque starts at scheduled_start (fondeo is before it).
    // desatraque starts at scheduled_start + atraque.duration_h + ejecucion.duration_h.
    const atraqueCounts    = new Array(24).fill(0);
    const desatraqueCounts = new Array(24).fill(0);
    for (const a of assigned) {
      const startMs = new Date(a.scheduled_start).getTime();
      atraqueCounts[new Date(startMs).getHours()]++;
      const atH = a.phases?.find(p => p.name === 'atraque')?.duration_h    ?? 0;
      const exH = a.phases?.find(p => p.name === 'ejecucion')?.duration_h  ?? 0;
      desatraqueCounts[new Date(startMs + (atH + exH) * 3_600_000).getHours()]++;
    }
    const maxPhaseCount = Math.max(...atraqueCounts, ...desatraqueCounts, 1);
    this.optiScheduledHours = atraqueCounts.map((atraqueCount, hour) => ({
      hour,
      atraqueCount,
      desatraqueCount: desatraqueCounts[hour],
      atraquePct:    atraqueCount            / maxPhaseCount * 100,
      desatraquePct: desatraqueCounts[hour]  / maxPhaseCount * 100,
    }));

    // ── [EXTRA] Operation phases ──────────────────────────────────────────
    const PHASE_ORDER = ['fondeo', 'atraque', 'ejecucion', 'desatraque'];
    const PHASE_CLR: Record<string, string> = {
      fondeo: 'bg-amber-400', atraque: 'bg-sky-500', ejecucion: 'bg-emerald-500', desatraque: 'bg-violet-500',
    };
    const phaseTotals = new Map<string, number>();
    const phaseCounts = new Map<string, number>();
    for (const a of assigned) {
      for (const p of a.phases ?? []) {
        phaseTotals.set(p.name, (phaseTotals.get(p.name) ?? 0) + p.duration_h);
        phaseCounts.set(p.name, (phaseCounts.get(p.name) ?? 0) + 1);
      }
    }
    const phaseRaw = PHASE_ORDER
      .map(name => ({
        name,
        totalH: phaseTotals.get(name) ?? 0,
        avgH:   phaseCounts.get(name) ? phaseTotals.get(name)! / phaseCounts.get(name)! : 0,
        colorClass: PHASE_CLR[name] ?? 'bg-slate-400',
      }))
      .filter(p => p.totalH > 0);
    const maxPhaseH = Math.max(...phaseRaw.map(p => p.totalH), 1);
    this.optiPhases = phaseRaw.map(p => ({ ...p, barPct: p.totalH / maxPhaseH * 100 }));

    // ── [EXTRA] Avg waiting time ──────────────────────────────────────────
    this.optiAvgWaitH = assigned.length
      ? assigned.reduce((s, a) => s + a.waiting_time_h, 0) / assigned.length : 0;

    // ── [EXTRA] Waiting time vertical bar chart ───────────────────────────
    const WAIT_BUCKETS = [
      { labelKey: 'stats.opt.wait.no_wait',   shortLabel: '0 h',     max: 0        },
      { labelKey: 'stats.opt.wait.low',        shortLabel: '1–10 h',  max: 10       },
      { labelKey: 'stats.opt.wait.medium',     shortLabel: '10–20 h', max: 20       },
      { labelKey: 'stats.opt.wait.high',       shortLabel: '20–30 h', max: 30       },
      { labelKey: 'stats.opt.wait.very_high',  shortLabel: '>30 h',   max: Infinity },
    ];
    const bucketCounts = new Array(WAIT_BUCKETS.length).fill(0);
    for (const a of assigned) {
      const w = a.waiting_time_h;
      const idx = WAIT_BUCKETS.findIndex((b, i) =>
        w <= b.max && (i === 0 ? true : w > WAIT_BUCKETS[i - 1].max)
      );
      if (idx >= 0) bucketCounts[idx]++;
    }
    const maxBucket = Math.max(...bucketCounts, 1);
    this.optiWaitBuckets = WAIT_BUCKETS.map((b, i) => ({
      labelKey: b.labelKey, shortLabel: b.shortLabel,
      count: bucketCounts[i], barPct: bucketCounts[i] / maxBucket * 100,
    }));

    // ── [EXTRA] Anchorage (fondeo) hours per berth ────────────────────────
    const berthFondeoMap = new Map<string, number[]>();
    for (const a of assigned) {
      const fp = a.phases?.find(p => p.name === 'fondeo');
      if (fp && fp.duration_h > 0) {
        if (!berthFondeoMap.has(a.berth_id)) berthFondeoMap.set(a.berth_id, []);
        berthFondeoMap.get(a.berth_id)!.push(fp.duration_h);
      }
    }
    const berthAnchorRaw = Array.from(berthFondeoMap.entries())
      .map(([berth, hours]) => ({
        berth,
        totalFondeoH: hours.reduce((s, h) => s + h, 0),
        avgFondeoH:   hours.reduce((s, h) => s + h, 0) / hours.length,
        vesselCount:  hours.length,
        barPct: 0,
      }))
      .sort((a, b) => b.totalFondeoH - a.totalFondeoH);
    const maxFondeoH = Math.max(...berthAnchorRaw.map(b => b.totalFondeoH), 1);
    this.optiBerthAnchorage = berthAnchorRaw.map(b => ({ ...b, barPct: b.totalFondeoH / maxFondeoH * 100 }));

    // ── [EXTRA] Duration sources ──────────────────────────────────────────
    const dsTotal = Object.values(kpis.duration_source_breakdown).reduce((s, n) => s + n, 0) || 1;
    this.optiDurSources = Object.entries(kpis.duration_source_breakdown)
      .filter(([, count]) => count > 0)
      .map(([source, count]) => ({ labelKey: `stats.opt.dur_source.${source}`, count, pct: count / dsTotal * 100 }))
      .sort((a, b) => b.count - a.count);

    // ── [EXTRA] Schedule-change breakdown ────────────────────────────────
    // Detect change types:
    //   Arrival delay      → 'delay' phase is FIRST (prepended before fondeo)
    //   Operation delay    → 'delay' phase present but NOT first (inserted after ejecucion)
    //   Early completion   → a.early_complete === true (user called early_complete endpoint)
    //   Undock wait        → 'waiting_undock' phase present AND a.early_complete !== true
    //                        (scheduler inserted a resource-wait phase at berth)
    let _opDelay     = 0;
    let _earlyC      = 0;
    let _undockWait  = 0;
    let _arrDelay    = 0;
    let _earlyArriv  = 0;
    for (const a of assigned) {
      const phases = a.phases ?? [];
      const hasDelay      = phases.some(p => p.name === 'delay');
      const hasWaitUndock = phases.some(p => p.name === 'waiting_undock');
      if (hasDelay) {
        if (phases[0]?.name === 'delay') _arrDelay++;
        else                              _opDelay++;
      }
      if (hasWaitUndock) {
        if (a.early_complete) _earlyC++;   // user-triggered early completion
        else                  _undockWait++; // scheduling resource contention at undock
      }
      if ((a.early_arrival_h ?? 0) > 0) _earlyArriv++;
    }
    this.optiReplanChanges = {
      operationDelay: _opDelay,
      earlyComplete:  _earlyC,
      undockWait:     _undockWait,
      arrivalDelay:   _arrDelay,
      earlyArrival:   _earlyArriv,
      totalAssigned:  assigned.length,
    };

  }

  /**
   * Minimum FTE resources required for a calendar month.
   * Pilots/tugs work only during `atraque` and `desatraque` phases.
   * Each individual phase duration is rounded UP to the nearest full hour
   * (e.g. 30 min → 1 h of charged work time).
   * Available hours per FTE: max 8 h/day AND max 40 h/week (Mon–Sun).
   */
  private _computeMonthFteResources(
    mAssigns: { phases?: { name: string; duration_h: number }[]; tugs_required: number }[],
    year: number, month: number,
  ): { pilotsNeededFte: number; tugsNeededFte: number } {
    const daysInMonth  = new Date(year, month, 0).getDate();
    const weeksInMonth = Math.ceil(daysInMonth / 7);
    // Binding constraint: 8 h/day daily cap AND 40 h/week weekly cap
    const availHPerFte = Math.min(8 * daysInMonth, 40 * weeksInMonth);

    let pilotHours = 0;
    let tugHours   = 0;
    for (const a of mAssigns) {
      const atH = a.phases?.find(p => p.name === 'atraque')?.duration_h    ?? 0;
      const deH = a.phases?.find(p => p.name === 'desatraque')?.duration_h ?? 0;
      const ph  = Math.ceil(atH) + Math.ceil(deH);   // round each phase up individually
      pilotHours += ph;
      tugHours   += (a.tugs_required ?? 0) * ph;
    }

    return {
      pilotsNeededFte: availHPerFte > 0 ? Math.ceil(pilotHours / availHPerFte) : 0,
      tugsNeededFte:   availHPerFte > 0 ? Math.ceil(tugHours   / availHPerFte) : 0,
    };
  }

  /**
   * Aggregate resource-wait hours and demand peaks for a month.
   *
   * peakPilots / peakTugs — constrained peak (max simultaneous atraque + desatraque
   *   in the final schedule).  Always ≤ configured fleet size.
   *
   * trueMinPilots / trueMinTugs — minimum fleet required so that NO vessel waits.
   *
   *   Formula:  trueMin = constrainedPeak + maxSimultaneousWaiters
   *
   *   When pilot_wait_h > 0 the fleet was fully occupied at the berth-available
   *   time — every waiting vessel represents demand ABOVE the fleet size.
   *   The maximum number of vessels simultaneously in their wait window tells us
   *   exactly how many extra resources are needed.
   *
   *   Wait windows considered:
   *     • Fondeo (docking)  pilots: [atraque.start − pilot_wait_h, atraque.start]  (+1 pilot)
   *     • Fondeo (docking)  tugs:   [atraque.start − tug_wait_h,   atraque.start]  (+nt tugs)
   *     • waiting_undock            [wu.start, wu.end]                              (+1 pilot, +nt tugs)
   *
   *   This avoids the cascading-shift problem: we don't move other vessels' windows,
   *   we just count how many are queued simultaneously at the time they wanted to dock.
   */
  private _computeMonthResourceWaits(
    mAssigns: OptimizationAssignment[],
  ): { pilotWaitH: number; tugWaitH: number; waitUndockH: number;
       peakPilots: number; peakTugs: number;
       trueMinPilots: number; trueMinTugs: number } {
    let pilotWaitH  = 0;
    let tugWaitH    = 0;
    let waitUndockH = 0;

    // Constrained sweep: actual atraque + desatraque windows (max = fleet size)
    const constrained: { t: number; dp: number; dt: number }[] = [];
    // Wait-window sweep: vessels simultaneously queued for resources
    const waiters:     { t: number; dp: number; dt: number }[] = [];

    const push = (arr: typeof constrained, t: number, dp: number, dt: number) =>
      arr.push({ t, dp, dt });

    for (const a of mAssigns) {
      pilotWaitH += a.pilot_wait_h ?? 0;
      tugWaitH   += a.tug_wait_h   ?? 0;
      const nt       = a.tugs_required;
      const pilotWh  = a.pilot_wait_h ?? 0;
      const tugWh    = a.tug_wait_h   ?? 0;

      let atraqueStartMs: number | null = null;

      for (const p of a.phases ?? []) {
        const s = new Date(p.start).getTime();
        const e = new Date(p.end).getTime();

        if (p.name === 'atraque') {
          atraqueStartMs = s;
          push(constrained, s, +1, +nt);
          push(constrained, e, -1, -nt);
        } else if (p.name === 'desatraque') {
          push(constrained, s, +1, +nt);
          push(constrained, e, -1, -nt);
        } else if (p.name === 'waiting_undock') {
          waitUndockH += p.duration_h;
          // Vessel queued at berth for 1 pilot + nt tugs
          push(waiters, s, +1, +nt);
          push(waiters, e, -1, -nt);
        }
      }

      // Fondeo resource-wait windows for docking
      if (atraqueStartMs !== null) {
        if (pilotWh > 0.01) {
          push(waiters, atraqueStartMs - pilotWh * 3_600_000, +1, 0);
          push(waiters, atraqueStartMs,                        -1, 0);
        }
        if (tugWh > 0.01) {
          push(waiters, atraqueStartMs - tugWh * 3_600_000, 0, +nt);
          push(waiters, atraqueStartMs,                      0, -nt);
        }
      }
    }

    const sortFn = (a: { t: number; dp: number }, b: { t: number; dp: number }) =>
      a.t !== b.t ? a.t - b.t : a.dp - b.dp;

    constrained.sort(sortFn);
    waiters.sort(sortFn);

    let pilots = 0, tugs = 0, peakPilots = 0, peakTugs = 0;
    for (const e of constrained) {
      pilots += e.dp; tugs += e.dt;
      if (pilots > peakPilots) peakPilots = pilots;
      if (tugs   > peakTugs)   peakTugs   = tugs;
    }

    let wp = 0, wt = 0, maxWaitPilots = 0, maxWaitTugs = 0;
    for (const e of waiters) {
      wp += e.dp; wt += e.dt;
      if (wp > maxWaitPilots) maxWaitPilots = wp;
      if (wt > maxWaitTugs)   maxWaitTugs   = wt;
    }

    return {
      pilotWaitH, tugWaitH, waitUndockH,
      peakPilots, peakTugs,
      trueMinPilots: peakPilots + maxWaitPilots,
      trueMinTugs:   peakTugs   + maxWaitTugs,
    };
  }

  /** Berth occupancy for a calendar month, using scheduled_start/end times. */
  private computeOptiMonthBerthOcc(
    assigns: { berth_id: string; scheduled_start: string; scheduled_end: string }[],
    year: number, month: number,
  ): BerthOccupancy[] {
    const monthStartMs = new Date(year, month - 1, 1).getTime();
    const monthEndMs   = new Date(year, month,     1).getTime();
    const hoursInMonth = (monthEndMs - monthStartMs) / 3_600_000;
    const berthHoursMap = new Map<string, number>();
    const berthCountMap = new Map<string, number>();
    for (const a of assigns) {
      const s = new Date(a.scheduled_start).getTime();
      const e = new Date(a.scheduled_end).getTime();
      const h = Math.max(0, Math.min(e, monthEndMs) - Math.max(s, monthStartMs)) / 3_600_000;
      berthHoursMap.set(a.berth_id, (berthHoursMap.get(a.berth_id) ?? 0) + h);
      berthCountMap.set(a.berth_id, (berthCountMap.get(a.berth_id) ?? 0) + 1);
    }
    const entries = Array.from(berthHoursMap.entries())
      .map(([berth, hours]) => ({
        berth, hours,
        pct: hours / hoursInMonth * 100,
        barPct: 0,
        vesselCount: berthCountMap.get(berth) ?? 0,
      }))
      .sort((a, b) => b.pct - a.pct);
    const maxPct = Math.max(...entries.map(e => e.pct), 1);
    for (const e of entries) e.barPct = e.pct / maxPct * 100;
    return entries;
  }

  private clearStats(): void {
    this.kpis         = [];
    this.months       = [];
    this.arrivalHours = [];
    this.durWindowStart    = 0;
    this.selectedMonthIndex = 0;
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}

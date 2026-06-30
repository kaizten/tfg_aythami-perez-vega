import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { BerthCall, OptimizationApiResult, OptimizationAssignment, TransformApiResponse } from '../../core/models/api.models';
import { LanguageService } from '../../core/services/language.service';
import { OptimizationResultStoreService } from '../../core/services/optimization-result-store.service';
import { TransformationStoreService } from '../../core/services/transformation-store.service';

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
  pilotsNeededFte: number;
  tugsNeededFte: number;
  pilotWaitH: number;
  tugWaitH: number;
  waitUndockH: number;
  peakPilots: number;
  peakTugs: number;
  trueMinPilots: number;
  trueMinTugs: number;
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

interface WaitBucket {
  labelKey: string;
  shortLabel: string;
  count: number;
  barPct: number;
}

interface BerthAnchorageStat {
  berth: string;
  totalFondeoH: number;
  avgFondeoH: number;
  vesselCount: number;
  barPct: number;
}

interface DurSourceStat {
  labelKey: string;
  count: number;
  pct: number;
}

interface ReplanChangeStat {
  operationDelay: number;
  earlyComplete: number;
  undockWait: number;
  arrivalDelay: number;
  earlyArrival: number;
  totalAssigned: number;
}

interface PhaseHourStat {
  hour: number;
  atraqueCount: number;
  desatraqueCount: number;
  atraquePct: number;
  desatraquePct: number;
}

interface OptiYearResource {
  year: number;
  totalWaitUndockH: number;
  finalMinPilots: number;
  finalMinTugs: number;
  totalPilotWaitH: number;
  totalTugWaitH: number;
}

/* Fixed - number of months shown in each sliding window panel */
const DUR_WINDOW = 6;

/* Fixed - mapping from raw operation type strings to i18n translation keys */
const OP_TYPE_KEY: Record<string, string> = {
  'Desembarque': 'op.type.desembarque',
  'Embarque':    'op.type.embarque',
  'Trasbordo':   'op.type.trasbordo',
  'Residuos':    'op.type.residuos',
};

/* Fixed - mapping from raw cargo group strings to i18n translation keys */
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

/* Fixed - mapping from language codes to BCP-47 locale strings used for date formatting */
const LANG_LOCALE: Record<string, string> = {
  en: 'en-GB',
  es: 'es-ES',
  de: 'de-DE',
  fr: 'fr-FR',
};

@Component({
  selector: 'app-statistics',
  standalone: false,
  templateUrl: './statistics.component.html',
  styleUrl: './statistics.component.scss',
})
export class StatisticsComponent implements OnInit, OnDestroy {
  /* Computed - whether the CSV transformation result store contains data */
  hasData = false;
  /* Computed - KPI cards derived from the loaded CSV dataset */
  kpis: KpiCard[] = [];
  /* Computed - monthly statistics aggregated from the CSV dataset */
  months: MonthStat[] = [];
  /* Computed - per-hour arrival and departure counts from the CSV dataset */
  arrivalHours: ArrivalHour[] = [];

  /* Fixed - re-exported window size constant for use in the template */
  readonly DUR_WINDOW = DUR_WINDOW;
  /* Computed - index of the first month shown in the duration/cargo sliding window */
  durWindowStart = 0;
  /* User-provided - index of the month selected in the CSV detail panel */
  selectedMonthIndex = 0;

  /* User-provided - active data source tab selected by the user */
  dataSource: 'csv' | 'optimizer' = 'csv';
  /* Computed - whether the optimizer result store contains a result */
  hasOptimizerResult = false;

  /* Computed - KPI cards derived from the optimizer result */
  optiKpis: KpiCard[]             = [];
  /* Computed - monthly statistics aggregated from the optimizer assignments */
  optiMonths: OptiMonthStat[]     = [];
  /* Computed - index of the first month shown in the optimizer duration/cargo window */
  optiMonthWindowStart            = 0;
  /* User-provided - index of the month selected in the optimizer detail panel */
  optiSelectedMonthIndex          = 0;
  /* Computed - per-hour docking and undocking phase-start counts from optimizer result */
  optiScheduledHours: PhaseHourStat[] = [];
  /* Computed - operation phase totals and averages derived from optimizer assignments */
  optiPhases: PhaseStat[]          = [];
  /* Computed - waiting time distribution buckets computed from optimizer assignments */
  optiWaitBuckets: WaitBucket[]    = [];
  /* Computed - anchorage hours aggregated per berth from optimizer assignments */
  optiBerthAnchorage: BerthAnchorageStat[] = [];
  /* Computed - duration source breakdown derived from optimizer KPI data */
  optiDurSources: DurSourceStat[]  = [];
  /* Computed - counts of replan change events derived from optimizer assignments */
  optiReplanChanges: ReplanChangeStat | null = null;
  /* Computed - average waiting time in hours across all assigned vessels */
  optiAvgWaitH = 0;
  /* Computed - index of the first month shown in the optimizer resource allocation window */
  optiResourceWindowStart = 0;
  /* Computed - yearly minimum staffing requirements aggregated from monthly data */
  optiYearResources: OptiYearResource[] = [];

  /* Computed - last received CSV transformation response, cached for language re-render */
  private cachedResult: TransformApiResponse | null = null;
  /* Computed - last received optimizer result, cached for language re-render */
  private cachedOptiResult: OptimizationApiResult | null = null;
  /* Fixed - collection of active RxJS subscriptions, cleaned up on destroy */
  private subs: Subscription[] = [];

  constructor(
    private transformStore: TransformationStoreService,
    private optimizerStore: OptimizationResultStoreService,
    private lang: LanguageService,
  ) {}

  /*
   * Subscribes to store and language observables to build statistics whenever data changes.
   */
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

  /*
   * Switches the active statistics view between the CSV dataset and the optimizer result.
   * @param src - The data source to activate ('csv' or 'optimizer')
   */
  setDataSource(src: 'csv' | 'optimizer'): void {
    this.dataSource = src;
  }

  /*
   * Returns the slice of optimizer months currently visible in the duration/cargo window.
   * @returns Array of OptiMonthStat for the current window
   */
  get optiMonthWindow(): OptiMonthStat[] {
    return this.optiMonths.slice(this.optiMonthWindowStart, this.optiMonthWindowStart + DUR_WINDOW);
  }

  /*
   * Returns a human-readable label describing the date range of the optimizer month window.
   * @returns Formatted date range string, or empty string if the window is empty
   */
  get optiMonthWindowLabel(): string {
    const w = this.optiMonthWindow;
    if (!w.length) return '';
    const first = this.monthLabel(w[0].year, w[0].month);
    return w.length === 1 ? first : `${first} – ${this.monthLabel(w[w.length - 1].year, w[w.length - 1].month)}`;
  }

  /*
   * Returns the exclusive end index of the optimizer month window within optiMonths.
   * @returns End index clamped to the total number of optimizer months
   */
  get optiMonthWindowEnd(): number {
    return Math.min(this.optiMonthWindowStart + DUR_WINDOW, this.optiMonths.length);
  }

  /*
   * Returns the maximum average duration value across months in the optimizer window, used to scale bar heights.
   * @returns Maximum avgDuration value, at least 1
   */
  get maxOptiDurValue(): number {
    return Math.max(...this.optiMonthWindow.map(m => m.avgDuration), 1);
  }

  /*
   * Returns the maximum total cargo quantity across months in the optimizer window, used to scale bar heights.
   * @returns Maximum totalQuantity value, at least 1
   */
  get maxOptiCargoValue(): number {
    return Math.max(...this.optiMonthWindow.map(m => m.totalQuantity), 1);
  }

  /*
   * Shifts the optimizer duration/cargo window backwards by one window size.
   */
  prevOptiMonthWindow(): void {
    this.optiMonthWindowStart = Math.max(0, this.optiMonthWindowStart - DUR_WINDOW);
  }

  /*
   * Shifts the optimizer duration/cargo window forwards by one window size.
   */
  nextOptiMonthWindow(): void {
    if (this.optiMonthWindowStart + DUR_WINDOW < this.optiMonths.length)
      this.optiMonthWindowStart = Math.min(this.optiMonths.length - 1, this.optiMonthWindowStart + DUR_WINDOW);
  }

  /*
   * Returns the currently selected optimizer month stat for the detail panel.
   * @returns The selected OptiMonthStat, or null if no months are available
   */
  get optiSelectedMonth(): OptiMonthStat | null {
    return this.optiMonths[this.optiSelectedMonthIndex] ?? null;
  }

  /*
   * Navigates to the previous month in the optimizer detail panel.
   */
  prevOptiMonth(): void {
    if (this.optiSelectedMonthIndex > 0) this.optiSelectedMonthIndex--;
  }

  /*
   * Navigates to the next month in the optimizer detail panel.
   */
  nextOptiMonth(): void {
    if (this.optiSelectedMonthIndex < this.optiMonths.length - 1) this.optiSelectedMonthIndex++;
  }

  /*
   * Returns the slice of optimizer months currently visible in the resource allocation window.
   * @returns Array of OptiMonthStat for the current resource window
   */
  get optiResourceWindow(): OptiMonthStat[] {
    return this.optiMonths.slice(this.optiResourceWindowStart, this.optiResourceWindowStart + DUR_WINDOW);
  }

  /*
   * Returns a human-readable label for the date range covered by the resource allocation window.
   * @returns Formatted date range string, or empty string if the window is empty
   */
  get optiResourceWindowLabel(): string {
    const w = this.optiResourceWindow;
    if (!w.length) return '';
    const first = this.monthLabel(w[0].year, w[0].month);
    return w.length === 1 ? first : `${first} – ${this.monthLabel(w[w.length - 1].year, w[w.length - 1].month)}`;
  }

  /*
   * Returns the exclusive end index of the resource window within optiMonths.
   * @returns End index clamped to the total number of optimizer months
   */
  get optiResourceWindowEnd(): number {
    return Math.min(this.optiResourceWindowStart + DUR_WINDOW, this.optiMonths.length);
  }

  /*
   * Returns the maximum finalMinPilots value across months in the resource window, used to scale pilot bars.
   * @returns Maximum pilot requirement, at least 1
   */
  get maxOptiResourcePilots(): number {
    return Math.max(...this.optiResourceWindow.map(m => m.finalMinPilots), 1);
  }

  /*
   * Returns the maximum finalMinTugs value across months in the resource window, used to scale tug bars.
   * @returns Maximum tug requirement, at least 1
   */
  get maxOptiResourceTugs(): number {
    return Math.max(...this.optiResourceWindow.map(m => m.finalMinTugs), 1);
  }

  /*
   * Returns the highest count across all replan-change categories, used to scale bar widths in the chart.
   * @returns Maximum replan change count, at least 1
   */
  get optiReplanMaxCount(): number {
    if (!this.optiReplanChanges) return 1;
    const { operationDelay, earlyComplete, undockWait, arrivalDelay, earlyArrival } = this.optiReplanChanges;
    return Math.max(operationDelay, earlyComplete, undockWait, arrivalDelay, earlyArrival, 1);
  }

  /*
   * Computes the percentage of assigned vessels represented by a given replan-change count.
   * @param count - Number of vessels affected by a specific change type
   * @returns Percentage relative to total assigned vessels, or 0 if unavailable
   */
  replanPct(count: number): number {
    if (!this.optiReplanChanges || this.optiReplanChanges.totalAssigned === 0) return 0;
    return count / this.optiReplanChanges.totalAssigned * 100;
  }

  /*
   * Returns the total number of docking (atraque) starts across all hours of the day.
   * @returns Sum of atraqueCount values across all PhaseHourStat entries
   */
  get optiTotalAtraque(): number {
    return this.optiScheduledHours.reduce((s, h) => s + h.atraqueCount, 0);
  }

  /*
   * Returns the total number of undocking (desatraque) starts across all hours of the day.
   * @returns Sum of desatraqueCount values across all PhaseHourStat entries
   */
  get optiTotalDesatraque(): number {
    return this.optiScheduledHours.reduce((s, h) => s + h.desatraqueCount, 0);
  }

  /*
   * Returns the hour of day with the highest number of docking (atraque) phase starts.
   * @returns Hour index (0–23) with peak atraque count, or 0 if no data
   */
  get optiPeakAtraqueHour(): number {
    if (!this.optiScheduledHours.length) return 0;
    return this.optiScheduledHours.reduce((best, h) =>
      h.atraqueCount > best.atraqueCount ? h : best
    ).hour;
  }

  /*
   * Returns the hour of day with the highest number of undocking (desatraque) phase starts.
   * @returns Hour index (0–23) with peak desatraque count, or 0 if no data
   */
  get optiPeakDesatraqueHour(): number {
    if (!this.optiScheduledHours.length) return 0;
    return this.optiScheduledHours.reduce((best, h) =>
      h.desatraqueCount > best.desatraqueCount ? h : best
    ).hour;
  }

  /*
   * Shifts the resource allocation window backwards by one window size.
   */
  prevOptiResourceWindow(): void {
    this.optiResourceWindowStart = Math.max(0, this.optiResourceWindowStart - DUR_WINDOW);
  }

  /*
   * Shifts the resource allocation window forwards by one window size.
   */
  nextOptiResourceWindow(): void {
    if (this.optiResourceWindowStart + DUR_WINDOW < this.optiMonths.length)
      this.optiResourceWindowStart = Math.min(this.optiMonths.length - 1, this.optiResourceWindowStart + DUR_WINDOW);
  }

  /*
   * Returns the slice of CSV months currently visible in the duration/cargo sliding window.
   * @returns Array of MonthStat for the current window
   */
  get durWindowMonths(): MonthStat[] {
    return this.months.slice(this.durWindowStart, this.durWindowStart + DUR_WINDOW);
  }

  /*
   * Returns a human-readable label for the date range of the CSV duration/cargo window.
   * @returns Formatted date range string, or empty string if the window is empty
   */
  get durWindowLabel(): string {
    const w = this.durWindowMonths;
    if (!w.length) return '';
    const first = this.monthLabel(w[0].year, w[0].month);
    return w.length === 1 ? first : `${first} – ${this.monthLabel(w[w.length - 1].year, w[w.length - 1].month)}`;
  }

  /*
   * Returns the exclusive end index of the CSV duration window within months.
   * @returns End index clamped to the total number of CSV months
   */
  get durWindowEnd(): number {
    return Math.min(this.durWindowStart + DUR_WINDOW, this.months.length);
  }

  /*
   * Returns the maximum average duration value across months in the CSV window, used to scale bar heights.
   * @returns Maximum avgDuration value, at least 1
   */
  get maxDurValue(): number {
    return Math.max(...this.durWindowMonths.map(m => m.avgDuration), 1);
  }

  /*
   * Returns the maximum total cargo quantity across months in the CSV window, used to scale bar heights.
   * @returns Maximum totalQuantity value, at least 1
   */
  get maxCargoValue(): number {
    return Math.max(...this.durWindowMonths.map(m => m.totalQuantity), 1);
  }

  /*
   * Shifts the CSV duration/cargo window backwards by one window size.
   */
  prevDurWindow(): void {
    if (this.durWindowStart > 0) {
      this.durWindowStart = Math.max(0, this.durWindowStart - DUR_WINDOW);
    }
  }

  /*
   * Shifts the CSV duration/cargo window forwards by one window size.
   */
  nextDurWindow(): void {
    if (this.durWindowStart + DUR_WINDOW < this.months.length) {
      this.durWindowStart = Math.min(this.months.length - 1, this.durWindowStart + DUR_WINDOW);
    }
  }

  /*
   * Returns the currently selected CSV month stat for the detail panel.
   * @returns The selected MonthStat, or null if no months are available
   */
  get selectedMonth(): MonthStat | null {
    return this.months[this.selectedMonthIndex] ?? null;
  }

  /*
   * Navigates to the previous month in the CSV detail panel.
   */
  prevMonth(): void {
    if (this.selectedMonthIndex > 0) this.selectedMonthIndex--;
  }

  /*
   * Navigates to the next month in the CSV detail panel.
   */
  nextMonth(): void {
    if (this.selectedMonthIndex < this.months.length - 1) this.selectedMonthIndex++;
  }

  /*
   * Formats a year and month number into a localized short month-year string.
   * @param year - Four-digit year number
   * @param month - One-based month number (1–12)
   * @returns Localized string such as "Jan 2024" in the current UI language
   */
  monthLabel(year: number, month: number): string {
    const locale = LANG_LOCALE[this.lang.current] ?? 'es-ES';
    return new Date(year, month - 1, 1).toLocaleDateString(locale, {
      month: 'short',
      year: 'numeric',
    });
  }

  /*
   * Formats a numeric quantity into a human-readable abbreviated string.
   * @param q - Raw numeric quantity
   * @returns Abbreviated string such as "1.2M", "500k", or "42"
   */
  formatQuantity(q: number): string {
    if (q >= 1_000_000) return `${(q / 1_000_000).toFixed(1)}M`;
    if (q >= 1_000)     return `${(q / 1_000).toFixed(0)}k`;
    return q.toFixed(0);
  }

  /*
   * Converts a decimal hours value to a compact duration string with years, days, hours, and minutes.
   * @param h - Duration in decimal hours (e.g. 24.5)
   * @returns Formatted string such as "1d 0h 30m", or "0m" for zero duration
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
   * Left-pads a single-digit hour number with a leading zero for display in time labels.
   * @param h - Hour integer (0–23)
   * @returns Two-character string such as "07" or "14"
   */
  padHour(h: number): string {
    return h.toString().padStart(2, '0');
  }

  /*
   * Builds the four KPI cards from a CSV transformation response and updates the current language locale.
   * @param result - The transformation API response containing berth call records
   */
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

  /*
   * Builds all CSV statistics (KPIs, monthly stats, arrival hour distribution) from a transformation response.
   * @param result - The transformation API response containing berth call records
   */
  private buildStats(result: TransformApiResponse): void {
    const calls = result.data;
    if (!calls.length) { this.clearStats(); return; }

    this.buildKpis(result);
    this.months = this.computeMonths(calls);
    this.arrivalHours = this.computeArrivalHours(calls);

    this.durWindowStart    = 0;
    this.selectedMonthIndex = 0;
  }

  /*
   * Groups berth calls by calendar month and computes aggregated statistics for each month.
   * @param calls - Array of berth call records from the CSV dataset
   * @returns Array of MonthStat objects sorted chronologically
   */
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

  /*
   * Computes berth occupancy percentages for a given calendar month from CSV berth call records.
   * @param calls - Berth call records belonging to the target month
   * @param year - Four-digit year of the target month
   * @param month - One-based month number of the target month
   * @returns Array of BerthOccupancy entries sorted by descending occupancy percentage
   */
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

  /*
   * Computes the breakdown of operation types from a set of berth calls, splitting compound types.
   * @param calls - Berth call records to analyse
   * @returns Array of OpBreakdown entries sorted by descending count
   */
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

  /*
   * Computes the breakdown of cargo groups from a set of berth calls.
   * @param calls - Berth call records to analyse
   * @returns Array of CargoBreakdown entries sorted by descending count
   */
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

  /*
   * Counts arrival and departure events per hour of the day across all berth calls.
   * @param calls - Berth call records to analyse
   * @returns Array of 24 ArrivalHour entries (one per hour), with normalized bar percentages
   */
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

  /*
   * Returns the hour of day with the most vessel arrivals in the CSV dataset.
   * @returns Hour index (0–23) with peak arrival count, or 0 if no data
   */
  get peakArrivalHour(): number {
    if (!this.arrivalHours.length) return 0;
    return this.arrivalHours.reduce((best, h) =>
      h.arrivalCount > best.arrivalCount ? h : best
    ).hour;
  }

  /*
   * Returns the hour of day with the most vessel departures in the CSV dataset.
   * @returns Hour index (0–23) with peak departure count, or 0 if no data
   */
  get peakDepartureHour(): number {
    if (!this.arrivalHours.length) return 0;
    return this.arrivalHours.reduce((best, h) =>
      h.departureCount > best.departureCount ? h : best
    ).hour;
  }

  /*
   * Builds all optimizer statistics from an optimization API result, including KPIs, monthly groupings,
   * phase distributions, resource requirements, and replan-change breakdowns.
   * @param result - The optimization API result containing assignments and KPI data
   */
  private buildOptimizerStats(result: OptimizationApiResult): void {
    const { assignments, kpis } = result;
    const assigned     = assignments.filter(a => a.status === 'assigned');
    const uniqueBerths = new Set(assigned.map(a => a.berth_id)).size;
    const avgDuration = assigned.length
      ? assigned.reduce((s, a) => {
          const totalH = a.phases?.length
            ? a.phases.reduce((ph, p) => ph + p.duration_h, 0)
            : a.waiting_time_h + a.duration_estimated_h;
          return s + totalH;
        }, 0) / assigned.length
      : 0;

    const callMap = new Map<string, BerthCall>(
      (this.cachedResult?.data ?? []).map(c => [c.call_id, c])
    );

    this.optiKpis = [
      { label: 'stats.opt.kpi.assigned',    value: `${assigned.length} / ${assignments.length}`, sub: 'stats.opt.kpi.assigned_sub',    icon: 'directions_boat' },
      { label: 'stats.opt.kpi.berths',      value: String(uniqueBerths),                          sub: 'stats.opt.kpi.berths_sub',      icon: 'dock'            },
      { label: 'stats.opt.kpi.avg_duration', value: this.formatHours(avgDuration),                  sub: 'stats.opt.kpi.avg_duration_sub', icon: 'timer'          },
      { label: 'stats.opt.kpi.improvement', value: `${kpis.improvement_vs_greedy_pct >= 0 ? '+' : ''}${kpis.improvement_vs_greedy_pct.toFixed(1)}%`, sub: 'stats.opt.kpi.improvement_sub', icon: 'trending_up' },
    ];

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
        finalMinPilots: Math.max(waitRes.trueMinPilots, fteRes.pilotsNeededFte),
        finalMinTugs:   Math.max(waitRes.trueMinTugs,   fteRes.tugsNeededFte),
      };
    });
    this.optiSelectedMonthIndex  = 0;
    this.optiMonthWindowStart    = 0;
    this.optiResourceWindowStart = 0;

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

    this.optiAvgWaitH = assigned.length
      ? assigned.reduce((s, a) => s + a.waiting_time_h, 0) / assigned.length : 0;

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

    const dsTotal = Object.values(kpis.duration_source_breakdown).reduce((s, n) => s + n, 0) || 1;
    this.optiDurSources = Object.entries(kpis.duration_source_breakdown)
      .filter(([, count]) => count > 0)
      .map(([source, count]) => ({ labelKey: `stats.opt.dur_source.${source}`, count, pct: count / dsTotal * 100 }))
      .sort((a, b) => b.count - a.count);

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
        if (a.early_complete) _earlyC++;
        else                  _undockWait++;
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

  /*
   * Computes the minimum FTE count of pilots and tugs required to cover all atraque and desatraque
   * phases in a calendar month, respecting daily (8 h) and weekly (40 h) working hour caps.
   * @param mAssigns - Assignments belonging to the target month, with phase and tug data
   * @param year - Four-digit year of the target month
   * @param month - One-based month number of the target month
   * @returns Object with pilotsNeededFte and tugsNeededFte integer counts
   */
  private _computeMonthFteResources(
    mAssigns: { phases?: { name: string; duration_h: number }[]; tugs_required: number }[],
    year: number, month: number,
  ): { pilotsNeededFte: number; tugsNeededFte: number } {
    const daysInMonth  = new Date(year, month, 0).getDate();
    const weeksInMonth = Math.ceil(daysInMonth / 7);
    const availHPerFte = Math.min(8 * daysInMonth, 40 * weeksInMonth);

    let pilotHours = 0;
    let tugHours   = 0;
    for (const a of mAssigns) {
      const atH = a.phases?.find(p => p.name === 'atraque')?.duration_h    ?? 0;
      const deH = a.phases?.find(p => p.name === 'desatraque')?.duration_h ?? 0;
      const ph  = Math.ceil(atH) + Math.ceil(deH);
      pilotHours += ph;
      tugHours   += (a.tugs_required ?? 0) * ph;
    }

    return {
      pilotsNeededFte: availHPerFte > 0 ? Math.ceil(pilotHours / availHPerFte) : 0,
      tugsNeededFte:   availHPerFte > 0 ? Math.ceil(tugHours   / availHPerFte) : 0,
    };
  }

  /*
   * Aggregates resource wait hours and computes constrained peak and true minimum fleet sizes for a month.
   * Uses a sweep-line algorithm over atraque, desatraque, and waiting_undock phase windows to find
   * the peak simultaneous resource demand without rescheduling other vessels.
   * @param mAssigns - Optimizer assignments belonging to the target month
   * @returns Object with pilotWaitH, tugWaitH, waitUndockH, peakPilots, peakTugs, trueMinPilots, trueMinTugs
   */
  private _computeMonthResourceWaits(
    mAssigns: OptimizationAssignment[],
  ): { pilotWaitH: number; tugWaitH: number; waitUndockH: number;
       peakPilots: number; peakTugs: number;
       trueMinPilots: number; trueMinTugs: number } {
    let pilotWaitH  = 0;
    let tugWaitH    = 0;
    let waitUndockH = 0;

    const constrained: { t: number; dp: number; dt: number }[] = [];
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
          push(waiters, s, +1, +nt);
          push(waiters, e, -1, -nt);
        }
      }

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

  /*
   * Computes berth occupancy percentages for a calendar month using optimizer scheduled start/end times.
   * @param assigns - Optimizer assignments belonging to the target month
   * @param year - Four-digit year of the target month
   * @param month - One-based month number of the target month
   * @returns Array of BerthOccupancy entries sorted by descending occupancy percentage
   */
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

  /*
   * Resets all CSV statistics state to empty, clearing KPIs, monthly stats, and arrival hour data.
   */
  private clearStats(): void {
    this.kpis         = [];
    this.months       = [];
    this.arrivalHours = [];
    this.durWindowStart    = 0;
    this.selectedMonthIndex = 0;
  }

  /*
   * Unsubscribes from all active RxJS subscriptions to prevent memory leaks on component teardown.
   */
  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}

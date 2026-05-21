import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { BerthCall, TransformApiResponse } from '../../core/models/api.models';
import { LanguageService } from '../../core/services/language.service';
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
  count: number;
  barPct: number;
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
  hasData = false;
  kpis: KpiCard[] = [];
  months: MonthStat[] = [];
  arrivalHours: ArrivalHour[] = [];

  readonly DUR_WINDOW = DUR_WINDOW;
  durWindowStart = 0;
  selectedMonthIndex = 0;

  private cachedResult: TransformApiResponse | null = null;
  private subs: Subscription[] = [];

  constructor(
    private transformStore: TransformationStoreService,
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
      this.lang.lang$.subscribe(() => {
        if (this.cachedResult) this.buildKpis(this.cachedResult);
      }),
    );
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
      { label: 'stats.kpi.avg_duration',  value: `${avgDuration.toFixed(1)} h`,       sub: 'stats.kpi.duration_sub',   icon: 'timer' },
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
    const counts = new Array(24).fill(0);
    for (const call of calls) {
      counts[new Date(call.arrival_time).getHours()]++;
    }
    const max = Math.max(...counts, 1);
    return counts.map((count, hour) => ({ hour, count, barPct: count / max * 100 }));
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

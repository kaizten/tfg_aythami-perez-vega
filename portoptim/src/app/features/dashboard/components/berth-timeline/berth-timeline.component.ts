import { Component, OnDestroy, OnInit } from '@angular/core';
import { interval, Subscription } from 'rxjs';
import { startWith } from 'rxjs/operators';
import { BerthCall, TransformApiResponse } from '../../../../core/models/api.models';
import { TransformationStoreService } from '../../../../core/services/transformation-store.service';

// ── Interfaces ──────────────────────────────────────────────────────────────────

interface GanttVessel {
  name: string;
  left: string;
  width: string;
  top: string;
  colorClass: string;
  clippedLeft: boolean;
  clippedRight: boolean;
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

// ── Component ───────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-berth-timeline',
  standalone: false,
  templateUrl: './berth-timeline.component.html',
  styleUrl: './berth-timeline.component.scss',
})
export class BerthTimelineComponent implements OnInit, OnDestroy {
  readonly hourLabels = HOUR_LABELS;
  ganttBerths: GanttBerth[] = [];

  availableDays: string[] = [];
  selectedDayIndex = 0;

  isToday = false;
  currentTimeLeft = '';

  private dayStartsMs: number[] = [];
  private allCalls: BerthCall[] = [];
  private subs: Subscription[] = [];

  constructor(private transformStore: TransformationStoreService) {}

  ngOnInit(): void {
    this.subs.push(
      this.transformStore.result$.subscribe(r => {
        if (r) this.buildView(r);
        else this.clearView();
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
      this.buildDayView();
      this.updateNowLine();
    }
  }

  nextDay(): void {
    if (this.selectedDayIndex < this.availableDays.length - 1) {
      this.selectedDayIndex++;
      this.buildDayView();
      this.updateNowLine();
    }
  }

  goToday(): void {
    const todayMs = floorToDay(Date.now());
    const idx = this.dayStartsMs.indexOf(todayMs);
    if (idx >= 0) {
      this.selectedDayIndex = idx;
      this.buildDayView();
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

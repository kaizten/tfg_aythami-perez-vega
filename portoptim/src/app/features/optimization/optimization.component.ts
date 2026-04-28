import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { BerthCall, TransformApiResponse } from '../../core/models/api.models';
import { TransformationStoreService } from '../../core/services/transformation-store.service';
import { VesselDetail } from './components/vessel-detail-panel/vessel-detail-panel.component';

interface Kpi { label: string; value: string; change: string; icon: string; positive: boolean; }
interface GanttVessel { name: string; left: string; width: string; colorClass: string; call: BerthCall; }
interface GanttBerth { name: string; vessels: GanttVessel[]; }

const VESSEL_COLORS = [
  'bg-teal-500/90', 'bg-indigo-500/90', 'bg-amber-500/90',
  'bg-violet-500/90', 'bg-sky-500/90', 'bg-rose-500/90',
];

@Component({
  selector: 'app-optimization',
  standalone: false,
  templateUrl: './optimization.component.html',
  styleUrl: './optimization.component.scss',
})
export class OptimizationComponent implements OnInit, OnDestroy {
  isPanelOpen = false;
  selectedVessel: VesselDetail | null = null;
  hasData = false;

  kpis: Kpi[] = [];
  ganttBerths: GanttBerth[] = [];
  ganttHours: string[] = [];

  private sub?: Subscription;
  private minTime = 0;
  private maxTime = 0;

  constructor(private store: TransformationStoreService) {}

  ngOnInit(): void {
    this.sub = this.store.result$.subscribe(result => {
      if (result) {
        this.buildFromResult(result);
      } else {
        this.hasData = false;
        this.ganttBerths = [];
        this.kpis = [];
      }
    });
  }

  private buildFromResult(result: TransformApiResponse): void {
    const calls = result.data;
    this.hasData = calls.length > 0;
    this.kpis = this.computeKpis(calls, result);
    this.ganttBerths = this.buildGantt(calls);
  }

  private computeKpis(calls: BerthCall[], result: TransformApiResponse): Kpi[] {
    const uniqueBerths = new Set(calls.map(c => c.berth_id)).size;
    const avgDuration = calls.length
      ? calls.reduce((s, c) => s + c.duration_hours, 0) / calls.length
      : 0;
    const skipped = result.transformation_summary.skipped_rows;

    return [
      { label: 'Total Vessels', value: String(calls.length), change: `${result.transformation_summary.total_input_rows} input rows`, icon: 'directions_boat', positive: true },
      { label: 'Active Berths', value: String(uniqueBerths), change: 'unique berth IDs', icon: 'dock', positive: true },
      { label: 'Avg. Duration', value: `${avgDuration.toFixed(1)}h`, change: 'per port call', icon: 'timer', positive: true },
      { label: 'Skipped Rows', value: String(skipped), change: skipped === 0 ? 'all rows valid' : 'check skip reasons', icon: 'warning', positive: skipped === 0 },
    ];
  }

  private buildGantt(calls: BerthCall[]): GanttBerth[] {
    if (!calls.length) return [];

    const times = calls.flatMap(c => [
      new Date(c.arrival_time).getTime(),
      new Date(c.departure_time).getTime(),
    ]);
    this.minTime = Math.min(...times);
    this.maxTime = Math.max(...times);
    const totalMs = this.maxTime - this.minTime || 1;

    this.ganttHours = this.buildHourLabels(this.minTime, this.maxTime);

    const berthMap = new Map<string, BerthCall[]>();
    for (const call of calls) {
      if (!berthMap.has(call.berth_id)) berthMap.set(call.berth_id, []);
      berthMap.get(call.berth_id)!.push(call);
    }

    let colorIdx = 0;
    return Array.from(berthMap.entries()).map(([berthId, berthCalls]) => ({
      name: berthId,
      vessels: berthCalls.map(call => {
        const start = new Date(call.arrival_time).getTime();
        const end = new Date(call.departure_time).getTime();
        const left = ((start - this.minTime) / totalMs * 100).toFixed(1) + '%';
        const width = Math.max(((end - start) / totalMs * 100), 4).toFixed(1) + '%';
        return {
          name: call.call_id,
          left, width,
          colorClass: VESSEL_COLORS[colorIdx++ % VESSEL_COLORS.length],
          call,
        };
      }),
    }));
  }

  private buildHourLabels(minMs: number, maxMs: number): string[] {
    const labels: string[] = [];
    const stepMs = (maxMs - minMs) / 6;
    for (let i = 0; i <= 6; i++) {
      const d = new Date(minMs + stepMs * i);
      labels.push(d.toLocaleString('es-ES', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }));
    }
    return labels;
  }

  openVesselDetail(vessel: GanttVessel): void {
    const c = vessel.call;
    this.selectedVessel = {
      name: c.call_id,
      imo: `Berth: ${c.berth_id}`,
      status: c.operation_type || 'Unknown',
      statusColor: 'bg-teal-500',
      priority: c.operation_type,
      type: c.operation_type,
      loa: `${c.vessel_length} m`,
      gt: c.vessel_gt.toLocaleString(),
      operation: c.operation_type,
      berth: c.berth_id,
      eta: new Date(c.arrival_time).toLocaleString('es-ES'),
      etd: new Date(c.departure_time).toLocaleString('es-ES'),
      cargo: [
        {
          icon: 'inventory_2',
          type: c.cargo_group || 'N/A',
          quantity: c.quantity !== null ? String(c.quantity) : 'N/A',
          unit: c.cargo_nature || '',
        },
      ],
    };
    this.isPanelOpen = true;
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}

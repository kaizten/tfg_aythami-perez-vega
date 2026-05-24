import { Component, EventEmitter, Input, Output } from '@angular/core';
import { OperationPhase } from '../../../../core/models/api.models';

export interface VesselDetail {
  name: string;
  imo: string;
  status: string;
  statusColor: string;
  priority: string;
  type: string;
  loa: string;
  gt: string;
  operation: string;
  berth: string;
  eta: string;
  etd: string;
  cargo: { icon: string; type: string; quantity: string; unit: string }[];
  // Optimizer-specific fields (only present when panel is opened from optimizer view)
  waitingTime?: string;
  durationEstimated?: string;
  durationSource?: string;
  pilotAssigned?: boolean;
  tugsRequired?: number;
  tugsAssigned?: boolean;
  optimizerStatus?: string;
  phases?: OperationPhase[];
  /** True when a delay can still be reported (not yet arrived, or arrived < 3 h ago). */
  canAddDelay?: boolean;
  /** Total accumulated delay in hours (for display in the panel). */
  delayHours?: number;
}

const PHASE_COLORS: Record<string, string> = {
  fondeo:    'bg-amber-400',
  atraque:   'bg-sky-500',
  ejecucion: 'bg-emerald-500',
  desatraque:'bg-violet-500',
};

@Component({
  selector: 'app-vessel-detail-panel',
  standalone: false,
  templateUrl: './vessel-detail-panel.component.html',
  styleUrl: './vessel-detail-panel.component.scss',
})
export class VesselDetailPanelComponent {
  @Input() vessel: VesselDetail | null = null;
  @Input() isOpen = false;
  @Output() close    = new EventEmitter<void>();
  @Output() confirm  = new EventEmitter<void>();
  @Output() addDelay = new EventEmitter<number>();

  showDelayInput  = false;
  pendingDelayH   = 1;

  get isOnTheWay(): boolean   { return this.vessel?.status === 'vessel.status.on_the_way'; }
  get isInProgress(): boolean  { return this.vessel?.status === 'vessel.status.in_progress'; }
  get isCompleted(): boolean   { return this.vessel?.status === 'vessel.status.completed'; }
  get isOptimizerMode(): boolean { return !!this.vessel?.optimizerStatus; }

  applyDelay(): void {
    if (this.pendingDelayH > 0) {
      this.addDelay.emit(this.pendingDelayH);
      this.showDelayInput = false;
      this.pendingDelayH  = 1;
    }
  }

  phaseColorClass(name: string): string {
    return PHASE_COLORS[name] ?? 'bg-slate-400';
  }

  formatPhaseTime(iso: string): string {
    return new Date(iso).toLocaleString('es-ES', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  totalPhaseDuration(): number {
    return (this.vessel?.phases ?? []).reduce((s, p) => s + p.duration_h, 0);
  }

  /** Converts a decimal hour value to "HH:MM" string (e.g. 1.75 → "01:45"). */
  hoursToHHMM(h: number): string {
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
}

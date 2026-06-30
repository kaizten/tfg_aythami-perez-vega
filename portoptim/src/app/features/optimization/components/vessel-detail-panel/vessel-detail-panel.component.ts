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
  waitingTime?: string;
  durationEstimated?: string;
  durationSource?: string;
  pilotAssigned?: boolean;
  tugsRequired?: number;
  tugsAssigned?: boolean;
  pilotWaitH?: number;
  tugWaitH?: number;
  optimizerStatus?: string;
  phases?: OperationPhase[];
  canAddDelay?: boolean;
  delayHours?: number;
  scheduledStartMs?: number;
  etaMs?: number;
}

/* Fixed - mapping from operation phase name to its Tailwind background color class */
const PHASE_COLORS: Record<string, string> = {
  delay:                'bg-red-500',
  fondeo:               'bg-amber-400',
  fondeo_resource_wait: 'bg-orange-400',
  atraque:              'bg-sky-500',
  ejecucion:            'bg-emerald-500',
  desatraque:           'bg-violet-500',
  waiting_undock:       'bg-violet-300',
};

@Component({
  selector: 'app-vessel-detail-panel',
  standalone: false,
  templateUrl: './vessel-detail-panel.component.html',
  styleUrl: './vessel-detail-panel.component.scss',
})
export class VesselDetailPanelComponent {
  /* User-provided - vessel data object to display in the panel */
  @Input() vessel: VesselDetail | null = null;
  /* User-provided - controls whether the panel is currently visible */
  @Input() isOpen = false;
  /* User-provided - emits when the user closes the panel */
  @Output() close    = new EventEmitter<void>();
  /* User-provided - emits when the user confirms the current vessel operation */
  @Output() confirm  = new EventEmitter<void>();
  /* User-provided - emits the delay in hours when the user submits a delay */
  @Output() addDelay = new EventEmitter<number>();

  /* Computed - controls visibility of the inline delay input form */
  showDelayInput = false;
  /* Computed - the pending delay value (hours) typed by the user before submission */
  pendingDelayH  = 1;

  /* Computed - true when the vessel status indicates it is still en route */
  get isOnTheWay(): boolean      { return this.vessel?.status === 'vessel.status.on_the_way'; }
  /* Computed - true when the vessel status indicates its operation is underway */
  get isInProgress(): boolean    { return this.vessel?.status === 'vessel.status.in_progress'; }
  /* Computed - true when the vessel status indicates it has finished and departed */
  get isCompleted(): boolean     { return this.vessel?.status === 'vessel.status.completed'; }
  /* Computed - true when the panel was opened from the optimizer view (has optimizer-specific fields) */
  get isOptimizerMode(): boolean { return !!this.vessel?.optimizerStatus; }

  /*
   * Emits the pending delay value to the parent and resets the delay input form.
   */
  applyDelay(): void {
    if (this.pendingDelayH > 0) {
      this.addDelay.emit(this.pendingDelayH);
      this.showDelayInput = false;
      this.pendingDelayH  = 1;
    }
  }

  /*
   * Returns the Tailwind background color class for a given phase name.
   * @param name - The phase name key (e.g. "fondeo", "atraque") (required)
   * @returns Tailwind class string, falling back to "bg-slate-400" for unknown phases
   */
  phaseColorClass(name: string): string {
    return PHASE_COLORS[name] ?? 'bg-slate-400';
  }

  /*
   * Formats an ISO-8601 datetime string into a short localised display string.
   * @param iso - ISO-8601 datetime string (required)
   * @returns Localised string such as "3 ene, 14:30"
   */
  formatPhaseTime(iso: string): string {
    return new Date(iso).toLocaleString('es-ES', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  /*
   * Sums the duration of all phases for the current vessel.
   * @returns Total phase duration in hours, or 0 if no phases are present
   */
  totalPhaseDuration(): number {
    return (this.vessel?.phases ?? []).reduce((s, p) => s + p.duration_h, 0);
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
}

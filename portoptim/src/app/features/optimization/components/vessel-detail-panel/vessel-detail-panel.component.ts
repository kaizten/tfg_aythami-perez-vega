import { Component, EventEmitter, Input, Output } from '@angular/core';

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
}

@Component({
  selector: 'app-vessel-detail-panel',
  standalone: false,
  templateUrl: './vessel-detail-panel.component.html',
  styleUrl: './vessel-detail-panel.component.scss',
})
export class VesselDetailPanelComponent {
  @Input() vessel: VesselDetail | null = null;
  @Input() isOpen = false;
  @Output() close = new EventEmitter<void>();
}

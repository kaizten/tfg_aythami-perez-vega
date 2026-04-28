import { Component, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { BerthCall, TransformApiResponse } from '../../core/models/api.models';
import { PortOptimApiService } from '../../core/services/portoptim-api.service';
import { TransformationStoreService } from '../../core/services/transformation-store.service';

interface Column { name: string; key: keyof BerthCall; valid: boolean; }

const PREVIEW_COLUMNS: Column[] = [
  { name: 'Call ID',      key: 'call_id',        valid: true },
  { name: 'Berth',        key: 'berth_id',       valid: true },
  { name: 'Arrival',      key: 'arrival_time',   valid: true },
  { name: 'Departure',    key: 'departure_time', valid: true },
  { name: 'LOA (m)',      key: 'vessel_length',  valid: true },
  { name: 'GT',           key: 'vessel_gt',      valid: true },
  { name: 'Operation',    key: 'operation_type', valid: true },
  { name: 'Cargo Group',  key: 'cargo_group',    valid: true },
  { name: 'Quantity',     key: 'quantity',       valid: true },
  { name: 'Duration (h)', key: 'duration_hours', valid: true },
];

@Component({
  selector: 'app-data-input',
  standalone: false,
  templateUrl: './data-input.component.html',
  styleUrl: './data-input.component.scss',
})
export class DataInputComponent implements OnDestroy {
  selectedFile: File | null = null;
  loading = false;
  error: string | null = null;
  result: TransformApiResponse | null = null;

  readonly columns = PREVIEW_COLUMNS;

  private sub?: Subscription;

  constructor(
    private api: PortOptimApiService,
    private store: TransformationStoreService,
    private router: Router,
  ) {
    // Restore previous result if the user navigates back
    this.result = this.store.snapshot;
  }

  get hasResult(): boolean { return this.result !== null; }
  get previewRows(): BerthCall[] { return this.result?.data.slice(0, 10) ?? []; }

  get skippedWithDates(): string[] {
    return (this.result?.transformation_summary.skipped_reasons ?? []).filter(r =>
      r.toLowerCase().includes('date')
    );
  }

  formatCell(row: BerthCall, key: keyof BerthCall): string {
    const val = row[key];
    if (val === null || val === undefined) return '—';
    if (key === 'arrival_time' || key === 'departure_time') {
      return new Date(val as string).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    }
    if (key === 'duration_hours') return `${(val as number).toFixed(1)}h`;
    return String(val);
  }

  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.upload(input.files[0]);
  }

  onFileDrop(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) this.upload(file);
  }

  upload(file: File): void {
    this.selectedFile = file;
    this.error = null;
    this.result = null;
    this.loading = true;

    this.sub = this.api.transformFile(file).subscribe({
      next: (res) => {
        this.result = res;
        this.store.set(res);
        this.loading = false;
      },
      error: (err: Error) => {
        this.error = err.message;
        this.loading = false;
      },
    });
  }

  goToOptimization(): void {
    this.router.navigate(['/optimization']);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}

import { Component, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  BerthCall,
  MooringZoneConfig,
  OptimizationParams,
  TransformApiResponse,
} from '../../core/models/api.models';
import { LanguageService } from '../../core/services/language.service';
import { OptimizationParamsStoreService } from '../../core/services/optimization-params-store.service';
import { PortOptimApiService } from '../../core/services/portoptim-api.service';
import { TransformationStoreService } from '../../core/services/transformation-store.service';

interface Column { name: string; key: keyof BerthCall; valid: boolean; }

const COLUMN_KEYS: { key: keyof BerthCall; tKey: string }[] = [
  { key: 'call_id',        tKey: 'di.col.call_id' },
  { key: 'berth_id',       tKey: 'di.col.mooring_zone' },
  { key: 'arrival_time',   tKey: 'di.col.berthing' },
  { key: 'departure_time', tKey: 'di.col.unberthing' },
  { key: 'vessel_length',  tKey: 'di.col.loa' },
  { key: 'vessel_gt',      tKey: 'di.col.gt' },
  { key: 'operation_type', tKey: 'di.col.op_type' },
  { key: 'cargo_group',    tKey: 'di.col.cargo_group' },
  { key: 'quantity',       tKey: 'di.col.quantity' },
  { key: 'duration_hours', tKey: 'di.col.duration' },
];

function uniqueOrdered(records: BerthCall[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of records) {
    if (!seen.has(r.berth_id)) { seen.add(r.berth_id); out.push(r.berth_id); }
  }
  return out;
}

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

  optimizationParams: OptimizationParams = { num_pilots: null, num_tugs: null, mooring_zones: [] };

  private sub?: Subscription;

  constructor(
    private api: PortOptimApiService,
    private store: TransformationStoreService,
    private paramsStore: OptimizationParamsStoreService,
    private router: Router,
    readonly lang: LanguageService,
  ) {
    this.result = this.store.snapshot;
    const saved = this.paramsStore.snapshot;
    if (saved) this.optimizationParams = { ...saved };
  }

  // ── Getters ──────────────────────────────────────────────────────────────

  get columns(): Column[] {
    return COLUMN_KEYS.map(c => ({ name: this.lang.t(c.tKey), key: c.key, valid: true }));
  }

  get hasResult(): boolean { return this.result !== null; }
  get previewRows(): BerthCall[] { return this.result?.data.slice(0, 10) ?? []; }
  get uniqueBerths(): string[] { return this.result ? uniqueOrdered(this.result.data) : []; }

  // ── Formatting ────────────────────────────────────────────────────────────

  formatCell(row: BerthCall, key: keyof BerthCall): string {
    const val = row[key];
    if (val === null || val === undefined) return '—';
    if (key === 'arrival_time' || key === 'departure_time') {
      return new Date(val as string).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    }
    if (key === 'duration_hours') return `${(val as number).toFixed(1)}h`;
    return String(val);
  }

  // ── File handling ─────────────────────────────────────────────────────────

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
    this.optimizationParams = { num_pilots: null, num_tugs: null, mooring_zones: [] };
    this.loading = true;

    this.sub = this.api.transformFile(file).subscribe({
      next: (res) => {
        this.result = res;
        this.store.set(res);
        this._syncMooringZones();
        this.loading = false;
      },
      error: (err: Error) => {
        this.error = err.message;
        this.loading = false;
      },
    });
  }

  goToOptimization(): void {
    if (!this.result) return;
    this.paramsStore.set(this.optimizationParams);
    this.router.navigate(['/optimization']);
  }

  ngOnDestroy(): void {
    this.paramsStore.set(this.optimizationParams);
    this.sub?.unsubscribe();
  }

  private _syncMooringZones(): void {
    const berths = uniqueOrdered(this.result?.data ?? []);
    const prev = new Map<string, MooringZoneConfig>(
      this.optimizationParams.mooring_zones.map(z => [z.berth_id, z])
    );
    this.optimizationParams.mooring_zones = berths.map(id =>
      prev.get(id) ?? { berth_id: id, bap_type: 'continuous', noray_max: null, capacity: null }
    );
  }
}

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
  /** True once the user has clicked "Proceed" at least once — enables inline error hints. */
  submitted = false;
  savedConfigBanner = false;
  private savedConfigForBerths: OptimizationParams | null = null;
  newBerthId = '';
  newBerthError = false;
  private csvBerthIds = new Set<string>();

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

  /** Returns a list of human-readable validation errors for the params form. */
  get paramErrors(): string[] {
    const errors: string[] = [];
    const p = this.optimizationParams;

    if (p.num_pilots === null || p.num_pilots === undefined || (p.num_pilots as unknown as string) === '' || p.num_pilots < 1) {
      errors.push(this.lang.t('di.params.err.pilots'));
    }
    if (p.num_tugs === null || p.num_tugs === undefined || (p.num_tugs as unknown as string) === '' || p.num_tugs < 1) {
      errors.push(this.lang.t('di.params.err.tugs'));
    }
    for (const zone of p.mooring_zones) {
      if (zone.bap_type === 'continuous' && (zone.noray_max === null || zone.noray_max === undefined || zone.noray_max < 1)) {
        errors.push(`${this.lang.t('di.params.err.zone_noray')} "${zone.berth_id}"`);
      }
      if (zone.bap_type === 'discrete' && (zone.capacity === null || zone.capacity === undefined || zone.capacity < 1)) {
        errors.push(`${this.lang.t('di.params.err.zone_capacity')} "${zone.berth_id}"`);
      }
    }
    return errors;
  }

  get paramsValid(): boolean { return this.paramErrors.length === 0; }

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
    this.newBerthId = '';
    this.newBerthError = false;
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
    this.submitted = true;
    if (!this.paramsValid) return;
    this.paramsStore.set(this.optimizationParams);
    this.saveToStorage();
    this.router.navigate(['/optimization']);
  }

  ngOnDestroy(): void {
    this.paramsStore.set(this.optimizationParams);
    this.saveToStorage();
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
    this.csvBerthIds = new Set(berths);
    const raw = localStorage.getItem(this.localStorageKey(berths));
    if (raw) {
      try {
        this.savedConfigForBerths = JSON.parse(raw) as OptimizationParams;
        this.savedConfigBanner = true;
      } catch {
        this.savedConfigForBerths = null;
      }
    }
  }

  // ── Config persistence ────────────────────────────────────────────────────

  private localStorageKey(berths: string[]): string {
    return 'portoptim_config_' + [...berths].sort().join('|');
  }

  private saveToStorage(): void {
    if (!this.hasResult) return;
    localStorage.setItem(this.localStorageKey(this.uniqueBerths), JSON.stringify(this.optimizationParams));
  }

  applySavedConfig(): void {
    const saved = this.savedConfigForBerths;
    if (!saved) return;
    this.optimizationParams.num_pilots = saved.num_pilots;
    this.optimizationParams.num_tugs = saved.num_tugs;
    const savedMap = new Map(saved.mooring_zones.map(z => [z.berth_id, z]));
    this.optimizationParams.mooring_zones = this.optimizationParams.mooring_zones.map(
      z => savedMap.get(z.berth_id) ?? z
    );
    this.savedConfigBanner = false;
  }

  dismissSavedConfig(): void {
    this.savedConfigBanner = false;
  }

  exportConfig(): void {
    const json = JSON.stringify(this.optimizationParams, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portoptim-config-${this.uniqueBerths.slice(0, 3).join('-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target?.result as string) as OptimizationParams;
        if (typeof parsed.num_pilots === 'number') this.optimizationParams.num_pilots = parsed.num_pilots;
        if (typeof parsed.num_tugs === 'number') this.optimizationParams.num_tugs = parsed.num_tugs;
        if (Array.isArray(parsed.mooring_zones)) {
          const importedMap = new Map(parsed.mooring_zones.map(z => [z.berth_id, z]));
          this.optimizationParams.mooring_zones = this.optimizationParams.mooring_zones.map(
            z => importedMap.get(z.berth_id) ?? z
          );
        }
      } catch { /* invalid file — ignore */ }
      input.value = '';
    };
    reader.readAsText(file);
  }

  // ── Berth management ──────────────────────────────────────────────────────

  isCsvBerth(berthId: string): boolean {
    return this.csvBerthIds.has(berthId);
  }

  addBerth(): void {
    const id = this.newBerthId.trim();
    if (!id) return;
    if (this.optimizationParams.mooring_zones.some(z => z.berth_id === id)) {
      this.newBerthError = true;
      return;
    }
    this.optimizationParams.mooring_zones = [
      ...this.optimizationParams.mooring_zones,
      { berth_id: id, bap_type: 'continuous', noray_max: null, capacity: null },
    ];
    this.newBerthId = '';
    this.newBerthError = false;
  }

  removeBerth(berthId: string): void {
    if (this.csvBerthIds.has(berthId)) return;
    this.optimizationParams.mooring_zones = this.optimizationParams.mooring_zones.filter(
      z => z.berth_id !== berthId
    );
  }
}

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

/* Fixed - ordered list of BerthCall property keys and their i18n translation keys for the preview table columns */
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

/*
 * Returns an ordered array of unique berth IDs from the records, preserving first-occurrence order.
 * @param records - Array of BerthCall objects from the transformation result (required)
 * @returns Deduplicated berth ID strings in first-seen order
 */
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
  /* User-provided - file selected by the user via the file picker or drag-and-drop */
  selectedFile: File | null = null;
  /* Computed - whether an upload/transform API request is currently in-flight */
  loading = false;
  /* Computed - error message from the last failed API call, null when no error is present */
  error: string | null = null;
  /* Computed - transformation result received from the API after a successful upload */
  result: TransformApiResponse | null = null;

  /* User-provided - pilot and tug resource counts and mooring zone configurations entered by the user */
  optimizationParams: OptimizationParams = { num_pilots: null, num_tugs: null, mooring_zones: [] };
  /* Computed - true once the user has clicked Proceed at least once, enabling inline validation hints */
  submitted = false;
  /* Computed - whether the saved-config restore banner should be displayed */
  savedConfigBanner = false;
  /* Computed - previously saved optimization config matching the current berth set, or null if none found */
  private savedConfigForBerths: OptimizationParams | null = null;
  /* User-provided - berth ID text entered in the manual add-berth input field */
  newBerthId = '';
  /* Computed - whether the add-berth input has a duplicate ID error */
  newBerthError = false;
  /* User-provided - search query for filtering the mooring zones list */
  berthSearchQuery = '';
  /* Computed - set of berth IDs that originated from the uploaded CSV, used to prevent deletion */
  private csvBerthIds = new Set<string>();

  /* Computed - active subscription to the file upload Observable */
  private sub?: Subscription;

  constructor(
    private api: PortOptimApiService,
    private store: TransformationStoreService,
    private paramsStore: OptimizationParamsStoreService,
    private router: Router,
    readonly lang: LanguageService,
  ) {
    this.result = this.store.snapshot;
    if (this.result) {
      this.csvBerthIds = new Set(uniqueOrdered(this.result.data));
    }
    const saved = this.paramsStore.snapshot;
    if (saved) this.optimizationParams = { ...saved };

    const alreadyConfigured = (this.optimizationParams.num_pilots ?? 0) > 0
                           && (this.optimizationParams.num_tugs   ?? 0) > 0;
    if (this.result && !alreadyConfigured) {
      this._checkSavedConfig(uniqueOrdered(this.result.data));
    }
  }

  /*
   * Returns the translated column definitions for the data preview table.
   * @returns Array of Column objects with name, key, and valid flag
   */
  get columns(): Column[] {
    return COLUMN_KEYS.map(c => ({ name: this.lang.t(c.tKey), key: c.key, valid: true }));
  }

  /*
   * Returns true when a transformation result is available.
   * @returns Boolean indicating whether result is non-null
   */
  get hasResult(): boolean { return this.result !== null; }

  /*
   * Returns the first ten berth call records for the preview table.
   * @returns Slice of up to ten BerthCall objects, or an empty array if no result is loaded
   */
  get previewRows(): BerthCall[] { return this.result?.data.slice(0, 10) ?? []; }

  /*
   * Returns the ordered list of unique berth IDs present in the current result.
   * @returns Array of unique berth ID strings in first-seen order
   */
  get uniqueBerths(): string[] { return this.result ? uniqueOrdered(this.result.data) : []; }

  /*
   * Returns the mooring zones filtered by the current berth search query for display purposes only.
   * @returns Filtered subset of optimizationParams.mooring_zones matching the search query
   */
  get filteredMooringZones() {
    const q = this.berthSearchQuery.trim().toLowerCase();
    if (!q) return this.optimizationParams.mooring_zones;
    return this.optimizationParams.mooring_zones.filter(z =>
      z.berth_id.toLowerCase().includes(q)
    );
  }

  /*
   * Returns a list of human-readable validation error messages for the params form.
   * @returns Array of translated error strings, empty when the form is valid
   */
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

  /*
   * Returns true when the params form has no validation errors.
   * @returns Boolean indicating whether paramErrors is empty
   */
  get paramsValid(): boolean { return this.paramErrors.length === 0; }

  /*
   * Formats a BerthCall cell value for display in the preview table, localizing dates and units.
   * @param row - The BerthCall record containing the value to format (required)
   * @param key - The property key of the value to format (required)
   * @returns Formatted string for display, or '—' for null/undefined values
   */
  formatCell(row: BerthCall, key: keyof BerthCall): string {
    const val = row[key];
    if (val === null || val === undefined) return '—';
    if (key === 'arrival_time' || key === 'departure_time') {
      return new Date(val as string).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    }
    if (key === 'duration_hours') return `${(val as number).toFixed(1)}h`;
    return String(val);
  }

  /*
   * Handles the native file input change event and initiates the file upload.
   * @param event - The DOM change event from the file input element (required)
   */
  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.upload(input.files[0]);
  }

  /*
   * Handles a file drag-and-drop event and initiates the file upload.
   * @param event - The DOM DragEvent containing the dropped file (required)
   */
  onFileDrop(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) this.upload(file);
  }

  /*
   * Uploads the given file to the transformation API, resets state, and populates the result on success.
   * @param file - The CSV or Excel file to upload and transform (required)
   */
  upload(file: File): void {
    this.selectedFile = file;
    this.error = null;
    this.result = null;
    this.optimizationParams = { num_pilots: null, num_tugs: null, mooring_zones: [] };
    this.newBerthId = '';
    this.newBerthError = false;
    this.berthSearchQuery = '';
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

  /*
   * Validates the params form and navigates to the optimization page if valid.
   */
  goToOptimization(): void {
    if (!this.result) return;
    this.submitted = true;
    if (!this.paramsValid) return;
    this.paramsStore.set(this.optimizationParams);
    this.router.navigate(['/optimization']);
  }

  /*
   * Persists the current params to the in-memory store before the component is destroyed, without writing to localStorage.
   */
  ngOnDestroy(): void {
    this.paramsStore.set(this.optimizationParams);
    this.sub?.unsubscribe();
  }

  /*
   * Rebuilds the mooring zones list from the current result, preserving any previously configured zone settings.
   */
  private _syncMooringZones(): void {
    const berths = uniqueOrdered(this.result?.data ?? []);
    const prev = new Map<string, MooringZoneConfig>(
      this.optimizationParams.mooring_zones.map(z => [z.berth_id, z])
    );
    this.optimizationParams.mooring_zones = berths.map(id =>
      prev.get(id) ?? { berth_id: id, bap_type: 'continuous', noray_max: null, capacity: null }
    );
    this.csvBerthIds = new Set(berths);
    this._checkSavedConfig(berths);
  }

  /*
   * Derives a localStorage key unique to the given ordered set of berth IDs.
   * @param berths - Ordered array of berth ID strings (required)
   * @returns localStorage key string for the matching config entry
   */
  private localStorageKey(berths: string[]): string {
    return 'portoptim_config_' + [...berths].sort().join('|');
  }

  /*
   * Checks localStorage for a previously saved config matching the given berth list and surfaces the restore banner if found.
   * @param berths - Ordered array of berth IDs from the current result (required)
   */
  private _checkSavedConfig(berths: string[]): void {
    const raw = localStorage.getItem(this.localStorageKey(berths));
    if (!raw) return;
    try {
      this.savedConfigForBerths = JSON.parse(raw) as OptimizationParams;
      this.savedConfigBanner = true;
    } catch {
      this.savedConfigForBerths = null;
    }
  }

  /*
   * Applies the saved configuration pilots, tugs, and matching mooring zones to the current params.
   */
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

  /*
   * Hides the saved-config restore banner without applying the saved values.
   */
  dismissSavedConfig(): void {
    this.savedConfigBanner = false;
  }

  /*
   * Exports the current optimization parameters as a downloadable JSON file.
   */
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

  /*
   * Reads a JSON config file selected by the user and merges its values into the current optimization params.
   * @param event - The DOM change event from the import file input element (required)
   */
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

  /*
   * Returns whether the given berth ID originated from the uploaded CSV and is therefore protected from deletion.
   * @param berthId - The berth identifier to check (required)
   * @returns True if the berth was present in the uploaded CSV
   */
  isCsvBerth(berthId: string): boolean {
    return this.csvBerthIds.has(berthId);
  }

  /*
   * Adds a new manually entered berth to the mooring zones list if the ID is non-empty and not already present.
   */
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

  /*
   * Removes a manually added berth from the mooring zones list, refusing to remove CSV-originated berths.
   * @param berthId - The berth identifier to remove (required)
   */
  removeBerth(berthId: string): void {
    if (this.csvBerthIds.has(berthId)) return;
    this.optimizationParams.mooring_zones = this.optimizationParams.mooring_zones.filter(
      z => z.berth_id !== berthId
    );
  }
}

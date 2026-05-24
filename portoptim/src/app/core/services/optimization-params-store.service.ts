import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { OptimizationParams } from '../models/api.models';

const LS_PREFIX = 'portoptim_config_';

/** In-memory singleton store that shares optimization parameters across pages. */
@Injectable({ providedIn: 'root' })
export class OptimizationParamsStoreService {
  private readonly _params$ = new BehaviorSubject<OptimizationParams | null>(null);
  readonly params$ = this._params$.asObservable();

  get snapshot(): OptimizationParams | null {
    return this._params$.value;
  }

  set(params: OptimizationParams): void {
    this._params$.next(params);
  }

  clear(): void {
    this._params$.next(null);
  }

  /**
   * Persists the current params to localStorage, keyed by the sorted list of
   * mooring-zone berth IDs.
   *
   * Call this ONLY when a complete, validated config has been successfully used
   * to run the optimizer — never on page navigation or partial state saves.
   */
  persistToLocalStorage(): void {
    const params = this._params$.value;
    if (!params?.mooring_zones?.length) return;
    const key = LS_PREFIX + [...params.mooring_zones.map(z => z.berth_id)].sort().join('|');
    localStorage.setItem(key, JSON.stringify(params));
  }
}

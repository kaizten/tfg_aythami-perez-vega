import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { OptimizationParams } from '../models/api.models';

/* Fixed - localStorage key prefix used when persisting optimization configuration */
const LS_PREFIX = 'portoptim_config_';

@Injectable({ providedIn: 'root' })
export class OptimizationParamsStoreService {
  /* Computed - internal BehaviorSubject holding the current optimization parameters */
  private readonly _params$ = new BehaviorSubject<OptimizationParams | null>(null);
  /* Computed - public Observable stream of the current optimization parameters */
  readonly params$ = this._params$.asObservable();

  /*
   * Returns the current optimization parameters without subscribing.
   * @returns The current OptimizationParams snapshot or null if not yet set
   */
  get snapshot(): OptimizationParams | null {
    return this._params$.value;
  }

  /*
   * Replaces the stored optimization parameters and notifies all subscribers.
   * @param params - The new optimization parameters to store (required)
   */
  set(params: OptimizationParams): void {
    this._params$.next(params);
  }

  /*
   * Resets the stored optimization parameters to null and notifies all subscribers.
   */
  clear(): void {
    this._params$.next(null);
  }

  /*
   * Persists the current parameters to localStorage keyed by the sorted list of mooring-zone berth IDs.
   * Should only be called after a successful optimizer run with a complete, validated configuration.
   */
  persistToLocalStorage(): void {
    const params = this._params$.value;
    if (!params?.mooring_zones?.length) return;
    const key = LS_PREFIX + [...params.mooring_zones.map(z => z.berth_id)].sort().join('|');
    localStorage.setItem(key, JSON.stringify(params));
  }
}

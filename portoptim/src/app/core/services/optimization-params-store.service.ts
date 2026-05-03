import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { OptimizationParams } from '../models/api.models';

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
}

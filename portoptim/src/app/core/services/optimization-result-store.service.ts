import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { OptimizationApiResult } from '../models/api.models';

/** In-memory singleton store that shares the last optimizer result across pages. */
@Injectable({ providedIn: 'root' })
export class OptimizationResultStoreService {
  private readonly _result$ = new BehaviorSubject<OptimizationApiResult | null>(null);
  readonly result$ = this._result$.asObservable();

  get snapshot(): OptimizationApiResult | null {
    return this._result$.value;
  }

  set(result: OptimizationApiResult): void {
    this._result$.next(result);
  }

  clear(): void {
    this._result$.next(null);
  }
}

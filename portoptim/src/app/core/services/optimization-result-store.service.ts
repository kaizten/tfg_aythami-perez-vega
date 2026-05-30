import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { OptimizationApiResult } from '../models/api.models';

/** In-memory singleton store that shares the last optimizer result across pages. */
@Injectable({ providedIn: 'root' })
export class OptimizationResultStoreService {
  private readonly _result$ = new BehaviorSubject<OptimizationApiResult | null>(null);
  readonly result$ = this._result$.asObservable();

  /**
   * Last Gantt window index selected by the user via prevDay / nextDay.
   * -1 means "not yet set by the user" → the Gantt component will fall back to
   * the window that contains today's date.
   * Reset to -1 whenever a brand-new optimization result is stored.
   */
  ganttWindowIndex = -1;

  get snapshot(): OptimizationApiResult | null {
    return this._result$.value;
  }

  set(result: OptimizationApiResult): void {
    this.ganttWindowIndex = -1;   // New result → reset to today's window.
    this._result$.next(result);
  }

  clear(): void {
    this.ganttWindowIndex = -1;
    this._result$.next(null);
  }
}

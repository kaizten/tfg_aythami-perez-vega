import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { OptimizationApiResult } from '../models/api.models';

@Injectable({ providedIn: 'root' })
export class OptimizationResultStoreService {
  /* Computed - internal BehaviorSubject holding the latest optimization result */
  private readonly _result$ = new BehaviorSubject<OptimizationApiResult | null>(null);
  /* Computed - public Observable stream of the latest optimization result */
  readonly result$ = this._result$.asObservable();

  /* Computed - last Gantt window index selected by the user; -1 means fall back to the window containing today */
  ganttWindowIndex = -1;

  /*
   * Returns the current optimization result without subscribing.
   * @returns The current OptimizationApiResult snapshot or null if not yet set
   */
  get snapshot(): OptimizationApiResult | null {
    return this._result$.value;
  }

  /*
   * Stores a new optimization result, resets the Gantt window index, and notifies all subscribers.
   * @param result - The new optimization result to store (required)
   */
  set(result: OptimizationApiResult): void {
    this.ganttWindowIndex = -1;
    this._result$.next(result);
  }

  /*
   * Resets the stored result and Gantt window index to their initial states and notifies all subscribers.
   */
  clear(): void {
    this.ganttWindowIndex = -1;
    this._result$.next(null);
  }
}

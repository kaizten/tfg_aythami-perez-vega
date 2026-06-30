import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TransformApiResponse } from '../models/api.models';

@Injectable({ providedIn: 'root' })
export class TransformationStoreService {
  /* Computed - internal BehaviorSubject holding the latest transformation result */
  private readonly _result$ = new BehaviorSubject<TransformApiResponse | null>(null);
  /* Computed - public Observable stream of the latest transformation result */
  readonly result$ = this._result$.asObservable();

  /*
   * Returns the current transformation result without subscribing.
   * @returns The current TransformApiResponse snapshot or null if not yet set
   */
  get snapshot(): TransformApiResponse | null {
    return this._result$.value;
  }

  /*
   * Stores a new transformation result and notifies all subscribers.
   * @param result - The transformation API response to store (required)
   */
  set(result: TransformApiResponse): void {
    this._result$.next(result);
  }

  /*
   * Resets the stored transformation result to null and notifies all subscribers.
   */
  clear(): void {
    this._result$.next(null);
  }
}

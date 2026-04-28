import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TransformApiResponse } from '../models/api.models';

/** In-memory singleton store that shares the last transformation result across pages. */
@Injectable({ providedIn: 'root' })
export class TransformationStoreService {
  private readonly _result$ = new BehaviorSubject<TransformApiResponse | null>(null);
  readonly result$ = this._result$.asObservable();

  get snapshot(): TransformApiResponse | null {
    return this._result$.value;
  }

  set(result: TransformApiResponse): void {
    this._result$.next(result);
  }

  clear(): void {
    this._result$.next(null);
  }
}

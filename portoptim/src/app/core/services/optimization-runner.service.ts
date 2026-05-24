import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Subscription } from 'rxjs';
import { OptimizationApiRequest } from '../models/api.models';
import { OptimizationParamsStoreService } from './optimization-params-store.service';
import { OptimizationResultStoreService } from './optimization-result-store.service';
import { PortOptimApiService } from './portoptim-api.service';

/**
 * Singleton service that owns the optimizer API subscription so it survives
 * Angular component navigation (ngOnDestroy no longer cancels the HTTP call).
 *
 * Components should call {@link run} to start optimization and subscribe to
 * {@link isRunning$}, {@link error$} and {@link showNotification$} for state.
 */
@Injectable({ providedIn: 'root' })
export class OptimizationRunnerService {

  private readonly _isRunning$        = new BehaviorSubject<boolean>(false);
  private readonly _error$            = new BehaviorSubject<string | null>(null);
  private readonly _showNotification$ = new BehaviorSubject<boolean>(false);

  readonly isRunning$        = this._isRunning$.asObservable();
  readonly error$            = this._error$.asObservable();
  /** Emits true when the optimization finishes and the user is NOT on /optimization. */
  readonly showNotification$ = this._showNotification$.asObservable();

  get isRunning(): boolean       { return this._isRunning$.value; }
  get error():     string | null { return this._error$.value;     }

  private sub?: Subscription;

  constructor(
    private api:         PortOptimApiService,
    private paramsStore: OptimizationParamsStoreService,
    private resultStore: OptimizationResultStoreService,
    private router:      Router,
  ) {}

  /** Starts a new optimization run (no-op if one is already in progress). */
  run(request: OptimizationApiRequest): void {
    if (this._isRunning$.value) return;

    this._isRunning$.next(true);
    this._error$.next(null);
    this.resultStore.clear();
    this.sub?.unsubscribe();

    this.sub = this.api.runOptimization(request).subscribe({
      next: res => {
        this.resultStore.set(res);
        // Persist the validated config only when the optimizer succeeds.
        this.paramsStore.persistToLocalStorage();
        this._isRunning$.next(false);
        // Show the completion toast only when the user has navigated away.
        if (!this.router.url.startsWith('/optimization')) {
          this._showNotification$.next(true);
        }
      },
      error: (err: Error) => {
        this._error$.next(err.message);
        this._isRunning$.next(false);
      },
    });
  }

  /** Cancels an in-progress run and resets state. */
  cancelRun(): void {
    this.sub?.unsubscribe();
    this._isRunning$.next(false);
    this._error$.next(null);
  }

  clearError(): void {
    this._error$.next(null);
  }

  dismissNotification(): void {
    this._showNotification$.next(false);
  }
}

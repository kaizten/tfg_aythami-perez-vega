import { Injectable } from '@angular/core';
import { Router } from '@angular/router';

export interface EarlyCompleteInfo {
  /* Computed - hours the vessel waited at berth for undocking resources (0 = immediate) */
  waitingUndockH:   number;
  /* Computed - true when at least one fondeo vessel for this berth was rescheduled */
  replanTriggered:  boolean;
  /* Computed - how many hours earlier the berth is freed vs. the original schedule */
  berthFreedDeltaH: number;
}
import { BehaviorSubject, Subscription } from 'rxjs';
import {
  EarlyCompleteRequest,
  OptimizationApiRequest,
  OptimizationApiResult,
  ReplanRequest,
  VesselDelay,
} from '../models/api.models';
import { OptimizationParamsStoreService } from './optimization-params-store.service';
import { OptimizationResultStoreService } from './optimization-result-store.service';
import { PortOptimApiService } from './portoptim-api.service';

@Injectable({ providedIn: 'root' })
export class OptimizationRunnerService {

  /* Computed - internal BehaviorSubject tracking whether an optimization run is in progress */
  private readonly _isRunning$             = new BehaviorSubject<boolean>(false);
  /* Computed - internal BehaviorSubject holding the last run error message, or null */
  private readonly _error$                 = new BehaviorSubject<string | null>(null);
  /* Computed - internal BehaviorSubject controlling the optimization completion toast visibility */
  private readonly _showNotification$      = new BehaviorSubject<boolean>(false);
  /* Computed - internal BehaviorSubject controlling the replan completion toast visibility */
  private readonly _showReplanNotification$ = new BehaviorSubject<boolean>(false);

  /* Computed - public Observable indicating whether an optimization run is active */
  readonly isRunning$             = this._isRunning$.asObservable();
  /* Computed - public Observable of the last run error message */
  readonly error$                 = this._error$.asObservable();
  /* Computed - emits true when the optimization finishes and the user is not on /optimization */
  readonly showNotification$      = this._showNotification$.asObservable();
  /* Computed - emits true when a replan or early-complete finishes outside /optimization */
  readonly showReplanNotification$ = this._showReplanNotification$.asObservable();

  /*
   * Returns whether an optimization run is currently in progress.
   * @returns True when a run is active
   */
  get isRunning(): boolean       { return this._isRunning$.value; }
  /*
   * Returns the last optimization error message.
   * @returns The error string or null if no error occurred
   */
  get error():     string | null { return this._error$.value;     }

  /* Computed - internal BehaviorSubject tracking whether a replan is in progress */
  private readonly _isReplanning$ = new BehaviorSubject<boolean>(false);
  /* Computed - internal BehaviorSubject holding the last replan error message, or null */
  private readonly _replanError$  = new BehaviorSubject<string | null>(null);

  /* Computed - public Observable indicating whether a replan is currently running */
  readonly isReplanning$ = this._isReplanning$.asObservable();
  /* Computed - public Observable of the last replan error message */
  readonly replanError$  = this._replanError$.asObservable();

  /*
   * Returns whether a replan is currently in progress.
   * @returns True when replanning is active
   */
  get isReplanning(): boolean      { return this._isReplanning$.value; }
  /*
   * Returns the last replan error message.
   * @returns The error string or null if no error occurred
   */
  get replanError():  string|null  { return this._replanError$.value;  }

  /* Computed - internal BehaviorSubject tracking whether an early-completion call is in progress */
  private readonly _isEarlyCompleting$  = new BehaviorSubject<boolean>(false);
  /* Computed - internal BehaviorSubject holding the last early-completion error message, or null */
  private readonly _earlyCompleteError$ = new BehaviorSubject<string | null>(null);
  /* Computed - internal BehaviorSubject holding the result details of the last early-completion call */
  private readonly _earlyCompleteInfo$  = new BehaviorSubject<EarlyCompleteInfo | null>(null);

  /* Computed - public Observable indicating whether an early-completion call is active */
  readonly isEarlyCompleting$  = this._isEarlyCompleting$.asObservable();
  /* Computed - public Observable of the last early-completion error message */
  readonly earlyCompleteError$ = this._earlyCompleteError$.asObservable();
  /* Computed - public Observable of the last early-completion result details */
  readonly earlyCompleteInfo$  = this._earlyCompleteInfo$.asObservable();

  /*
   * Returns whether an early-completion call is currently in progress.
   * @returns True when early completion is active
   */
  get isEarlyCompleting():  boolean              { return this._isEarlyCompleting$.value;  }
  /*
   * Returns the last early-completion error message.
   * @returns The error string or null if no error occurred
   */
  get earlyCompleteError(): string | null        { return this._earlyCompleteError$.value; }
  /*
   * Returns the result details of the last early-completion call.
   * @returns The EarlyCompleteInfo object or null if not yet set
   */
  get earlyCompleteInfo():  EarlyCompleteInfo | null { return this._earlyCompleteInfo$.value; }

  /* Computed - assignment list from the most recent successful operation, used as the base for replanning */
  private baseAssignments: OptimizationApiResult['assignments'] | null = null;
  /* Computed - original /run request reused by /replan with updated ETAs */
  private lastRequest: OptimizationApiRequest | null = null;
  /* Computed - accumulated total delay hours per vessel; always sent as the full total to the backend */
  private readonly vesselDelays     = new Map<string, number>();
  /* Computed - delay type per vessel; last applied type wins when multiple delays are applied */
  private readonly vesselDelayTypes = new Map<string, 'arrival' | 'operation'>();
  /* Computed - accumulated early-arrival hours per vessel */
  private readonly earlyArrivals    = new Map<string, number>();

  /* Computed - active HTTP subscription, replaced on each new run or replan */
  private sub?: Subscription;

  constructor(
    private api:         PortOptimApiService,
    private paramsStore: OptimizationParamsStoreService,
    private resultStore: OptimizationResultStoreService,
    private router:      Router,
  ) {}

  /*
   * Starts a new optimization run using the provided request payload. No-op if a run is already in progress.
   * @param request - The full optimization API request including vessels and configuration (required)
   */
  run(request: OptimizationApiRequest): void {
    if (this._isRunning$.value) return;

    this._isRunning$.next(true);
    this._error$.next(null);
    this.resultStore.clear();
    this.sub?.unsubscribe();

    this.lastRequest = request;

    this.sub = this.api.runOptimization(request).subscribe({
      next: res => {
        this.baseAssignments = res.assignments;
        this.vesselDelays.clear();
        this.vesselDelayTypes.clear();
        this.earlyArrivals.clear();

        this.resultStore.set(res);
        this.paramsStore.persistToLocalStorage();
        this._earlyCompleteInfo$.next(null);
        this._earlyCompleteError$.next(null);
        this._isRunning$.next(false);
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

  /*
   * Accumulates a delay increment for the given vessel and triggers a replan call to the backend.
   * Sends the full accumulated total delay so that replan calls are idempotent.
   * @param vesselId - Vessel identifier (required)
   * @param deltaHours - Additional delay hours to add to the vessel's total (required)
   * @param delayType - Whether the vessel is en route or already at berth (optional, defaults to 'arrival')
   */
  applyDelay(
    vesselId: string,
    deltaHours: number,
    delayType: 'arrival' | 'operation' = 'arrival',
  ): void {
    if (this._isReplanning$.value) return;

    const previous = this.vesselDelays.get(vesselId) ?? 0;
    const newTotal  = previous + deltaHours;
    this.vesselDelays.set(vesselId, newTotal);
    this.vesselDelayTypes.set(vesselId, delayType);

    const base = this.baseAssignments;
    const req  = this.lastRequest;
    if (!base || !req) return;

    const delays: VesselDelay[] = [];
    for (const [vid, dh] of this.vesselDelays.entries()) {
      if (dh > 0) {
        delays.push({
          vessel_id:  vid,
          delay_h:    dh,
          delay_type: this.vesselDelayTypes.get(vid) ?? 'arrival',
        });
      }
    }

    const replanReq: ReplanRequest = {
      base_assignments: base,
      delays,
      config:   req.config,
      vessels:  req.vessels,
    };

    this._isReplanning$.next(true);
    this._replanError$.next(null);
    this.sub?.unsubscribe();

    this.sub = this.api.replan(replanReq).subscribe({
      next: res => {
        const preservedImprovement = this.resultStore.snapshot?.kpis.improvement_vs_greedy_pct;
        const result: OptimizationApiResult = {
          assignments: res.assignments,
          kpis: preservedImprovement !== undefined
            ? { ...res.kpis, improvement_vs_greedy_pct: preservedImprovement }
            : res.kpis,
          delay_map:   res.delay_map,
        };
        this.baseAssignments = res.assignments;
        this.vesselDelays.clear();
        this.vesselDelayTypes.clear();
        this.earlyArrivals.clear();
        this.resultStore.set(result);
        this._isReplanning$.next(false);
        if (!this.router.url.startsWith('/optimization')) {
          this._showReplanNotification$.next(true);
        }
      },
      error: (err: Error) => {
        this.vesselDelays.set(vesselId, previous);
        if (previous === 0) this.vesselDelayTypes.delete(vesselId);
        this._replanError$.next(err.message);
        this._isReplanning$.next(false);
      },
    });
  }

  /*
   * Returns the total accumulated delay hours for the given vessel.
   * @param vesselId - Vessel identifier to look up (required)
   * @returns Total accumulated delay in hours (0 if none recorded)
   */
  getVesselDelay(vesselId: string): number {
    return this.vesselDelays.get(vesselId) ?? 0;
  }

  /*
   * Reports that a vessel arrived before its scheduled ETA and triggers a replan to extend the fondeo phase.
   * Berth times are not affected since the vessel simply waits longer in anchorage.
   * @param vesselId - Vessel identifier (required)
   * @param earlyH - Number of hours before ETA that the vessel arrived (required)
   */
  applyEarlyArrival(vesselId: string, earlyH: number): void {
    if (this._isReplanning$.value) return;

    const previous = this.earlyArrivals.get(vesselId) ?? 0;
    const newTotal  = previous + earlyH;
    this.earlyArrivals.set(vesselId, newTotal);

    const base = this.baseAssignments;
    const req  = this.lastRequest;
    if (!base || !req) return;

    const delays: VesselDelay[] = [];
    for (const [vid, dh] of this.vesselDelays.entries()) {
      if (dh > 0) {
        delays.push({
          vessel_id:  vid,
          delay_h:    dh,
          delay_type: this.vesselDelayTypes.get(vid) ?? 'arrival',
        });
      }
    }
    for (const [vid, eh] of this.earlyArrivals.entries()) {
      if (eh > 0) {
        delays.push({ vessel_id: vid, delay_h: eh, delay_type: 'early_arrival' });
      }
    }

    const replanReq: ReplanRequest = {
      base_assignments: base,
      delays,
      config:   req.config,
      vessels:  req.vessels,
    };

    this._isReplanning$.next(true);
    this._replanError$.next(null);
    this.sub?.unsubscribe();

    this.sub = this.api.replan(replanReq).subscribe({
      next: res => {
        const preservedImprovement = this.resultStore.snapshot?.kpis.improvement_vs_greedy_pct;
        const result: OptimizationApiResult = {
          assignments: res.assignments,
          kpis: preservedImprovement !== undefined
            ? { ...res.kpis, improvement_vs_greedy_pct: preservedImprovement }
            : res.kpis,
          delay_map:   res.delay_map,
        };
        this.baseAssignments = res.assignments;
        this.vesselDelays.clear();
        this.vesselDelayTypes.clear();
        this.earlyArrivals.clear();
        this.resultStore.set(result);
        this._isReplanning$.next(false);
        if (!this.router.url.startsWith('/optimization')) {
          this._showReplanNotification$.next(true);
        }
      },
      error: (err: Error) => {
        this.earlyArrivals.set(vesselId, previous);
        this._replanError$.next(err.message);
        this._isReplanning$.next(false);
      },
    });
  }

  /*
   * Returns the total accumulated early-arrival hours for the given vessel.
   * @param vesselId - Vessel identifier to look up (required)
   * @returns Total accumulated early-arrival hours (0 if none recorded)
   */
  getVesselEarlyArrival(vesselId: string): number {
    return this.earlyArrivals.get(vesselId) ?? 0;
  }

  /*
   * Clears the current replan error and notifies subscribers.
   */
  clearReplanError(): void {
    this._replanError$.next(null);
  }

  /*
   * Cancels an in-progress optimization run, unsubscribes from the API call, and resets run state.
   */
  cancelRun(): void {
    this.sub?.unsubscribe();
    this._isRunning$.next(false);
    this._error$.next(null);
  }

  /*
   * Clears the current optimization error and notifies subscribers.
   */
  clearError(): void {
    this._error$.next(null);
  }

  /*
   * Clears all accumulated delays and early arrivals and resets all replan and early-complete state.
   * Call this when the optimizer is fully reset so subsequent operations start from a clean slate.
   */
  resetDelays(): void {
    this.vesselDelays.clear();
    this.vesselDelayTypes.clear();
    this.earlyArrivals.clear();
    this.baseAssignments = null;
    this._replanError$.next(null);
    this._isReplanning$.next(false);
    this._earlyCompleteInfo$.next(null);
    this._earlyCompleteError$.next(null);
    this._isEarlyCompleting$.next(false);
    this._showReplanNotification$.next(false);
  }

  /*
   * Dismisses the optimization completion notification toast.
   */
  dismissNotification(): void {
    this._showNotification$.next(false);
  }

  /*
   * Dismisses the replan or early-complete completion notification toast.
   */
  dismissReplanNotification(): void {
    this._showReplanNotification$.next(false);
  }

  /*
   * Notifies the backend that a vessel finished its cargo operation early, then updates the result store.
   * The backend truncates the operation phase, checks resource availability for undocking, and
   * optionally pulls forward vessels waiting in fondeo for the freed berth.
   * @param vesselId - Identifier of the vessel that completed early (required)
   * @param completeTime - ISO 8601 timestamp when the operation finished (required)
   */
  earlyComplete(vesselId: string, completeTime: string): void {
    const base = this.baseAssignments;
    const req  = this.lastRequest;
    if (!base || !req) return;
    if (this._isEarlyCompleting$.value) return;

    const earlyReq: EarlyCompleteRequest = {
      vessel_id:        vesselId,
      complete_time:    completeTime,
      base_assignments: base,
      config:           req.config,
      vessels:          req.vessels,
    };

    this._isEarlyCompleting$.next(true);
    this._earlyCompleteError$.next(null);
    this.sub?.unsubscribe();

    this.sub = this.api.earlyComplete(earlyReq).subscribe({
      next: res => {
        const preservedImprovement = this.resultStore.snapshot?.kpis.improvement_vs_greedy_pct;
        const result: OptimizationApiResult = {
          assignments: res.assignments,
          kpis: preservedImprovement !== undefined
            ? { ...res.kpis, improvement_vs_greedy_pct: preservedImprovement }
            : res.kpis,
        };
        this.baseAssignments = res.assignments;
        this.resultStore.set(result);
        if (!this.router.url.startsWith('/optimization')) {
          this._showReplanNotification$.next(true);
        }
        this._earlyCompleteInfo$.next({
          waitingUndockH:   res.waiting_undock_h,
          replanTriggered:  res.replan_triggered,
          berthFreedDeltaH: res.berth_freed_delta_h,
        });
        this._isEarlyCompleting$.next(false);
      },
      error: (err: Error) => {
        this._earlyCompleteError$.next(err.message);
        this._isEarlyCompleting$.next(false);
      },
    });
  }

  /*
   * Clears the early-completion error and notifies subscribers.
   */
  clearEarlyCompleteError(): void {
    this._earlyCompleteError$.next(null);
  }

  /*
   * Clears the early-completion result info and notifies subscribers.
   */
  clearEarlyCompleteInfo(): void {
    this._earlyCompleteInfo$.next(null);
  }
}

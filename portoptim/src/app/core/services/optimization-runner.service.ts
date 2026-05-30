import { Injectable } from '@angular/core';
import { Router } from '@angular/router';

/** Payload surfaced to the UI after a successful early-completion call. */
export interface EarlyCompleteInfo {
  /** Hours the vessel had to wait at berth for undocking resources (0 = immediate). */
  waitingUndockH:   number;
  /** True when at least one fondeo vessel for this berth was rescheduled. */
  replanTriggered:  boolean;
  /** How many hours earlier the berth is freed vs. the original schedule. */
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

/**
 * Singleton service that owns the optimizer API subscription so it survives
 * Angular component navigation (ngOnDestroy no longer cancels the HTTP call).
 *
 * Also manages the re-planning lifecycle:
 *   - {@link applyDelay}   — accumulate delay and call /replan
 *   - {@link resetDelays}  — clear accumulated delays (called on optimizer reset)
 *
 * The base assignments snapshot is updated after every successful operation
 * (run, replan, early-complete) so that each subsequent call composes on top
 * of the latest known schedule rather than an outdated snapshot.
 */
@Injectable({ providedIn: 'root' })
export class OptimizationRunnerService {

  // ── Optimization run state ────────────────────────────────────────────────
  private readonly _isRunning$             = new BehaviorSubject<boolean>(false);
  private readonly _error$                 = new BehaviorSubject<string | null>(null);
  private readonly _showNotification$      = new BehaviorSubject<boolean>(false);
  private readonly _showReplanNotification$ = new BehaviorSubject<boolean>(false);

  readonly isRunning$             = this._isRunning$.asObservable();
  readonly error$                 = this._error$.asObservable();
  /** Emits true when the optimization finishes and the user is NOT on /optimization. */
  readonly showNotification$      = this._showNotification$.asObservable();
  /** Emits true when a replan / early-complete finishes outside /optimization. */
  readonly showReplanNotification$ = this._showReplanNotification$.asObservable();

  get isRunning(): boolean       { return this._isRunning$.value; }
  get error():     string | null { return this._error$.value;     }

  // ── Re-planning state ─────────────────────────────────────────────────────
  private readonly _isReplanning$ = new BehaviorSubject<boolean>(false);
  private readonly _replanError$  = new BehaviorSubject<string | null>(null);

  readonly isReplanning$ = this._isReplanning$.asObservable();
  readonly replanError$  = this._replanError$.asObservable();

  get isReplanning(): boolean      { return this._isReplanning$.value; }
  get replanError():  string|null  { return this._replanError$.value;  }

  // ── Early-completion state ─────────────────────────────────────────────────

  private readonly _isEarlyCompleting$  = new BehaviorSubject<boolean>(false);
  private readonly _earlyCompleteError$ = new BehaviorSubject<string | null>(null);
  private readonly _earlyCompleteInfo$  = new BehaviorSubject<EarlyCompleteInfo | null>(null);

  readonly isEarlyCompleting$  = this._isEarlyCompleting$.asObservable();
  readonly earlyCompleteError$ = this._earlyCompleteError$.asObservable();
  readonly earlyCompleteInfo$  = this._earlyCompleteInfo$.asObservable();

  get isEarlyCompleting():  boolean              { return this._isEarlyCompleting$.value;  }
  get earlyCompleteError(): string | null        { return this._earlyCompleteError$.value; }
  get earlyCompleteInfo():  EarlyCompleteInfo | null { return this._earlyCompleteInfo$.value; }

  // ── Stored context for re-planning ────────────────────────────────────────
  /** Base assignments from the most recent successful operation (run / replan / early-complete). */
  private baseAssignments: OptimizationApiResult['assignments'] | null = null;
  /** Original /run request — reused by /replan with updated ETAs. */
  private lastRequest: OptimizationApiRequest | null = null;
  /**
   * Accumulated delay per vessel (total hours, not incremental).
   * Always sends the full total to the backend so re-plans are idempotent.
   */
  private readonly vesselDelays     = new Map<string, number>();
  /** Delay type per vessel: "arrival" or "operation" (last call wins). */
  private readonly vesselDelayTypes = new Map<string, 'arrival' | 'operation'>();
  /** Accumulated early-arrival hours per vessel (how many hours before ETA they arrived). */
  private readonly earlyArrivals    = new Map<string, number>();

  private sub?: Subscription;

  constructor(
    private api:         PortOptimApiService,
    private paramsStore: OptimizationParamsStoreService,
    private resultStore: OptimizationResultStoreService,
    private router:      Router,
  ) {}

  // ── Optimizer run ─────────────────────────────────────────────────────────

  /** Starts a new optimization run (no-op if one is already in progress). */
  run(request: OptimizationApiRequest): void {
    if (this._isRunning$.value) return;

    this._isRunning$.next(true);
    this._error$.next(null);
    this.resultStore.clear();
    this.sub?.unsubscribe();

    // Store the original request so /replan can reuse vessels + config
    this.lastRequest = request;

    this.sub = this.api.runOptimization(request).subscribe({
      next: res => {
        // Capture base assignments for subsequent re-plans
        this.baseAssignments = res.assignments;
        this.vesselDelays.clear();
        this.vesselDelayTypes.clear();
        this.earlyArrivals.clear();

        this.resultStore.set(res);
        // Persist the validated config only when the optimizer succeeds.
        this.paramsStore.persistToLocalStorage();
        // Fresh run — clear any stale early-complete notification.
        this._earlyCompleteInfo$.next(null);
        this._earlyCompleteError$.next(null);
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

  // ── Re-planning ───────────────────────────────────────────────────────────

  /**
   * Apply a delay increment to a vessel and trigger re-planning if needed.
   *
   * Accumulates delays per vessel (total, not incremental) and sends the
   * full accumulated value to the backend each time.  The backend only
   * re-schedules when the delay causes an actual berth / pilot / tug conflict.
   *
   * @param vesselId   Vessel identifier.
   * @param deltaHours Additional delay hours to add.
   * @param delayType  "arrival" (vessel not docked yet) or "operation" (vessel at berth).
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
    // Last call wins for the delay type (e.g. a vessel can go from on_the_way → in_progress
    // between successive delay applications)
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
        // Preserve the greedy-improvement figure from the initial run:
        // _compute_simple_kpis (used by /replan) always returns 0 for this field,
        // but the value is meaningful only from the original full optimisation.
        const preservedImprovement = this.resultStore.snapshot?.kpis.improvement_vs_greedy_pct;
        const result: OptimizationApiResult = {
          assignments: res.assignments,
          kpis: preservedImprovement !== undefined
            ? { ...res.kpis, improvement_vs_greedy_pct: preservedImprovement }
            : res.kpis,
          delay_map:   res.delay_map,
        };
        // Advance the base snapshot so subsequent replans / early-completes
        // compose on top of this result instead of the stale original.
        // Clear accumulated delays/early-arrivals: they are now baked into
        // the new base, so keeping them would double-apply on the next call.
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
        // Roll back the accumulated delay on error so the user can retry
        this.vesselDelays.set(vesselId, previous);
        if (previous === 0) this.vesselDelayTypes.delete(vesselId);
        this._replanError$.next(err.message);
        this._isReplanning$.next(false);
      },
    });
  }

  /** Returns the total accumulated delay for a vessel (for display purposes). */
  getVesselDelay(vesselId: string): number {
    return this.vesselDelays.get(vesselId) ?? 0;
  }

  // ── Early arrival ─────────────────────────────────────────────────────────

  /**
   * Report that a vessel arrived *earlyH* hours before its scheduled ETA.
   *
   * Sends a replan request with `delay_type = "early_arrival"`.  The backend
   * extends the fondeo phase backwards; berth times do not change (no
   * conflict possible — the vessel simply waits longer in anchorage).
   *
   * @param vesselId Vessel identifier.
   * @param earlyH   How many hours before ETA the vessel arrived.
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
    // Include regular delays
    for (const [vid, dh] of this.vesselDelays.entries()) {
      if (dh > 0) {
        delays.push({
          vessel_id:  vid,
          delay_h:    dh,
          delay_type: this.vesselDelayTypes.get(vid) ?? 'arrival',
        });
      }
    }
    // Include early arrivals
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

  /** Returns the total accumulated early-arrival hours for a vessel (for display purposes). */
  getVesselEarlyArrival(vesselId: string): number {
    return this.earlyArrivals.get(vesselId) ?? 0;
  }

  clearReplanError(): void {
    this._replanError$.next(null);
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  /** Cancels an in-progress run and resets state. */
  cancelRun(): void {
    this.sub?.unsubscribe();
    this._isRunning$.next(false);
    this._error$.next(null);
  }

  clearError(): void {
    this._error$.next(null);
  }

  /** Clears accumulated delays and early arrivals — call when the optimizer is reset. */
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

  dismissNotification(): void {
    this._showNotification$.next(false);
  }

  dismissReplanNotification(): void {
    this._showReplanNotification$.next(false);
  }

  // ── Early completion ──────────────────────────────────────────────────────

  /**
   * Notify the backend that *vesselId* finished its cargo operation early.
   *
   * The backend truncates the operation, checks pilot / tug availability for
   * undocking, and optionally pulls forward any vessel waiting in fondeo for
   * the freed berth.  The updated assignment list is stored in the result store.
   *
   * @param vesselId     Vessel identifier.
   * @param completeTime ISO 8601 string for when the operation completed (use `new Date().toISOString()`).
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
        // Update the base snapshot so subsequent replans / early-completes
        // are relative to the new schedule.
        this.baseAssignments = res.assignments;
        this.resultStore.set(result);
        if (!this.router.url.startsWith('/optimization')) {
          this._showReplanNotification$.next(true);
        }
        // Surface result details to the UI notification banner.
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

  clearEarlyCompleteError(): void {
    this._earlyCompleteError$.next(null);
  }

  clearEarlyCompleteInfo(): void {
    this._earlyCompleteInfo$.next(null);
  }
}

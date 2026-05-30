import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';
import { OptimizationAssignment } from '../models/api.models';
import { OptimizationResultStoreService } from './optimization-result-store.service';

// ── Public types ──────────────────────────────────────────────────────────────

export interface VesselAlert {
  /** Unique stable key: `${vesselId}-arrival` or `${vesselId}-departure`. */
  id:         string;
  vesselId:   string;
  type:       'arrival' | 'departure';
  /** i18n key for the human-readable reason shown in the list / toast. */
  reasonKey:  string;
  /** Unix timestamp when this alert was first detected. */
  firedAt:    number;
  /**
   * Unix timestamp when the alert window closes:
   *  • arrival   → ETA + ARRIVAL_AFTER_H
   *  • departure → scheduled_end + DEPARTURE_AFTER_H
   */
  expiresAt:  number;
  read:       boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Hours BEFORE ETA at which the arrival alert starts showing. */
const ARRIVAL_BEFORE_H  = 1;
/** Hours AFTER ETA within which the arrival alert remains active. */
const ARRIVAL_AFTER_H   = 3;
/** Hours AFTER scheduled end within which the departure alert is active. */
const DEPARTURE_AFTER_H = 5;
/** How often the service re-evaluates active alerts (ms). */
const REFRESH_INTERVAL_MS = 60_000;

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Singleton that watches the current optimization result and computes
 * time-based vessel alerts:
 *
 *  • **Arrival alert** – fires in the window [ETA − 1 h, ETA + 3 h].
 *    Reason: vessel is approaching or has arrived recently.
 *
 *  • **Departure alert** – fires in the window [scheduled_end, scheduled_end + 5 h].
 *    Reason: vessel's operation should have ended but it is still at berth.
 *
 * Alerts are refreshed every 60 s and whenever a new optimization result
 * is loaded.  Each NEW alert (not seen in a previous refresh) is emitted
 * once through `newAlert$` so the toast component can react.
 */
@Injectable({ providedIn: 'root' })
export class VesselAlertService implements OnDestroy {

  // ── Streams ──────────────────────────────────────────────────────────────────
  private readonly _alerts$    = new BehaviorSubject<VesselAlert[]>([]);
  /** Fires once per new alert that hasn't been toasted yet. */
  private readonly _newAlert$  = new Subject<VesselAlert>();

  readonly alerts$      = this._alerts$.asObservable();
  /** Emits the first new alert detected in each refresh cycle. */
  readonly newAlert$    = this._newAlert$.asObservable();
  readonly unreadCount$ = this._alerts$.pipe(map(a => a.filter(x => !x.read).length));
  readonly hasUnread$   = this._alerts$.pipe(map(a => a.some(x => !x.read)));

  get alerts():      VesselAlert[] { return this._alerts$.value; }
  get unreadCount(): number        { return this._alerts$.value.filter(x => !x.read).length; }

  // ── Internal state ────────────────────────────────────────────────────────────
  /** IDs already notified via the toast — prevents re-firing for the same event. */
  private toastedIds = new Set<string>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private subs = new Subscription();

  constructor(private resultStore: OptimizationResultStoreService) {
    // React to new optimization results.
    this.subs.add(
      this.resultStore.result$.subscribe(res => {
        if (res) this.refresh(res.assignments);
        else     this.clear();
      })
    );

    // Periodic refresh so alerts fire as real time advances.
    this.refreshTimer = setInterval(() => {
      const res = this.resultStore.snapshot;
      if (res) this.refresh(res.assignments);
    }, REFRESH_INTERVAL_MS);
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  markAllRead(): void {
    this._alerts$.next(this._alerts$.value.map(a => ({ ...a, read: true })));
  }

  dismiss(id: string): void {
    this._alerts$.next(this._alerts$.value.filter(a => a.id !== id));
    // Prevent the dismissed alert from triggering another toast if it re-appears.
    this.toastedIds.add(id);
  }

  // ── Core refresh logic ────────────────────────────────────────────────────────

  refresh(assignments: OptimizationAssignment[]): void {
    const nowMs    = Date.now();
    const existing = new Map(this._alerts$.value.map(a => [a.id, a]));
    const next: VesselAlert[] = [];

    for (const a of assignments) {
      if (a.status !== 'assigned') continue;

      const etaMs      = this._etaMs(a);
      const schedEndMs = new Date(a.scheduled_end).getTime();

      // ── Arrival alert ───────────────────────────────────────────────────────
      const arrId       = `${a.vessel_id}-arrival`;
      const arrExpires  = etaMs + ARRIVAL_AFTER_H * 3_600_000;
      if (
        nowMs >= etaMs - ARRIVAL_BEFORE_H  * 3_600_000 &&
        nowMs <  arrExpires
      ) {
        const alert: VesselAlert = existing.get(arrId) ?? {
          id:        arrId,
          vesselId:  a.vessel_id,
          type:      'arrival',
          reasonKey: 'notif.arrival.reason',
          firedAt:   nowMs,
          expiresAt: arrExpires,
          read:      false,
        };
        next.push(alert);
        if (!this.toastedIds.has(arrId)) {
          this._newAlert$.next(alert);
          this.toastedIds.add(arrId);
        }
      }

      // ── Departure alert ─────────────────────────────────────────────────────
      const depId      = `${a.vessel_id}-departure`;
      const depExpires = schedEndMs + DEPARTURE_AFTER_H * 3_600_000;
      if (
        nowMs >= schedEndMs &&
        nowMs <  depExpires
      ) {
        const alert: VesselAlert = existing.get(depId) ?? {
          id:        depId,
          vesselId:  a.vessel_id,
          type:      'departure',
          reasonKey: 'notif.departure.reason',
          firedAt:   nowMs,
          expiresAt: depExpires,
          read:      false,
        };
        next.push(alert);
        if (!this.toastedIds.has(depId)) {
          this._newAlert$.next(alert);
          this.toastedIds.add(depId);
        }
      }
    }

    // Sort: unread first, then newest first.
    next.sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return b.firedAt - a.firedAt;
    });

    this._alerts$.next(next);
  }

  clear(): void {
    this._alerts$.next([]);
    this.toastedIds.clear();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /**
   * Returns the original vessel ETA as a Unix timestamp.
   *
   * For delayed vessels the backend prepends a `delay` phase; `phases[0].start`
   * is therefore always the original ETA regardless of delay status — the same
   * logic used by `fondeoStartMs()` in the optimization component.
   */
  private _etaMs(a: OptimizationAssignment): number {
    if (a.phases?.length) return new Date(a.phases[0].start).getTime();
    return new Date(a.scheduled_start).getTime() - a.waiting_time_h * 3_600_000;
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
  }
}

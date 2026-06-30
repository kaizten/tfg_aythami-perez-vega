import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';
import { OptimizationAssignment } from '../models/api.models';
import { OptimizationResultStoreService } from './optimization-result-store.service';

export interface VesselAlert {
  /* Fixed - unique stable key composed of vesselId and alert type */
  id:         string;
  /* Fixed - identifier of the vessel this alert refers to */
  vesselId:   string;
  /* Fixed - whether this alert is for an approaching arrival or a pending departure */
  type:       'arrival' | 'departure';
  /* Fixed - i18n key for the human-readable reason shown in the list and toast */
  reasonKey:  string;
  /* Computed - Unix timestamp when this alert was first detected */
  firedAt:    number;
  /* Computed - Unix timestamp when the alert window closes */
  expiresAt:  number;
  /* User-provided - whether the user has seen this alert */
  read:       boolean;
}

/* Fixed - hours before ETA at which the arrival alert starts showing */
const ARRIVAL_BEFORE_H  = 1;
/* Fixed - hours after ETA within which the arrival alert remains active */
const ARRIVAL_AFTER_H   = 3;
/* Fixed - hours after scheduled end within which the departure alert is active */
const DEPARTURE_AFTER_H = 5;
/* Fixed - how often the service re-evaluates active alerts in milliseconds */
const REFRESH_INTERVAL_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class VesselAlertService implements OnDestroy {

  /* Computed - internal BehaviorSubject holding the current list of active alerts */
  private readonly _alerts$    = new BehaviorSubject<VesselAlert[]>([]);
  /* Computed - Subject that fires once per newly detected alert not yet shown as a toast */
  private readonly _newAlert$  = new Subject<VesselAlert>();

  /* Computed - public Observable of the full active alert list */
  readonly alerts$      = this._alerts$.asObservable();
  /* Computed - emits the first new alert detected in each refresh cycle */
  readonly newAlert$    = this._newAlert$.asObservable();
  /* Computed - Observable of the count of unread alerts */
  readonly unreadCount$ = this._alerts$.pipe(map(a => a.filter(x => !x.read).length));
  /* Computed - Observable that emits true when at least one unread alert exists */
  readonly hasUnread$   = this._alerts$.pipe(map(a => a.some(x => !x.read)));

  /*
   * Returns the current list of active alerts.
   * @returns Array of VesselAlert objects
   */
  get alerts():      VesselAlert[] { return this._alerts$.value; }
  /*
   * Returns the number of unread alerts in the current list.
   * @returns Count of alerts where read is false
   */
  get unreadCount(): number        { return this._alerts$.value.filter(x => !x.read).length; }

  /* Computed - set of alert IDs already shown as toasts to prevent re-firing */
  private toastedIds = new Set<string>();
  /* Computed - interval handle for the periodic refresh timer */
  private refreshTimer?: ReturnType<typeof setInterval>;
  /* Computed - composite subscription tracking all active RxJS subscriptions */
  private subs = new Subscription();

  constructor(private resultStore: OptimizationResultStoreService) {
    this.subs.add(
      this.resultStore.result$.subscribe(res => {
        if (res) this.refresh(res.assignments);
        else     this.clear();
      })
    );

    this.refreshTimer = setInterval(() => {
      const res = this.resultStore.snapshot;
      if (res) this.refresh(res.assignments);
    }, REFRESH_INTERVAL_MS);
  }

  /*
   * Marks all current alerts as read and notifies subscribers.
   */
  markAllRead(): void {
    this._alerts$.next(this._alerts$.value.map(a => ({ ...a, read: true })));
  }

  /*
   * Removes the alert with the given ID from the active list and prevents it from re-appearing as a toast.
   * @param id - The unique alert identifier to dismiss (required)
   */
  dismiss(id: string): void {
    this._alerts$.next(this._alerts$.value.filter(a => a.id !== id));
    this.toastedIds.add(id);
  }

  /*
   * Evaluates all assigned vessels against the current time and updates the active alert list.
   * Emits new alerts through newAlert$ for any alert not yet shown as a toast.
   * @param assignments - The full list of vessel assignments from the current optimization result (required)
   */
  refresh(assignments: OptimizationAssignment[]): void {
    const nowMs    = Date.now();
    const existing = new Map(this._alerts$.value.map(a => [a.id, a]));
    const next: VesselAlert[] = [];

    for (const a of assignments) {
      if (a.status !== 'assigned') continue;

      const etaMs      = this._etaMs(a);
      const schedEndMs = new Date(a.scheduled_end).getTime();

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

    next.sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return b.firedAt - a.firedAt;
    });

    this._alerts$.next(next);
  }

  /*
   * Clears all active alerts and resets the toasted-IDs set.
   */
  clear(): void {
    this._alerts$.next([]);
    this.toastedIds.clear();
  }

  /*
   * Returns the original vessel ETA as a Unix timestamp in milliseconds.
   * For delayed vessels, phases[0].start always holds the original ETA regardless of delay status.
   * @param a - The optimization assignment whose ETA should be computed (required)
   * @returns Unix timestamp in milliseconds representing the vessel's original ETA
   */
  private _etaMs(a: OptimizationAssignment): number {
    if (a.phases?.length) return new Date(a.phases[0].start).getTime();
    return new Date(a.scheduled_start).getTime() - a.waiting_time_h * 3_600_000;
  }

  /*
   * Unsubscribes from all RxJS subscriptions and clears the periodic refresh timer.
   */
  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
  }
}

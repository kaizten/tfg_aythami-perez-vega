import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { VesselAlert, VesselAlertService } from '../../../core/services/vessel-alert.service';

/* Fixed - auto-dismiss duration for each toast entry in milliseconds */
const TOAST_DURATION_MS = 6000;
/* Fixed - CSS transition duration for the slide animation; must match the SCSS value */
const SLIDE_DURATION_MS = 320;

interface ToastEntry {
  /* Fixed - the vessel alert data this entry displays */
  alert:        VesselAlert;
  /* Computed - controls DOM presence for this entry */
  visible:      boolean;
  /* Computed - CSS slide state flag for this entry */
  sliding:      boolean;
  /* Computed - true while the progress bar is present in the DOM for this entry */
  progressing:  boolean;
  /* Computed - triggers the drain transition to animate the progress bar */
  draining:     boolean;
  /* Computed - formatted expiration time string shown in the toast */
  expiresLabel: string;
  /* Computed - handle for the auto-dismiss setTimeout for this entry */
  autoTimer?:   ReturnType<typeof setTimeout>;
  /* Computed - handle for the slide-out setTimeout for this entry */
  slideTimer?:  ReturnType<typeof setTimeout>;
}

@Component({
  selector: 'app-vessel-alert-toast',
  standalone: false,
  templateUrl: './vessel-alert-toast.component.html',
  styleUrl:    './vessel-alert-toast.component.scss',
})
export class VesselAlertToastComponent implements OnInit, OnDestroy {

  /* Computed - list of currently active toast entries rendered in the template */
  toasts: ToastEntry[] = [];

  /* Computed - list of active RxJS subscriptions to clean up on destroy */
  private subs: Subscription[] = [];

  constructor(private alertSvc: VesselAlertService) {}

  /*
   * Subscribes to VesselAlertService.newAlert$ and adds a new toast entry for each incoming alert.
   */
  ngOnInit(): void {
    this.subs.push(
      this.alertSvc.newAlert$.subscribe(alert => this._addToast(alert))
    );
  }

  /*
   * Slides out and removes the given toast entry.
   * @param entry - The toast entry to dismiss (required)
   */
  dismiss(entry: ToastEntry): void {
    this._slideOut(entry);
  }

  /*
   * TrackBy function for the toasts ngFor loop to minimise DOM re-renders.
   * @param _ - Index parameter (unused) (required)
   * @param entry - The toast entry being tracked (required)
   * @returns The unique alert ID of the entry
   */
  trackByAlert(_: number, entry: ToastEntry): string {
    return entry.alert.id;
  }

  /*
   * Formats a Unix millisecond timestamp as a zero-padded HH:MM time string.
   * @param ms - Unix timestamp in milliseconds to format (required)
   * @returns Zero-padded HH:MM string
   */
  formatTime(ms: number): string {
    const d  = new Date(ms);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  }

  /*
   * Appends a new toast entry for the given alert and starts its slide-in animation and auto-dismiss timer.
   * If a toast for the same alert ID already exists, only its timer is restarted.
   * @param alert - The vessel alert to display (required)
   */
  private _addToast(alert: VesselAlert): void {
    const existing = this.toasts.find(t => t.alert.id === alert.id);
    if (existing) {
      clearTimeout(existing.autoTimer);
      existing.autoTimer = setTimeout(() => this._slideOut(existing), TOAST_DURATION_MS);
      return;
    }

    const entry: ToastEntry = {
      alert,
      visible:      true,
      sliding:      false,
      progressing:  false,
      draining:     false,
      expiresLabel: this.formatTime(alert.expiresAt),
    };

    this.toasts.push(entry);

    setTimeout(() => {
      entry.sliding     = true;
      entry.progressing = true;
      setTimeout(() => { entry.draining = true; }, 16);
    }, 16);

    entry.autoTimer = setTimeout(() => this._slideOut(entry), TOAST_DURATION_MS);
  }

  /*
   * Plays the slide-out animation for the given entry and removes it from the toasts array afterwards.
   * @param entry - The toast entry to slide out and remove (required)
   */
  private _slideOut(entry: ToastEntry): void {
    clearTimeout(entry.autoTimer);
    entry.sliding     = false;
    entry.progressing = false;
    entry.draining    = false;
    entry.slideTimer  = setTimeout(() => {
      entry.visible = false;
      this.toasts = this.toasts.filter(t => t !== entry);
    }, SLIDE_DURATION_MS);
  }

  /*
   * Clears all pending timers and unsubscribes from all active subscriptions on component destruction.
   */
  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.toasts.forEach(t => {
      clearTimeout(t.autoTimer);
      clearTimeout(t.slideTimer);
    });
  }
}

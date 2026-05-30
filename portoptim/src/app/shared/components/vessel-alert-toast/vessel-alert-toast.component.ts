import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { VesselAlert, VesselAlertService } from '../../../core/services/vessel-alert.service';

const TOAST_DURATION_MS = 6000;
const SLIDE_DURATION_MS = 320;

// ── Internal entry type ───────────────────────────────────────────────────────

interface ToastEntry {
  alert:        VesselAlert;
  visible:      boolean;
  sliding:      boolean;
  progressing:  boolean;
  draining:     boolean;
  /** Formatted expiration time string, e.g. "14:35". */
  expiresLabel: string;
  autoTimer?:   ReturnType<typeof setTimeout>;
  slideTimer?:  ReturnType<typeof setTimeout>;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Global vessel-alert toast container.
 *
 * Each new alert received from `VesselAlertService.newAlert$` is appended as
 * an independent entry in `toasts[]`. Entries stack vertically (newest at the
 * bottom) and each has its own slide animation, progress bar and auto-dismiss
 * timer — simultaneous alerts are all visible at once.
 */
@Component({
  selector: 'app-vessel-alert-toast',
  standalone: false,
  templateUrl: './vessel-alert-toast.component.html',
  styleUrl:    './vessel-alert-toast.component.scss',
})
export class VesselAlertToastComponent implements OnInit, OnDestroy {

  toasts: ToastEntry[] = [];

  private subs: Subscription[] = [];

  constructor(private alertSvc: VesselAlertService) {}

  ngOnInit(): void {
    this.subs.push(
      this.alertSvc.newAlert$.subscribe(alert => this._addToast(alert))
    );
  }

  // ── Public actions ────────────────────────────────────────────────────────────

  dismiss(entry: ToastEntry): void {
    this._slideOut(entry);
  }

  trackByAlert(_: number, entry: ToastEntry): string {
    return entry.alert.id;
  }

  formatTime(ms: number): string {
    const d  = new Date(ms);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  private _addToast(alert: VesselAlert): void {
    // If already toasting the same alert ID, just restart its timer.
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

    // Kick off slide-in on the next tick so Angular has rendered the element.
    setTimeout(() => {
      entry.sliding     = true;
      entry.progressing = true;
      setTimeout(() => { entry.draining = true; }, 16);
    }, 16);

    entry.autoTimer = setTimeout(() => this._slideOut(entry), TOAST_DURATION_MS);
  }

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

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.toasts.forEach(t => {
      clearTimeout(t.autoTimer);
      clearTimeout(t.slideTimer);
    });
  }
}

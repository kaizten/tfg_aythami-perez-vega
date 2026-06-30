import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { OptimizationResultStoreService } from '../../core/services/optimization-result-store.service';
import { TransformationStoreService } from '../../core/services/transformation-store.service';

@Component({
  selector: 'app-dashboard',
  standalone: false,
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, OnDestroy {
  /* Computed - total number of vessel calls loaded from the transformed CSV */
  totalVessels = '—';
  /* Computed - number of unique berths referenced across all vessel calls */
  uniqueBerths = '—';
  /* Computed - average stay duration formatted as days/hours/minutes */
  avgDuration  = '—';
  /* Computed - number of rows skipped during CSV transformation */
  skippedRows  = '—';
  /* Computed - whether any vessel call data is currently available */
  hasData      = false;

  /* Computed - average duration in hours derived from the raw CSV data */
  private _csvAvgH    = 0;
  /* Computed - average duration in hours derived from optimizer assignments, null when no optimization result is loaded */
  private _optiAvgH: number | null = null;
  /* Computed - composite subscription collecting all active RxJS subscriptions */
  private subs = new Subscription();

  constructor(
    private store:        TransformationStoreService,
    private optiStore:    OptimizationResultStoreService,
  ) {}

  /*
   * Subscribes to transformation and optimization store streams to keep KPI metrics up to date.
   */
  ngOnInit(): void {
    this.subs.add(this.store.result$.subscribe(result => {
      if (result) {
        const calls = result.data;
        this.hasData      = calls.length > 0;
        this.totalVessels = String(calls.length);
        this.uniqueBerths = String(new Set(calls.map(c => c.berth_id)).size);
        this._csvAvgH     = calls.length
          ? calls.reduce((s, c) => s + c.duration_hours, 0) / calls.length
          : 0;
        this.skippedRows  = String(result.transformation_summary.skipped_rows);
      } else {
        this.hasData      = false;
        this.totalVessels = '—';
        this.uniqueBerths = '—';
        this._csvAvgH     = 0;
        this.skippedRows  = '—';
      }
      this._updateAvgDuration();
    }));

    this.subs.add(this.optiStore.result$.subscribe(result => {
      if (result) {
        const assigned = result.assignments.filter(a => a.status === 'assigned');
        this._optiAvgH = assigned.length
          ? assigned.reduce((s, a) => {
              const h = a.phases?.reduce((ph, p) => ph + p.duration_h, 0)
                ?? (a.waiting_time_h + a.duration_estimated_h);
              return s + h;
            }, 0) / assigned.length
          : 0;
      } else {
        this._optiAvgH = null;
      }
      this._updateAvgDuration();
    }));
  }

  /*
   * Recomputes the displayed average duration, preferring optimizer data over raw CSV data.
   */
  private _updateAvgDuration(): void {
    if (!this.hasData) { this.avgDuration = '—'; return; }
    this.avgDuration = this._formatHours(this._optiAvgH ?? this._csvAvgH);
  }

  /*
   * Converts a fractional hour value into a human-readable string of days, hours, and minutes.
   * @param h - Duration in decimal hours (required)
   * @returns Formatted string such as "1d 2h 30m", or "0m" if the duration rounds to zero
   */
  private _formatHours(h: number): string {
    const totalMinutes = Math.round(h * 60);
    const days    = Math.floor(totalMinutes / 1440);
    const hours   = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];
    if (days > 0)    parts.push(`${days}d`);
    if (hours > 0)   parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    return parts.length ? parts.join(' ') : '0m';
  }

  /*
   * Unsubscribes from all active subscriptions to prevent memory leaks.
   */
  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }
}

import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { BerthCall } from '../../core/models/api.models';
import { TransformationStoreService } from '../../core/services/transformation-store.service';

@Component({
  selector: 'app-dashboard',
  standalone: false,
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, OnDestroy {
  // KPI values — derived from store when data is available, otherwise show placeholder dashes
  totalVessels = '—';
  uniqueBerths = '—';
  avgDuration = '—';
  skippedRows = '—';
  hasData = false;

  private sub?: Subscription;

  constructor(private store: TransformationStoreService) {}

  ngOnInit(): void {
    this.sub = this.store.result$.subscribe(result => {
      if (result) {
        const calls = result.data;
        this.hasData = calls.length > 0;
        this.totalVessels = String(calls.length);
        this.uniqueBerths = String(new Set(calls.map(c => c.berth_id)).size);
        this.avgDuration = calls.length
          ? `${(calls.reduce((s, c) => s + c.duration_hours, 0) / calls.length).toFixed(1)}h`
          : '0h';
        this.skippedRows = String(result.transformation_summary.skipped_rows);
      } else {
        this.hasData = false;
        this.totalVessels = '—';
        this.uniqueBerths = '—';
        this.avgDuration = '—';
        this.skippedRows = '—';
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}

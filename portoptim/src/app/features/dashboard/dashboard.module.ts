import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { DashboardRoutingModule } from './dashboard-routing.module';
import { DashboardComponent } from './dashboard.component';
import { MetricCardComponent } from './components/metric-card/metric-card.component';
import { BerthTimelineComponent } from './components/berth-timeline/berth-timeline.component';
import { ActionAlertsComponent } from './components/action-alerts/action-alerts.component';


@NgModule({
  declarations: [
    DashboardComponent,
    MetricCardComponent,
    BerthTimelineComponent,
    ActionAlertsComponent
  ],
  imports: [
    CommonModule,
    DashboardRoutingModule
  ]
})
export class DashboardModule { }

import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';
import { DashboardRoutingModule } from './dashboard-routing.module';
import { DashboardComponent } from './dashboard.component';
import { MetricCardComponent } from './components/metric-card/metric-card.component';
import { BerthTimelineComponent } from './components/berth-timeline/berth-timeline.component';
import { ActionAlertsComponent } from './components/action-alerts/action-alerts.component';
import { TerminalMapComponent } from './components/terminal-map/terminal-map.component';

@NgModule({
  declarations: [
    DashboardComponent,
    MetricCardComponent,
    BerthTimelineComponent,
    ActionAlertsComponent,
    TerminalMapComponent,
  ],
  imports: [
    SharedModule,
    RouterModule,
    DashboardRoutingModule,
  ],
})
export class DashboardModule {}

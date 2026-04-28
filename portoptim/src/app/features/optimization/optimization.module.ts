import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { OptimizationRoutingModule } from './optimization-routing.module';
import { OptimizationComponent } from './optimization.component';
import { VesselDetailPanelComponent } from './components/vessel-detail-panel/vessel-detail-panel.component';

@NgModule({
  declarations: [OptimizationComponent, VesselDetailPanelComponent],
  imports: [CommonModule, RouterModule, OptimizationRoutingModule],
})
export class OptimizationModule {}

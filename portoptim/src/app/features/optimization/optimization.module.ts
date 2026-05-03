import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';
import { OptimizationRoutingModule } from './optimization-routing.module';
import { OptimizationComponent } from './optimization.component';
import { VesselDetailPanelComponent } from './components/vessel-detail-panel/vessel-detail-panel.component';

@NgModule({
  declarations: [OptimizationComponent, VesselDetailPanelComponent],
  imports: [SharedModule, RouterModule, OptimizationRoutingModule],
})
export class OptimizationModule {}

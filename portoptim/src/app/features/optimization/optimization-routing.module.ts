import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { OptimizationComponent } from './optimization.component';

const routes: Routes = [{ path: '', component: OptimizationComponent }];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class OptimizationRoutingModule { }

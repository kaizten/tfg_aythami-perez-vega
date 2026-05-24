import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { TopbarComponent } from './components/topbar/topbar.component';
import { LayoutComponent } from './components/layout/layout.component';
import { OptimizationToastComponent } from './components/optimization-toast/optimization-toast.component';
import { TranslatePipe } from './pipes/translate.pipe';

@NgModule({
  declarations: [
    SidebarComponent,
    TopbarComponent,
    LayoutComponent,
    OptimizationToastComponent,
    TranslatePipe,
  ],
  imports: [CommonModule, RouterModule],
  exports: [
    SidebarComponent,
    TopbarComponent,
    LayoutComponent,
    OptimizationToastComponent,
    TranslatePipe,
    CommonModule,
  ],
})
export class SharedModule {}

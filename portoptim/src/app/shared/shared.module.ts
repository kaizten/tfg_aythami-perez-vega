import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { TopbarComponent } from './components/topbar/topbar.component';
import { LayoutComponent } from './components/layout/layout.component';

@NgModule({
  declarations: [SidebarComponent, TopbarComponent, LayoutComponent],
  imports: [CommonModule, RouterModule],
  exports: [SidebarComponent, TopbarComponent, LayoutComponent],
})
export class SharedModule {}

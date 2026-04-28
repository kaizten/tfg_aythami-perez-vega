import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { DataInputRoutingModule } from './data-input-routing.module';
import { DataInputComponent } from './data-input.component';

@NgModule({
  declarations: [DataInputComponent],
  imports: [CommonModule, RouterModule, DataInputRoutingModule],
})
export class DataInputModule {}

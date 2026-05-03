import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';
import { DataInputRoutingModule } from './data-input-routing.module';
import { DataInputComponent } from './data-input.component';

@NgModule({
  declarations: [DataInputComponent],
  imports: [SharedModule, FormsModule, RouterModule, DataInputRoutingModule],
})
export class DataInputModule {}

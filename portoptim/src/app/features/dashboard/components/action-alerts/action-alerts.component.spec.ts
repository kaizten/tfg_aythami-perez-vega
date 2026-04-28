import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ActionAlertsComponent } from './action-alerts.component';

describe('ActionAlertsComponent', () => {
  let component: ActionAlertsComponent;
  let fixture: ComponentFixture<ActionAlertsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ActionAlertsComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ActionAlertsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

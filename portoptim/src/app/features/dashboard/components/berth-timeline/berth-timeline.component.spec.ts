import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BerthTimelineComponent } from './berth-timeline.component';

describe('BerthTimelineComponent', () => {
  let component: BerthTimelineComponent;
  let fixture: ComponentFixture<BerthTimelineComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [BerthTimelineComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(BerthTimelineComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

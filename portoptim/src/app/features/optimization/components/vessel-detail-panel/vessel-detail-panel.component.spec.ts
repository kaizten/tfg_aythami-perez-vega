import { ComponentFixture, TestBed } from '@angular/core/testing';

import { VesselDetailPanelComponent } from './vessel-detail-panel.component';

describe('VesselDetailPanelComponent', () => {
  let component: VesselDetailPanelComponent;
  let fixture: ComponentFixture<VesselDetailPanelComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [VesselDetailPanelComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(VesselDetailPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

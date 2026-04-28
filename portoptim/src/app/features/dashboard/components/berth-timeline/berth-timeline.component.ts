import { Component } from '@angular/core';

interface TimeLabel { label: string; current: boolean; }
interface BerthBlock { label: string; left: string; width: string; colorClass: string; }
interface Berth { name: string; blocks: BerthBlock[]; }

@Component({
  selector: 'app-berth-timeline',
  standalone: false,
  templateUrl: './berth-timeline.component.html',
  styleUrl: './berth-timeline.component.scss',
})
export class BerthTimelineComponent {
  currentTimeOffset = 'calc(9rem + 66.6%)';

  timeLabels: TimeLabel[] = [
    { label: '00:00', current: false },
    { label: '04:00', current: false },
    { label: '08:00', current: false },
    { label: '12:00', current: false },
    { label: '16:00 (NOW)', current: true },
    { label: '20:00', current: false },
    { label: '23:59', current: false },
  ];

  berths: Berth[] = [
    {
      name: 'Berth Alpha-01',
      blocks: [
        { label: 'MS EVERGREEN – LOADING', left: '5%', width: '45%', colorClass: 'bg-primary-container text-white' },
        { label: 'APL MERIDIAN (ETA 19:30)', left: '52%', width: '30%', colorClass: 'bg-on-secondary-container/20 border border-on-secondary-container/30 text-on-secondary-container' },
      ],
    },
    {
      name: 'Berth Alpha-02',
      blocks: [
        { label: 'COSCO SHIPPING TANKER', left: '0%', width: '58%', colorClass: 'bg-primary-container text-white' },
      ],
    },
    {
      name: 'Berth Beta-01',
      blocks: [
        { label: 'MAERSK ADRIATIC (DELAYED)', left: '62%', width: '35%', colorClass: 'bg-error-container border border-error/20 text-error' },
      ],
    },
    {
      name: 'Berth Beta-02',
      blocks: [
        { label: 'HYUNDAI GLORY', left: '10%', width: '30%', colorClass: 'bg-primary-container text-white' },
        { label: 'OOCL LONDON', left: '45%', width: '40%', colorClass: 'bg-primary-container text-white' },
      ],
    },
  ];
}

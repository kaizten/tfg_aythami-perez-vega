import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-metric-card',
  standalone: false,
  templateUrl: './metric-card.component.html',
  styleUrl: './metric-card.component.scss',
})
export class MetricCardComponent {
  @Input() title = '';
  @Input() value = '';
  @Input() trend = '';
  @Input() trendIcon = 'trending_up';
  @Input() trendClass = 'text-teal-600';
  @Input() icon = '';
  @Input() iconBgClass = 'bg-primary-container';
}

import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-metric-card',
  standalone: false,
  templateUrl: './metric-card.component.html',
  styleUrl: './metric-card.component.scss',
})
export class MetricCardComponent {
  /* User-provided - label displayed in the card header */
  @Input() title = '';
  /* User-provided - primary metric value shown in large text */
  @Input() value = '';
  /* User-provided - trend description text shown below the value */
  @Input() trend = '';
  /* User-provided - Material icon name for the trend indicator */
  @Input() trendIcon = 'trending_up';
  /* User-provided - CSS class controlling the trend indicator color */
  @Input() trendClass = 'text-teal-600';
  /* User-provided - Material icon name displayed in the card icon area */
  @Input() icon = '';
  /* User-provided - CSS class controlling the background color of the icon container */
  @Input() iconBgClass = 'bg-primary-container';
}

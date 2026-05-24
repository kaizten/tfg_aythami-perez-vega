import { Component, OnDestroy, OnInit } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { OptimizationRunnerService } from '../../../core/services/optimization-runner.service';

/** Auto-dismiss duration in milliseconds. */
const TOAST_DURATION_MS = 6000;
/** CSS transition duration for the slide animation (must match SCSS). */
const SLIDE_DURATION_MS = 320;

/**
 * Global completion toast that slides in from under the topbar whenever the
 * optimizer finishes while the user is on a page other than /optimization.
 *
 * Declared in SharedModule and rendered once inside LayoutComponent.
 */
@Component({
  selector: 'app-optimization-toast',
  standalone: false,
  templateUrl: './optimization-toast.component.html',
  styleUrl: './optimization-toast.component.scss',
})
export class OptimizationToastComponent implements OnInit, OnDestroy {

  /** Controls DOM presence — kept alive during the slide-out animation. */
  visible = false;
  /** CSS state: true = slid in (translateY 0), false = hidden above header. */
  sliding = false;
  /** Progress bar present in DOM. */
  progressing = false;
  /**
   * Activates the drain transition one frame after the bar appears.
   * Two-flag pattern avoids @keyframes (which linters flag for property changes):
   * progressing=true renders scaleX(1)/transition:none, then draining=true
   * triggers the 6 s transition to scaleX(0).
   */
  draining = false;

  private autoTimer?:    ReturnType<typeof setTimeout>;
  private slideTimer?:   ReturnType<typeof setTimeout>;
  private dismissing = false;
  private subs: Subscription[] = [];

  constructor(
    readonly runner: OptimizationRunnerService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.subs.push(
      // Show toast when a run completes outside /optimization.
      this.runner.showNotification$.subscribe(show => {
        if (show) {
          this.slideIn();
        } else if (this.visible && !this.dismissing) {
          // An external caller (e.g. OptimizationComponent.ngOnInit) cleared
          // the notification — slide out gracefully.
          this.slideOut();
        }
      }),

      // Auto-dismiss when the user navigates to the optimization page.
      this.router.events
        .pipe(filter(e => e instanceof NavigationStart))
        .subscribe(e => {
          if ((e as NavigationStart).url.startsWith('/optimization') && this.visible) {
            this.dismiss();
          }
        }),
    );
  }

  // ── Public actions ──────────────────────────────────────────────────────────

  dismiss(): void {
    if (this.dismissing) return;
    this.dismissing = true;
    this.slideOut();
    this.runner.dismissNotification();
    setTimeout(() => { this.dismissing = false; }, SLIDE_DURATION_MS + 60);
  }

  goToOptimization(): void {
    this.dismiss();
    this.router.navigate(['/optimization']);
  }

  // ── Animation helpers ───────────────────────────────────────────────────────

  private slideIn(): void {
    clearTimeout(this.autoTimer);
    clearTimeout(this.slideTimer);

    if (this.visible && this.sliding) {
      // Already visible — restart auto-dismiss timer only.
      this.autoTimer = setTimeout(() => this.dismiss(), TOAST_DURATION_MS);
      return;
    }

    this.visible     = true;
    this.sliding     = false;
    this.progressing = false;
    this.draining    = false;

    // Frame 1: render the initial -translateY state + progress bar at scaleX(1).
    setTimeout(() => {
      this.sliding     = true;
      this.progressing = true;
      // Frame 2: start the drain transition (scaleX(1) → scaleX(0) over 6 s).
      setTimeout(() => { this.draining = true; }, 16);
    }, 16);

    this.autoTimer = setTimeout(() => this.dismiss(), TOAST_DURATION_MS);
  }

  private slideOut(): void {
    clearTimeout(this.autoTimer);
    this.sliding     = false;
    this.progressing = false;
    this.draining    = false;
    this.slideTimer  = setTimeout(() => {
      this.visible = false;
    }, SLIDE_DURATION_MS);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    clearTimeout(this.autoTimer);
    clearTimeout(this.slideTimer);
  }
}

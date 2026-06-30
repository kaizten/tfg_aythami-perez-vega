import { Component, OnDestroy, OnInit } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { OptimizationRunnerService } from '../../../core/services/optimization-runner.service';

/* Fixed - auto-dismiss duration for the toast in milliseconds */
const TOAST_DURATION_MS = 6000;
/* Fixed - CSS transition duration for the slide animation; must match the SCSS value */
const SLIDE_DURATION_MS = 320;

@Component({
  selector: 'app-optimization-toast',
  standalone: false,
  templateUrl: './optimization-toast.component.html',
  styleUrl: './optimization-toast.component.scss',
})
export class OptimizationToastComponent implements OnInit, OnDestroy {

  /* Computed - controls DOM presence; kept true during the slide-out animation to avoid layout jump */
  visible = false;
  /* Computed - CSS state flag: true applies translateY(0), false hides the toast above the header */
  sliding = false;
  /* Computed - true while the progress bar element is present in the DOM */
  progressing = false;
  /* Computed - distinguishes a full optimizer run toast from a replan or early-complete toast */
  toastType: 'optimizer' | 'replan' = 'optimizer';
  /* Computed - triggers the drain transition one frame after the bar appears to animate scaleX from 1 to 0 */
  draining = false;

  /* Computed - handle for the auto-dismiss setTimeout */
  private autoTimer?:    ReturnType<typeof setTimeout>;
  /* Computed - handle for the slide-out setTimeout that hides the element after the transition */
  private slideTimer?:   ReturnType<typeof setTimeout>;
  /* Computed - prevents dismiss from being called multiple times during a single slide-out */
  private dismissing = false;
  /* Computed - list of active RxJS subscriptions to clean up on destroy */
  private subs: Subscription[] = [];

  constructor(
    readonly runner: OptimizationRunnerService,
    private router: Router,
  ) {}

  /*
   * Subscribes to optimization and replan notification streams and auto-dismisses when navigating to /optimization.
   */
  ngOnInit(): void {
    this.subs.push(
      this.runner.showNotification$.subscribe(show => {
        if (show) {
          this.toastType = 'optimizer';
          this.slideIn();
        } else if (this.visible && !this.dismissing && this.toastType === 'optimizer') {
          this.slideOut();
        }
      }),

      this.runner.showReplanNotification$.subscribe(show => {
        if (show) {
          this.toastType = 'replan';
          this.slideIn();
        } else if (this.visible && !this.dismissing && this.toastType === 'replan') {
          this.slideOut();
        }
      }),

      this.router.events
        .pipe(filter(e => e instanceof NavigationStart))
        .subscribe(e => {
          if ((e as NavigationStart).url.startsWith('/optimization') && this.visible) {
            this.dismiss();
          }
        }),
    );
  }

  /*
   * Slides the toast out and notifies the runner service to clear the corresponding notification flag.
   */
  dismiss(): void {
    if (this.dismissing) return;
    this.dismissing = true;
    this.slideOut();
    if (this.toastType === 'replan') {
      this.runner.dismissReplanNotification();
    } else {
      this.runner.dismissNotification();
    }
    setTimeout(() => { this.dismissing = false; }, SLIDE_DURATION_MS + 60);
  }

  /*
   * Dismisses the toast and navigates the user to the optimization page.
   */
  goToOptimization(): void {
    this.dismiss();
    this.router.navigate(['/optimization']);
  }

  /*
   * Plays the slide-in animation and starts the auto-dismiss timer.
   * If the toast is already visible, only the timer is restarted.
   */
  private slideIn(): void {
    clearTimeout(this.autoTimer);
    clearTimeout(this.slideTimer);

    if (this.visible && this.sliding) {
      this.autoTimer = setTimeout(() => this.dismiss(), TOAST_DURATION_MS);
      return;
    }

    this.visible     = true;
    this.sliding     = false;
    this.progressing = false;
    this.draining    = false;

    setTimeout(() => {
      this.sliding     = true;
      this.progressing = true;
      setTimeout(() => { this.draining = true; }, 16);
    }, 16);

    this.autoTimer = setTimeout(() => this.dismiss(), TOAST_DURATION_MS);
  }

  /*
   * Plays the slide-out animation and hides the toast element after the transition completes.
   */
  private slideOut(): void {
    clearTimeout(this.autoTimer);
    this.sliding     = false;
    this.progressing = false;
    this.draining    = false;
    this.slideTimer  = setTimeout(() => {
      this.visible = false;
    }, SLIDE_DURATION_MS);
  }

  /*
   * Clears all pending timers and unsubscribes from all active subscriptions on component destruction.
   */
  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    clearTimeout(this.autoTimer);
    clearTimeout(this.slideTimer);
  }
}

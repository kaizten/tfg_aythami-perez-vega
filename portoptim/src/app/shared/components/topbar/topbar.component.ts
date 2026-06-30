import { Component, OnDestroy, OnInit } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Observable, Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { LangCode, LANGUAGES } from '../../../core/i18n/translations';
import { LanguageService } from '../../../core/services/language.service';
import { VesselAlert, VesselAlertService } from '../../../core/services/vessel-alert.service';

@Component({
  selector: 'app-topbar',
  standalone: false,
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
})
export class TopbarComponent implements OnInit, OnDestroy {
  /* User-provided - controls whether the help panel is currently open */
  helpOpen  = false;
  /* User-provided - controls whether the language selector dropdown is open */
  langOpen  = false;
  /* User-provided - controls whether the notifications panel is open */
  notifOpen = false;

  /* Computed - slug of the current route, used to load context-sensitive help text */
  currentPage = 'dashboard';

  /* Fixed - list of available language options for the language selector */
  readonly languages = LANGUAGES;

  /* Computed - Observable of the full active vessel alert list */
  readonly alerts$:      Observable<VesselAlert[]>;
  /* Computed - Observable of the count of unread vessel alerts */
  readonly unreadCount$: Observable<number>;
  /* Computed - Observable that emits true when at least one unread alert exists */
  readonly hasUnread$:   Observable<boolean>;

  /* Computed - composite subscription tracking router and alert subscriptions */
  private sub = new Subscription();

  constructor(
    private router:    Router,
    readonly lang:     LanguageService,
    readonly alertSvc: VesselAlertService,
  ) {
    this.alerts$      = alertSvc.alerts$;
    this.unreadCount$ = alertSvc.unreadCount$;
    this.hasUnread$   = alertSvc.hasUnread$;
  }

  /*
   * Initialises the current page from the router URL and subscribes to navigation events to keep it in sync.
   */
  ngOnInit(): void {
    this.currentPage = this._pageFromUrl(this.router.url);

    this.sub.add(
      this.router.events
        .pipe(filter(e => e instanceof NavigationEnd))
        .subscribe((e) => {
          this.currentPage = this._pageFromUrl((e as NavigationEnd).urlAfterRedirects);
          this.helpOpen  = false;
          this.notifOpen = false;
        })
    );
  }

  /*
   * Returns the translated help panel title for the current page.
   * @returns Localised help title string
   */
  get helpTitle(): string { return this.lang.t(`help.${this.currentPage}.title`); }
  /*
   * Returns the translated help panel body text for the current page.
   * @returns Localised help body string
   */
  get helpBody():  string { return this.lang.t(`help.${this.currentPage}.body`);  }

  /*
   * Toggles the help panel and closes all other dropdowns.
   */
  toggleHelp():  void { this.helpOpen  = !this.helpOpen;  this.langOpen  = false; this.notifOpen = false; }
  /*
   * Closes the help panel.
   */
  closeHelp():   void { this.helpOpen  = false; }

  /*
   * Toggles the language selector and closes all other dropdowns.
   */
  toggleLang():  void { this.langOpen  = !this.langOpen;  this.helpOpen  = false; this.notifOpen = false; }
  /*
   * Closes the language selector dropdown.
   */
  closeLang():   void { this.langOpen  = false; }

  /*
   * Toggles the notifications panel and marks all alerts as read when opening.
   */
  toggleNotif(): void {
    this.notifOpen = !this.notifOpen;
    this.helpOpen  = false;
    this.langOpen  = false;
    if (this.notifOpen) {
      this.alertSvc.markAllRead();
    }
  }
  /*
   * Closes the notifications panel.
   */
  closeNotif():  void { this.notifOpen = false; }

  /*
   * Delegates dismissal of the given alert to VesselAlertService.
   * @param id - The unique alert identifier to dismiss (required)
   */
  dismissAlert(id: string): void {
    this.alertSvc.dismiss(id);
  }

  /*
   * Formats a Unix millisecond timestamp as a localised HH:MM time string.
   * @param ms - Unix timestamp in milliseconds to format (required)
   * @returns Zero-padded HH:MM string
   */
  formatTime(ms: number): string {
    const d  = new Date(ms);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  }

  /*
   * Applies the selected language and closes the language dropdown.
   * @param code - The language code to activate (required)
   */
  selectLang(code: LangCode): void {
    this.lang.set(code);
    this.langOpen = false;
  }

  /*
   * Unsubscribes from all active subscriptions on component destruction.
   */
  ngOnDestroy(): void { this.sub.unsubscribe(); }

  /*
   * Extracts the first path segment from a URL string to identify the current page.
   * @param url - The full router URL string (required)
   * @returns The first non-empty path segment, or 'dashboard' as the default
   */
  private _pageFromUrl(url: string): string {
    return url.split('/')[1]?.split('?')[0] || 'dashboard';
  }
}

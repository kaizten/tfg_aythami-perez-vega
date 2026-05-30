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
  helpOpen  = false;
  langOpen  = false;
  notifOpen = false;

  currentPage = 'dashboard';

  readonly languages = LANGUAGES;

  readonly alerts$:      Observable<VesselAlert[]>;
  readonly unreadCount$: Observable<number>;
  readonly hasUnread$:   Observable<boolean>;

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

  get helpTitle(): string { return this.lang.t(`help.${this.currentPage}.title`); }
  get helpBody():  string { return this.lang.t(`help.${this.currentPage}.body`);  }

  toggleHelp():  void { this.helpOpen  = !this.helpOpen;  this.langOpen  = false; this.notifOpen = false; }
  closeHelp():   void { this.helpOpen  = false; }

  toggleLang():  void { this.langOpen  = !this.langOpen;  this.helpOpen  = false; this.notifOpen = false; }
  closeLang():   void { this.langOpen  = false; }

  toggleNotif(): void {
    this.notifOpen = !this.notifOpen;
    this.helpOpen  = false;
    this.langOpen  = false;
    if (this.notifOpen) {
      // Mark all as read when the dropdown is opened.
      this.alertSvc.markAllRead();
    }
  }
  closeNotif():  void { this.notifOpen = false; }

  dismissAlert(id: string): void {
    this.alertSvc.dismiss(id);
  }

  /** Formats a Unix-ms timestamp as a localised HH:MM string. */
  formatTime(ms: number): string {
    const d  = new Date(ms);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  }

  selectLang(code: LangCode): void {
    this.lang.set(code);
    this.langOpen = false;
  }

  ngOnDestroy(): void { this.sub.unsubscribe(); }

  private _pageFromUrl(url: string): string {
    return url.split('/')[1]?.split('?')[0] || 'dashboard';
  }
}

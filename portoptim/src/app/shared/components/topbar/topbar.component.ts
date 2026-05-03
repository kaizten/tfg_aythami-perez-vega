import { Component, OnDestroy, OnInit } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { LangCode, LANGUAGES } from '../../../core/i18n/translations';
import { LanguageService } from '../../../core/services/language.service';

@Component({
  selector: 'app-topbar',
  standalone: false,
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
})
export class TopbarComponent implements OnInit, OnDestroy {
  helpOpen = false;
  langOpen  = false;

  currentPage = 'dashboard';

  readonly languages = LANGUAGES;

  private sub = new Subscription();

  constructor(
    private router: Router,
    readonly lang: LanguageService,
  ) {}

  ngOnInit(): void {
    this.currentPage = this._pageFromUrl(this.router.url);

    this.sub.add(
      this.router.events
        .pipe(filter(e => e instanceof NavigationEnd))
        .subscribe((e) => {
          this.currentPage = this._pageFromUrl((e as NavigationEnd).urlAfterRedirects);
          this.helpOpen = false;
        })
    );
  }

  get helpTitle(): string { return this.lang.t(`help.${this.currentPage}.title`); }
  get helpBody(): string  { return this.lang.t(`help.${this.currentPage}.body`); }

  toggleHelp(): void { this.helpOpen = !this.helpOpen; this.langOpen  = false; }
  closeHelp(): void  { this.helpOpen = false; }

  toggleLang(): void { this.langOpen  = !this.langOpen;  this.helpOpen = false; }
  closeLang(): void  { this.langOpen  = false; }

  selectLang(code: LangCode): void {
    this.lang.set(code);
    this.langOpen = false;
  }

  ngOnDestroy(): void { this.sub.unsubscribe(); }

  private _pageFromUrl(url: string): string {
    return url.split('/')[1]?.split('?')[0] || 'dashboard';
  }
}

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { LangCode, translations } from '../i18n/translations';

@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly _lang = new BehaviorSubject<LangCode>('en');
  readonly lang$ = this._lang.asObservable();

  get current(): LangCode { return this._lang.value; }

  set(lang: LangCode): void { this._lang.next(lang); }

  t(key: string): string {
    return translations[this.current][key] ?? key;
  }
}

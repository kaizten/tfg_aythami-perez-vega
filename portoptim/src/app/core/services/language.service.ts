import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { LangCode, translations } from '../i18n/translations';

@Injectable({ providedIn: 'root' })
export class LanguageService {
  /* Computed - internal BehaviorSubject holding the active language code */
  private readonly _lang = new BehaviorSubject<LangCode>('en');
  /* Computed - public Observable stream of the active language code */
  readonly lang$ = this._lang.asObservable();

  /*
   * Returns the currently active language code.
   * @returns The active LangCode value
   */
  get current(): LangCode { return this._lang.value; }

  /*
   * Updates the active language to the given code and notifies all subscribers.
   * @param lang - The language code to activate (required)
   */
  set(lang: LangCode): void { this._lang.next(lang); }

  /*
   * Looks up a translation key in the current language dictionary and returns the translated string.
   * Falls back to the key itself when no translation is found.
   * @param key - The translation key to look up (required)
   * @returns The translated string, or the key if no translation exists
   */
  t(key: string): string {
    return translations[this.current][key] ?? key;
  }
}

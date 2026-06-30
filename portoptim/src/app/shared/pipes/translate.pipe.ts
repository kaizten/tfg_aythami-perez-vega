import { Pipe, PipeTransform } from '@angular/core';
import { LanguageService } from '../../core/services/language.service';

@Pipe({ name: 'translate', pure: false, standalone: false })
export class TranslatePipe implements PipeTransform {
  constructor(private lang: LanguageService) {}

  /*
   * Translates a key string into the currently active language using LanguageService.
   * Falls back to the key itself when no translation is found.
   * @param key - The translation key to look up (required)
   * @returns The translated string for the current language
   */
  transform(key: string): string {
    return this.lang.t(key);
  }
}

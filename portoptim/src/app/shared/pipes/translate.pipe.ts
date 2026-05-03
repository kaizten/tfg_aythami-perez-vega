import { Pipe, PipeTransform } from '@angular/core';
import { LanguageService } from '../../core/services/language.service';

/** Translates a key string to the current language. Pure: false so it reacts to language changes. */
@Pipe({ name: 'translate', pure: false, standalone: false })
export class TranslatePipe implements PipeTransform {
  constructor(private lang: LanguageService) {}

  transform(key: string): string {
    return this.lang.t(key);
  }
}

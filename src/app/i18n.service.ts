import { Injectable, computed, signal } from '@angular/core';
import { APP_NAME, DICTS, I18nKey, LOCALES, Lang, detectLang } from './i18n';

// Intl formatters are expensive to build, so keep one per locale/digits. The
// tables call these helpers for every visible cell on every change detection:
// building a formatter per call made big listings (and scans) visibly slow.
const INT_FMT = new Map<string, Intl.NumberFormat>();
const NUM_FMT = new Map<string, Intl.NumberFormat>();
const SHORT_DATE_FMT = new Map<string, Intl.DateTimeFormat>();
const LONG_DATE_FMT = new Map<string, Intl.DateTimeFormat>();

function intFormatter(locale: string): Intl.NumberFormat {
  let f = INT_FMT.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale);
    INT_FMT.set(locale, f);
  }
  return f;
}

function numFormatter(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let f = NUM_FMT.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    NUM_FMT.set(key, f);
  }
  return f;
}

function shortDateFormatter(locale: string): Intl.DateTimeFormat {
  let f = SHORT_DATE_FMT.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
    SHORT_DATE_FMT.set(locale, f);
  }
  return f;
}

function longDateFormatter(locale: string): Intl.DateTimeFormat {
  let f = LONG_DATE_FMT.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale);
    LONG_DATE_FMT.set(locale, f);
  }
  return f;
}

/**
 * Reactive language state. The signal is read from the templates (through the
 * component's `t()` helper), so switching the language re-renders the whole UI
 * without a reload. `set()` also pushes the choice to the main process, which
 * rebuilds the native menu in that language.
 */
@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<Lang>(detectLang());
  private readonly dict = computed(() => DICTS[this.lang()]);

  /** BCP-47 tag used for number/date formatting. */
  readonly locale = computed(() => LOCALES[this.lang()]);

  /** false until the persisted choice has been read (see `load`). */
  readonly loaded = signal(false);

  t(key: I18nKey): string {
    // `{app}` is the only placeholder present in strings used without parameters
    // (report/print titles), so it is resolved here as well as in `tf()`.
    return this.dict()[key].split('{app}').join(APP_NAME);
  }

  /** Translation with `{name}` placeholders filled in. */
  tf(key: I18nKey, params: Record<string, string | number>): string {
    let s = this.t(key);
    for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
    return s;
  }

  /** Locale-aware grouping (1.234 / 1 234 / 1 234 depending on the language). */
  int(n: number): string {
    return intFormatter(this.locale()).format(n);
  }

  /** Locale-aware number with a fixed number of decimals (1,50 vs 1.50). */
  num(n: number, digits: number): string {
    return numFormatter(this.locale(), digits).format(n);
  }

  /** Short date+time for the details list. */
  dateShort(ms: number): string {
    if (!ms) return '';
    return shortDateFormatter(this.locale()).format(ms);
  }

  /** Full date+time used in generated reports/printouts. */
  dateLong(ms: number | Date): string {
    return longDateFormatter(this.locale()).format(ms);
  }

  /** Apply the persisted language (called once at startup, before the user interacts). */
  async load(): Promise<void> {
    const s = await window.driversize?.getSettings();
    const v = s?.['lang'];
    if (v === 'pt' || v === 'en' || v === 'es' || v === 'fr') this.set(v, false);
    // Only now may the renderer override the language the main process already
    // used to build the menu: this avoids a needless rebuild at startup.
    this.loaded.set(true);
  }

  /** Switch language; persists it and rebuilds the native menu. */
  set(lang: Lang, persist = true): void {
    this.lang.set(lang);
    document.documentElement.lang = LOCALES[lang];
    window.driversize?.setMenuState({ lang });
    if (persist) void window.driversize?.setSettings({ lang });
  }
}

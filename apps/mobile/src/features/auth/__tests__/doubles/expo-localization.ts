export function getLocales(): Array<{ languageCode: string | null; regionCode: string | null }> {
  return [{ languageCode: 'en', regionCode: 'GB' }];
}

export function getCalendars(): Array<{ timeZone: string | null }> {
  return [{ timeZone: 'Europe/London' }];
}

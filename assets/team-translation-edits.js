const normalized = value => String(value || "").trim().normalize("NFC").replace(/\r\n?/g, "\n");

// Compare against the last machine preview (or the original saved text), so
// typing and then undoing an edit does not create a new manual lock.
export function manualTranslationEdits(fields, baseline, edits) {
  return Object.fromEntries(Object.entries(fields).flatMap(([field, value]) => {
    const locales = ["zhHant", "zhHans"].filter(locale =>
      edits[field]?.[locale] && normalized(value[locale]) &&
      normalized(value[locale]) !== normalized(baseline[field]?.[locale]),
    );
    return locales.length ? [[field, locales]] : [];
  }));
}

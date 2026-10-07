import type { ContentLocale } from './content-store';
import type { HomeBannerItem, HomeBannerSnapshot } from './home-banner';
import type { SiteMediaAlt } from './site-media-types';

const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export const HOME_BANNER_IMAGE_SIZES = '(min-width: 1160px) 762px, (min-width: 1024px) calc((100vw - 72px) * 0.7), calc(100vw - 48px)';

export function homeBannerText(values: SiteMediaAlt | null, locale: ContentLocale): string {
  return values?.[locale]?.trim() ? values[locale] : values?.en?.trim() ? values.en : '';
}
const textLanguage = (values: SiteMediaAlt | null, locale: ContentLocale) => values?.[locale]?.trim() ? ({ en: 'en', zhHant: 'zh-Hant', zhHans: 'zh-Hans' }[locale]) : 'en';
function copy(item: HomeBannerItem, locale: ContentLocale, active: boolean): string {
  const title = homeBannerText(item.title, locale), caption = homeBannerText(item.caption, locale);
  return `<div class="home-banner__text"${title || caption ? '' : ' hidden'}><h3${active ? ' data-home-banner-field="title"' : ''} lang="${textLanguage(item.title, locale)}"${title ? '' : ' hidden'}>${escapeText(title)}</h3><p${active ? ' data-home-banner-field="caption"' : ''} lang="${textLanguage(item.caption, locale)}"${caption ? '' : ' hidden'}>${escapeText(caption)}</p></div>`;
}
function firstImage(item: HomeBannerItem, items: HomeBannerItem[], locale: ContentLocale, fallback: string): string {
  const largest = item.image.variants.reduce<HomeBannerItem['image']['variants'][number] | undefined>((current, variant) => !current || variant.pixelWidth > current.pixelWidth ? variant : current, undefined);
  const width = largest?.pixelWidth || 1200, height = largest?.pixelHeight || 799;
  const locales = ['en', 'zhHant', 'zhHans'] as const;
  // Reserve all public slides and locales in the initial HTML. Enhancing or
  // manually selecting a longer slide then does not move the following cards.
  const hasCopy = items.some(entry => locales.some(language => homeBannerText(entry.title, language) || homeBannerText(entry.caption, language)));
  return `<div class="home-banner__image"><img data-home-banner-image data-home-banner-field="alt" src="${escapeAttribute(item.image.src)}" srcset="${escapeAttribute(item.image.srcSet)}" sizes="${HOME_BANNER_IMAGE_SIZES}" width="${width}" height="${height}" alt="${escapeAttribute(homeBannerText(item.image.alt, locale))}" lang="${textLanguage(item.image.alt, locale)}" fetchpriority="high" loading="eager" decoding="async"><div class="home-banner__image-error" data-home-banner-image-error hidden>${fallback}</div></div><div class="home-banner__copy"${hasCopy ? '' : ' hidden'}>${copy(item, locale, true)}<div class="home-banner__reserve" aria-hidden="true">${items.flatMap(entry => locales.map(language => copy(entry, language, false))).join('')}</div></div>`;
}

/** Called after fixed content slots render, before sending this request's HTML. */
export function renderHomeBanner(html: string, snapshot: HomeBannerSnapshot, locale: ContentLocale, request: Request): string {
  const first = snapshot.state === 'ready' ? snapshot.items[0] : undefined;
  const fallback = /<template\b[^>]*data-home-banner-image-error-template[^>]*>([\s\S]*?)<\/template>/i.exec(html)?.[1] || '';
  html = html.replace(/(<section\b[^>]*\bdata-home-focus\b[^>]*\bdata-banner-state=")[^"]*(")/i, `$1${snapshot.state}$2`);
  html = html.replace(/(<div\b[^>]*\bdata-home-banner)(?=[\s>])([^>]*>)/i, (_match, prefix: string, suffix: string) => `${prefix}${snapshot.state === 'empty' ? ' hidden' : ''}${suffix.replace(/\s+hidden\b/g, '')}`);
  if (first) html = html.replace(/<!-- home-banner:start -->[\s\S]*?<!-- home-banner:end -->/, () => `<!-- home-banner:start -->${firstImage(first, snapshot.items, locale, fallback)}<!-- home-banner:end -->`);
  else if (snapshot.state === 'empty') html = html.replace(/<!-- home-banner:start -->[\s\S]*?<!-- home-banner:end -->/, '<!-- home-banner:start --><!-- home-banner:end -->');
  const requestUrl = new URL(request.url);
  const retryUrl = escapeAttribute(requestUrl.pathname + requestUrl.search);
  html = html.replace(/<a\b[^>]*\bdata-home-banner-retry\b[^>]*>/i, opening => opening.replace(/\bhref="[^"]*"/, () => `href="${retryUrl}"`));
  const preload = first ? `\n<link rel="preload" as="image" href="${escapeAttribute(first.image.src)}" imagesrcset="${escapeAttribute(first.image.srcSet)}" imagesizes="${HOME_BANNER_IMAGE_SIZES}" fetchpriority="high" data-home-banner-preload>` : '';
  // Insert ahead of the existing synchronous head bootstrap so localStorage's
  // browser-only language can be applied before body content is painted.
  return html.replace(/<head([^>]*)>/i, opening => `${opening}\n<script id="ihear-home-banner" type="application/json">${json(snapshot)}</script>${preload}`);
}

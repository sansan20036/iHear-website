import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

const source = await readFile(new URL('../assets/site-media-bootstrap.js', import.meta.url), 'utf8');
const media = { items: { 'home.hero': {
  src: '/api/site-media/home.hero/image?width=1200&v=4&asset=custom-home-hero',
  srcSet: '/api/site-media/home.hero/image?width=480&v=4&asset=custom-home-hero 480w, /api/site-media/home.hero/image?width=1200&v=4&asset=custom-home-hero 1200w',
} } };

async function bootstrap(snapshot, pathname = '/') {
  const links = [], window = {};
  const fetch = vi.fn(async () => ({ ok: true, json: async () => media }));
  const document = {
    documentElement: { classList: { add: vi.fn() } },
    getElementById: vi.fn(id => id === 'ihear-home-banner' && snapshot ? { textContent: JSON.stringify(snapshot) } : null),
    createElement: vi.fn(tag => ({ tagName: tag.toUpperCase() })),
    head: { appendChild: vi.fn(element => links.push(element)) },
  };
  runInNewContext(source, { document, window, fetch, location: { pathname } }, { filename: 'site-media-bootstrap.js' });
  const initialPromise = window.iHearInitialSiteMedia;
  expect(typeof initialPromise?.then).toBe('function');
  const resolved = await initialPromise;
  // The later site-media controller must consume the same authoritative lookup,
  // even when Banner SSR owns the navigation's prioritized image.
  expect(window.iHearInitialSiteMedia).toBe(initialPromise);
  expect(resolved).toBe(media);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/site-media', { credentials: 'same-origin', cache: 'no-store' });
  expect(document.documentElement.classList.add).toHaveBeenCalledWith('site-media-loading');
  return { links, document };
}

test.each(['ready', 'empty', 'error'])('Banner %s snapshot suppresses legacy hero priority while retaining the shared lookup', async state => {
  const snapshot = { schemaVersion: 1, galleryId: 'home-banner', state, version: state === 'error' ? null : 3, items: [] };
  const { links, document } = await bootstrap(snapshot);
  expect(links).toEqual([]);
  expect(document.head.appendChild).not.toHaveBeenCalled();
});

test('legacy homepage without a Banner snapshot retains its single high-priority hero preload', async () => {
  for (const pathname of ['/', '/index.html']) {
    const { links } = await bootstrap(null, pathname);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      tagName: 'LINK', rel: 'preload', as: 'image', href: media.items['home.hero'].src,
      imageSrcset: media.items['home.hero'].srcSet, imageSizes: '(max-width: 900px) calc(100vw - 48px), 520px', fetchPriority: 'high',
    });
  }
});

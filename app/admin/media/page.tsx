"use client";

import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '../admin-context';
import { adminFetch, displayError } from '../admin-api';
import { compressAdminImage } from '../../../lib/client-image-compression';
import { youtubeVideoId } from '../../../assets/youtube';
import { emptyCaption, galleryAssetSlot, GALLERY_TITLE_LIMIT, type GalleryId, type PublicGallery, type PublicGalleryItem } from '../../../lib/media-gallery-types';
import type { SiteMediaAlt } from '../../../lib/site-media-types';

type Draft = { resource: { id: string; version: number }; originalAlt?: SiteMediaAlt; originalCaption: SiteMediaAlt; originalHidden: boolean; originalTitle: SiteMediaAlt | null; title: SiteMediaAlt; titleDirty: boolean; titleEdited: Locale[]; existing: boolean; key: string; operationId: string; itemId: string; kind: 'photo' | 'youtube'; file?: File; preview?: string; previewSrcSet?: string; compressed?: File; url: string; alt: SiteMediaAlt; caption: SiteMediaAlt; editAlt: boolean; hidden: boolean; receipt: string; manual: string[]; status: string; done: boolean; attempted: boolean; payload?: any };
const names = {
  en: { tutoring: 'English tutoring · Home + Programs', outreach: 'Community outreach · Home + Programs', home: 'Homepage media', stories: 'Stories media', impact: 'Impact media', 'home-banner': 'Homepage Banner · Photos only' },
  zhHant: { tutoring: '英語輔導 · 首頁＋Programs 共用', outreach: '社區推廣 · 首頁＋Programs 共用', home: '首頁媒體展示', stories: '生命故事媒體展示', impact: '成果媒體展示', 'home-banner': '首頁 Banner · 僅限照片' },
  zhHans: { tutoring: '英语辅导 · 首页＋Programs 共用', outreach: '社区推广 · 首页＋Programs 共用', home: '首页媒体展示', stories: '生命故事媒体展示', impact: '成果媒体展示', 'home-banner': '首页 Banner · 仅限照片' },
};
const languages = { en: 'English', zhHant: '繁體中文', zhHans: '简体中文' };
type Locale = keyof SiteMediaAlt;
type BannerPreviewViewport = 'mobile' | 'desktop';
function BannerPreview({ src, srcSet, alt, title, locale, viewport, unavailable, untitled }: { src?: string; srcSet?: string; alt: string; title: SiteMediaAlt | null; locale: Locale; viewport: BannerPreviewViewport; unavailable: string; untitled: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src, srcSet]);
  const localTitle = title?.[locale]?.trim();
  const displayTitle = localTitle || title?.en?.trim() || '';
  const titleLocale = localTitle ? locale : 'en';
  return <figure className="admin-banner-preview" data-preview-mode={viewport}>
    <div className="admin-banner-preview-image">
      {src && !failed ? <img src={src} srcSet={srcSet || undefined} sizes="(max-width: 700px) 100vw, 640px" alt={alt} onError={() => setFailed(true)} /> : <p role="status">{unavailable}</p>}
    </div>
    <figcaption className={`admin-banner-preview-title${displayTitle ? '' : ' is-empty'}`} data-testid="banner-preview-title" lang={displayTitle ? titleLocale === 'zhHant' ? 'zh-Hant' : titleLocale === 'zhHans' ? 'zh-Hans' : 'en' : undefined}>{displayTitle || untitled}</figcaption>
  </figure>;
}
function newDraft(kind: Draft['kind'], item?: PublicGalleryItem): Draft {
  const operationId = crypto.randomUUID();
  return { resource: { id: item?.assetSlot || galleryAssetSlot(operationId), version: item?.image?.recordVersion || 0 }, originalAlt: item?.image?.alt, originalCaption: item?.caption || emptyCaption(), originalHidden: item?.hidden || false, originalTitle: item?.title ?? null, title: { ...item?.title || emptyCaption() }, titleDirty: false, titleEdited: [], existing: !!item, key: operationId, operationId, itemId: item?.id || operationId, kind, url: item?.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : '', alt: { ...item?.image?.alt || emptyCaption() }, caption: { ...item?.caption || emptyCaption() }, hidden: item?.hidden || false, preview: item?.image?.src, previewSrcSet: item?.image?.srcSet, editAlt: !!item?.image?.recordVersion, receipt: '', manual: item?.image ? ['zhHant', 'zhHans'].filter(lang => item.altStates?.find(state => state.locale === lang)?.origin !== 'machine') : [], status: '', done: false, attempted: false };
}
export default function MediaPage() {
  const { locale, setDirty, setSubmitting, confirmAction } = useAdmin();
  const t = (en: string, hant: string, hans = hant) => locale === 'en' ? en : locale === 'zhHans' ? hans : hant;
  const [galleries, setGalleries] = useState<PublicGallery[]>([]);
  const [selected, setSelected] = useState<GalleryId>('tutoring');
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [previewLocale, setPreviewLocale] = useState<Locale>(locale);
  const [previewViewport, setPreviewViewport] = useState<BannerPreviewViewport>('mobile');
  const [embedded, setEmbedded] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<PublicGalleryItem | null>(null);
  const [conflict, setConflict] = useState(false);
  const current = useRef<PublicGallery | undefined>(undefined);
  const draftRef = useRef(drafts); draftRef.current = drafts;
  const alive = useRef(true);
  const objectUrls = useRef<string[]>([]);
  const gallery = galleries.find(g => g.id === selected);
  const banner = selected === 'home-banner';
  current.current = gallery;
  const pending = drafts.some(d => !d.done);
  useEffect(() => { setDirty('media', pending); return () => setDirty('media', false); }, [pending, setDirty]);
  useEffect(() => {
    alive.current = true;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('gallery');
    if (requested && Object.hasOwn(names.en, requested)) { selectedRef.current = requested as GalleryId; setSelected(requested as GalleryId); }
    setEmbedded(window.parent !== window && params.get('embed') === '1');
    void load();
    return () => { alive.current = false; objectUrls.current.forEach(url => URL.revokeObjectURL(url)); };
  }, []);
  useEffect(() => {
    if (!embedded) return;
    window.parent.postMessage({ type: 'ihear:gallery-editor-state', busy }, window.location.origin);
    const requestClose = () => {
      if (busy) return;
      confirmAction(() => window.parent.postMessage({ type: 'ihear:gallery-editor-close' }, window.location.origin));
    };
    const receive = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === window.parent && event.data?.type === 'ihear:gallery-editor-close-request') requestClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target as Element)?.closest('dialog[open]')) { event.preventDefault(); requestClose(); }
    };
    window.addEventListener('message', receive); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('message', receive); window.removeEventListener('keydown', escape); };
  }, [embedded, busy, confirmAction]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (busy || pending) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [busy, pending]);
  function patch(key: string, changes: Partial<Draft>) { setDrafts(list => list.map(d => d.key === key ? { ...d, ...changes } : d)); }
  function accept(item: PublicGallery) {
    current.current = item;
    setGalleries(list => list.map(g => g.id === item.id ? item : g));
    // The public controller also observes the database content revision.
    try { const channel = new BroadcastChannel('ihear-media-galleries'); channel.postMessage('updated'); channel.close(); } catch { /* polling remains available */ }
    if (embedded) window.parent.postMessage({ type: 'ihear:gallery-editor-saved' }, window.location.origin);
  }
  async function load() {
    setLoading(true);
    try {
      const data = await adminFetch<{ items: PublicGallery[] }>('/api/media-galleries?admin=1');
      if (alive.current) {
        setGalleries(data.items); current.current = data.items.find(g => g.id === selectedRef.current); setError('');
        // Refresh after a conflict keeps typed translations while taking untouched
        // locales from the latest saved item. Ambiguous/retry payloads stay frozen.
        if (selectedRef.current === 'home-banner') setDrafts(list => list.map(draft => {
          const latest = current.current?.items.find(item => item.id === draft.itemId);
          if (!latest || draft.done || draft.attempted) return draft;
          const title = { ...latest.title || emptyCaption() };
          for (const language of draft.titleEdited) title[language] = draft.title[language];
          const caption = { ...latest.caption };
          for (const language of Object.keys(languages) as Locale[]) if (draft.caption[language] !== draft.originalCaption[language]) caption[language] = draft.caption[language];
          const unchangedPhoto = !draft.file && JSON.stringify(draft.alt) === JSON.stringify(draft.originalAlt);
          return { ...draft, title, originalTitle: latest.title, caption, originalCaption: latest.caption, hidden: draft.hidden === draft.originalHidden ? latest.hidden : draft.hidden, originalHidden: latest.hidden, ...(unchangedPhoto && latest.image ? { preview: latest.image.src, previewSrcSet: latest.image.srcSet, alt: { ...latest.image.alt }, originalAlt: latest.image.alt, resource: { id: latest.assetSlot || draft.resource.id, version: latest.image.recordVersion }, editAlt: !!latest.image.recordVersion, manual: ['zhHant', 'zhHans'].filter(language => latest.altStates?.find(state => state.locale === language)?.origin !== 'machine'), receipt: '' } : {}) };
        }));
      }
      return true;
    } catch (e) { if (alive.current) setError(displayError(e, locale)); return false; }
    finally { if (alive.current) setLoading(false); }
  }
  async function work(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setSubmitting(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(displayError(e, locale)); }
    finally { setBusy(false); setSubmitting(false); }
  }
  async function withLimit<T>(fn: () => Promise<T>, key?: string): Promise<T> {
    for (;;) {
      if (!alive.current) throw new Error('Cancelled');
      try { return await fn(); }
      catch (e) {
        const details = e as { status?: number; retryAfter?: number };
        if (details.status !== 429) throw e;
        for (let seconds = Math.max(1, details.retryAfter || 60); seconds > 0; seconds--) {
          if (!alive.current) throw new Error('Cancelled');
          const message = t(`Waiting ${seconds}s before retrying`, `等待 ${seconds} 秒後繼續`, `等待 ${seconds} 秒后继续`);
          if (key) patch(key, { status: message }); else setNotice(message);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }
  function choosePhotos(files: FileList | null, replaceKey?: string) {
    if (!files?.length) return;
    const replacements = drafts.filter(d => !d.done && !gallery?.items.some(i => i.id === d.itemId)).length;
    if (!replaceKey && (gallery?.items.length || 0) + replacements + files.length > 20) { setError(t('Maximum 20 items per gallery, including hidden items.', '每區最多 20 個項目，包含隱藏項目。')); return; }
    const added: Draft[] = [];
    for (const file of Array.from(files)) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024 || !file.size) { setError(t('Choose PNG, JPEG or WebP photos, up to 20 MB each.', '請選擇 PNG、JPEG 或 WebP 照片，每張上限 20 MB。')); continue; }
      const preview = URL.createObjectURL(file); objectUrls.current.push(preview);
      if (replaceKey) { patch(replaceKey, { file, preview, previewSrcSet: undefined, compressed: undefined, editAlt: true, receipt: '', status: '' }); break; }
      added.push({ ...newDraft('photo'), file, preview, editAlt: true });
    }
    if (added.length) setDrafts(list => [...list, ...added]);
  }
  async function translate(draft: Draft) {
    if (draft.alt.en.trim().length < 2) throw new Error(t('Enter the English photo description first.', '請先填寫英文照片描述。'));
    patch(draft.key, { status: t('Translating…', '翻譯中…') });
    const preview = await withLimit(() => adminFetch<any>('/api/admin/translations/preview', {
      method: 'POST', body: JSON.stringify({ resource: { type: 'media', scope: '', ...draft.resource }, fields: { alt: draft.alt }, manualEdits: { alt: draft.manual }, autoTranslate: true }),
    }), draft.key);
    patch(draft.key, { alt: preview.fields.alt.value, receipt: preview.receipt, status: t('Translation ready. Review it before saving.', '翻譯已產生，請確認後儲存。') });
  }
  async function saveDraft(draft: Draft) {
    const endpoint = `/api/media-galleries/${selected}`;
    if (draft.attempted) {
      const status = await adminFetch<{ committed: boolean; item: PublicGallery }>(`${endpoint}?operationId=${draft.operationId}`);
      if (status.committed) { accept(status.item); patch(draft.key, { done: true, status: t('Saved', '已儲存', '已保存') }); return; }
    }
    if (!draft.payload) {
      if (banner && draft.kind !== 'photo') throw new Error(t('Homepage Banner supports photos only.', '首頁 Banner 僅支援照片。', '首页 Banner 仅支持照片。'));
      if (draft.existing && !current.current?.items.some(item => item.id === draft.itemId)) throw new Error(t('This item was removed. Your draft is still here; discard it or copy its text before adding a new photo.', '此項目已被移除。草稿仍保留，請取消草稿，或先複製文字再新增照片。', '此项目已被移除。草稿仍保留，请取消草稿，或先复制文字再新增照片。'));
      if (banner && draft.titleDirty && draft.titleEdited.some(language => draft.title[language] !== draft.originalTitle?.[language] && draft.title[language].trim().length > GALLERY_TITLE_LIMIT)) throw new Error(t(`Each title must be ${GALLERY_TITLE_LIMIT} characters or fewer.`, `每種語言的標題最多 ${GALLERY_TITLE_LIMIT} 字。`, `每种语言的标题最多 ${GALLERY_TITLE_LIMIT} 字。`));
      if (draft.kind === 'photo' && draft.originalAlt && draft.alt.en !== draft.originalAlt.en && !draft.receipt) throw new Error(t('Preview translations after changing English, then review and save.', '英文變更後，請先預覽翻譯、確認內容，再儲存。'));
      if (draft.kind === 'youtube' && !youtubeVideoId(draft.url)) throw new Error(t('Enter a valid YouTube URL.', '請輸入有效的 YouTube 影片網址。'));
      if (draft.kind === 'photo' && draft.editAlt && Object.values(draft.alt).some(v => v.trim().length < 2 || v.trim().length > 300)) throw new Error(t('Photo descriptions need 2–300 characters in each language.', '照片替代文字每種語言都需要 2–300 字。'));
      patch(draft.key, { status: t('Preparing photo…', '準備照片中…') });
      if (draft.file && !draft.compressed) draft.compressed = await compressAdminImage(draft.file, { kind: 'site' });
      const latest = current.current?.items.find(item => item.id === draft.itemId);
      const title = { ...latest?.title || emptyCaption() };
      for (const language of draft.titleEdited) title[language] = draft.title[language];
      const caption = { ...draft.caption };
      if (banner && latest) for (const language of Object.keys(languages) as Locale[]) if (draft.caption[language] === draft.originalCaption[language]) caption[language] = latest.caption[language];
      const hidden = banner && latest && draft.hidden === draft.originalHidden ? latest.hidden : draft.hidden;
      draft.payload = { operationId: draft.operationId, expectedVersion: current.current?.version, action: 'put', item: { id: draft.itemId, kind: draft.kind, hidden, caption, url: draft.url, ...(banner && draft.titleDirty ? { title: Object.values(title).some(value => value.trim()) ? title : null } : {}) }, ...(draft.kind === 'photo' && draft.editAlt && (draft.file || JSON.stringify(draft.alt) !== JSON.stringify(draft.originalAlt)) ? { alt: draft.alt, translationReceipt: draft.receipt } : {}) };
      draft.attempted = true;
      patch(draft.key, { payload: draft.payload, compressed: draft.compressed, attempted: true });
    }
    let body: BodyInit = JSON.stringify(draft.payload);
    if (draft.compressed) { const form = new FormData(); form.set('metadata', JSON.stringify(draft.payload)); form.set('file', draft.compressed); body = form; }
    patch(draft.key, { status: t('Uploading and saving…', '上傳並儲存中…') });
    try {
      const saved = await withLimit(() => adminFetch<{ item: PublicGallery }>(endpoint, { method: 'POST', body }), draft.key);
      accept(saved.item); patch(draft.key, { done: true, status: t('Saved', '已儲存', '已保存') });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status < 500) {
        patch(draft.key, { payload: undefined, attempted: false });
        if (status === 409) setConflict(true);
      }
      throw e;
    }
  }
  async function saveAll() {
    await work(async () => {
      for (const draft of draftRef.current.filter(d => !d.done)) {
        try { await saveDraft(draft); }
        catch (e) {
          patch(draft.key, { status: displayError(e, locale) });
          const status = (e as { status?: number }).status;
          if (status === 409 || status === 403 || draft.attempted || (status && status >= 500)) throw e;
        }
      }
    });
  }
  async function mutate(item: PublicGalleryItem, action: 'remove' | 'move' | 'put', direction?: number) {
    await work(async () => {
      const operationId = crypto.randomUUID();
      // Omit title and image metadata for unchanged fields. The API retains them.
      const body = JSON.stringify({ operationId, expectedVersion: current.current?.version, action, ...(action === 'put' ? { item: { id: item.id, kind: item.kind, hidden: !item.hidden, caption: item.caption, url: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : '' } } : { itemId: item.id, ...(action === 'move' ? { direction } : {}) }) });
      try {
        const saved = await withLimit(() => adminFetch<{ item: PublicGallery }>(`/api/media-galleries/${selected}`, { method: 'POST', body }));
        accept(saved.item); setConfirmRemove(null);
      } catch (e) {
        const status = await adminFetch<{ committed: boolean; item: PublicGallery }>(`/api/media-galleries/${selected}?operationId=${operationId}`).catch(() => null);
        if (status?.committed) { accept(status.item); setConfirmRemove(null); return; }
        if ((e as { status?: number }).status === 409) setConflict(true);
        throw e;
      }
    });
  }
  const changeText = (draft: Draft, group: 'alt' | 'caption', language: keyof SiteMediaAlt, value: string) => {
    const changes: Partial<Draft> = { [group]: { ...draft[group], [language]: value } };
    if (group === 'alt') {
      if (language === 'en') changes.receipt = '';
      if (language !== 'en') changes.manual = [...new Set([...draft.manual, language])];
      else { changes.alt = { ...draft.alt, en: value }; for (const lang of ['zhHant', 'zhHans'] as const) if (!draft.manual.includes(lang)) changes.alt[lang] = ''; }
    }
    patch(draft.key, changes);
  };
  return <>
    <header className="admin-page-head"><div><h1>{t('Media galleries', '媒體展示', '媒体展示')}</h1><p>{banner ? t('Manage Homepage Banner photos and titles. Save each change to this gallery.', '管理首頁 Banner 照片與標題，儲存後更新此集合。', '管理首页 Banner 照片与标题，保存后更新此集合。') : t('Upload photos or add YouTube links. Each successful save updates the website immediately.', '上傳照片或貼上 YouTube 連結，每次儲存成功後立即更新網站。', '上传照片或粘贴 YouTube 链接，每次保存成功后立即更新网站。')}</p></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="admin-toolbar admin-gallery-toolbar"><label>{t('Gallery', '展示區', '展示区')}<select className="admin-select" value={selected} disabled={loading || busy || pending} onChange={e => { selectedRef.current = e.target.value as GalleryId; setSelected(e.target.value as GalleryId); setDrafts([]); setConflict(false); setError(''); setNotice(''); setConfirmRemove(null); }}>{Object.entries(names[locale]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><button className="admin-button secondary" disabled={loading || busy} onClick={() => void work(async () => { if (await load()) { setConflict(false); setConfirmRemove(null); } })}>{t('Refresh saved content', '重新讀取已儲存內容', '重新读取已保存内容')}</button><span className="admin-gallery-status" role="status">{loading ? t('Loading gallery…', '相簿載入中…', '相册加载中…') : gallery ? `${gallery.items.length} / 20` : t('Could not load gallery. Please retry.', '相簿載入失敗，請重新讀取。', '相册加载失败，请重新读取。')}</span></div>
    {conflict && <p className="admin-alert error" role="alert">{t('A newer version exists. Refresh saved content, review your draft, then save again.', '有更新版本，請重新讀取已儲存內容，核對草稿後再儲存。', '有更新版本，请重新读取已保存内容，核对草稿后再保存。')}</p>}
    <div className="admin-actions"><label className="admin-button primary">{t('Add photos', '新增照片')}<input className="admin-media-file" aria-label={t('Add photos', '新增照片')} type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy || !gallery || pending && drafts.some(d => d.attempted)} onChange={e => { choosePhotos(e.target.files); e.target.value = ''; }} /></label>{!banner && <button className="admin-button primary" disabled={busy || !gallery || (gallery.items.length + drafts.filter(d => !d.done && !gallery.items.some(i => i.id === d.itemId)).length >= 20)} onClick={() => setDrafts(list => [...list, newDraft('youtube')])}>{t('Add YouTube video', '新增 YouTube 影片')}</button>}</div>
    <p>{banner ? t('Photos only: PNG / JPEG / WebP, up to 20 MB each. Hidden photos count toward the 20-item limit.', '僅限照片：PNG／JPEG／WebP，每張上限 20 MB；隱藏照片也計入 20 個上限。', '仅限照片：PNG／JPEG／WebP，每张上限 20 MB；隐藏照片也计入 20 个上限。') : t('PNG / JPEG / WebP, up to 20 MB each. Videos: upload to YouTube, then paste the link. Hidden items count toward the 20-item limit.', '照片支援 PNG／JPEG／WebP，每張上限 20 MB。影片請先上傳 YouTube 再貼連結；隱藏項目也計入 20 個上限。')}</p>
    {banner && <div className="admin-banner-guidance"><div><strong>{t('Centered crop preview', '中央裁切預覽', '中央裁切预览')}</strong><p>{t('Original images are kept. Mobile photos use 16:9. The desktop preview scales the 666.4 × 420 px image area of a 1024 px homepage. Missing translations display English without changing saved text.', '原圖保持不變。手機圖片比例為 16:9；桌面預覽按比例縮小 1024 px 首頁的 666.4 × 420 px 圖片區。缺少翻譯時僅顯示英文，不會改寫儲存文字。', '原图保持不变。手机图片比例为 16:9；桌面预览按比例缩小 1024 px 首页的 666.4 × 420 px 图片区。缺少翻译时仅显示英文，不会改写保存文字。')}</p></div><label>{t('Preview viewport', '預覽畫面', '预览画面')}<select className="admin-select" aria-label="Banner preview viewport" value={previewViewport} onChange={e => setPreviewViewport(e.target.value as BannerPreviewViewport)}><option value="mobile">{t('Mobile · 16:9', '手機 · 16:9', '手机 · 16:9')}</option><option value="desktop">{t('Desktop · 1024 px', '桌面 · 1024 px', '桌面 · 1024 px')}</option></select></label><label>{t('Preview language', '預覽語言', '预览语言')}<select className="admin-select" aria-label="Banner preview language" value={previewLocale} onChange={e => setPreviewLocale(e.target.value as Locale)}>{Object.entries(languages).map(([language, label]) => <option key={language} value={language}>{label}</option>)}</select></label></div>}
    <div className="admin-media-list">{gallery?.items.map((item, index) => <article className={`admin-panel admin-media-item${banner ? ' admin-banner-item' : ''}`} key={item.id}>
      {banner && item.kind === 'photo' ? <BannerPreview src={item.image?.src} srcSet={item.image?.srcSet} alt={item.image?.alt[previewLocale] || item.image?.alt.en || ''} title={item.title} locale={previewLocale} viewport={previewViewport} unavailable={t('Photo preview unavailable. You can replace the photo.', '照片預覽無法載入，可更換照片。', '照片预览无法加载，可更换照片。')} untitled={t('No title', '未設定標題', '未设置标题')} /> : <img onLoad={e => { e.currentTarget.style.visibility = ""; }} onError={e => { e.currentTarget.style.visibility = "hidden"; }} src={item.image?.src || `https://i.ytimg.com/vi/${item.videoId}/default.jpg`} alt={item.image?.alt[locale] || ''} />}
      <div><strong>{index + 1}. {item.kind === 'photo' ? t('Photo', '照片') : 'YouTube'} {item.hidden ? t('(Hidden)', '（隱藏）', '（隐藏）') : ''}</strong><p>{item.caption[locale] || item.caption.en || item.image?.alt[locale]}</p>{banner && item.kind !== 'photo' && <p className="admin-alert error" role="alert">{t('This existing video is unsupported in Homepage Banner. Remove it and add a photo.', '首頁 Banner 不支援此既有影片，請移除後新增照片。', '首页 Banner 不支持此既有影片，请移除后新增照片。')}</p>}<div className="admin-actions admin-media-item-actions">
        <button className="admin-button secondary" disabled={busy || pending || banner && item.kind !== 'photo'} onClick={() => setDrafts([newDraft(item.kind, item)])}>{t('Edit / replace', '編輯／更換', '编辑／更换')}</button>
        <button className="admin-button secondary" disabled={busy || pending || conflict || banner && item.kind !== 'photo'} onClick={() => void mutate(item, 'put')}>{item.hidden ? t('Show', '顯示', '显示') : t('Hide', '隱藏', '隐藏')}</button>
        <button aria-label={t('Move up', '向前移動')} className="admin-button secondary" disabled={busy || pending || conflict || index === 0} onClick={() => void mutate(item, 'move', -1)}>↑</button>
        <button aria-label={t('Move down', '向後移動')} className="admin-button secondary" disabled={busy || pending || conflict || index === gallery.items.length - 1} onClick={() => void mutate(item, 'move', 1)}>↓</button>
        <button className="admin-button danger" disabled={busy || pending || conflict} onClick={() => setConfirmRemove(item)}>{t('Remove', '移除')}</button>
      </div></div>
    </article>)}</div>
    {gallery && !gallery.items.length && <p className="admin-empty">{banner ? t('No Banner photos. Add a photo when you are ready; this gallery stays empty until you save one.', '目前沒有 Banner 照片。新增並儲存照片後才會加入，此集合會保持空白。', '目前没有 Banner 照片。新增并保存照片后才会加入，此集合会保持空白。') : t('No media yet. This area stays hidden on the website.', '尚無媒體，網站會隱藏此展示區。')}</p>}
    {drafts.map((draft, index) => draft.done ? <p key={draft.key} className="admin-alert success" role="status">{draft.kind === "photo" ? t("Photo", "照片") : "YouTube"} {index + 1} · {draft.status}</p> : <fieldset className="admin-panel admin-media-draft" key={draft.key} disabled={busy || draft.done || draft.attempted}>
      <legend>{draft.kind === 'photo' ? t('Photo', '照片') : 'YouTube'} {index + 1}</legend>
      {draft.kind === 'photo' ? <>{banner ? <BannerPreview src={draft.preview} srcSet={draft.previewSrcSet} alt={draft.alt[previewLocale] || draft.alt.en || ''} title={draft.title} locale={previewLocale} viewport={previewViewport} unavailable={t('Photo preview unavailable. Choose a replacement photo.', '照片預覽無法載入，請選擇替換照片。', '照片预览无法加载，请选择替换照片。')} untitled={t('No title', '未設定標題', '未设置标题')} /> : <img className="admin-media-preview" src={draft.preview} alt="" />}<label>{t('Replace photo', '更換照片', '更换照片')}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { choosePhotos(e.target.files, draft.key); e.target.value = ''; }} /></label></> : <label>YouTube URL<input type="url" value={draft.url} onChange={e => patch(draft.key, { url: e.target.value })} placeholder="https://youtu.be/…" />{draft.url && !youtubeVideoId(draft.url) && <span role="alert">{t('Invalid YouTube link', 'YouTube 連結格式不正確')}</span>}</label>}
      {banner && <section className="admin-banner-titles" aria-labelledby={`banner-title-${draft.key}`}><h3 id={`banner-title-${draft.key}`}>{t('Banner titles (optional)', 'Banner 標題（選填）', 'Banner 标题（选填）')}</h3><p className="admin-muted">{t(`Up to ${GALLERY_TITLE_LIMIT} characters per language. Leave translations blank if unavailable.`, `每種語言最多 ${GALLERY_TITLE_LIMIT} 字，尚無翻譯可留空。`, `每种语言最多 ${GALLERY_TITLE_LIMIT} 字，尚无翻译可留空。`)}</p><div className="admin-media-fields">{(Object.entries(languages) as [Locale, string][]).map(([language, label]) => {
        const count = draft.title[language].trim().length;
        const unchanged = draft.title[language] === draft.originalTitle?.[language];
        const invalid = count > GALLERY_TITLE_LIMIT && !unchanged;
        const hintId = `title-count-${draft.key}-${language}`;
        return <label key={language}>{label}<textarea aria-label={`Title ${label}`} aria-describedby={hintId} aria-invalid={invalid} value={draft.title[language]} onChange={e => patch(draft.key, { title: { ...draft.title, [language]: e.target.value }, titleDirty: true, titleEdited: [...new Set([...draft.titleEdited, language])] })} /><small id={hintId} className={invalid ? 'admin-title-error' : ''}>{count} / {GALLERY_TITLE_LIMIT}{count > GALLERY_TITLE_LIMIT && (unchanged ? t(' · Existing title kept. Shorten this language if you change it.', ' · 既有標題保留；修改此語言時請縮短。', ' · 既有标题保留；修改此语言时请缩短。') : t(' · Shorten this title before saving.', ' · 儲存前請縮短標題。', ' · 保存前请缩短标题。'))}</small></label>;
      })}</div><button className="admin-button secondary" onClick={() => patch(draft.key, { title: emptyCaption(), titleDirty: true, titleEdited: ['en', 'zhHant', 'zhHans'] })}>{t('Clear all titles', '清空三語標題', '清空三语标题')}</button></section>}
      {draft.kind === 'photo' && draft.editAlt && <><h3>{t('Photo descriptions (required)', '照片替代文字（必填）')}</h3><div className="admin-media-fields">{Object.entries(languages).map(([language, label]) => <label key={language}>{label}<textarea minLength={2} maxLength={300} value={draft.alt[language as keyof SiteMediaAlt]} onChange={e => changeText(draft, 'alt', language as keyof SiteMediaAlt, e.target.value)} /></label>)}</div><button className="admin-button secondary" onClick={() => void work(() => translate(draft))}>{t('Preview translation', '預覽翻譯', '预览翻译')}</button><small>{t('Manually entered Chinese is preserved. Clear a Chinese field to translate it again.', '已手動填寫的中文會保留；若要重新翻譯，請先清空該中文欄位。')}</small></>}
      <h3>{t('Display captions (optional)', '顯示說明（選填）', '显示说明（选填）')}</h3><div className="admin-media-fields">{Object.entries(languages).map(([language, label]) => <label key={language}>{label}<textarea maxLength={300} value={draft.caption[language as keyof SiteMediaAlt]} onChange={e => changeText(draft, 'caption', language as keyof SiteMediaAlt, e.target.value)} /></label>)}</div>
      <label><input type="checkbox" checked={draft.hidden} onChange={e => patch(draft.key, { hidden: e.target.checked })} />{t('Keep hidden', '隱藏此項目', '隐藏此项目')}</label>
      <p role="status">{draft.status}</p>
      {!draft.done && <button className="admin-button secondary" onClick={() => setDrafts(list => list.filter(d => d.key !== draft.key))}>{t('Discard this draft', '取消此草稿')}</button>}
    </fieldset>)}
    {pending && <div className="admin-actions"><button className="admin-button primary" disabled={busy || conflict} onClick={() => void saveAll()}>{busy ? t('Working…', '處理中…') : t('Save / retry pending items', '儲存／重試未完成項目', '保存／重试未完成项目')}</button><button className="admin-button secondary" disabled={busy || drafts.some(d => d.attempted && !d.done)} onClick={() => void work(async () => { for (const draft of draftRef.current.filter(d => !d.done && d.kind === 'photo' && d.editAlt)) { try { await translate(draft); } catch (e) { patch(draft.key, { status: displayError(e, locale) }); } } })}>{t('Preview all photo translations', '預覽全部照片翻譯')}</button></div>}
    {confirmRemove && <dialog open className="admin-confirm"><div className="admin-confirm-card"><h2>{t('Remove this item?', '移除此項目？')}</h2><p>{t('The item will leave this gallery. Saved photo files are retained.', '此項目會從相簿移除，已保存的照片檔案會保留。')}</p><div className="admin-actions"><button className="admin-button secondary" disabled={busy} onClick={() => setConfirmRemove(null)}>{t('Cancel', '取消')}</button><button className="admin-button danger" disabled={busy} onClick={() => void mutate(confirmRemove, 'remove')}>{t('Remove', '移除')}</button></div></div></dialog>}
  </>;
}

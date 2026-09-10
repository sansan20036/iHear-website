"use client";

import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '../admin-context';
import { adminFetch, displayError } from '../admin-api';
import { compressAdminImage } from '../../../lib/client-image-compression';
import { youtubeVideoId } from '../../../assets/youtube';
import { emptyCaption, galleryAssetSlot, type GalleryId, type PublicGallery, type PublicGalleryItem } from '../../../lib/media-gallery-types';
import type { SiteMediaAlt } from '../../../lib/site-media-types';

type Draft = { resource: { id: string; version: number }; originalAlt?: SiteMediaAlt; key: string; operationId: string; itemId: string; kind: 'photo' | 'youtube'; file?: File; preview?: string; compressed?: File; url: string; alt: SiteMediaAlt; caption: SiteMediaAlt; editAlt: boolean; hidden: boolean; receipt: string; manual: string[]; status: string; done: boolean; attempted: boolean; payload?: any };
const names = {
  en: { tutoring: 'English tutoring · Home + Programs', outreach: 'Community outreach · Home + Programs', home: 'Homepage media', stories: 'Stories media', impact: 'Impact media' },
  zhHant: { tutoring: '英語輔導 · 首頁＋Programs 共用', outreach: '社區推廣 · 首頁＋Programs 共用', home: '首頁媒體展示', stories: '生命故事媒體展示', impact: '成果媒體展示' },
  zhHans: { tutoring: '英语辅导 · 首页＋Programs 共用', outreach: '社区推广 · 首页＋Programs 共用', home: '首页媒体展示', stories: '生命故事媒体展示', impact: '成果媒体展示' },
};
const languages = { en: 'English', zhHant: '繁體中文', zhHans: '简体中文' };
function newDraft(kind: Draft['kind'], item?: PublicGalleryItem): Draft {
  const operationId = crypto.randomUUID();
  return { resource: { id: item?.assetSlot || galleryAssetSlot(operationId), version: item?.image?.recordVersion || 0 }, originalAlt: item?.image?.alt, key: operationId, operationId, itemId: item?.id || operationId, kind, url: item?.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : '', alt: { ...item?.image?.alt || emptyCaption() }, caption: { ...item?.caption || emptyCaption() }, hidden: item?.hidden || false, preview: item?.image?.src, editAlt: !!item?.image?.recordVersion, receipt: '', manual: item?.image ? ['zhHant', 'zhHans'].filter(lang => item.altStates?.find(state => state.locale === lang)?.origin !== 'machine') : [], status: '', done: false, attempted: false };
}
export default function MediaPage() {
  const { locale, setDirty, setSubmitting } = useAdmin();
  const t = (en: string, hant: string, hans = hant) => locale === 'en' ? en : locale === 'zhHans' ? hans : hant;
  const [galleries, setGalleries] = useState<PublicGallery[]>([]);
  const [selected, setSelected] = useState<GalleryId>('tutoring');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<PublicGalleryItem | null>(null);
  const [conflict, setConflict] = useState(false);
  const current = useRef<PublicGallery | undefined>(undefined);
  const draftRef = useRef(drafts); draftRef.current = drafts;
  const alive = useRef(true);
  const objectUrls = useRef<string[]>([]);
  const gallery = galleries.find(g => g.id === selected);
  current.current = gallery;
  const pending = drafts.some(d => !d.done);
  useEffect(() => { setDirty('media', pending); return () => setDirty('media', false); }, [pending, setDirty]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; objectUrls.current.forEach(url => URL.revokeObjectURL(url)); };
  }, []);
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
  }
  async function load() {
    try {
      const data = await adminFetch<{ items: PublicGallery[] }>('/api/media-galleries?admin=1');
      if (alive.current) { setGalleries(data.items); current.current = data.items.find(g => g.id === selected); setError(''); }
    } catch (e) { if (alive.current) setError(displayError(e, locale)); }
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
      if (replaceKey) { patch(replaceKey, { file, preview, compressed: undefined, editAlt: true, receipt: '', status: '' }); break; }
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
      if (draft.kind === 'photo' && draft.originalAlt && draft.alt.en !== draft.originalAlt.en && !draft.receipt) throw new Error(t('Preview translations after changing English, then review and save.', '英文變更後，請先預覽翻譯、確認內容，再儲存。'));
      if (draft.kind === 'youtube' && !youtubeVideoId(draft.url)) throw new Error(t('Enter a valid YouTube URL.', '請輸入有效的 YouTube 影片網址。'));
      if (draft.kind === 'photo' && draft.editAlt && Object.values(draft.alt).some(v => v.trim().length < 2 || v.trim().length > 300)) throw new Error(t('Photo descriptions need 2–300 characters in each language.', '照片替代文字每種語言都需要 2–300 字。'));
      patch(draft.key, { status: t('Preparing photo…', '準備照片中…') });
      if (draft.file && !draft.compressed) draft.compressed = await compressAdminImage(draft.file, { kind: 'site' });
      draft.payload = { operationId: draft.operationId, expectedVersion: current.current?.version, action: 'put', item: { id: draft.itemId, kind: draft.kind, hidden: draft.hidden, caption: draft.caption, url: draft.url }, ...(draft.kind === 'photo' && draft.editAlt && (draft.file || JSON.stringify(draft.alt) !== JSON.stringify(draft.originalAlt)) ? { alt: draft.alt, translationReceipt: draft.receipt } : {}) };
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
      const body = JSON.stringify({ operationId, expectedVersion: current.current?.version, action, itemId: item.id, direction, item: { ...item, hidden: !item.hidden, url: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : '' } });
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
    <header className="admin-page-head"><div><h1>{t('Media galleries', '媒體展示', '媒体展示')}</h1><p>{t('Upload photos or add YouTube links. Each successful save updates the website immediately.', '上傳照片或貼上 YouTube 連結，每次儲存成功後立即更新網站。', '上传照片或粘贴 YouTube 链接，每次保存成功后立即更新网站。')}</p></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="admin-toolbar"><label>{t('Gallery', '展示區')}<select value={selected} disabled={busy || pending} onChange={e => { setSelected(e.target.value as GalleryId); setDrafts([]); setConflict(false); }}>{Object.entries(names[locale]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><button className="admin-button secondary" disabled={busy} onClick={() => void work(async () => { await load(); setConflict(false); })}>{t('Refresh saved content', '重新讀取已儲存內容', '重新读取已保存内容')}</button><span>{gallery?.items.length || 0} / 20</span></div>
    {conflict && <p role="alert">{t('A newer version exists. Refresh saved content, review your draft, then save again.', '有更新版本，請重新讀取已儲存內容，核對草稿後再儲存。')}</p>}
    <div className="admin-actions"><label className="admin-button primary">{t('Add photos', '新增照片')}<input className="admin-media-file" aria-label={t('Add photos', '新增照片')} type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy || !gallery || pending && drafts.some(d => d.attempted)} onChange={e => { choosePhotos(e.target.files); e.target.value = ''; }} /></label><button className="admin-button primary" disabled={busy || !gallery || (gallery.items.length + drafts.filter(d => !d.done && !gallery.items.some(i => i.id === d.itemId)).length >= 20)} onClick={() => setDrafts(list => [...list, newDraft('youtube')])}>{t('Add YouTube video', '新增 YouTube 影片')}</button></div>
    <p>{t('PNG / JPEG / WebP, up to 20 MB each. Videos: upload to YouTube, then paste the link. Hidden items count toward the 20-item limit.', '照片支援 PNG／JPEG／WebP，每張上限 20 MB。影片請先上傳 YouTube 再貼連結；隱藏項目也計入 20 個上限。')}</p>
    <div className="admin-media-list">{gallery?.items.map((item, index) => <article className="admin-panel admin-media-item" key={item.id}>
      <img onLoad={e => { e.currentTarget.style.visibility = ""; }} onError={e => { e.currentTarget.style.visibility = "hidden"; }} src={item.image?.src || `https://i.ytimg.com/vi/${item.videoId}/default.jpg`} alt={item.image?.alt[locale] || ''} />
      <div><strong>{index + 1}. {item.kind === 'photo' ? t('Photo', '照片') : 'YouTube'} {item.hidden ? t('(Hidden)', '（隱藏）', '（隐藏）') : ''}</strong><p>{item.caption[locale] || item.caption.en || item.image?.alt[locale]}</p><div className="admin-actions">
        <button className="admin-button secondary" disabled={busy || pending} onClick={() => setDrafts([newDraft(item.kind, item)])}>{t('Edit / replace', '編輯／更換', '编辑／更换')}</button>
        <button className="admin-button secondary" disabled={busy || pending || conflict} onClick={() => void mutate(item, 'put')}>{item.hidden ? t('Show', '顯示', '显示') : t('Hide', '隱藏', '隐藏')}</button>
        <button aria-label={t('Move up', '向前移動')} className="admin-button secondary" disabled={busy || pending || conflict || index === 0} onClick={() => void mutate(item, 'move', -1)}>↑</button>
        <button aria-label={t('Move down', '向後移動')} className="admin-button secondary" disabled={busy || pending || conflict || index === gallery.items.length - 1} onClick={() => void mutate(item, 'move', 1)}>↓</button>
        <button className="admin-button danger" disabled={busy || pending || conflict} onClick={() => setConfirmRemove(item)}>{t('Remove', '移除')}</button>
      </div></div>
    </article>)}</div>
    {gallery && !gallery.items.length && <p className="admin-empty">{t('No media yet. This area stays hidden on the website.', '尚無媒體，網站會隱藏此展示區。')}</p>}
    {drafts.map((draft, index) => draft.done ? <p key={draft.key} className="admin-alert success" role="status">{draft.kind === "photo" ? t("Photo", "照片") : "YouTube"} {index + 1} · {draft.status}</p> : <fieldset className="admin-panel admin-media-draft" key={draft.key} disabled={busy || draft.done || draft.attempted}>
      <legend>{draft.kind === 'photo' ? t('Photo', '照片') : 'YouTube'} {index + 1}</legend>
      {draft.kind === 'photo' ? <><img className="admin-media-preview" src={draft.preview} alt="" /><label>{t('Replace photo', '更換照片', '更换照片')}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { choosePhotos(e.target.files, draft.key); e.target.value = ''; }} /></label></> : <label>YouTube URL<input type="url" value={draft.url} onChange={e => patch(draft.key, { url: e.target.value })} placeholder="https://youtu.be/…" />{draft.url && !youtubeVideoId(draft.url) && <span role="alert">{t('Invalid YouTube link', 'YouTube 連結格式不正確')}</span>}</label>}
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

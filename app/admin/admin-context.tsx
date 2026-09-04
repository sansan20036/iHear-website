"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export type AdminLocale = "en" | "zhHant" | "zhHans";
type Principal = { email: string; role: "owner" | "editor" };

type AdminContextValue = {
  locale: AdminLocale;
  principal: Principal;
  dirty: boolean;
  submitting: boolean;
  setDirty: (key: string, value: boolean) => void;
  setSubmitting: (value: boolean) => void;
  navigate: (href: string) => void;
  changeLocale: (locale: AdminLocale) => void;
  confirmAction: (action: () => void) => void;
};

const AdminContext = createContext<AdminContextValue | null>(null);

const promptCopy = {
  en: { title: "Unsaved changes", body: "You have unsaved changes. Leave this page and discard them?", stay: "Keep editing", leave: "Leave page" },
  zhHant: { title: "尚有未儲存資料", body: "您有尚未儲存的變更。確定要離開並放棄嗎？", stay: "繼續編輯", leave: "確定離開" },
  zhHans: { title: "尚有未保存数据", body: "您有尚未保存的更改。确定要离开并放弃吗？", stay: "继续编辑", leave: "确定离开" },
};

export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error("useAdmin must be used inside AdminProvider");
  return value;
}

export function AdminProvider({ principal, children }: { principal: Principal; children: React.ReactNode }) {
  const [locale, setLocale] = useState<AdminLocale>("zhHant");
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingAction = useRef<null | (() => void)>(null);
  const router = useRouter();
  const pathname = usePathname();
  const dirty = dirtyKeys.size > 0;

  const setDirty = useCallback((key: string, value: boolean) => {
    setDirtyKeys((current) => {
      const next = new Set(current);
      if (value) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const guard = useCallback((action: () => void) => {
    if (submitting) return;
    if (!dirty) return action();
    pendingAction.current = action;
    setConfirmOpen(true);
  }, [dirty, submitting]);

  const navigate = useCallback((href: string) => guard(() => router.push(href)), [guard, router]);
  const changeLocale = useCallback((next: AdminLocale) => guard(() => setLocale(next)), [guard]);

  useEffect(() => {
    setDirtyKeys(new Set());
  }, [pathname]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty || submitting) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, submitting]);

  useEffect(() => {
    const onPopState = () => {
      if (!dirty || submitting) return;
      history.go(1);
      guard(() => history.back());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [dirty, submitting, guard]);

  const value = useMemo(() => ({
    locale, principal, dirty, submitting, setDirty, setSubmitting, navigate, changeLocale, confirmAction: guard,
  }), [locale, principal, dirty, submitting, setDirty, navigate, changeLocale, guard]);
  const copy = promptCopy[locale];

  return (
    <AdminContext.Provider value={value}>
      {children}
      <dialog className="admin-confirm" open={confirmOpen} aria-labelledby="admin-confirm-title">
        <div className="admin-confirm-card">
          <h2 id="admin-confirm-title">{copy.title}</h2>
          <p>{copy.body}</p>
          <div className="admin-actions">
            <button type="button" className="admin-button secondary" onClick={() => { pendingAction.current = null; setConfirmOpen(false); }}>{copy.stay}</button>
            <button type="button" className="admin-button danger" onClick={() => {
              const action = pendingAction.current;
              pendingAction.current = null;
              setConfirmOpen(false);
              setDirtyKeys(new Set());
              action?.();
            }}>{copy.leave}</button>
          </div>
        </div>
      </dialog>
    </AdminContext.Provider>
  );
}

"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { AdminProvider, useAdmin, type AdminLocale } from "./admin-context";

const copy = {
  en: { title: "iHear Admin", overview: "Overview", content: "Website content", team: "Team", impact: "Impact", trash: "Trash", admins: "Administrators", publicSite: "View public site", signOut: "Sign out", owner: "Owner", editor: "Editor", menu: "Open menu" },
  zhHant: { title: "iHear 管理後台", overview: "總覽", content: "網站內容", team: "團隊名冊", impact: "成果資料", trash: "回收區", admins: "管理員", publicSite: "查看公開網站", signOut: "登出", owner: "擁有者", editor: "編輯者", menu: "開啟選單" },
  zhHans: { title: "iHear 管理后台", overview: "总览", content: "网站内容", team: "团队名册", impact: "成果数据", trash: "回收区", admins: "管理员", publicSite: "查看公开网站", signOut: "登出", owner: "拥有者", editor: "编辑者", menu: "打开菜单" },
};

function ShellContent({ children }: { children: React.ReactNode }) {
  const { locale, principal, navigate, changeLocale, submitting } = useAdmin();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const text = copy[locale];
  const links = [
    ["/admin", text.overview, "⌂"], ["/admin/content", text.content, "✎"], ["/admin/team", text.team, "👥"],
    ["/admin/impact", text.impact, "▥"], ["/admin/trash", text.trash, "♲"],
    ...(principal.role === "owner" ? [["/admin/admins", text.admins, "⚙"]] : []),
  ];
  const go = (href: string) => { setOpen(false); navigate(href); };
  return (
    <div className="admin-app">
      <header className="admin-mobile-header">
        <button type="button" className="admin-icon-button" aria-label={text.menu} onClick={() => setOpen(true)}>☰</button>
        <strong>{text.title}</strong>
      </header>
      {open && <button type="button" className="admin-backdrop" aria-label="Close" onClick={() => setOpen(false)} />}
      <aside className={`admin-sidebar ${open ? "is-open" : ""}`}>
        <div className="admin-brand"><span className="admin-brand-mark">iH</span><strong>{text.title}</strong></div>
        <nav aria-label={text.title}>
          {links.map(([href, label, icon]) => (
            <button type="button" key={href} disabled={submitting} onClick={() => go(href)} className={pathname === href ? "active" : ""}>
              <span aria-hidden="true">{icon}</span><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <div className="admin-languages" aria-label="Language">
            {(["en", "zhHant", "zhHans"] as AdminLocale[]).map((item) => (
              <button type="button" key={item} className={locale === item ? "active" : ""} onClick={() => changeLocale(item)} disabled={submitting}>
                {item === "en" ? "EN" : item === "zhHant" ? "繁" : "简"}
              </button>
            ))}
          </div>
          <div className="admin-identity"><strong>{principal.email}</strong><span>{principal.role === "owner" ? text.owner : text.editor}</span></div>
          <button type="button" className="admin-sidebar-link" onClick={() => go("/")}>{text.publicSite}</button>
          <button type="button" className="admin-sidebar-link" onClick={() => go("/api/auth/signout?callbackUrl=%2F")}>{text.signOut}</button>
        </div>
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  );
}

export function AdminShell({ principal, children }: { principal: { email: string; role: "owner" | "editor" }; children: React.ReactNode }) {
  return <AdminProvider principal={principal}><ShellContent>{children}</ShellContent></AdminProvider>;
}

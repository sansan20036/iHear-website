import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign-in link expired | iHear Initiative",
};

const colors = {
  navy: "#263974",
  navyDeep: "#1B2A57",
  orange: "#E8964F",
  orangeText: "#A65313",
  cream: "#FDF9F2",
  ink: "#232A46",
  inkSoft: "#55597A",
};

export default function AuthErrorPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "32px 20px",
        boxSizing: "border-box",
        color: colors.ink,
        background: `radial-gradient(560px 360px at 80% 0%, rgba(232,150,79,.18), transparent 65%), ${colors.cream}`,
        fontFamily: '"Nunito Sans", "Noto Sans TC", "Noto Sans SC", system-ui, sans-serif',
      }}
    >
      <section style={{ width: "min(680px, 100%)", textAlign: "center" }} aria-labelledby="auth-error-title">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/logo.png" alt="iHear Initiative" width="154" height="57" style={{ margin: "0 auto 26px" }} />
        <p style={{ margin: 0, color: colors.orangeText, fontWeight: 900, fontSize: "1rem", letterSpacing: ".08em", textTransform: "uppercase" }}>
          Sign-in link expired
        </p>
        <h1 id="auth-error-title" style={{ margin: "14px 0 12px", color: colors.navy, fontSize: "clamp(2rem, 6vw, 3.2rem)", lineHeight: 1.15 }}>
          Please start sign-in again
        </h1>
        <p style={{ margin: "0 auto 10px", color: colors.inkSoft, fontSize: "1.08rem", lineHeight: 1.7 }}>
          Google sign-in links can only be used once. Using the browser Back or Forward button may reopen an expired link.
        </p>
        <p style={{ margin: "0 auto", color: colors.inkSoft, fontSize: "1rem", lineHeight: 1.7 }}>
          Google 登入連結只能使用一次。使用上一頁或下一頁可能會重新開啟已失效的連結。
        </p>
        <a
          href="/"
          style={{
            minHeight: 48,
            display: "inline-flex",
            alignItems: "center",
            marginTop: 30,
            padding: "0 24px",
            borderRadius: 999,
            background: colors.orange,
            color: "#3A2410",
            fontWeight: 900,
            textDecoration: "none",
            border: `2px solid ${colors.orange}`,
            outlineColor: colors.navyDeep,
          }}
        >
          Return home and sign in again · 回首頁重新登入
        </a>
      </section>
    </main>
  );
}

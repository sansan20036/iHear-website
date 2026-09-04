const colors = {
  navy: "#263974",
  navyDeep: "#1B2A57",
  orange: "#E8964F",
  orangeText: "#A04E10",
  cream: "var(--bg-page, #FAF7F2)",
  ink: "var(--text-main, #1A2B4C)",
  inkSoft: "#55597A",
};

export default function NotFound() {
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
      <section style={{ width: "min(680px, 100%)", textAlign: "center" }} aria-labelledby="not-found-title">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/logo.png" alt="iHear Initiative" width="154" height="57" style={{ margin: "0 auto 26px" }} />
        <p style={{ margin: 0, color: colors.orangeText, fontWeight: 900, fontSize: "clamp(3.6rem, 12vw, 7rem)", lineHeight: 1 }}>404</p>
        <h1 id="not-found-title" data-editable-content="errors.not_found.title" data-editable-page="/_system/not-found" data-editable-mode="singleline" data-editable-maxlength="200" style={{ margin: "14px 0 12px", color: colors.navy, fontSize: "clamp(2rem, 6vw, 3.2rem)", lineHeight: 1.15 }}>
          Page not found
        </h1>
        <p data-editable-content="errors.not_found.description" data-editable-page="/_system/not-found" data-editable-mode="multiline" data-editable-maxlength="5000" style={{ margin: "0 auto 10px", color: colors.inkSoft, fontSize: "1.08rem", lineHeight: 1.7 }}>
          The address may have changed, or the page may no longer exist.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12, marginTop: 30 }}>
          <a href="/" data-editable-content="errors.not_found.home" data-editable-page="/_system/not-found" data-editable-mode="singleline" data-editable-maxlength="120" style={{ minHeight: 48, display: "inline-flex", alignItems: "center", padding: "0 24px", borderRadius: 999, background: colors.orange, color: "#3A2410", fontWeight: 900, textDecoration: "none" }}>
            Return home
          </a>
          <a href="/contact" data-editable-content="errors.not_found.contact" data-editable-page="/_system/not-found" data-editable-mode="singleline" data-editable-maxlength="120" style={{ minHeight: 48, display: "inline-flex", alignItems: "center", padding: "0 24px", borderRadius: 999, border: `2px solid ${colors.navyDeep}`, color: colors.navyDeep, fontWeight: 900, textDecoration: "none" }}>
            Contact us
          </a>
        </div>
      </section>
    </main>
  );
}

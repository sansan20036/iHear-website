import { afterEach, describe, expect, it } from "vitest";

import {
  buildTranslationPreview,
  createTranslationReceipt,
  finishProtectedTranslation,
  finishGoogleTranslationHtml,
  googleTranslationAuthConfiguration,
  isGoogleTranslationConfigured,
  machineTranslationQualityIssues,
  personNameContextTerms,
  prepareGoogleTranslationHtml,
  protectTranslationText,
  sha256,
  splitTranslationUnits,
  TERM_PATTERN,
  TranslationIntegrityError,
  TranslationReceiptError,
  verifyTranslationReceipt,
} from "../lib/translation-core.ts";

const originalSecret = process.env.TRANSLATION_RECEIPT_SECRET;
const googleEnvironmentNames = [
  "VERCEL",
  "VERCEL_ENV",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT_NUMBER",
  "GOOGLE_CLOUD_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_CLOUD_WORKLOAD_IDENTITY_POOL_ID",
  "GOOGLE_CLOUD_WORKLOAD_IDENTITY_PROVIDER_ID",
  "GOOGLE_CLOUD_LOCAL_ADC",
  "GOOGLE_CLOUD_CLIENT_EMAIL",
  "GOOGLE_CLOUD_PRIVATE_KEY",
];
const originalGoogleEnvironment = Object.fromEntries(googleEnvironmentNames.map((name) => [name, process.env[name]]));
afterEach(() => {
  if (originalSecret == null) delete process.env.TRANSLATION_RECEIPT_SECRET;
  else process.env.TRANSLATION_RECEIPT_SECRET = originalSecret;
  for (const name of googleEnvironmentNames) {
    if (originalGoogleEnvironment[name] == null) delete process.env[name];
    else process.env[name] = originalGoogleEnvironment[name];
  }
});

describe("Google translation authentication", () => {
  it("uses Workload Identity Federation in Vercel without a private key", () => {
    process.env.VERCEL = "1";
    process.env.GOOGLE_CLOUD_PROJECT_ID = "project-id";
    process.env.GOOGLE_CLOUD_PROJECT_NUMBER = "123456789";
    process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_EMAIL = "translation@project-id.iam.gserviceaccount.com";
    process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_POOL_ID = "vercel";
    process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_PROVIDER_ID = "vercel";
    delete process.env.GOOGLE_CLOUD_PRIVATE_KEY;
    const configuration = googleTranslationAuthConfiguration();
    expect(configuration).toMatchObject({ mode: "vercel-oidc", projectId: "project-id", projectNumber: "123456789" });
    expect(configuration).not.toHaveProperty("privateKey");
    expect(configuration.credentialAudience).toBe("//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel");
    expect(configuration.tokenAudience).toBe("https://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel");
    expect(isGoogleTranslationConfigured()).toBe(true);
  });

  it("refuses to use a long-lived service-account key inside Vercel", () => {
    process.env.VERCEL = "1";
    process.env.GOOGLE_CLOUD_PROJECT_ID = "project-id";
    process.env.GOOGLE_CLOUD_CLIENT_EMAIL = "translation@project-id.iam.gserviceaccount.com";
    process.env.GOOGLE_CLOUD_PRIVATE_KEY = "private-key";
    delete process.env.GOOGLE_CLOUD_PROJECT_NUMBER;
    delete process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_POOL_ID;
    delete process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_PROVIDER_ID;
    expect(() => googleTranslationAuthConfiguration()).toThrow("OIDC");
    expect(isGoogleTranslationConfigured()).toBe(false);
  });

  it("uses explicit short-lived ADC for localhost", () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    process.env.GOOGLE_CLOUD_PROJECT_ID = "project-id";
    process.env.GOOGLE_CLOUD_LOCAL_ADC = "true";
    delete process.env.GOOGLE_CLOUD_CLIENT_EMAIL;
    delete process.env.GOOGLE_CLOUD_PRIVATE_KEY;
    delete process.env.GOOGLE_CLOUD_PROJECT_NUMBER;
    delete process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_POOL_ID;
    delete process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_PROVIDER_ID;
    expect(googleTranslationAuthConfiguration()).toEqual({ mode: "local-adc", projectId: "project-id" });
    expect(isGoogleTranslationConfigured()).toBe(true);
  });

  it("rejects long-lived service-account keys on localhost", () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    process.env.GOOGLE_CLOUD_PROJECT_ID = "project-id";
    process.env.GOOGLE_CLOUD_LOCAL_ADC = "true";
    process.env.GOOGLE_CLOUD_CLIENT_EMAIL = "translation@project-id.iam.gserviceaccount.com";
    process.env.GOOGLE_CLOUD_PRIVATE_KEY = "private-key";
    expect(() => googleTranslationAuthConfiguration()).toThrow("Long-lived");
    expect(isGoogleTranslationConfigured()).toBe(false);
  });

  it("fails closed when only part of the OIDC configuration exists", () => {
    process.env.VERCEL = "1";
    process.env.GOOGLE_CLOUD_PROJECT_ID = "project-id";
    process.env.GOOGLE_CLOUD_PROJECT_NUMBER = "123456789";
    delete process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_CLOUD_CLIENT_EMAIL;
    delete process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_POOL_ID;
    delete process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_PROVIDER_ID;
    expect(() => googleTranslationAuthConfiguration()).toThrow("incomplete");
  });
});

describe("translation glossary and placeholders", () => {
  it("matches iHear and tutor/tutee forms without touching tutorial", () => {
    const input = "iHear's tutors’ and a tutee's tutorial";
    const matches = [...input.matchAll(TERM_PATTERN)].map((match) => match[0]);
    expect(matches).toEqual(["iHear's", "tutors’", "tutee's"]);
    const protectedValue = protectTranslationText(input);
    expect(protectedValue.source).toMatch(/⟦IH_[A-Z0-9]{10}_0000⟧/);
    expect(protectedValue.source).toContain("tutorial");
  });

  it("protects complete tutor titles before the generic tutor term", () => {
    const protectedValue = protectTranslationText("Senior Lead Tutor, Lead Tutors, and tutor tutorials");
    const result = finishProtectedTranslation(protectedValue, protectedValue.source);
    expect(result.zhHant).toBe("資深小老師組長, 小老師組長, and 小老師 tutorials");
    expect(result.zhHans).toBe("资深小老师组长, 小老师组长, and 小老师 tutorials");
  });

  it("protects dynamic names, schools, URLs, email and numbers", () => {
    const protectedValue = protectTranslationText(
      "Ryan studies at Taipei School. Email ryan@example.org for 1,200+ sessions at https://ihear.example/path.",
      ["Ryan", "Taipei School"],
    );
    expect(protectedValue.source).not.toContain("Ryan");
    expect(protectedValue.source).not.toContain("Taipei School");
    expect(protectedValue.source).not.toContain("ryan@example.org");
    expect(protectedValue.source).not.toContain("1,200+");
  });

  it("protects complete names and repeated given-name references without matching lower-case words", () => {
    expect(personNameContextTerms("  Yi   Yi  ")).toEqual(["Yi Yi", "Yi"]);
    const yiBio = "Yi supports iHear. As a Senior Lead Tutor, Yi helps students.";
    const protectedYi = protectTranslationText(yiBio, personNameContextTerms("Yi Yi"));
    expect(protectedYi.source).not.toMatch(/(?<![\p{L}\p{N}_])Yi(?![\p{L}\p{N}_])/gu);
    const restoredYi = finishProtectedTranslation(protectedYi, protectedYi.source);
    expect(restoredYi.zhHant.match(/(?<![\p{L}\p{N}_])Yi(?![\p{L}\p{N}_])/gu)).toHaveLength(2);

    const protectedWill = protectTranslationText("Will will mentor students.", personNameContextTerms("Will Smith"));
    expect(protectedWill.source).not.toMatch(/(?<![\p{L}\p{N}_])Will(?![\p{L}\p{N}_])/gu);
    expect(protectedWill.source).toContain(" will mentor students.");
  });

  it("allows placeholder reordering and restores after OpenCC", () => {
    const protectedValue = protectTranslationText("iHear supports tutor Ryan", ["Ryan"]);
    const tokens = protectedValue.placeholders.map((item) => item.token);
    const result = finishProtectedTranslation(protectedValue, `${tokens[2]} 受到 ${tokens[0]} 與 ${tokens[1]} 支持，使用軟體`);
    expect(result.zhHant).toContain("Ryan");
    expect(result.zhHant).toContain("小老師");
    expect(result.zhHans).toContain("小老师");
    expect(result.zhHans).toContain("软件");
  });

  it("rejects missing, duplicated and unknown placeholders", () => {
    const protectedValue = protectTranslationText("iHear tutor");
    const [first] = protectedValue.placeholders;
    expect(() => finishProtectedTranslation(protectedValue, protectedValue.source.replace(first.token, ""))).toThrow(TranslationIntegrityError);
    expect(() => finishProtectedTranslation(protectedValue, `${protectedValue.source} ${first.token}`)).toThrow(TranslationIntegrityError);
    expect(() => finishProtectedTranslation(protectedValue, `${protectedValue.source} ⟦IH_AAAAAAAAAA_9999⟧`)).toThrow(TranslationIntegrityError);
  });

  it("keeps protected tokens out of visible text while retaining fail-closed HTML markers", () => {
    const protectedValue = protectTranslationText("iHear tutors use A & B < C");
    const html = prepareGoogleTranslationHtml(protectedValue.source, protectedValue);
    expect(html).toContain('<span translate="no" data-ihear-placeholder="⟦IH_');
    expect(html).toContain(">iHear</span>");
    expect(html).toContain(">tutors</span>");
    expect(html).not.toMatch(/>⟦IH_[^⟧]+⟧(?:iHear|tutors)<\/span>/u);
    expect(html).toContain("A &amp; B &lt; C");
    const restored = finishGoogleTranslationHtml(html);
    expect(restored).toBe(protectedValue.source);
    expect(() => finishProtectedTranslation(protectedValue, restored)).not.toThrow();
  });

  it("restores attribute markers after Google reorders natural protected terms without losing prose", () => {
    const protectedValue = protectTranslationText(
      "Local Translation Test helps iHear tutors support tutees in the USA.",
      ["Local Translation Test"],
    );
    const [name, ihear, tutors, tutees] = protectedValue.placeholders;
    const translatedHtml = [
      `<span translate="no" data-ihear-placeholder="${name.token}">${name.source}</span>幫助`,
      `<span translate="no" data-ihear-placeholder="${ihear.token}">${ihear.source}</span> `,
      `<span translate="no" data-ihear-placeholder="${tutors.token}">${tutors.source}</span>為美國的`,
      `<span translate="no" data-ihear-placeholder="${tutees.token}">${tutees.source}</span>提供支援。`,
    ].join("");
    const restoredTokens = finishGoogleTranslationHtml(translatedHtml);
    const result = finishProtectedTranslation(protectedValue, restoredTokens);
    expect(result.zhHant).toBe("Local Translation Test幫助iHear 小老師為美國的受輔導學生提供支援。");
    expect(result.zhHans).toBe("Local Translation Test帮助iHear 小老师为美国的受辅导学生提供支持。");
  });

  it("fails closed when Google removes an attribute marker", () => {
    const protectedValue = protectTranslationText("iHear tutors");
    const html = prepareGoogleTranslationHtml(protectedValue.source, protectedValue)
      .replace(/\sdata-ihear-placeholder="[^"]+"/u, "");
    const restored = finishGoogleTranslationHtml(html);
    expect(() => finishProtectedTranslation(protectedValue, restored)).toThrow(TranslationIntegrityError);
  });

  it("splits long bios into sentence-bound requests while preserving paragraphs", () => {
    const input = "Yi supports iHear’s community events. She coordinates volunteers.\n\nAs a Senior Lead Tutor, Yi teaches students.";
    const units = splitTranslationUnits(input);
    expect(units).toHaveLength(3);
    expect(units.map((unit) => unit.text)).toEqual([
      "Yi supports iHear’s community events.",
      "She coordinates volunteers.",
      "As a Senior Lead Tutor, Yi teaches students.",
    ]);
    expect(units.map((unit) => `${unit.text}${unit.separator}`).join("")).toBe(input);
  });

  it("flags the real Yi and Karen placeholder-displacement regressions", () => {
    const yi = "Yi iHear 的支援社區活動。身為資深小老師組長活動負責人，Yi 擁有教學經驗。";
    const karen = "Karen 為課程、教學資源和專案專案的開發提供支援，致力於改進 iHear 的和計畫資源。";
    expect(machineTranslationQualityIssues(yi)).toEqual(expect.arrayContaining([
      "misplaced-person-and-ihear",
      "glued-tutor-title",
    ]));
    expect(machineTranslationQualityIssues(karen)).toEqual(expect.arrayContaining([
      "duplicated-project-term",
      "misplaced-ihear-possessive",
    ]));
  });
});

describe("translation preview and signed receipt", () => {
  const resource = { type: "team", scope: "", id: "profile-1", version: 3 };

  it("keeps protected legacy Chinese when English changes", async () => {
    let calls = 0;
    const existing = { en: "Updated tutor bio", zhHant: "既有繁中", zhHans: "既有简中" };
    const legacyStates = [
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHant", sourceHash: sha256("Original tutor bio"), origin: "protected_legacy", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHans", sourceHash: sha256("既有繁中"), origin: "protected_legacy", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
    ];
    const result = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: existing }, states: legacyStates,
      translate: async (values) => { calls += 1; return values.map((value) => `翻譯 ${value}`); },
    });
    expect(calls).toBe(0);
    expect(result.fields.bio.value).toEqual(existing);
    expect(result.fields.bio.zhHantOrigin).toBe("protected_legacy");
    expect(result.fields.bio.zhHansOrigin).toBe("protected_legacy");
    expect(result.fields.bio.zhHantStatus).toBe("protected");
    expect(result.fields.bio.zhHansStatus).toBe("protected");
  });

  it("fails safe when existing Chinese has no translation-state rows", async () => {
    let calls = 0;
    const existing = { en: "Updated tutor bio", zhHant: "既有繁中", zhHans: "既有简中" };
    const result = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: existing }, states: [],
      translate: async (values) => { calls += 1; return values; },
    });
    expect(calls).toBe(0);
    expect(result.fields.bio.value).toEqual(existing);
    expect(result.fields.bio.zhHantOrigin).toBe("protected_legacy");
    expect(result.fields.bio.zhHansOrigin).toBe("protected_legacy");
  });

  it("retranslates protected legacy Chinese only when force is explicit", async () => {
    let calls = 0;
    const existing = { en: "Updated Lead Tutor bio", zhHant: "既有繁中", zhHans: "既有简中" };
    const legacyStates = [
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHant", sourceHash: sha256("Original tutor bio"), origin: "protected_legacy", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHans", sourceHash: sha256("既有繁中"), origin: "protected_legacy", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
    ];
    const result = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: existing }, states: legacyStates,
      force: { bio: ["zhHant", "zhHans"] },
      translate: async (values) => { calls += 1; return values.map((value) => `翻譯 ${value}`); },
    });
    expect(calls).toBe(1);
    expect(result.fields.bio.value.zhHant).toContain("小老師組長");
    expect(result.fields.bio.zhHantOrigin).toBe("machine");
    expect(result.fields.bio.zhHansOrigin).toBe("machine");
  });

  it("translates each sentence independently and restores the original paragraph breaks", async () => {
    const english = "iHear supports tutors. Lead Tutors guide the team.\n\nStudents learn confidently.";
    let received = [];
    const result = await buildTranslationPreview({
      email: "admin@example.org",
      resource,
      fields: { bio: { en: english, zhHant: "", zhHans: "" } },
      states: [],
      translate: async (values) => {
        received = values;
        return values.map((value) => `翻譯：${value}`);
      },
    });
    expect(received).toHaveLength(3);
    expect(received.every((value) => !value.includes("\n"))).toBe(true);
    expect(result.fields.bio.value.zhHant).toContain("\n\n");
    expect(result.fields.bio.value.zhHant).toContain("小老師組長");
  });

  it("keeps manually corrected Chinese unless force is explicit", async () => {
    let calls = 0;
    const existing = { en: "Updated tutor bio", zhHant: "人工繁中", zhHans: "人工简中" };
    const manualStates = [
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHant", sourceHash: sha256("Original tutor bio"), origin: "manual", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHans", sourceHash: sha256("人工繁中"), origin: "manual", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
    ];
    const protectedResult = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: existing }, states: manualStates,
      translate: async (values) => { calls += 1; return values; },
    });
    expect(protectedResult.fields.bio.value).toEqual(existing);
    expect(calls).toBe(0);
    const forced = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: existing }, states: manualStates, force: { bio: ["zhHant", "zhHans"] },
      translate: async (values) => { calls += 1; return values.map((value) => `翻譯 ${value}`); },
    });
    expect(calls).toBe(1);
    expect(forced.fields.bio.value.zhHant).toContain("小老師");
    expect(forced.fields.bio.zhHantOrigin).toBe("machine");
  });

  it("skips Google when the English hash is already current", async () => {
    let calls = 0;
    const value = { en: "Current English", zhHant: "目前中文", zhHans: "目前中文" };
    const result = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: value },
      states: [
        { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHant", sourceHash: sha256(value.en), origin: "machine", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
        { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHans", sourceHash: sha256(value.zhHant), origin: "machine", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
      ],
      translate: async (values) => { calls += 1; return values; },
    });
    expect(calls).toBe(0);
    expect(result.fields.bio.zhHantStatus).toBe("current");
  });

  it("binds receipts to user, record, version and English hash", () => {
    process.env.TRANSLATION_RECEIPT_SECRET = "test-secret-with-enough-randomness";
    const value = { en: "Tutor bio", zhHant: "小老師簡介", zhHans: "小老师简介" };
    const receipt = createTranslationReceipt({ email: "admin@example.org", resource, fields: { bio: { value, zhHantOrigin: "machine", zhHansOrigin: "machine" } } });
    expect(verifyTranslationReceipt({ receipt, email: "admin@example.org", resource, fields: { bio: value } })).toHaveLength(2);
    expect(() => verifyTranslationReceipt({ receipt, email: "other@example.org", resource, fields: { bio: value } })).toThrow(TranslationReceiptError);
    expect(() => verifyTranslationReceipt({ receipt, email: "admin@example.org", resource: { ...resource, version: 4 }, fields: { bio: value } })).toThrow(TranslationReceiptError);
    expect(() => verifyTranslationReceipt({ receipt, email: "admin@example.org", resource, fields: { bio: { ...value, en: "Changed" } } })).toThrow(TranslationReceiptError);
  });

  it("marks final Chinese edits as manual and rejects expired receipts", () => {
    process.env.TRANSLATION_RECEIPT_SECRET = "test-secret-with-enough-randomness";
    const value = { en: "Tutor bio", zhHant: "小老師簡介", zhHans: "小老师简介" };
    const receipt = createTranslationReceipt({ email: "admin@example.org", resource, fields: { bio: { value, zhHantOrigin: "machine", zhHansOrigin: "machine" } } });
    const writes = verifyTranslationReceipt({ receipt, email: "admin@example.org", resource, fields: { bio: { ...value, zhHant: "人工修正" } } });
    expect(writes.find((item) => item.locale === "zhHant")?.origin).toBe("manual");
    const expired = createTranslationReceipt({ email: "admin@example.org", resource, fields: { bio: { value, zhHantOrigin: "machine", zhHansOrigin: "machine" } }, now: Date.now() - 16 * 60 * 1000 });
    expect(() => verifyTranslationReceipt({ receipt: expired, email: "admin@example.org", resource, fields: { bio: value } })).toThrow(TranslationReceiptError);
  });
});

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { TranslationServiceClient } from "@google-cloud/translate";
import { getVercelOidcToken } from "@vercel/oidc";
import { ExternalAccountClient } from "google-auth-library";
import OpenCC from "opencc-js";

import type {
  LocalizedTranslationField,
  TranslationOrigin,
  TranslationResource,
  TranslationState,
  TranslationStateWrite,
} from "./translation-types";

export const TRANSLATION_GLOSSARY_VERSION = "ihear-2026-08-v1";
export const TERM_PATTERN = /(?<![\p{L}\p{N}_])(?:(tutee|tutor)(s(?:['’])?|['’]s)?|(ihear)(['’]s)?)(?![\p{L}\p{N}_])/giu;

const PLACEHOLDER_PATTERN = /⟦IH_([A-Z0-9]{10})_(\d{4})⟧/g;
const simplifiedConverter = OpenCC.Converter({ from: "twp", to: "cn" });

export function convertZhHantToZhHans(value: string) {
  return simplifiedConverter(value.normalize("NFC")).normalize("NFC");
}

type ProtectedValue = {
  source: string;
  placeholders: Array<{ token: string; zhHant: string; zhHans: string }>;
};

type ReceiptField = {
  enHash: string;
  zhHantHash: string;
  zhHansHash: string;
  zhHantOrigin: TranslationOrigin;
  zhHansOrigin: TranslationOrigin;
};

type ReceiptPayload = {
  v: 1;
  email: string;
  resource: TranslationResource;
  glossaryVersion: string;
  expiresAt: number;
  fields: Record<string, ReceiptField>;
};

type Candidate = {
  start: number;
  end: number;
  zhHant: string;
  zhHans: string;
  priority: number;
};

export class TranslationConfigurationError extends Error {
  code = "TRANSLATION_NOT_CONFIGURED";
}

export class TranslationIntegrityError extends Error {
  code = "TRANSLATION_INTEGRITY_FAILED";
}

export class TranslationReceiptError extends Error {
  code = "TRANSLATION_RECEIPT_INVALID";
}

export function sha256(value: string) {
  return createHash("sha256").update(value.normalize("NFC").replace(/\r\n?/g, "\n")).digest("hex");
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function possessive(value: string | undefined) {
  return Boolean(value && /['’]/.test(value));
}

function glossaryCandidates(text: string) {
  const candidates: Candidate[] = [];
  TERM_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(TERM_PATTERN)) {
    const value = match[0];
    const root = (match[1] || match[3] || "").toLowerCase();
    const suffix = match[2] || match[4];
    const zhHant = root === "tutor"
      ? `小老師${possessive(suffix) ? "的" : ""}`
      : root === "tutee"
        ? `受輔導學生${possessive(suffix) ? "的" : ""}`
        : `iHear${possessive(suffix) ? " 的" : ""}`;
    const zhHans = root === "tutor"
      ? `小老师${possessive(suffix) ? "的" : ""}`
      : root === "tutee"
        ? `受辅导学生${possessive(suffix) ? "的" : ""}`
        : `iHear${possessive(suffix) ? " 的" : ""}`;
    candidates.push({ start: match.index!, end: match.index! + value.length, zhHant, zhHans, priority: 100 });
  }
  return candidates;
}

function invariantCandidates(text: string, contextTerms: string[]) {
  const candidates: Candidate[] = [];
  const patterns = [
    /https?:\/\/[^\s<>]+/giu,
    /mailto:[^\s<>]+/giu,
    /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
    /\b\d{4}[-\/.]\d{1,2}(?:[-\/.]\d{1,2})?\b/gu,
    /\b\d+(?:[,.]\d+)*(?:\+|%|–\d+)?\b/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      candidates.push({ start: match.index!, end: match.index! + match[0].length, zhHant: match[0], zhHans: match[0], priority: 40 });
    }
  }
  const terms = [...new Set(contextTerms.map((term) => term.trim()).filter((term) => term.length >= 2 && term.length <= 300))]
    .sort((left, right) => right.length - left.length);
  if (terms.length) {
    const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "giu");
    for (const match of text.matchAll(pattern)) {
      candidates.push({ start: match.index!, end: match.index! + match[0].length, zhHant: match[0], zhHans: match[0], priority: 80 });
    }
  }
  return candidates;
}

function chooseCandidates(candidates: Candidate[]) {
  const sorted = candidates.sort((left, right) => left.start - right.start || right.priority - left.priority || (right.end - right.start) - (left.end - left.start));
  const chosen: Candidate[] = [];
  for (const candidate of sorted) {
    if (chosen.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    chosen.push(candidate);
  }
  return chosen.sort((left, right) => left.start - right.start);
}

export function protectTranslationText(input: string, contextTerms: string[] = []): ProtectedValue {
  const text = input.normalize("NFC").replace(/\r\n?/g, "\n");
  const nonce = randomBytes(8).toString("hex").slice(0, 10).toUpperCase();
  const candidates = chooseCandidates([...glossaryCandidates(text), ...invariantCandidates(text, contextTerms)]);
  const placeholders: ProtectedValue["placeholders"] = [];
  let cursor = 0;
  let source = "";
  candidates.forEach((candidate, index) => {
    const token = `⟦IH_${nonce}_${String(index).padStart(4, "0")}⟧`;
    source += text.slice(cursor, candidate.start) + token;
    cursor = candidate.end;
    placeholders.push({ token, zhHant: candidate.zhHant, zhHans: candidate.zhHans });
  });
  source += text.slice(cursor);
  return { source, placeholders };
}

function assertPlaceholderIntegrity(value: string, protectedValue: ProtectedValue) {
  const expected = new Set(protectedValue.placeholders.map((item) => item.token));
  const counts = new Map<string, number>();
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  if (counts.size !== expected.size) throw new TranslationIntegrityError("A protected term was changed during translation");
  for (const token of expected) {
    if (counts.get(token) !== 1) throw new TranslationIntegrityError("A protected term is missing or duplicated");
  }
  for (const token of counts.keys()) {
    if (!expected.has(token)) throw new TranslationIntegrityError("The translation contains an unknown protected term");
  }
}

function restorePlaceholders(value: string, protectedValue: ProtectedValue, locale: "zhHant" | "zhHans") {
  let restored = value;
  for (const placeholder of protectedValue.placeholders) restored = restored.replace(placeholder.token, placeholder[locale]);
  if (restored.includes("⟦IH_")) throw new TranslationIntegrityError("The translation contains an unresolved protected term");
  return restored.normalize("NFC");
}

export function finishProtectedTranslation(protectedValue: ProtectedValue, translatedZhHant: string) {
  assertPlaceholderIntegrity(translatedZhHant, protectedValue);
  const translatedZhHans = convertZhHantToZhHans(translatedZhHant);
  assertPlaceholderIntegrity(translatedZhHans, protectedValue);
  return {
    zhHant: restorePlaceholders(translatedZhHant, protectedValue, "zhHant"),
    zhHans: restorePlaceholders(translatedZhHans, protectedValue, "zhHans"),
  };
}

type GoogleTranslationAuth =
  | {
      mode: "vercel-oidc";
      projectId: string;
      projectNumber: string;
      serviceAccountEmail: string;
      poolId: string;
      providerId: string;
      credentialAudience: string;
      tokenAudience: string;
    }
  | {
      mode: "service-account-key";
      projectId: string;
      clientEmail: string;
      privateKey: string;
    };

function isVercelRuntime() {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

function oidcCredentials() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID?.trim();
  const projectNumber = process.env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
  const serviceAccountEmail = process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_EMAIL?.trim();
  const poolId = process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_POOL_ID?.trim();
  const providerId = process.env.GOOGLE_CLOUD_WORKLOAD_IDENTITY_PROVIDER_ID?.trim();
  const oidcSpecificValues = [projectNumber, serviceAccountEmail, poolId, providerId];
  if (!oidcSpecificValues.some(Boolean)) return null;
  const values = [projectId, ...oidcSpecificValues];
  if (!values.every(Boolean)) throw new TranslationConfigurationError("Google Cloud OIDC configuration is incomplete");
  if (!/^\d{6,30}$/.test(projectNumber!) || !/^[a-z][a-z0-9-]{2,31}$/.test(poolId!) || !/^[a-z][a-z0-9-]{2,31}$/.test(providerId!)) {
    throw new TranslationConfigurationError("Google Cloud OIDC configuration is invalid");
  }
  if (!/^[a-z0-9][a-z0-9._-]*@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/i.test(serviceAccountEmail!)) {
    throw new TranslationConfigurationError("Google Cloud OIDC service account is invalid");
  }
  const providerResource = `iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
  // Google STS requires a protocol-relative resource name in the external
  // account credential, while the Vercel-issued ID token must use the
  // provider's HTTPS URL as its aud claim.
  const credentialAudience = `//${providerResource}`;
  const tokenAudience = `https://${providerResource}`;
  return {
    mode: "vercel-oidc",
    projectId,
    projectNumber,
    serviceAccountEmail,
    poolId,
    providerId,
    credentialAudience,
    tokenAudience,
  } as const;
}

function localServiceAccountCredentials() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID?.trim();
  const clientEmail = process.env.GOOGLE_CLOUD_CLIENT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_CLOUD_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!projectId || !clientEmail || !privateKey) throw new TranslationConfigurationError("Automatic translation is not configured");
  return { mode: "service-account-key", projectId, clientEmail, privateKey } as const;
}

export function googleTranslationAuthConfiguration(): GoogleTranslationAuth {
  const oidc = oidcCredentials();
  if (oidc) return oidc;
  // Hosted Vercel functions must never fall back to a persisted service-account
  // private key. Local development keeps the key flow for offline-safe testing.
  if (isVercelRuntime()) throw new TranslationConfigurationError("Vercel OIDC translation authentication is not configured");
  return localServiceAccountCredentials();
}

export function isGoogleTranslationConfigured() {
  try { googleTranslationAuthConfiguration(); return true; } catch { return false; }
}

export function prepareGoogleTranslationHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(PLACEHOLDER_PATTERN, (token) => `<span translate="no">${token}</span>`);
}

export function finishGoogleTranslationHtml(value: string) {
  return value
    .replace(/<span\s+translate=(?:"no"|'no'|no)\s*>/giu, "")
    .replace(/<\/span>/giu, "")
    .replace(/&#x([0-9a-f]+);|&#([0-9]+);|&(amp|lt|gt|quot|#39);/giu, (entity, hexadecimal, decimal, named) => {
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" } as Record<string, string>)[String(named).toLowerCase()] || entity;
    });
}

export async function googleTranslateToZhHant(contents: string[]) {
  if (!contents.length) return [];
  const credentials = googleTranslationAuthConfiguration();
  let client: TranslationServiceClient;
  if (credentials.mode === "vercel-oidc") {
    const authClient = ExternalAccountClient.fromJSON({
      type: "external_account",
      audience: credentials.credentialAudience,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${credentials.serviceAccountEmail}:generateAccessToken`,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      subject_token_supplier: {
        getSubjectToken: () => getVercelOidcToken({ audience: credentials.tokenAudience, expirationBufferMs: 5 * 60 * 1000 }),
      },
    });
    if (!authClient) throw new TranslationConfigurationError("Could not initialize Google Cloud OIDC authentication");
    client = new TranslationServiceClient({ projectId: credentials.projectId, authClient });
  } else {
    client = new TranslationServiceClient({
      projectId: credentials.projectId,
      credentials: { client_email: credentials.clientEmail, private_key: credentials.privateKey },
    });
  }
  const [response] = await client.translateText({
    parent: `projects/${credentials.projectId}/locations/global`,
    contents: contents.map(prepareGoogleTranslationHtml),
    mimeType: "text/html",
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-TW",
  });
  const translations = response.translations || [];
  if (translations.length !== contents.length) throw new TranslationIntegrityError("The translation service returned an incomplete response");
  return translations.map((item) => finishGoogleTranslationHtml(String(item.translatedText || "")));
}

function receiptSecret() {
  const secret = process.env.TRANSLATION_RECEIPT_SECRET || (process.env.NODE_ENV === "production" ? "" : "ihear-local-translation-receipt-only");
  if (!secret) throw new TranslationConfigurationError("TRANSLATION_RECEIPT_SECRET is required");
  return secret;
}

function signature(encoded: string) {
  return createHmac("sha256", receiptSecret()).update(encoded).digest("base64url");
}

export function createTranslationReceipt(params: {
  email: string;
  resource: TranslationResource;
  fields: Record<string, { value: LocalizedTranslationField; zhHantOrigin: TranslationOrigin; zhHansOrigin: TranslationOrigin }>;
  now?: number;
}) {
  const fields = Object.fromEntries(Object.entries(params.fields).map(([field, item]) => [field, {
    enHash: sha256(item.value.en),
    zhHantHash: sha256(item.value.zhHant),
    zhHansHash: sha256(item.value.zhHans),
    zhHantOrigin: item.zhHantOrigin,
    zhHansOrigin: item.zhHansOrigin,
  } satisfies ReceiptField]));
  const payload: ReceiptPayload = {
    v: 1,
    email: params.email.trim().toLowerCase(),
    resource: params.resource,
    glossaryVersion: TRANSLATION_GLOSSARY_VERSION,
    expiresAt: (params.now || Date.now()) + 15 * 60 * 1000,
    fields,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

function parseReceipt(receipt: string) {
  const [encoded, supplied, extra] = receipt.split(".");
  if (!encoded || !supplied || extra) throw new TranslationReceiptError("Invalid translation preview receipt");
  const expected = signature(encoded);
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) throw new TranslationReceiptError("Invalid translation preview receipt");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ReceiptPayload;
  if (payload.v !== 1 || payload.glossaryVersion !== TRANSLATION_GLOSSARY_VERSION || payload.expiresAt < Date.now()) throw new TranslationReceiptError("The translation preview has expired; generate it again");
  return payload;
}

function resourceMatches(receipt: TranslationResource, resource: TranslationResource) {
  const idMatches = receipt.id === resource.id || receipt.id === "__new__";
  return receipt.type === resource.type && receipt.scope === resource.scope && idMatches &&
    (receipt.version == null || String(receipt.version) === String(resource.version));
}

export function verifyTranslationReceipt(params: {
  receipt: string;
  email: string;
  resource: TranslationResource;
  fields: Record<string, LocalizedTranslationField>;
}) {
  const payload = parseReceipt(params.receipt);
  if (payload.email !== params.email.trim().toLowerCase() || !resourceMatches(payload.resource, params.resource)) throw new TranslationReceiptError("This translation preview belongs to another record or administrator");
  const writes: TranslationStateWrite[] = [];
  for (const [field, value] of Object.entries(params.fields)) {
    const receiptField = payload.fields[field];
    if (!receiptField) {
      if (value.en.trim()) throw new TranslationReceiptError("English changed after translation preview");
      if (value.zhHant) writes.push({ field, locale: "zhHant", sourceHash: sha256(""), origin: "manual", glossaryVersion: TRANSLATION_GLOSSARY_VERSION });
      if (value.zhHans) writes.push({ field, locale: "zhHans", sourceHash: sha256(value.zhHant), origin: "manual", glossaryVersion: TRANSLATION_GLOSSARY_VERSION });
      continue;
    }
    if (receiptField.enHash !== sha256(value.en)) throw new TranslationReceiptError("English changed after translation preview");
    const hantMatches = receiptField.zhHantHash === sha256(value.zhHant);
    const hansMatches = receiptField.zhHansHash === sha256(value.zhHans);
    if (value.zhHant) writes.push({ field, locale: "zhHant", sourceHash: sha256(value.en), origin: hantMatches ? receiptField.zhHantOrigin : "manual", glossaryVersion: TRANSLATION_GLOSSARY_VERSION });
    if (value.zhHans) writes.push({ field, locale: "zhHans", sourceHash: sha256(value.zhHant), origin: hansMatches ? receiptField.zhHansOrigin : "manual", glossaryVersion: TRANSLATION_GLOSSARY_VERSION });
  }
  return writes;
}

export function manualTranslationWrites(fields: Record<string, LocalizedTranslationField>) {
  const writes: TranslationStateWrite[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (value.zhHant) writes.push({ field, locale: "zhHant", sourceHash: sha256(value.en), origin: "manual", glossaryVersion: TRANSLATION_GLOSSARY_VERSION });
    if (value.zhHans) writes.push({ field, locale: "zhHans", sourceHash: sha256(value.zhHant), origin: "manual", glossaryVersion: TRANSLATION_GLOSSARY_VERSION });
  }
  return writes;
}

export async function buildTranslationPreview(params: {
  email: string;
  resource: TranslationResource;
  fields: Record<string, LocalizedTranslationField>;
  states: TranslationState[];
  force?: Record<string, Array<"zhHant" | "zhHans">>;
  autoTranslate?: boolean;
  contextTerms?: string[];
  translate?: (contents: string[]) => Promise<string[]>;
}) {
  const stateMap = new Map(params.states.map((state) => [`${state.field}:${state.locale}`, state]));
  const results: Record<string, { value: LocalizedTranslationField; zhHantOrigin: TranslationOrigin; zhHansOrigin: TranslationOrigin; zhHantStatus: string; zhHansStatus: string }> = {};
  const pending: Array<{ field: string; protectedValue: ProtectedValue }> = [];
  const autoTranslate = params.autoTranslate !== false;

  for (const [field, raw] of Object.entries(params.fields)) {
    const value = { en: raw.en.trim(), zhHant: raw.zhHant.trim(), zhHans: raw.zhHans.trim() };
    const hantState = stateMap.get(`${field}:zhHant`);
    const hansState = stateMap.get(`${field}:zhHans`);
    const force = new Set(params.force?.[field] || []);
    const englishHash = sha256(value.en);
    // Only an explicit human correction is locked. Legacy translations are a
    // safe baseline, but should follow the English source once it changes.
    const hantLocked = Boolean(value.zhHant && hantState?.origin === "manual");
    const hansLocked = Boolean(value.zhHans && hansState?.origin === "manual");
    const shouldTranslateHant = Boolean(value.en && autoTranslate && (
      force.has("zhHant")
      || !value.zhHant
      || (!hantLocked && (!hantState || hantState.sourceHash !== englishHash))
    ));
    results[field] = {
      value,
      zhHantOrigin: hantState?.origin || (value.zhHant ? "protected_legacy" : "machine"),
      zhHansOrigin: hansState?.origin || (value.zhHans ? "protected_legacy" : "machine"),
      zhHantStatus: shouldTranslateHant ? "pending" : hantLocked ? "protected" : "current",
      zhHansStatus: hansLocked && !force.has("zhHans") ? "protected" : "pending",
    };
    if (shouldTranslateHant) pending.push({ field, protectedValue: protectTranslationText(value.en, params.contextTerms || []) });
  }

  if (pending.length) {
    const translated = await (params.translate || googleTranslateToZhHant)(pending.map((item) => item.protectedValue.source));
    pending.forEach((item, index) => {
      const finished = finishProtectedTranslation(item.protectedValue, translated[index]);
      const result = results[item.field];
      result.value.zhHant = finished.zhHant;
      result.zhHantOrigin = "machine";
      result.zhHantStatus = "translated";
      const hansState = stateMap.get(`${item.field}:zhHans`);
      const forceHans = new Set(params.force?.[item.field] || []).has("zhHans");
      const hansLocked = Boolean(result.value.zhHans && hansState?.origin === "manual");
      if (!hansLocked || forceHans) {
        result.value.zhHans = finished.zhHans;
        result.zhHansOrigin = "machine";
        result.zhHansStatus = "translated";
      }
    });
  }

  for (const [field, result] of Object.entries(results)) {
    const forceHans = new Set(params.force?.[field] || []).has("zhHans");
    const hansState = stateMap.get(`${field}:zhHans`);
    const hansLocked = Boolean(result.value.zhHans && hansState?.origin === "manual");
    const traditionalHash = sha256(result.value.zhHant);
    if (result.value.zhHant && autoTranslate && (
      !result.value.zhHans
      || forceHans
      || (!hansLocked && (!hansState || hansState.sourceHash !== traditionalHash))
    )) {
      result.value.zhHans = convertZhHantToZhHans(result.value.zhHant);
      result.zhHansOrigin = "machine";
      result.zhHansStatus = "translated";
    }
  }

  const receipt = createTranslationReceipt({ email: params.email, resource: params.resource, fields: results });
  return { fields: results, receipt, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), glossaryVersion: TRANSLATION_GLOSSARY_VERSION };
}

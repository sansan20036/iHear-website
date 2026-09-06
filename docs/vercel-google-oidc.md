# Vercel → Google Cloud translation OIDC

Production translation uses short-lived Vercel OIDC tokens and Google Workload Identity
Federation. No Google service-account private key is stored in Vercel.

## Fixed production trust boundary

- Google project: `ihear-website-502118` (`791054148527`)
- Workload Identity Pool: `vercel`
- Provider: `vercel`
- Issuer: `https://oidc.vercel.com/sansan20036s-projects`
- Accepted subject: `owner:sansan20036s-projects:project:i-hear-website:environment:production`
- Impersonated service account: `ihear-translation@ihear-website-502118.iam.gserviceaccount.com`
- Service-account project role: `roles/cloudtranslate.user`
- Service-account impersonation role for the subject: `roles/iam.workloadIdentityUser`

The provider uses Google's default audience:

```text
https://iam.googleapis.com/projects/791054148527/locations/global/workloadIdentityPools/vercel/providers/vercel
```

The provider maps `google.subject=assertion.sub` and applies this CEL condition:

```text
assertion.sub == 'owner:sansan20036s-projects:project:i-hear-website:environment:production'
```

Both the provider condition and the service-account IAM binding are production-specific. Preview
and Development deployments cannot impersonate the translation account.

## Vercel Production environment

Set these non-secret identifiers for Production only:

```text
GOOGLE_CLOUD_PROJECT_ID=ihear-website-502118
GOOGLE_CLOUD_PROJECT_NUMBER=791054148527
GOOGLE_CLOUD_SERVICE_ACCOUNT_EMAIL=ihear-translation@ihear-website-502118.iam.gserviceaccount.com
GOOGLE_CLOUD_WORKLOAD_IDENTITY_POOL_ID=vercel
GOOGLE_CLOUD_WORKLOAD_IDENTITY_PROVIDER_ID=vercel
```

Set `TRANSLATION_RECEIPT_SECRET` as a separate random Production-only sensitive value. Do not add
`GOOGLE_CLOUD_PRIVATE_KEY` or reuse the local receipt secret. Environment changes require a new
deployment before they are active.

## Runtime behavior

- Vercel uses `@vercel/oidc` to obtain the request's short-lived token.
- `google-auth-library` exchanges it with Google STS and impersonates the translation account.
- The Vercel token requests the HTTPS provider audience shown above; the Google external-account
  credential uses the same resource with the required `//iam.googleapis.com/...` prefix.
- Localhost uses short-lived, impersonated Application Default Credentials created by `gcloud`.
- Any partial OIDC configuration fails closed.
- The application rejects long-lived `GOOGLE_CLOUD_PRIVATE_KEY` credentials in every environment.

## Verification

After deployment:

1. Confirm `GOOGLE_CLOUD_PRIVATE_KEY` is absent from every Vercel environment.
2. Generate an English-first translation preview while signed in as an administrator.
3. Confirm Traditional Chinese is returned by Google and Simplified Chinese is produced by OpenCC.
4. Confirm a Preview deployment receives `TRANSLATION_NOT_CONFIGURED` or an IAM denial.
5. Review Google IAM audit logs for service-account impersonation by the exact Production subject.
6. After the OIDC path is verified, disable and delete the old downloaded service-account key.
7. For localhost, run `npm run translation:configure -- --login --account=owner@example.com`; never create a replacement JSON key.

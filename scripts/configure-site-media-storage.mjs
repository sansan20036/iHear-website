import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || "site-media";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const configuration = {
  public: true,
  fileSizeLimit: 1024 * 1024,
  allowedMimeTypes: ["image/webp"],
};

try {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;
  const existing = buckets.find((candidate) => candidate.id === bucket);
  const result = existing
    ? await supabase.storage.updateBucket(bucket, configuration)
    : await supabase.storage.createBucket(bucket, configuration);
  if (result.error) throw result.error;
  console.log(JSON.stringify({
    configured: true,
    bucket,
    created: !existing,
    public: true,
    fileSizeLimit: configuration.fileSizeLimit,
    allowedMimeTypes: configuration.allowedMimeTypes,
  }));
} catch (error) {
  console.error(JSON.stringify({
    configured: false,
    bucket,
    message: error instanceof Error ? error.message : "Could not configure Supabase Storage",
  }));
  process.exitCode = 1;
}

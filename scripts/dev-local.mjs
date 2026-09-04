// Keep local admin smoke tests isolated from any configured hosted database.
// Translation may still call Google Cloud when an administrator explicitly
// requests a translated preview.
process.env.IHEAR_FORCE_FILE_STORE = "1";

// Google OAuth redirect URIs are exact matches. Keep local admin development on
// the single callback registered in Google Cloud instead of allowing an
// arbitrary dev port to create redirect_uri_mismatch after sign-out.
const canonicalPort = "3000";
const incomingArgs = process.argv.slice(2);
const forwardedArgs = [];
let requestedPort = "";

for (let index = 0; index < incomingArgs.length; index += 1) {
  const value = incomingArgs[index];
  if (value === "--port" || value === "-p") {
    requestedPort = String(incomingArgs[index + 1] || "");
    index += 1;
    continue;
  }
  if (value.startsWith("--port=")) {
    requestedPort = value.slice("--port=".length);
    continue;
  }
  forwardedArgs.push(value);
}

if (requestedPort && requestedPort !== canonicalPort) {
  console.warn(`Local administrator login uses http://localhost:${canonicalPort}; ignoring requested port ${requestedPort}.`);
}

process.env.AUTH_URL = `http://localhost:${canonicalPort}`;
process.argv.splice(2, process.argv.length - 2, ...forwardedArgs, "--port", canonicalPort);

await import("./dev.mjs");

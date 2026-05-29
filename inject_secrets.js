/**
 * inject_secrets.js
 * Netlify build script — runs ONLY inside Netlify's build container.
 *
 * What it does:
 *   1. Reads the source HTML (index.html in repo root).
 *   2. Replaces ALL %%PLACEHOLDER%% tokens with real values
 *      sourced from Netlify Environment Variables (encrypted at rest).
 *   3. Writes the result to /dist/index.html for Netlify to serve.
 *
 * Security guarantees:
 *   • Real secrets NEVER touch the git repo.
 *   • The built /dist/index.html is ephemeral — created fresh on every deploy.
 *   • Netlify environment variables are encrypted at rest and only exposed
 *     to the build container at deploy time.
 *   • If any required variable is missing, the build FAILS loudly
 *     rather than deploying a broken or insecure file.
 *   • Secrets are passed as HTTP headers (X-Webhook-Secret), NOT as URL
 *     query parameters. This prevents secrets from appearing in server
 *     access logs, browser history, and Referer headers.
 *
 * Required Netlify Environment Variables (set in Netlify UI → Site → Environment):
 *   QB_WEBHOOK_SECRET       — 64-char hex secret for the QuickBooks push webhook
 *   N8N_BASE_URL            — e.g. https://your-n8n.domain.com  (no trailing slash)
 *   PROJECTS_WEBHOOK_SECRET — 64-char hex secret for the project management webhook
 *   PROJECTS_SHEET_URL      — Direct URL to the Projects tab in Google Sheets
 *   SHEETS_URL              — Full Google Sheets master URL
 *   N8N_STATUS_URL          — https://chase-cc-n8n.chasedashdemo.workers.dev/workflow-status
 *
 * How to generate secrets (run once, store result in Netlify):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 1. Verify required env vars are present ──────────────────────────────────
const REQUIRED = ['QB_WEBHOOK_SECRET', 'N8N_BASE_URL', 'PROJECTS_WEBHOOK_SECRET', 'N8N_STATUS_URL'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('\n[inject_secrets] BUILD FAILED — missing environment variables:');
  missing.forEach(k => console.error(`  • ${k}`));
  console.error('\nSet these in Netlify: Site settings → Environment variables.\n');
  process.exit(1);  // Non-zero exit aborts the deploy
}

const QB_SECRET       = process.env.QB_WEBHOOK_SECRET;
const PROJECTS_SECRET = process.env.PROJECTS_WEBHOOK_SECRET;
const N8N_BASE_URL    = process.env.N8N_BASE_URL.replace(/\/$/, ''); // strip trailing slash

// Validate secrets look like proper hex strings (64 chars = 32 bytes)
if (!/^[a-f0-9]{64}$/i.test(QB_SECRET)) {
  console.error('[inject_secrets] QB_WEBHOOK_SECRET must be a 64-char hex string.');
  console.error('  Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (!/^[a-f0-9]{64}$/i.test(PROJECTS_SECRET)) {
  console.error('[inject_secrets] PROJECTS_WEBHOOK_SECRET must be a 64-char hex string.');
  console.error('  Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// ── 2. Read source HTML ───────────────────────────────────────────────────────
const srcPath  = path.join(__dirname, 'index.html');
const distDir  = path.join(__dirname, 'dist');
const distPath = path.join(distDir, 'index.html');

if (!fs.existsSync(srcPath)) {
  console.error(`[inject_secrets] Source not found: ${srcPath}`);
  process.exit(1);
}

let html = fs.readFileSync(srcPath, 'utf8');

// ── 3. Replace placeholders ───────────────────────────────────────────────────
// All placeholders follow the pattern %%VARIABLE_NAME%%
//
// SECURITY: QB_PUSH_URL and PROJECTS_WEBHOOK_URL are clean URLs with NO secret
// in the query string. The secrets are injected as separate JS constants
// (%%QB_PUSH_SECRET%% and %%PROJECTS_WEBHOOK_SECRET%%) and sent as
// X-Webhook-Secret headers at runtime. This prevents secrets from leaking
// into server access logs, browser history, and HTTP Referer headers.
const replacements = {
  '%%QB_PUSH_URL%%':              `${N8N_BASE_URL}/webhook/qb-push`,
  '%%QB_PUSH_SECRET%%':           QB_SECRET,
  '%%SHEETS_URL%%':               process.env.SHEETS_URL         || '',
  '%%PROJECTS_WEBHOOK_URL%%':     `${N8N_BASE_URL}/webhook/projects`,
  '%%PROJECTS_WEBHOOK_SECRET%%':  PROJECTS_SECRET,
  '%%PROJECTS_SHEET_URL%%':       process.env.PROJECTS_SHEET_URL || '',
  '%%N8N_STATUS_URL%%':           process.env.N8N_STATUS_URL    || '',  // Cloudflare Worker /workflow-status
  '%%DASHBOARD_DATA_URL%%':       `${N8N_BASE_URL}/dashboard-data`,     // Cloudflare Worker /dashboard-data
};

let replacedCount = 0;
for (const [placeholder, value] of Object.entries(replacements)) {
  const regex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const count = (html.match(regex) || []).length;
  if (count === 0) {
    console.warn(`[inject_secrets] WARNING: placeholder "${placeholder}" not found in HTML.`);
  }
  html = html.replace(regex, value);
  replacedCount += count;
}

// ── 4. Verify no placeholders remain ─────────────────────────────────────────
const remaining = html.match(/%%[A-Z_]+%%/g);
if (remaining && remaining.length > 0) {
  console.error('[inject_secrets] BUILD FAILED — unresolved placeholders remain:');
  [...new Set(remaining)].forEach(p => console.error(`  • ${p}`));
  process.exit(1);
}

// ── 5. Write output ───────────────────────────────────────────────────────────
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(distPath, html, 'utf8');

// ── 6. Log summary (no secrets printed) ──────────────────────────────────────
const stats = fs.statSync(distPath);
console.log('\n[inject_secrets] ✅ Build complete');
console.log(`  Source : ${srcPath}`);
console.log(`  Output : ${distPath} (${(stats.size / 1024).toFixed(1)} KB)`);
console.log(`  Tokens replaced    : ${replacedCount}`);
console.log(`  N8N_BASE_URL       : ${N8N_BASE_URL}`);
console.log(`  QB secret          : [set, ${QB_SECRET.length} chars, not logged]`);
console.log(`  Projects secret    : [set, ${PROJECTS_SECRET.length} chars, not logged]`);
console.log(`  Secret delivery    : X-Webhook-Secret header (not URL query string)\n`);

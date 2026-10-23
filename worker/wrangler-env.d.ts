// Ambient bindings for the Worker. Keep in sync with wrangler.toml.
// In production prefer `wrangler types` to regenerate these.

interface Env {
  ROOMS: DurableObjectNamespace;
  /** R2 S3-compatible credentials — set as Worker secrets, never committed. */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  /** Optional S3 endpoint override (tests only; production uses the account's r2.cloudflarestorage.com host). */
  R2_ENDPOINT?: string;
}

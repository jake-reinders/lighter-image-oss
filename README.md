# lighter-image-oss

Source code for an image compression application using Sharp, a vanilla JavaScript interface, Node serverless handlers, and an Express backend.

This is a code-only release. No hosted backend, storage, credentials, or infrastructure is provided. Compression requires a developer's own API and storage configuration.

## Check the code

Use Node.js 22.12 or newer:

```sh
npm ci
npm ci --prefix gcp
npm test
npm test --prefix gcp
npm run build
npm run build --prefix gcp
npm audit
npm audit --prefix gcp
```

Tests use synthetic images and mocked storage. The root suite includes backend tests; the counts are not additive.

## Source layout

- `public/`: neutral interface; network operations require configured API endpoints.
- `src/`: direct storage upload client, bundled by the build.
- `api/`: Node serverless handlers targeting a Vercel-compatible adapter. Local structural HTTP types avoid bundling a deployment SDK.
- `gcp/`: Express service, image-processing code, and tests.
- `lib/`: proxy HTTP types and service authentication.

## Configuration and limitations

`.env.example` lists configuration names. Supply your own credentials, bucket CORS/lifecycle rules, and hosting adapter. The Express service uses Google Application Default Credentials and does not load the root `.env.local` automatically.

The proxy uses `GCP_CLOUD_RUN_URL` and `GCP_SERVICE_ACCOUNT_KEY`. The backend requires `UPLOAD_TOKEN_SECRET`: 32 random bytes encoded as 64 hexadecimal characters, shared by all instances of that backend and kept out of client code. Generate it with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Use a different secret for each environment. Rotation invalidates outstanding upload tokens. The cleanup proxy requires `CRON_SECRET`; backend cleanup requires matching `CLEANUP_SECRET` values on both services. Schedule cleanup using your own infrastructure.

Uploads use signed form policies with an exact object key, content type, and a size bound of at most 10 MiB. Compression requires a signed token for that upload; object paths and download links do not authorize compression. Reads are bounded and tied to a specific object generation. Compression cleanup deletes only that generation after successful processing. The storage SDK currently converts generations to numbers internally; generation identifiers it cannot represent exactly are rejected.

Keep the bucket private with public-access prevention and no anonymous write access. Configure storage CORS for your frontend's origin and form POST uploads; backend CORS is separate. The 15-minute grant window covers uploading and starting compression. Expired grants require a new upload. Policies and tokens are bearer credentials: keep them in memory, never log them or put them in URLs, and do not cache grant responses. Grants can be reused until expiry; they are not single-use. Failed or abandoned uploads/outputs rely on bucket lifecycle rules or scheduled cleanup.

Use a dedicated app bucket. The example `gcp/lifecycle.json` makes objects under `uploads/` and `compressed/` eligible for deletion after one day. Review it before applying it: a lifecycle configuration replaces the bucket's existing rules, so preserve any rules you still need. Deletion is asynchronous, not an exact 24-hour deadline.

Update the client, proxies, and backend together. The client submits signed form fields to storage, then sends only the upload token and compression options to `/compress`. Legacy PUT-upload and path-only compression requests are not supported.

These controls do not provide a global rate limit, spending cap, decoded-image memory limit, or processing timeout. Configure these separately before a public deployment. No cloud configuration or deployed behavior is verified by the unit tests.

## Optional storage integration test

The normal test suite skips real-storage checks. To exercise Google's actual policy enforcement, use Application Default Credentials with signing permissions and your own **disposable test bucket**:

```sh
RUN_GCS_POLICY_TESTS=1 GCS_POLICY_TEST_BUCKET=your-disposable-test-bucket npm run test:storage --prefix gcp
```

This writes synthetic objects, performs boundary/oversize uploads and a generation-replacement check, and attempts to delete only its generated objects. Cloud charges may apply; lifecycle cleanup should cover interrupted runs and retained object versions. It never provisions infrastructure. This test does not verify browser CORS or container behavior.

Accounts, billing, databases, activity tracking, ratings, contact forms, and email reports are not included. The Dockerfile is a build reference; no image or running service is supplied.

## License and contributions

MIT, copyright 2026 Jake Reinders. See [LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).

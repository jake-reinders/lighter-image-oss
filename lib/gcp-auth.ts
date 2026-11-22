import { SignJWT, importPKCS8 } from 'jose';

interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

let cachedToken: { token: string; expiry: number } | null = null;

/**
 * Get an ID token for authenticating to Cloud Run
 * Uses the service account key from environment variable
 */
export async function getCloudRunToken(targetAudience: string): Promise<string> {
  // Check cache (tokens are valid for 1 hour, refresh at 50 mins)
  if (cachedToken && Date.now() < cachedToken.expiry) {
    return cachedToken.token;
  }

  const keyBase64 = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!keyBase64) {
    throw new Error('GCP_SERVICE_ACCOUNT_KEY environment variable not set');
  }

  const keyJson = Buffer.from(keyBase64, 'base64').toString('utf-8');
  const key: ServiceAccountKey = JSON.parse(keyJson);

  // Create a signed JWT to exchange for an ID token
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(key.private_key, 'RS256');

  const signedJwt = await new SignJWT({
    target_audience: targetAudience,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(key.client_email)
    .setSubject(key.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  // Exchange JWT for ID token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt,
    }),
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`Failed to get ID token: ${error}`);
  }

  const tokenData = await tokenResponse.json();
  const idToken = tokenData.id_token;

  // Cache token (expire 10 minutes early to be safe)
  cachedToken = {
    token: idToken,
    expiry: Date.now() + 50 * 60 * 1000,
  };

  return idToken;
}

/**
 * Make an authenticated request to Cloud Run
 */
export async function callCloudRun(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const cloudRunUrl = process.env.GCP_CLOUD_RUN_URL;
  if (!cloudRunUrl) {
    console.error(JSON.stringify({
      event: 'call_cloud_run_error',
      error: 'GCP_CLOUD_RUN_URL not set',
      path,
      timestamp: new Date().toISOString(),
    }));
    throw new Error('GCP_CLOUD_RUN_URL environment variable not set');
  }

  const fullUrl = `${cloudRunUrl}${path}`;
  const method = options.method || 'POST';

  try {
    console.log(JSON.stringify({
      event: 'call_cloud_run_start',
      path,
      method,
      fullUrl,
      timestamp: new Date().toISOString(),
    }));

    const token = await getCloudRunToken(cloudRunUrl);

    console.log(JSON.stringify({
      event: 'call_cloud_run_token_obtained',
      path,
      tokenLength: token?.length || 0,
      timestamp: new Date().toISOString(),
    }));

    const response = await fetch(fullUrl, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    console.log(JSON.stringify({
      event: 'call_cloud_run_response',
      path,
      status: response.status,
      statusText: response.statusText,
      timestamp: new Date().toISOString(),
    }));

    return response;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'call_cloud_run_exception',
      path,
      method,
      fullUrl,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}

// Vertex AI (Google Cloud) authentication for the agent. Vertex's
// OpenAI-compatible endpoint takes a short-lived Google Cloud access token
// (1 hour) instead of an API key; google-auth-library mints it from a
// service account key and refreshes it before it expires.
// https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/auth-and-credentials
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// Only a plain service account key is accepted. Other credential types
// google-auth-library understands (e.g. external_account) can make it run
// commands or fetch URLs named inside the file.
export function parseServiceAccountKey(json) {
  let key;
  try {
    key = JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must be the service account key file's JSON contents.");
  }

  if (key?.type !== "service_account" || !key.client_email || !key.private_key || !key.project_id) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON must be a service account key ("type": "service_account" with client_email, private_key and project_id).',
    );
  }

  return Object.freeze({
    type: key.type,
    project_id: key.project_id,
    client_email: key.client_email,
    private_key: key.private_key,
  });
}

export function vertexOpenAiBaseUrl({ projectId, location }) {
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${projectId}/locations/${location}/endpoints/openapi`;
}

// Vertex names Google's models with a publisher prefix ("google/...").
export function vertexModelName(model) {
  return model.includes("/") ? model : `google/${model}`;
}

export function createVertexTokenProvider(serviceAccountKey, { loadGoogleAuth = () => import("google-auth-library") } = {}) {
  let authPromise;

  return async function getAccessToken() {
    // Loaded lazily so the library is only needed when Vertex is in use.
    authPromise ??= loadGoogleAuth().then(
      ({ GoogleAuth }) => new GoogleAuth({ credentials: serviceAccountKey, scopes: [CLOUD_PLATFORM_SCOPE] }),
    );

    let token;
    try {
      token = await (await authPromise).getAccessToken();
    } catch (error) {
      authPromise = undefined;
      throw error;
    }
    if (!token) {
      throw new Error("Google didn't return an access token for the Vertex AI service account.");
    }
    return token;
  };
}

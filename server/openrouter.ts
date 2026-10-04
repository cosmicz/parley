// Pieces shared by every OpenRouter call: the base URL, the request headers
// and reading the documented error body { error: { code, message, metadata } }.

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const APP_TITLE = 'Parley';

export function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-OpenRouter-Title': APP_TITLE,
  };
}

export function upstreamErrorText(body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' ? message : 'no error message';
}

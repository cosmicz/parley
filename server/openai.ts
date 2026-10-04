// OpenAI used directly, for an operator with only an OpenAI key (pahax-t37
// scope addition 14:27). Model ids confirmed in that key's /v1/models listing
// at 14:26: gpt-4.1-mini, gpt-4o-mini-transcribe, gpt-4o-transcribe.

export const OPENAI_API = 'https://api.openai.com/v1';

/** JSON requests; multipart requests omit Content-Type so fetch sets the boundary. */
export function openAiHeaders(apiKey: string, json = true): Record<string, string> {
  return json ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${apiKey}` };
}

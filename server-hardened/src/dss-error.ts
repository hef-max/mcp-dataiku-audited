const secretKey = /authorization|cookie|password|passwd|secret|credential|token|api.?key|access.?key/i;
export function sanitize(value: unknown, apiKey: string): any {
  if (Array.isArray(value)) return value.map(v => sanitize(v, apiKey));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKey.test(k) ? '[REDACTED]' : sanitize(v, apiKey)]));
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of [apiKey, encodeURIComponent(apiKey), Buffer.from(apiKey).toString('base64')].filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1 [REDACTED]')
    .replace(/((?:authorization|cookie|password|passwd|[\w-]*secret[\w-]*|[\w-]*token|[\w-]*api[_-]?key|[\w-]*access[_-]?key(?:id)?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&<>]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  return text;
}
export function errorDetails(error: unknown): unknown {
  if (error instanceof Error && 'details' in error) return error.details;
  if (error instanceof Error) {
    try { return JSON.parse(error.message); } catch { return { error: error.message }; }
  }
  return { error: 'Unknown operation failure' };
}
export class DssHttpError extends Error {
  readonly details: Record<string, unknown>;
  constructor(status: number, method: string, endpoint: string, body: unknown, apiKey: string) {
    const safe = sanitize(body, apiKey);
    const object = safe && typeof safe === 'object' ? safe as Record<string, unknown> : {};
    const details = { error: 'Dataiku API request failed', status, method,
      endpoint: sanitize(endpoint, apiKey), response_body: safe,
      dss_error: { type: object.errorType ?? object.type ?? null, message: object.message ?? object.error ?? (typeof safe === 'string' ? safe : null) } };
    super(JSON.stringify(details));
    this.name = 'DssHttpError'; this.details = details;
  }
}
export function parseSuccessBody(status: number, method: string, endpoint: string, contentType: string, text: string, apiKey: string, asText = false): any {
  if (!text.trim()) return asText ? '' : null;
  if (asText || !/(?:application|text)\/(?:[\w.-]+\+)?json\b/i.test(contentType)) return sanitize(text, apiKey);
  try { return JSON.parse(text); }
  catch {
    const details = { error: 'Invalid JSON in successful DSS response', status, method, endpoint: sanitize(endpoint, apiKey),
      content_type: contentType, body_length: Buffer.byteLength(text, 'utf8'), excerpt: sanitize(text, apiKey).slice(0, 1500) };
    throw Object.assign(new Error(JSON.stringify(details)), { details });
  }
}

/** Bound streaming reads so an error page cannot exhaust memory. Oversized errors are omitted, not partially leaked. */
export async function readBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new Error('Response body exceeds safe size limit'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

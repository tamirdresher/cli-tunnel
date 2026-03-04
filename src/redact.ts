// F-08: Strip Unicode zero-width characters that can bypass regex patterns
function stripZeroWidth(text: string): string {
  return text.replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g, '');
}

export function redactSecrets(text: string): string {
  const cleaned = stripZeroWidth(text);
  return cleaned
    // Generic patterns: key=value, key: value, key="value"
    .replace(/(?:token|secret|key|password|credential|authorization|api_key|private_key|access_key|connection_string|db_pass|signing)[\s:="']+\S{8,}/gi, '[REDACTED]')
    // OpenAI keys
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED]')
    // GitHub tokens
    .replace(/gh[ps]_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
    // AWS keys
    .replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED]')
    // Azure connection strings
    .replace(/DefaultEndpointsProtocol=[^;\s]{20,}/gi, '[REDACTED]')
    .replace(/AccountKey=[^;\s]{20,}/gi, 'AccountKey=[REDACTED]')
    // F-09: Azure SAS tokens
    .replace(/[?&]sig=[a-zA-Z0-9%/+=]{20,}/gi, '?sig=[REDACTED]')
    .replace(/SharedAccessSignature\s+[^\s"']{20,}/gi, 'SharedAccessSignature [REDACTED]')
    // Database URLs
    .replace(/(postgres|mongodb|mysql|redis):\/\/[^\s"']{10,}/gi, '[REDACTED]')
    // F-17: Bearer tokens (relaxed min length to catch shorter tokens)
    .replace(/Bearer\s+[a-zA-Z0-9._\-/+=]{8,}/gi, 'Bearer [REDACTED]')
    // F-17: Basic auth headers
    .replace(/Basic\s+[a-zA-Z0-9+/=]{8,}/gi, 'Basic [REDACTED]')
    // JWT tokens
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[REDACTED]')
    // Slack tokens
    .replace(/xox[bpras]-[a-zA-Z0-9-]{10,}/g, '[REDACTED]')
    // npm tokens
    .replace(/npm_[a-zA-Z0-9]{20,}/g, '[REDACTED]')
    // F-09: Google API keys
    .replace(/AIzaSy[a-zA-Z0-9_-]{33}/g, '[REDACTED]')
    // F-09: Stripe keys
    .replace(/(?:sk|pk|rk)_(?:live|test)_[a-zA-Z0-9]{10,}/g, '[REDACTED]')
    // F-09: SendGrid keys
    .replace(/SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}/g, '[REDACTED]')
    // F-09: Twilio keys
    .replace(/SK[a-f0-9]{32}/g, '[REDACTED]')
    // F-09: Webhook secrets
    .replace(/whsec_[a-zA-Z0-9+/=]{20,}/g, '[REDACTED]')
    // PEM private keys
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[REDACTED]');
}

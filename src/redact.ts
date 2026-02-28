export function redactSecrets(text: string): string {
  return text
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
    // Database URLs
    .replace(/(postgres|mongodb|mysql|redis):\/\/[^\s"']{10,}/gi, '[REDACTED]')
    // Bearer tokens in headers
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, 'Bearer [REDACTED]')
    // JWT tokens
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[REDACTED]')
    // Slack tokens
    .replace(/xox[bpras]-[a-zA-Z0-9-]{10,}/g, '[REDACTED]')
    // npm tokens
    .replace(/npm_[a-zA-Z0-9]{20,}/g, '[REDACTED]')
    // PEM private keys
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[REDACTED]');
}

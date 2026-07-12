import { t } from '../i18n/index.js';

const LEGACY_DETAIL_KEYS = new Map(Object.entries({
  'Link is invalid or expired': 'api.error.passwordSetup.invalidOrExpired',
  'A new link can only be requested by email. Please contact an admin.': 'api.error.passwordSetup.emailOnlyResend',
  'The new link could not be sent by email. Please contact an admin.': 'api.error.passwordSetup.resendEmailFailed',
  'Please enter a valid email address': 'api.error.validation.invalidEmail',
  'Password must be at least 8 characters long': 'api.error.validation.passwordTooShort8',
  'Password must be at least 12 characters long': 'api.error.validation.passwordTooShort12',
  'Password must contain at least one uppercase letter': 'api.error.validation.passwordUppercase',
  'Password must contain at least one lowercase letter': 'api.error.validation.passwordLowercase',
  'Password must contain at least one digit': 'api.error.validation.passwordDigit',
  'Password must contain at least one special character': 'api.error.validation.passwordSpecial',
  'Too many login attempts. Please try again in 15 minutes.': 'api.error.rateLimit.login',
  'Too many requests. Please try again later.': 'api.error.rateLimit.passwordReset',
  'Too many requests. Please slow down.': 'api.error.rateLimit.api',
  'You are not authenticated.': 'api.error.auth.notAuthenticated',
  'Attachments are disabled by the administrator': 'todo.attachments.disabled',
  'This attachment file type is not allowed': 'todo.attachments.typeNotAllowed',
  'Attachment quota exceeded': 'todo.attachments.quotaExceeded',
  'Attachment is too large': 'todo.attachments.fileTooLargeGeneric',
  'Too many attachments': 'todo.attachments.tooMany',
}));

function normalizeApiErrorData(data, fallback) {
  let code = data && typeof data === 'object' ? data.code : undefined;
  let params = data && typeof data === 'object' ? (data.params || {}) : {};
  let detail = data && typeof data === 'object' ? data.detail : undefined;

  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    code = detail.code || code;
    params = detail.params || params;
    detail = detail.detail || detail.message || fallback;
  }

  return { code, params, detail };
}

function messageFromNormalizedError({ code, params, detail }, fallback) {
  if (code) {
    const key = `api.error.${code}`;
    const translated = t(key, params || {});
    if (translated !== key) return translated;
  }

  if (typeof detail === 'string' && detail) {
    const key = LEGACY_DETAIL_KEYS.get(detail);
    if (key) return t(key);
    return detail;
  }

  return fallback;
}

export async function apiErrorFromResponse(response, fallback = 'Request failed') {
  const data = await response.json().catch(() => ({}));
  const normalized = normalizeApiErrorData(data, fallback);
  const message = messageFromNormalizedError(normalized, fallback);
  const error = new Error(message);
  error.status = response.status;
  error.code = normalized.code;
  error.params = normalized.params;
  error.detail = normalized.detail;
  throw error;
}

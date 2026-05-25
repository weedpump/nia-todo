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
}));

function messageFromDetail(detail, fallback) {
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const code = detail.code ? String(detail.code) : '';
    if (code) {
      const key = `api.error.${code}`;
      const translated = t(key, detail.params || {});
      if (translated !== key) return translated;
    }
    if (detail.message) return String(detail.message);
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
  const message = messageFromDetail(data.detail, fallback);
  const error = new Error(message);
  error.status = response.status;
  error.code = data.detail && typeof data.detail === 'object' ? data.detail.code : undefined;
  error.detail = data.detail;
  throw error;
}

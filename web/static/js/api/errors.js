import { t } from '../i18n/index.js';

const LEGACY_DETAIL_KEYS = new Map(Object.entries({
  'Link is invalid or expired': 'api.error.passwordSetup.invalidOrExpired',
  'A new link can only be requested by email. Please contact an admin.': 'api.error.passwordSetup.emailOnlyResend',
  'The new link could not be sent by email. Please contact an admin.': 'api.error.passwordSetup.resendEmailFailed',
  'Bitte eine gültige E-Mail-Adresse eingeben': 'api.error.validation.invalidEmail',
  'Passwort muss mindestens 8 Zeichen lang sein': 'api.error.validation.passwordTooShort8',
  'Passwort muss mindestens 12 Zeichen lang sein': 'api.error.validation.passwordTooShort12',
  'Passwort muss mindestens einen Großbuchstaben enthalten': 'api.error.validation.passwordUppercase',
  'Passwort muss mindestens einen Kleinbuchstaben enthalten': 'api.error.validation.passwordLowercase',
  'Passwort muss mindestens eine Ziffer enthalten': 'api.error.validation.passwordDigit',
  'Passwort muss mindestens ein Sonderzeichen enthalten': 'api.error.validation.passwordSpecial',
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

const CLIENT_MARKER_RE = /nia-todo-client\(([^)]{1,160})\)\s*/i;

function clientInfoFromUserAgent(userAgent) {
  const marker = String(userAgent || '').match(CLIENT_MARKER_RE);
  if (!marker) return {};
  return Object.fromEntries(
    marker[1].split(';')
      .map(part => part.trim().split('=').map(value => value.trim()))
      .filter(([key, value]) => key && value)
  );
}

export function cleanSessionUserAgent(userAgent) {
  return String(userAgent || '').replace(CLIENT_MARKER_RE, '').trim();
}

function browserName(ua, fallback) {
  if (/EdgA\//.test(ua)) return 'Edge';
  if (/EdgiOS\//.test(ua)) return 'Edge';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/Firefox\//.test(ua) || /FxiOS\//.test(ua)) return 'Firefox';
  if (/CriOS\//.test(ua) || /Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return fallback;
}

function osName(ua, fallback) {
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/iPhone|iPad/i.test(ua)) return 'iOS/iPadOS';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return fallback;
}

function nativePlatformName(platform, fallback) {
  switch (String(platform || '').toLowerCase()) {
    case 'android': return 'Android App';
    case 'windows': return 'Windows App';
    case 'macos': return 'macOS App';
    case 'linux': return 'Linux App';
    default: return fallback;
  }
}

export function sessionDeviceName(device, t) {
  const rawUa = String(device?.user_agent || '').trim();
  if (!rawUa) return t('settings.2fa.trustedDeviceUnknown');
  const client = clientInfoFromUserAgent(rawUa);
  if (client.app === 'nia-todo' && client.mode === 'native') {
    return nativePlatformName(client.platform, 'nia-todo App');
  }
  const ua = cleanSessionUserAgent(rawUa);
  const browser = browserName(ua, t('settings.2fa.trustedDeviceBrowser'));
  const os = osName(ua, t('settings.2fa.trustedDeviceDevice'));
  return `${browser} · ${os}`;
}

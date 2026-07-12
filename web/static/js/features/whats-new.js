import { getCurrentLanguage, t } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';

const WHATS_NEW_CONTENT_URL = '/static/content/whats-new.json';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0];
}

function releaseBadge(release) {
  if (release?.badge) return release.badge;
  return t('whatsNew.versionBadge', { version: String(release?.version || '').replace(/^v/i, '') });
}

function releaseMatchesAppVersion(release, appVersion) {
  const current = normalizeVersion(appVersion);
  if (!current) return false;
  const versions = [release.version, ...(release.appVersions || [])].map(normalizeVersion);
  return versions.includes(current);
}

function storageKey(release, user) {
  const version = normalizeVersion(release?.version);
  const userId = user?.id ? String(user.id) : 'anonymous';
  return `nia-whats-new:${userId}:${version}`;
}

function localizedRelease(release, language) {
  const content = release?.content?.[language] || release?.content?.en || release?.content?.de || {};
  const slides = Array.isArray(content.slides) ? content.slides : [];
  return {
    ...release,
    badge: content.badge || release.badge,
    title: content.title || '',
    intro: content.intro || '',
    slides,
  };
}

export function createWhatsNewFeature({ appVersion, getCurrentUser = () => null } = {}) {
  let releasesPromise = null;
  let releases = [];
  let activeRelease = null;
  let activeSlide = 0;
  let modal = null;
  let bound = false;

  async function loadReleases() {
    if (!releasesPromise) {
      releasesPromise = fetch(WHATS_NEW_CONTENT_URL, { cache: 'force-cache' })
        .then((response) => {
          if (!response.ok) throw new Error(`Failed to load what's new content: ${response.status}`);
          return response.json();
        })
        .then((data) => Array.isArray(data?.releases) ? data.releases : []);
    }
    releases = await releasesPromise;
    return releases;
  }

  async function getCurrentRelease() {
    const allReleases = await loadReleases();
    const currentLanguage = getCurrentLanguage();
    const currentRelease = allReleases.find((release) => releaseMatchesAppVersion(release, appVersion));
    if (currentRelease) return localizedRelease(currentRelease, currentLanguage);
    const carriedRelease = allReleases.find((release) => release.carryForward && !hasSeenRelease(release));
    return carriedRelease ? localizedRelease(carriedRelease, currentLanguage) : null;
  }

  function hasSeenRelease(release) {
    if (!release) return true;
    return localStorage.getItem(storageKey(release, getCurrentUser())) === '1';
  }

  function markSeen(release = activeRelease) {
    if (!release) return;
    localStorage.setItem(storageKey(release, getCurrentUser()), '1');
  }

  function currentSlide() {
    const slides = activeRelease?.slides || [];
    return slides[Math.max(0, Math.min(activeSlide, slides.length - 1))] || null;
  }

  function renderSlideBullets(slide) {
    const bullets = Array.isArray(slide?.bullets) ? slide.bullets.filter(Boolean) : [];
    if (!bullets.length) return '';
    return `<ul class="whats-new-slide-bullets">${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>`;
  }

  function renderSlideMedia(slide) {
    const media = slide?.media || (slide?.image ? { type: 'image', src: slide.image, alt: slide.alt } : { type: 'icon', icon: slide?.icon });
    if (media.type === 'image' && media.src) {
      return `<figure class="whats-new-slide-media whats-new-slide-media-image"><img src="${escapeHtml(media.src)}" alt="${escapeHtml(media.alt || '')}"></figure>`;
    }
    return `<div class="whats-new-slide-media whats-new-slide-media-icon" aria-hidden="true">${iconSvg(media.icon || 'sparkles')}</div>`;
  }

  function render() {
    if (!modal || !activeRelease) return;
    const slides = activeRelease.slides || [];
    const slide = currentSlide();
    const isFirst = activeSlide <= 0;
    const isLast = activeSlide >= slides.length - 1;
    modal.innerHTML = `
      <div class="modal-overlay" data-whats-new-action="dismiss"></div>
      <section class="modal-content entity-modal-content ui-detail-modal-content whats-new-content" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
        <header class="entity-modal-header ui-detail-modal-header whats-new-header">
          <span class="entity-modal-title-icon ui-detail-title-icon whats-new-title-icon" aria-hidden="true">${iconSvg('newspaper')}</span>
          <div class="whats-new-title-wrap">
            <div class="whats-new-badge">${escapeHtml(releaseBadge(activeRelease))}</div>
            <h3 id="whats-new-title">${escapeHtml(activeRelease.title)}</h3>
            <p>${escapeHtml(activeRelease.intro)}</p>
          </div>
          <div class="ui-detail-header-actions whats-new-header-actions">
            <button type="button" class="modal-close-x" data-whats-new-action="dismiss" aria-label="${escapeHtml(t('common.close'))}">${iconSvg('x')}</button>
          </div>
        </header>
        <div class="entity-modal-body ui-detail-modal-body whats-new-body">
          <article class="whats-new-slide">
            ${renderSlideMedia(slide)}
            <div class="whats-new-slide-copy">
              <h4>${escapeHtml(slide?.title || '')}</h4>
              <p>${escapeHtml(slide?.body || '')}</p>
              ${renderSlideBullets(slide)}
            </div>
          </article>
        </div>
        <div class="whats-new-dots" role="tablist" aria-label="${escapeHtml(t('whatsNew.progress'))}">
          ${slides.map((item, index) => `
            <button type="button" class="whats-new-dot ${index === activeSlide ? 'active' : ''}" data-whats-new-slide="${index}" aria-label="${escapeHtml(t('whatsNew.slideLabel', { current: index + 1, total: slides.length }))}" aria-selected="${index === activeSlide ? 'true' : 'false'}"></button>
          `).join('')}
        </div>
        <div class="entity-modal-actions whats-new-actions">
          <div class="modal-actions-right">
            <button type="button" class="btn btn-secondary" data-whats-new-action="prev" ${isFirst ? 'disabled' : ''}>${escapeHtml(t('common.back'))}</button>
            <button type="button" class="btn btn-primary" data-whats-new-action="${isLast ? 'done' : 'next'}">${escapeHtml(t(isLast ? 'whatsNew.done' : 'common.continue'))}</button>
          </div>
        </div>
      </section>
    `;
  }

  function close({ remember = true } = {}) {
    if (remember) markSeen();
    modal?.classList.remove('active');
    modal?.setAttribute('aria-hidden', 'true');
    activeRelease = null;
    activeSlide = 0;
  }

  function open(release) {
    if (!release) return false;
    activeRelease = release;
    activeSlide = 0;
    ensureModal();
    render();
    modal.classList.add('active');
    modal.removeAttribute('aria-hidden');
    modal.querySelector('[data-whats-new-action="next"], [data-whats-new-action="done"]')?.focus();
    return true;
  }

  function ensureModal() {
    if (modal) return modal;
    modal = document.getElementById('whats-new-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'whats-new-modal';
      modal.className = 'modal ui-detail-modal ui-detail-view whats-new-modal';
      modal.setAttribute('aria-hidden', 'true');
      document.body.appendChild(modal);
    }
    return modal;
  }

  async function maybeShowWhatsNew({ force = false } = {}) {
    const release = await getCurrentRelease();
    if (!release) return false;
    // Temporarily disabled for visual testing: keep writing the seen flag,
    // but show the tour on every reload while this branch is in review.
    // if (!force && hasSeenRelease(release)) return false;
    return open(release);
  }

  function bindWhatsNewActions() {
    if (bound) return;
    bound = true;
    ensureModal();
    modal.addEventListener('click', (event) => {
      const slideButton = event.target.closest('[data-whats-new-slide]');
      if (slideButton) {
        activeSlide = Number(slideButton.dataset.whatsNewSlide || 0);
        render();
        return;
      }
      const action = event.target.closest('[data-whats-new-action]')?.dataset.whatsNewAction;
      if (!action) return;
      if (action === 'dismiss') {
        close({ remember: false });
        return;
      }
      if (action === 'done') {
        close({ remember: true });
        return;
      }
      if (action === 'prev') activeSlide = Math.max(0, activeSlide - 1);
      if (action === 'next') activeSlide = Math.min((activeRelease?.slides?.length || 1) - 1, activeSlide + 1);
      render();
    });
    document.addEventListener('keydown', (event) => {
      if (!activeRelease || event.key !== 'Escape') return;
      close({ remember: false });
    });
    window.addEventListener('nia-language-change', async () => {
      if (!activeRelease) return;
      const release = await getCurrentRelease();
      if (!release) return;
      activeRelease = release;
      activeSlide = Math.min(activeSlide, Math.max(0, (activeRelease.slides || []).length - 1));
      render();
    });
  }

  return { bindWhatsNewActions, maybeShowWhatsNew, open, close };
}

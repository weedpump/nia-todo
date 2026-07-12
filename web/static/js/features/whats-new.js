import { t } from '../i18n/index.js';
import { WHATS_NEW_RELEASES } from '../content/whats-new.js';

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

export function createWhatsNewFeature({ appVersion, getCurrentUser = () => null } = {}) {
  let activeRelease = null;
  let activeSlide = 0;
  let modal = null;
  let bound = false;

  function getCurrentRelease() {
    return WHATS_NEW_RELEASES.find((release) => releaseMatchesAppVersion(release, appVersion)) || null;
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

  function render() {
    if (!modal || !activeRelease) return;
    const slides = activeRelease.slides || [];
    const slide = currentSlide();
    const isFirst = activeSlide <= 0;
    const isLast = activeSlide >= slides.length - 1;
    modal.innerHTML = `
      <div class="modal-overlay" data-whats-new-action="dismiss"></div>
      <section class="modal-content whats-new-content" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
        <button type="button" class="modal-close-x" data-whats-new-action="dismiss" aria-label="${escapeHtml(t('common.close'))}">×</button>
        <div class="whats-new-hero">
          <div class="whats-new-badge">${escapeHtml(t(activeRelease.badgeKey))}</div>
          <h3 id="whats-new-title">${escapeHtml(t(activeRelease.titleKey))}</h3>
          <p>${escapeHtml(t(activeRelease.introKey))}</p>
        </div>
        <div class="modal-body whats-new-body">
          <article class="whats-new-slide">
            ${slide?.image ? `<figure class="whats-new-slide-media"><img src="${escapeHtml(slide.image)}" alt="${escapeHtml(slide.altKey ? t(slide.altKey) : '')}"></figure>` : `<div class="whats-new-slide-icon" aria-hidden="true">${escapeHtml(slide?.icon || '✨')}</div>`}
            <div>
              <h4>${escapeHtml(t(slide?.titleKey || ''))}</h4>
              <p>${escapeHtml(t(slide?.bodyKey || ''))}</p>
            </div>
          </article>
          <div class="whats-new-dots" role="tablist" aria-label="${escapeHtml(t('whatsNew.progress'))}">
            ${slides.map((item, index) => `
              <button type="button" class="whats-new-dot ${index === activeSlide ? 'active' : ''}" data-whats-new-slide="${index}" aria-label="${escapeHtml(t('whatsNew.slideLabel', { current: index + 1, total: slides.length }))}" aria-selected="${index === activeSlide ? 'true' : 'false'}"></button>
            `).join('')}
          </div>
        </div>
        <div class="modal-actions whats-new-actions">
          <button type="button" class="btn btn-secondary" data-whats-new-action="dismiss">${escapeHtml(t('whatsNew.dismiss'))}</button>
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
      modal.className = 'modal whats-new-modal';
      modal.setAttribute('aria-hidden', 'true');
      document.body.appendChild(modal);
    }
    return modal;
  }

  function maybeShowWhatsNew({ force = false } = {}) {
    const release = getCurrentRelease();
    if (!release) return false;
    if (!force && hasSeenRelease(release)) return false;
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
      if (action === 'dismiss' || action === 'done') {
        close({ remember: true });
        return;
      }
      if (action === 'prev') activeSlide = Math.max(0, activeSlide - 1);
      if (action === 'next') activeSlide = Math.min((activeRelease?.slides?.length || 1) - 1, activeSlide + 1);
      render();
    });
    document.addEventListener('keydown', (event) => {
      if (!activeRelease || event.key !== 'Escape') return;
      close({ remember: true });
    });
    window.addEventListener('nia-language-change', () => {
      if (activeRelease) render();
    });
  }

  return { bindWhatsNewActions, maybeShowWhatsNew, open, close };
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createTodoAttachmentsFeature } from '../web/static/js/features/todo-attachments.js';

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  setFromString(value) {
    this.values = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) this.values.add(name);
    this.element._className = [...this.values].join(' ');
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
    this.element._className = [...this.values].join(' ');
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.src = '';
    this.alt = '';
    this.loading = '';
    this.decoding = '';
    this._className = '';
    this.classList = new FakeClassList(this);
  }

  set className(value) {
    this._className = String(value || '');
    this.classList.setFromString(this._className);
  }

  get className() {
    return this._className;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    if (!value) this.children = [];
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) || []) listener({ target: this });
  }

  closest() {
    return null;
  }
}

function findByClass(root, className) {
  if (root.classList?.contains(className)) return root;
  for (const child of root.children || []) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

const elements = new Map([
  ['todo-attachments-list', new FakeElement('div')],
  ['todo-attachments-empty', new FakeElement('div')],
  ['todo-attachments-count', new FakeElement('span')],
  ['todo-attachment-upload-btn', new FakeElement('button')],
  ['attachment-preview-modal', new FakeElement('div')],
  ['attachment-preview-title', new FakeElement('h3')],
  ['attachment-preview-body', new FakeElement('div')],
  ['attachment-preview-download-btn', new FakeElement('button')],
]);

globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
  getElementById: (id) => elements.get(id) || null,
};

const observed = [];
let observerCallback = null;
globalThis.IntersectionObserver = class {
  constructor(callback) {
    observerCallback = callback;
  }

  observe(element) {
    observed.push(element);
  }

  unobserve() {}
  disconnect() {}
};

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const createdUrls = [];
const revokedUrls = [];
URL.createObjectURL = (blob) => {
  const url = `blob:thumbnail-${createdUrls.length + 1}`;
  createdUrls.push({ blob, url });
  return url;
};
URL.revokeObjectURL = (url) => revokedUrls.push(url);

const blobRequests = [];
let failAttachmentId = null;
const deferredCacheReads = new Map();
function deferredCacheRead(id) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  deferredCacheReads.set(String(id), { promise, resolve });
  return promise;
}
const feature = createTodoAttachmentsFeature({
  getTodos: () => [],
  setTodos: () => {},
  getProjects: () => [],
  getCurrentUser: () => ({ id: 1 }),
  setCurrentUser: () => {},
  getAppInitialized: () => true,
  getDb: () => ({}),
  dbPut: async () => {},
  isOnlineForSync: () => true,
  todosApi: {
    async getAttachmentBlob(todoId, attachmentId) {
      blobRequests.push({ todoId, attachmentId });
      if (attachmentId === failAttachmentId) throw new Error('thumbnail unavailable');
      return new Blob(['image'], { type: 'image/png' });
    },
  },
  attachmentCache: {
    get: async id => deferredCacheReads.get(String(id))?.promise || null,
    put: async () => {},
  },
  renderStats: () => {},
  renderTodos: () => {},
  closeModal: (id) => elements.get(id)?.classList.remove('active'),
  confirmDanger: async () => false,
  showToast: () => {},
  t: (key) => key,
  iconSvg: (name) => `<svg data-icon="${name}"></svg>`,
  escapeHtmlAttr: (value) => String(value),
  setTodoCollapsibleOpen: () => {},
  refreshTodoActionButtonState: () => {},
  refreshTodoSaveButtonState: () => {},
});

const flushPromises = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

try {
  console.log('🖼️ Running todo attachment thumbnail test...');

  feature.renderTodoAttachments([
    {
      id: 11,
      user_id: 1,
      original_filename: 'photo.png',
      content_type: 'image/png',
      size_bytes: 2048,
      uploader_display_name: 'Owner',
    },
    {
      id: 12,
      user_id: 1,
      original_filename: 'notes.txt',
      content_type: 'text/plain',
      size_bytes: 512,
      uploader_display_name: 'Owner',
    },
  ], { id: 7, user_id: 1, project_id: 1 });

  const list = elements.get('todo-attachments-list');
  const imageItem = list.children[0];
  const fileItem = list.children[1];
  const thumbnail = findByClass(imageItem, 'todo-attachment-thumbnail');
  const fallback = findByClass(imageItem, 'todo-attachment-thumbnail-fallback');

  assert.ok(thumbnail, 'image attachments should render a thumbnail image in the details attachment list');
  assert.ok(fallback, 'image thumbnails should retain an icon fallback');
  assert.equal(thumbnail.loading, 'lazy', 'browser-native lazy loading should be enabled as a second guard');
  assert.equal(thumbnail.hidden, false, 'the observed thumbnail must participate in layout so IntersectionObserver can see it');
  assert.equal(blobRequests.length, 0, 'thumbnail bytes should not load before the thumbnail approaches the viewport');
  assert.equal(findByClass(fileItem, 'todo-attachment-thumbnail'), null, 'non-image attachments should keep the file representation');

  observerCallback([{ target: thumbnail, isIntersecting: true }]);
  await flushPromises();
  assert.deepEqual(blobRequests, [{ todoId: 7, attachmentId: 11 }]);
  assert.equal(thumbnail.src, 'blob:thumbnail-1');
  assert.equal(thumbnail.classList.contains('is-loaded'), false, 'the fallback should remain visible until the image decodes');
  thumbnail.dispatch('load');
  assert.equal(thumbnail.classList.contains('is-loaded'), true);
  assert.equal(fallback.classList.contains('is-hidden'), true, 'loaded thumbnails should remove the fallback from layout');

  failAttachmentId = 13;
  feature.renderTodoAttachments([{
    id: 13,
    user_id: 1,
    original_filename: 'broken.webp',
    content_type: 'image/webp',
    size_bytes: 1024,
    uploader_display_name: 'Owner',
  }], { id: 7, user_id: 1, project_id: 1 });

  assert.deepEqual(revokedUrls, ['blob:thumbnail-1'], 're-rendering should release thumbnail object URLs');
  const brokenItem = elements.get('todo-attachments-list').children[0];
  const brokenThumbnail = findByClass(brokenItem, 'todo-attachment-thumbnail');
  const brokenFallback = findByClass(brokenItem, 'todo-attachment-thumbnail-fallback');
  observerCallback([{ target: brokenThumbnail, isIntersecting: true }]);
  await flushPromises();
  assert.equal(brokenThumbnail.classList.contains('is-loaded'), false, 'failed thumbnail requests should keep the fallback visible');
  assert.equal(brokenFallback.classList.contains('is-hidden'), false, 'failed thumbnail requests should retain the file icon');

  deferredCacheRead(21);
  feature.renderTodoAttachments([{
    id: 21,
    user_id: 1,
    original_filename: 'slow.png',
    content_type: 'image/png',
    size_bytes: 4,
    uploader_display_name: 'Owner',
  }], { id: 7, user_id: 1, project_id: 1 });
  findByClass(elements.get('todo-attachments-list').children[0], 'todo-attachment-name').dispatch('click');
  feature.closeAttachmentPreview();
  deferredCacheReads.get('21').resolve({ blob: new Blob(['slow'], { type: 'image/png' }) });
  await flushPromises();
  assert.equal(elements.get('attachment-preview-modal').classList.contains('active'), false, 'closing during load must keep the preview closed');

  deferredCacheRead(22);
  deferredCacheRead(23);
  feature.renderTodoAttachments([
    { id: 22, user_id: 1, original_filename: 'first.png', content_type: 'image/png', size_bytes: 5, uploader_display_name: 'Owner' },
    { id: 23, user_id: 1, original_filename: 'second.png', content_type: 'image/png', size_bytes: 6, uploader_display_name: 'Owner' },
  ], { id: 7, user_id: 1, project_id: 1 });
  const previewList = elements.get('todo-attachments-list');
  findByClass(previewList.children[0], 'todo-attachment-name').dispatch('click');
  findByClass(previewList.children[1], 'todo-attachment-name').dispatch('click');
  deferredCacheReads.get('23').resolve({ blob: new Blob(['second'], { type: 'image/png' }) });
  await flushPromises();
  const winningPreviewHtml = elements.get('attachment-preview-body').innerHTML;
  deferredCacheReads.get('22').resolve({ blob: new Blob(['first'], { type: 'image/png' }) });
  await flushPromises();
  assert.equal(elements.get('attachment-preview-title').textContent, 'second.png', 'the second preview request must win');
  assert.equal(elements.get('attachment-preview-body').innerHTML, winningPreviewHtml, 'a stale first preview must not replace the second preview');
  feature.closeAttachmentPreview();
  assert.ok(revokedUrls.includes(createdUrls.at(-1).url), 'closing the winning preview must revoke its object URL');

  console.log('✅ Todo attachment thumbnails are lazy, accessible, and resilient');
} finally {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  delete globalThis.IntersectionObserver;
  delete globalThis.document;
}

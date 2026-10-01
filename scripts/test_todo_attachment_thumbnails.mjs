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
  renderStats: () => {},
  renderTodos: () => {},
  closeModal: () => {},
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

  console.log('✅ Todo attachment thumbnails are lazy, accessible, and resilient');
} finally {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  delete globalThis.IntersectionObserver;
  delete globalThis.document;
}

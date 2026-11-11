import { renderQuickAddPreview } from './quick-add.js';
export const MAX_MULTI_ITEMS = 50;
export function syncMultiAddNativeFields(fields, multi, fieldStates) {
  if (multi) for (const field of fields) {
   if (!fieldStates.has(field)) fieldStates.set(field,{required:field.required,disabled:field.disabled});
   field.required=false; field.disabled=true;
  }
  else { for (const [field,state] of fieldStates) Object.assign(field,state); fieldStates.clear(); }
 }

export function stripMultiAddPrefix(value) { return String(value || '').replace(/^\s*(?:(?:[-*•])\s+|(?:\d+[.)])\s+)/u, '').trim(); }
export function splitMultiAddPaste(text, availableRows) {
 const values = String(text || '').split(/\r?\n/).map(stripMultiAddPrefix).filter(Boolean);
 const limit = Math.max(0, Number(availableRows) || 0);
 return {values: values.slice(0, limit), omittedCount: Math.max(0, values.length-limit)};
}
export function getMultiAddRowA11y(prefix, rowId, number, translate) {
 return {inputId: `${prefix}-multi-add-input-${rowId}`, previewId: `${prefix}-multi-add-preview-${rowId}`, messageId: `${prefix}-multi-add-message-${rowId}`, inputLabel: translate('capture.multiAdd.rowLabel',{number}), removeLabel: translate('capture.multiAdd.removeRow',{number})};
}
export function renderMultiAddModeSwitch({prefix, singleKey, multipleKey}) { return `<div class="ui-multi-add-mode-switch" id="${prefix}-create-mode-switch" role="group" aria-label="Capture mode" data-i18n-aria-label-key="capture.multiAdd.modeLabel" hidden><button type="button" class="ui-multi-add-mode-btn active" data-multi-add-mode="single" aria-pressed="true" data-i18n-key="${singleKey}">Single</button><button type="button" class="ui-multi-add-mode-btn" data-multi-add-mode="multi" aria-pressed="false" data-i18n-key="${multipleKey}">Multiple</button></div>`; }
export function renderMultiAddPanel({prefix, quickAddHintKey, defaultsHtml = '', defaultsColumns = 3}) { return `        <section class="ui-multi-add-panel" id="${prefix}-multi-add-panel" hidden>
          <div class="ui-multi-add-intro">
            <div class="ui-multi-add-intro-heading ui-section-heading ui-detail-section-heading">
              <div class="ui-multi-add-intro-icon ui-section-icon ui-detail-section-icon" data-icon="lightbulb" aria-hidden="true"></div>
              <div>
                <h4 data-i18n-key="capture.multiAdd.introTitle">Capture thoughts quickly</h4>
                <p data-i18n-key="capture.multiAdd.introDescription">Press Enter to start the next line. Pasted bullet lists are split automatically.</p>
              </div>
            </div>
            <div class="ui-multi-add-counter" aria-live="polite">
              <strong id="${prefix}-multi-add-count">0</strong>
              <span id="${prefix}-multi-add-limit">50 lines available</span>
            </div>
          </div>
          <div class="ui-multi-add-editor">
            <div class="ui-multi-add-rows" id="${prefix}-multi-add-rows"></div>
            <div class="ui-multi-add-toolbar">
              <span class="ui-multi-add-toolbar-hint" data-i18n-key="${quickAddHintKey}">Quick Add works per line.</span>
              <button type="button" class="btn btn-secondary" id="${prefix}-multi-add-more"><span data-icon="plus"></span> <span data-i18n-key="capture.multiAdd.addRow">Add another line</span></button>
            </div>
          </div>
          <section class="ui-multi-add-defaults ui-section-divider">
            <div class="ui-multi-add-defaults-head ui-section-heading ui-detail-section-heading">
              <div class="ui-multi-add-defaults-icon ui-section-icon ui-detail-section-icon" data-icon="sliders-horizontal"></div>
              <div>
                <h4 data-i18n-key="capture.multiAdd.defaultsTitle">Apply to all lines</h4>
                <p data-i18n-key="capture.multiAdd.defaultsDescription">Values entered directly in a line override these defaults.</p>
              </div>
            </div>
            <div class="ui-multi-add-defaults-grid" style="--multi-add-default-columns: ${defaultsColumns === 2 ? 2 : 3}">${defaultsHtml}</div>
          </section>
        </section>
`; }

/** Neutral capture renderer/controller (no modal/history or persistence ownership).
 *
 * Required: prefix, t, copy, parse(raw, defaults, context), onSave(results, meta).
 * parse returns { title, matches?, ...domainData }; domainData stays opaque.
 * validate(result, {defaults, context}) returns a translation key or null.
 * copy contains whole translation keys: count/create (plural key bases),
 * title/subtitle (multi), singleTitle/singleSubtitle, and optional save.
 * readDefaults/getContext return JSON-serializable snapshots (defaults: {}, context: null).
 * onSave receives {isCurrent, defaults, context}; check isCurrent again inside
 * the domain commit lock. Return false/null to abort without onSaved(result).
 * onSaved only runs while this session/context/row snapshot is still current.
 * onModeChange('single'|'multi') handles only domain layout/default selectors.
 * getSingleFields returns an iterable of native single-editor fields; required
 * and disabled states are suppressed in multi and restored exactly on exit.
 * Optional: document, root (element or getter), onError(error), showToast(text).
 *
 * All lookups are root-scoped. Default root: `${prefix}-modal`, with .active
 * while open. Renderer IDs: `${prefix}-create-mode-switch`, plus
 * `${prefix}-multi-add-{panel,rows,more,count,limit}`. Host supplies
 * `${prefix}-{form,save-btn,modal-title,modal-subtitle}` (header nodes optional).
 * Host form submit calls save(); Ctrl/Meta+Enter uses that same requestSubmit.
 * bind may run before mounting; reset({editing}) binds once the host exists.
 * Reset on each new open to invalidate outstanding work. setMode preserves rows;
 * refresh reparses changed defaults;
 * destroy invalidates work and removes listeners without closing the host modal.
 */
export function createMultiAddFeature({prefix, root, document: doc = globalThis.document, t,
 copy, parse, readDefaults = () => ({}), getContext = () => null,
 validate = () => null, onSave, onSaved = () => {}, onModeChange = () => {},
 getSingleFields = () => [], onError = error => console.error(error), showToast = () => {}}) {
 const modal = () => typeof root === 'function' ? root() : root || doc.getElementById(`${prefix}-modal`);
 const element = suffix => modal()?.querySelector(`[id="${prefix}-${suffix}"]`);
 const panel = () => element('multi-add-panel');
 const rowsContainer = () => element('multi-add-rows');
 const saveButton = () => element('save-btn');
 const titleElement = () => element('modal-title');
 const subtitleElement = () => element('modal-subtitle');
 const fingerprint = value => JSON.stringify(value);
 const stripListPrefix = stripMultiAddPrefix;
 let bound = false, rowSequence = 0, parseSequence = 0, lifecycleGeneration = 0;
 let saveInFlight = null, editing = false;
 const fieldStates = new Map(), listeners = [];
 const isActive = () => Boolean(modal()?.classList.contains('active') && modal()?.classList.contains('ui-multi-add-mode'));
 function listen(target, type, handler) { if (!target) return; target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type,handler)); }
  function rowElements() {
    return Array.from(rowsContainer()?.querySelectorAll('.ui-multi-add-row') || []);
  }

  function inputForRow(row) {
    return row?.querySelector('.ui-multi-add-input') || null;
  }

  function refreshRowAccessibility() {
    rowElements().forEach((row, index) => {
      const input = inputForRow(row);
      const preview = row.querySelector('.ui-multi-add-preview');
      const message = row.querySelector('.ui-multi-add-row-message');
      const remove = row.querySelector('.ui-multi-add-remove');
      const metadata = getMultiAddRowA11y(prefix, row.dataset.rowId, index + 1, t);
      if (input) {
        input.id = metadata.inputId;
        input.setAttribute('aria-label', metadata.inputLabel);
        input.setAttribute('aria-describedby', `${metadata.previewId} ${metadata.messageId}`);
        if (!input.hasAttribute('aria-invalid')) input.setAttribute('aria-invalid', 'false');
      }
      if (preview) preview.id = metadata.previewId;
      if (message) message.id = metadata.messageId;
      if (remove) {
        remove.setAttribute('aria-label', metadata.removeLabel);
        remove.setAttribute('title', metadata.removeLabel);
      }
    });
  }

  function normalizedRows() {
    return rowElements().map((row) => ({
      row,
      input: inputForRow(row),
      raw: stripListPrefix(inputForRow(row)?.value || ''),
    }));
  }

  function createRow(value = '', { focus = false, after = null } = {}) {
    const container = rowsContainer();
    if (!container || rowElements().length >= MAX_MULTI_ITEMS) return null;
    const row = doc.createElement('div');
    row.className = 'ui-multi-add-row';
    row.dataset.rowId = String(++rowSequence);
    row.innerHTML = `
      <span class="ui-multi-add-bullet" aria-hidden="true"></span>
      <div class="ui-multi-add-field">
        <input class="ui-field ui-multi-add-input" type="text" maxlength="620" autocomplete="off" aria-invalid="false">
        <div class="ui-multi-add-preview" aria-live="polite"></div>
        <div class="ui-multi-add-row-message" aria-live="polite"></div>
      </div>
      <button type="button" class="ui-multi-add-remove">×</button>
    `;
    const input = inputForRow(row);
    input.value = stripListPrefix(value);
    if (after?.parentElement === container) after.after(row);
    else container.appendChild(row);
    refreshRowAccessibility();
    window.hydrateIcons?.(row);
    scheduleRowParse(row);
    updateState();
    if (focus) window.requestAnimationFrame(() => { if (isActive() && row.isConnected) input.focus(); });
    return row;
  }

  function removeRow(row) {
    const rows = rowElements();
    if (rows.length === 1) {
      const input = inputForRow(row);
      if (input) input.value = '';
      scheduleRowParse(row);
      input?.focus();
      return;
    }
    const index = rows.indexOf(row);
    const nextFocus = inputForRow(rows[index - 1] || rows[index + 1]);
    row.remove();
    refreshRowAccessibility();
    nextFocus?.focus();
    updateState();
  }

  function reserveRowParse(row) {
    const sequence = ++parseSequence;
    row.dataset.parseSequence = String(sequence);
    return sequence;
  }

  async function parseRow(row, reservedSequence = null) {
    const input = inputForRow(row);
    const preview = row.querySelector('.ui-multi-add-preview');
    const message = row.querySelector('.ui-multi-add-row-message');
    if (!input || !preview || !message) return false;
    if (reservedSequence === null) {
      window.clearTimeout(row._multiParseTimer);
      row._multiParseTimer = null;
    }
    const sequence = reservedSequence ?? reserveRowParse(row);
    if (row.dataset.parseSequence !== String(sequence)) return false;
    const raw = stripListPrefix(input.value);
    if (!raw) {
      message.textContent = '';
      row.classList.remove('is-invalid');
      input.setAttribute('aria-invalid', 'false');
      preview.replaceChildren();
      row._multiParsed = null;
      updateState();
      return true;
    }
    if (raw.length > 500) {
      message.textContent = '';
      row.classList.remove('is-invalid');
      input.setAttribute('aria-invalid', 'false');
      preview.replaceChildren();
      row._multiParsed = null;
      row.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      message.textContent = t('capture.multiAdd.tooLong', { count: raw.length - 500 });
      updateState();
      return true;
    }
    const generation = lifecycleGeneration;
    const defaults = readDefaults();
    const context = getContext();
    const defaultsKey = fingerprint(defaults), contextKey = fingerprint(context);
    const result = await parse(raw, defaults, context);
    if (generation !== lifecycleGeneration || !isActive() || !row.isConnected || defaultsKey !== fingerprint(readDefaults()) || contextKey !== fingerprint(getContext())) return false;
    if (row.dataset.parseSequence !== String(sequence) || stripListPrefix(input.value) !== raw) return false;
    message.textContent = '';
    row.classList.remove('is-invalid');
    input.setAttribute('aria-invalid', 'false');
    row._multiParsed = result;
    const validationKey = validate(result, { defaults, context });
    if (validationKey) {
      row.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      message.textContent = t(validationKey);
    }
    renderQuickAddPreview(preview, result, t);
    updateState();
    return true;
  }

  function scheduleRowParse(row) {
    window.clearTimeout(row._multiParseTimer);
    const sequence = reserveRowParse(row);
    const generation = lifecycleGeneration;
    row._multiParseTimer = window.setTimeout(() => {
      row._multiParseTimer = null;
      if (generation !== lifecycleGeneration || !isActive() || !row.isConnected) return;
      const defaultsKey = fingerprint(readDefaults()), contextKey = fingerprint(getContext());
      void parseRow(row, sequence).catch(error => {
        if (generation === lifecycleGeneration && isActive() && row.dataset.parseSequence === String(sequence)
          && defaultsKey === fingerprint(readDefaults()) && contextKey === fingerprint(getContext())) onError(error);
      });
    }, 90);
  }

  function updateState() {
    const rows = normalizedRows();
    const nonEmpty = rows.filter(item => item.raw);
    const duplicateCounts = new Map();
    nonEmpty.forEach(item => {
      const key = item.raw.toLocaleLowerCase();
      duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
    });
    rows.forEach(({ row, raw }) => {
      const duplicate = raw && duplicateCounts.get(raw.toLocaleLowerCase()) > 1;
      row.classList.toggle('is-duplicate', Boolean(duplicate));
      if (duplicate && !row.classList.contains('is-invalid')) {
        row.querySelector('.ui-multi-add-row-message').textContent = t('capture.multiAdd.duplicate');
      } else if (!duplicate && !row.classList.contains('is-invalid')) {
        row.querySelector('.ui-multi-add-row-message').textContent = '';
      }
    });
    const count = nonEmpty.length;
    const overLimit = count > MAX_MULTI_ITEMS;
    const hasKnownInvalidRow = nonEmpty.some(({ row }) => (
      row.classList.contains('is-invalid')
      || (row._multiParsed && !row._multiParsed.title?.trim())
    ));
    const countElement = element('multi-add-count');
    if (countElement) countElement.textContent = t(`${copy.count}.${count === 1 ? 'one' : 'many'}`, { count });
    const limitElement = element('multi-add-limit');
    const remaining = MAX_MULTI_ITEMS - rows.length;
    if (limitElement) {
      limitElement.textContent = overLimit
        ? t('capture.multiAdd.limit', { max: MAX_MULTI_ITEMS })
        : t(`capture.multiAdd.remaining.${remaining === 1 ? 'one' : 'many'}`, { count: remaining });
    }
    const save = saveButton();
    if (save && isActive()) {
      save.hidden = count === 0;
      save.disabled = Boolean(saveInFlight) || count === 0 || overLimit || hasKnownInvalidRow;
      save.textContent = t(`${copy.create}.${count === 1 ? 'one' : 'many'}`, { count });
    }
    const more = element('multi-add-more');
    if (more) more.disabled = rowElements().length >= MAX_MULTI_ITEMS;
  }


 function syncNativeFields(multi) { syncMultiAddNativeFields(getSingleFields(),multi,fieldStates); }
 function updateHeader(multi) {
  if (editing) return;
  const title=titleElement(),subtitle=subtitleElement();
  for (const [element, key] of [[title, multi ? copy.title : copy.singleTitle], [subtitle, multi ? copy.subtitle : copy.singleSubtitle]]) {
   if (element && key) {element.dataset.i18nKey=key;element.textContent=t(key);}
  }
 }
 function setMode(mode, {focus = true} = {}) {
  const multi=mode==='multi' && !editing;
  if(saveInFlight) return;
  modal()?.classList.toggle('ui-multi-add-mode',multi);
  syncNativeFields(multi);
  panel()?.toggleAttribute('hidden',!multi);
  modal()?.querySelectorAll('[data-multi-add-mode]').forEach(button=>{
   const active=button.dataset.multiAddMode===(multi?'multi':'single');
   button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  updateHeader(multi);
  const save=saveButton();
  if(save && !multi) {save.hidden=false;save.disabled=false;save.textContent=t(copy.save || 'common.save');}
  onModeChange(multi?'multi':'single');
  if (!multi && focus && !editing) Array.from(getSingleFields()).find(field => !field.disabled && field.type !== 'hidden')?.focus();
  if(multi) {
   if(!rowElements().length) createRow('',{focus:true});
   else {inputForRow(rowElements()[0])?.focus();refresh();}
  }
  updateState();
 }
 function busy(active) {
  panel()?.toggleAttribute('inert',active);
  if (active) modal()?.setAttribute('aria-busy','true');
  else modal()?.removeAttribute('aria-busy');
  modal()?.querySelectorAll('[data-multi-add-mode]').forEach(b=>b.disabled=active);
  if(active && saveButton()) saveButton().disabled=true;
 }
 function reset({editing: nextEditing=false}={}) {
  bind();
  lifecycleGeneration++;saveInFlight=null;busy(false);editing=nextEditing;
  rowElements().forEach(row=>window.clearTimeout(row._multiParseTimer));
  rowsContainer()?.replaceChildren();
  const switcher=element('create-mode-switch');if(switcher) switcher.hidden=editing;
  setMode('single', {focus:false});
  if(!editing) createRow();
 }
 function refresh() {rowElements().forEach(scheduleRowParse);refreshRowAccessibility();updateHeader(isActive());updateState();}
 function handlePaste(event,row) {
  const text=event.clipboardData?.getData('text/plain') || '';
  if(!/[\r\n]/.test(text)) return;
  event.preventDefault();
  const {values,omittedCount}=splitMultiAddPaste(text,MAX_MULTI_ITEMS-rowElements().length+1);
  if(!values.length) return;
  inputForRow(row).value=values[0];scheduleRowParse(row);
  let current=row;
  for(const value of values.slice(1)) current=createRow(value,{after:current}) || current;
  if(omittedCount) showToast(t(`capture.multiAdd.pasteOmitted.${omittedCount===1?'one':'many'}`,{count:omittedCount,max:MAX_MULTI_ITEMS}));
  inputForRow(current)?.focus();updateState();
 }
 function bind() {
  if(bound || !modal()) return;bound=true;
  listen(element('create-mode-switch'),'click',event=>{const b=event.target.closest('[data-multi-add-mode]');if(b)setMode(b.dataset.multiAddMode);});
  listen(element('multi-add-more'),'click',()=>{if(isActive()&&!saveInFlight)createRow('',{focus:true});});
  listen(panel(),'change',event=>{if(!rowsContainer()?.contains(event.target))refresh();});
  listen(rowsContainer(),'input',event=>{
   const input=event.target.closest('.ui-multi-add-input');if(!input || saveInFlight)return;
   scheduleRowParse(input.closest('.ui-multi-add-row'));updateState();
  });
  listen(rowsContainer(),'paste',event=>{const row=event.target.closest('.ui-multi-add-row');if(row&&!saveInFlight)handlePaste(event,row);});
  listen(rowsContainer(),'click',event=>{const b=event.target.closest('.ui-multi-add-remove');if(b&&!saveInFlight)removeRow(b.closest('.ui-multi-add-row'));});
  listen(rowsContainer(),'keydown',event=>{
   if(event.defaultPrevented || event.isComposing || event.keyCode===229) return;
   const input=event.target.closest('.ui-multi-add-input');if(!input || saveInFlight)return;
   const row=input.closest('.ui-multi-add-row');
   if(event.key==='Enter' && !event.ctrlKey&&!event.metaKey) {event.preventDefault();createRow('',{focus:true,after:row});}
   else if(event.key==='Backspace'&&!input.value) {event.preventDefault();removeRow(row);}
   else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)) {event.preventDefault();element('form')?.requestSubmit();}
  });
  listen(window,'nia-language-change',()=>{refreshRowAccessibility();updateHeader(isActive());updateState();});
 }
 function save() {
  if(saveInFlight) return saveInFlight;
  if(!isActive()) return Promise.resolve(false);
  const generation=lifecycleGeneration;
  const rows=normalizedRows().filter(item=>item.raw);
  if(!rows.length) return Promise.resolve(true);
  const defaults=readDefaults(),context=getContext();
  const defaultsKey=fingerprint(defaults),contextKey=fingerprint(context);
  const snapshot=()=> generation===lifecycleGeneration && isActive()
   && defaultsKey===fingerprint(readDefaults()) && contextKey===fingerprint(getContext())
   && fingerprint(rows.map(({row,raw})=>[row.dataset.rowId,raw]))===fingerprint(normalizedRows().filter(item=>item.raw).map(({row,raw})=>[row.dataset.rowId,raw]));
  busy(true);
  const pending=(async()=>{
   const applied=await Promise.all(rows.map(({row})=>parseRow(row)));
   if(!snapshot()||applied.some(ok=>!ok)) return true;
   if(rows.some(({row})=>row.classList.contains('is-invalid')||!row._multiParsed?.title?.trim()))return true;
   const result=await onSave(rows.map(({row})=>row._multiParsed),{isCurrent:snapshot,defaults,context});
   if(result!==false && result!=null && snapshot()) await onSaved(result);
   return true;
  })().catch(error=>{if(snapshot())onError(error);return true;}).finally(()=>{
   if(saveInFlight!==pending)return;saveInFlight=null;busy(false);if(isActive())updateState();
  });
  saveInFlight=pending;return pending;
 }
 function destroy() {reset({editing:true});listeners.splice(0).forEach(remove=>remove());bound=false;}
 return {bind,reset,setMode,isActive,save,refresh,destroy};
}

import { createMultiAddFeature, splitMultiAddPaste, getMultiAddRowA11y, syncMultiAddNativeFields } from './multi-add.js';
import { resolveKnownTodoTargets } from './todo-targets.js';
// Compatibility exports; all row/mode/parse/save orchestration lives in multi-add.js.
const legacyNativeStates = new Map();
export function syncMultiAddNativeValidation(multi) {
 const input=document.getElementById('todo-title');
 syncMultiAddNativeFields(input ? [input] : [],multi,legacyNativeStates);
}
export const splitMultiTodoPaste = splitMultiAddPaste;
export const getMultiTodoRowA11y = (rowId,number,t) => getMultiAddRowA11y('todo',rowId,number,t);
export function getMultiTodoValidationKey(todoData) {
  return todoData?.recurring_rule && !todoData?.due_date
    ? 'todo.multiAdd.recurringNeedsDue'
    : null;
}

export function shouldOpenCreateTodoMetaDrawer(mediaQueryList) {
  return !mediaQueryList?.matches;
}

export function createTodoMultiAddFeature({
  t,
  getTodos,
  setTodos,
  getProjects = () => [],
  getSections = () => [],
  getCurrentProjectId,
  getCurrentWorkspaceId = () => null,
  routingMemory = null,
  getAppInitialized,
  getDb,
  dbPut,
  addToSyncQueue,
  runSyncQueueMutation,
  isOnlineForSync,
  syncWithServer,
  parseQuickAddTitle,
  loadSectionsForQuickAdd,
  hydrateSelect,
  refreshSelect,
  renderProjects,
  renderStats,
  renderTodos,
  closeModal,
  showToast,
}) {
  const commitQueuedMutation = runSyncQueueMutation || (operation => operation(addToSyncQueue));
  let optionsGeneration=0;
  let projectExplicit = false, sectionExplicit = false;
  let saving = false, memoryRefreshPending = false, saveOperation = null;
  function syncProjectOptions() {
    const source = document.getElementById('todo-project');
    const target = document.getElementById('todo-multi-project');
    if (!source || !target) return;
    const selected = target.value || source.value || String(getCurrentProjectId?.() || '');
    target.innerHTML = source.innerHTML;
    target.value = selected;
    hydrateSelect(target, {
      className: 'project-ui-select todo-multi-ui-select',
      menuClassName: 'project-ui-select-menu todo-multi-ui-select-menu',
      searchPlaceholder: t('focus.projects.search'),
      searchLabel: t('focus.projects.search'),
      emptyText: t('focus.projects.noMatches'),
    });
    refreshSelect(target);
  }

  async function syncSectionOptions() {
    const generation = optionsGeneration;
    const projectId = document.getElementById('todo-multi-project')?.value || '';
    const select = document.getElementById('todo-multi-section');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = `<option value="">${t('todo.section.none')}</option>`;
    const sections = await loadSectionsForQuickAdd();
    if (generation !== optionsGeneration || projectId !== (document.getElementById('todo-multi-project')?.value || '')) return;
    sections
      .filter(section => String(section.project_id) === String(projectId))
      .forEach((section) => {
        const option = document.createElement('option');
        option.value = String(section.id);
        option.textContent = section.name;
        select.appendChild(option);
      });
    select.disabled = !projectId;
    if (previous && Array.from(select.options).some(option => option.value === previous)) select.value = previous;
    hydrateSelect(select, { className: 'todo-multi-ui-select', menuClassName: 'todo-multi-ui-select-menu' });
    refreshSelect(select);
  }


  const feature = createMultiAddFeature({
    prefix:'todo',t,showToast,
    copy:{count:'todo.multiAdd.count',create:'todo.multiAdd.create',title:'todo.multiAdd.title',subtitle:'todo.multiAdd.subtitle',singleTitle:'todo.new',singleSubtitle:'todo.modal.subtitle'},
    readDefaults:()=>({projectId:document.getElementById('todo-multi-project')?.value || '',sectionId:document.getElementById('todo-multi-section')?.value || '',priority:Number(document.getElementById('todo-multi-priority')?.value || 3),projectExplicit,sectionExplicit}),
    getContext:()=>({projectId:getCurrentProjectId(),workspaceId:getCurrentWorkspaceId()}),
    getSingleFields:()=>Array.from(document.querySelectorAll('#todo-form .todo-editor-section input, #todo-form .todo-editor-section textarea, #todo-form .todo-editor-section select')),
    parse:(raw,defaults,context)=>parseQuickAddTitle(raw,context.projectId,defaults.projectId || null,{
      projectExplicit:defaults.projectExplicit,sectionExplicit:defaults.sectionExplicit,sectionId:defaults.sectionId,syntaxOverridesDefaults:true,
      routingSnapshot:saveOperation?.routingSnapshot,
    }),
    validate:result=>getMultiTodoValidationKey(result.changes || {}),
    onModeChange:mode=>{
      const root=document.getElementById('todo-modal');
      root?.classList.toggle('todo-multi-add-mode',mode==='multi');
      root?.classList.toggle('todo-meta-editing',mode!=='multi' && shouldOpenCreateTodoMetaDrawer(window.matchMedia?.('(max-width: 1180px)')));
      if(mode==='multi') {
        syncProjectOptions();void syncSectionOptions();
        const priority=document.getElementById('todo-multi-priority');
        if(priority){hydrateSelect(priority,{className:'todo-multi-ui-select',menuClassName:'todo-multi-ui-select-menu'});refreshSelect(priority);}
      } else {
        const title=document.getElementById('todo-title');title?.dispatchEvent(new Event('input',{bubbles:true}));
      }
    },
    onSave:async(results,{isCurrent,defaults})=>{
      if(!getAppInitialized()||!getDb())return false;
      const routingSnapshot=saveOperation?.routingSnapshot || routingMemory;
      const {projectId,sectionId,priority}=defaults;
      const sections=await loadSectionsForQuickAdd();
      if(!isCurrent())return false;
      const prepared=[];
      for(const parsed of results) {
      const todoData = {
        title: parsed.title,
        description: '',
        priority,
        is_pinned: false,
        project_id: projectId || null,
        section_id: sectionId || null,
        status: 'pending',
        subtasks: [],
        due_date: null,
        remind_at: null,
        recurring_rule: null,
        location_reminder: null,
        location_reminders: [],
      };
      if (parsed.changes.priority) todoData.priority = parsed.changes.priority;
      if (Object.hasOwn(parsed.changes, 'project_id')) todoData.project_id = parsed.changes.project_id;
      if (Object.hasOwn(parsed.changes, 'section_id')) todoData.section_id = parsed.changes.section_id;
      if (parsed.changes.due_date) todoData.due_date = parsed.changes.due_date;
      if (parsed.changes.remind_at) todoData.remind_at = parsed.changes.remind_at;
      if (parsed.changes.recurring_rule) todoData.recurring_rule = parsed.changes.recurring_rule;
      if (parsed.changes.location_reminder) todoData.location_reminder = parsed.changes.location_reminder;
      const targets = resolveKnownTodoTargets({ projectId: todoData.project_id, sectionId: todoData.section_id,
        projects: getProjects(), sections,
        inheritedSectionProjectId: parsed.changes.project_id && !parsed.changes.section_id ? projectId : undefined });
      if (!targets) return false;
      Object.assign(todoData, targets);
      todoData.location_reminders = todoData.location_reminder ? [todoData.location_reminder] : [];
      if(getMultiTodoValidationKey(todoData))return false;
      const fields = new Set(parsed.routing_fields || []);
      if (!(parsed.memory_fields || []).includes('list') && getCurrentProjectId() != null
        && String(todoData.project_id) === String(getCurrentProjectId())) fields.add('list');
      prepared.push({ todoData, routingFeedback: routingSnapshot?.feedback([...fields]) });
      }
    const now = Date.now();
    const created = [];
    let commitAborted = false;
    await commitQueuedMutation(async enqueue => {
      const liveSections = prepared.some(({todoData}) => todoData.section_id != null)
        ? await loadSectionsForQuickAdd()
        : [];
      if (!isCurrent()) {
        commitAborted = true;
        return;
      }
      const liveProjects = getProjects();
      const invalidParent = prepared.some(({todoData}) => {
        if (todoData.project_id != null
          && !liveProjects.some(project => String(project.id) === String(todoData.project_id))) return true;
        if (todoData.section_id == null) return false;
        const section = liveSections.find(candidate => String(candidate.id) === String(todoData.section_id));
        return !section || String(section.project_id) !== String(todoData.project_id);
      });
      if (invalidParent) {
        commitAborted = true;
        return;
      }
      for (const [index, {todoData,routingFeedback}] of prepared.entries()) {
        const tempId = `temp-${now}-${index}`;
        const nowIso = new Date(now + index).toISOString();
        const newTodo = { id: tempId, ...todoData, completed_at: null, created_at: nowIso, updated_at: nowIso, reminders: [], subtasks: [] };
        await dbPut('todos', newTodo);
        await enqueue('CREATE_TODO', { ...todoData, _tempId: tempId, ...(routingFeedback ? {routing_feedback:routingFeedback} : {}) });
        created.push(newTodo);
      }
      setTodos([...getTodos(), ...created]);
    });
    if (commitAborted) {
      return false;
    }
      renderProjects();renderStats();renderTodos();
      return created;
    },
    onSaved:async created=>{
      closeModal('todo-modal');
      showToast(t(`todo.multiAdd.created.${created.length===1?'one':'many'}`,{count:created.length}));
      if(isOnlineForSync()){await syncWithServer();renderProjects();renderStats();renderTodos();}
    },
  });
  let domainBound=false;
  return {...feature,
    bind(){feature.bind();if(domainBound)return;domainBound=true;document.getElementById('todo-multi-project')?.addEventListener('change',()=>{projectExplicit=true;sectionExplicit=false;void syncSectionOptions().then(()=>feature.refresh());});
      document.getElementById('todo-multi-section')?.addEventListener('change',()=>{sectionExplicit=true;feature.refresh();});
      globalThis.window?.addEventListener('nia-routing-memory-changed',()=>{if(!feature.isActive())return;if(saving)memoryRefreshPending=true;else feature.refresh();});},
    save(){
      if(saveOperation)return saveOperation.promise;
      const operation={routingSnapshot:routingMemory?.capture?.() || routingMemory,promise:null};
      saveOperation=operation;saving=true;
      operation.promise=Promise.resolve().then(()=>{
        if(saveOperation!==operation)return false;
        return feature.save();
      }).finally(()=>{
        // A canceled save may settle after a new modal/save has started.
        if(saveOperation!==operation)return;
        saveOperation=null;saving=false;
        if(memoryRefreshPending){memoryRefreshPending=false;if(feature.isActive())feature.refresh();}
      });
      return operation.promise;
    },
    reset(options){optionsGeneration++;projectExplicit=false;sectionExplicit=false;saveOperation=null;saving=false;memoryRefreshPending=false;feature.reset(options);},
  };
}

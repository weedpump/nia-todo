function queueTodoId(item) {
  if (!item?.data || typeof item.data !== 'object') return null;
  if (['CREATE_TODO'].includes(item.action)) return item.data._tempId ?? null;
  if (['UPDATE_TODO', 'DELETE_TODO'].includes(item.action)) return item.data.id ?? null;
  if (['CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK'].includes(item.action)) {
    return item.data.todo_id ?? null;
  }
  return null;
}

export function hasPendingTodoChanges(queue, todoId) {
  return queue.some(item => String(queueTodoId(item)) === String(todoId));
}

export function queueItemReferencesTodo(item, todoId) {
  return String(queueTodoId(item)) === String(todoId);
}

export async function beginSyncQueueWrite(syncRef) {
  if (!syncRef) return () => {};
  while (true) {
    while (syncRef.commitLocked) await syncRef.commitGate;
    syncRef.pendingQueueWrites = Number(syncRef.pendingQueueWrites || 0) + 1;
    if (!syncRef.commitLocked) break;
    syncRef.pendingQueueWrites -= 1;
  }
  return () => {
    syncRef.pendingQueueWrites = Math.max(0, Number(syncRef.pendingQueueWrites || 0) - 1);
  };
}

export async function acquireSyncCommitLock(syncRef) {
  if (!syncRef) return () => {};
  while (syncRef.commitLocked) await syncRef.commitGate;
  let releaseGate;
  syncRef.commitLocked = true;
  syncRef.commitGate = new Promise(resolve => { releaseGate = resolve; });
  while (Number(syncRef.pendingQueueWrites || 0) > 0) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return () => {
    syncRef.commitLocked = false;
    syncRef.commitGate = null;
    releaseGate();
  };
}

export function projectPendingTodoChanges(todo, pendingItems) {
  if (!todo) return null;
  let projected = {
    ...todo,
    comments: Array.isArray(todo.comments) ? [...todo.comments] : [],
    subtasks: Array.isArray(todo.subtasks) ? [...todo.subtasks] : [],
  };

  for (const item of pendingItems) {
    if (!item || typeof item.action !== 'string') continue;
    if (String(queueTodoId(item)) !== String(projected.id)) continue;

    if (item.action === 'DELETE_TODO') return null;
    if (item.action === 'UPDATE_TODO') {
      projected = { ...projected, ...(item.data?.changes || {}) };
    } else if (item.action === 'CREATE_COMMENT') {
      const comment = item.data?.local_comment;
      if (comment && !projected.comments.some(existing => String(existing.id) === String(comment.id))) {
        projected.comments.push(comment);
      }
    } else if (item.action === 'UPDATE_COMMENT') {
      projected.comments = projected.comments.map(comment => (
        String(comment.id) === String(item.data?.comment_id)
          ? { ...comment, ...(item.data?.changes || {}) }
          : comment
      ));
    } else if (item.action === 'DELETE_COMMENT') {
      projected.comments = projected.comments.filter(comment => String(comment.id) !== String(item.data?.comment_id));
    } else if (item.action === 'CREATE_SUBTASK') {
      const subtask = item.data?.local_subtask;
      if (subtask && !projected.subtasks.some(existing => String(existing.id) === String(subtask.id))) {
        projected.subtasks.push(subtask);
      }
    } else if (item.action === 'UPDATE_SUBTASK') {
      projected.subtasks = projected.subtasks.map(subtask => (
        String(subtask.id) === String(item.data?.subtask_id)
          ? { ...subtask, ...(item.data?.changes || {}) }
          : subtask
      ));
    } else if (item.action === 'DELETE_SUBTASK') {
      projected.subtasks = projected.subtasks.filter(subtask => String(subtask.id) !== String(item.data?.subtask_id));
    }
  }

  projected.comments_count = projected.comments.length;
  projected.subtasks.sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || String(a.id).localeCompare(String(b.id)));
  return projected;
}

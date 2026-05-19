export function createUiShell({ renderMarkdown, showTodoModal }) {
  function toggleSidebar() {
    document.getElementById('sidebar')?.classList.toggle('open');
    document.getElementById('sidebar-overlay')?.classList.toggle('active');
  }

  function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('active');
  }

  function closeModal(modalId) {
    document.getElementById(modalId)?.classList.remove('active');
  }

  function setupDescPreview() {
    const textarea = document.getElementById('todo-desc');
    const preview = document.getElementById('todo-desc-preview');
    if (!textarea || !preview) return;
    preview.innerHTML = renderMarkdown(textarea.value);
    textarea.oninput = () => { preview.innerHTML = renderMarkdown(textarea.value); };
  }

  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement?.tagName;
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey && activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
        e.preventDefault();
        showTodoModal();
        setTimeout(() => document.getElementById('todo-title')?.focus(), 50);
      }
      if (e.key === 'Escape') {
        closeModal('todo-modal');
        closeModal('project-modal');
      }
    });
  }

  return { toggleSidebar, closeSidebar, closeModal, setupDescPreview, bindKeyboardShortcuts };
}

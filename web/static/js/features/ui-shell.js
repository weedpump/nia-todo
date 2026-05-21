export function createUiShell({ renderMarkdown, showTodoModal }) {
  function openSidebar() {
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-overlay')?.classList.add('active');
  }

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

  function bindSidebarEdgeSwipe() {
    const edgeWidth = 24;
    const openDistance = 72;
    const maxVerticalDrift = 55;
    let gesture = null;

    function isMobileLayout() {
      return window.matchMedia?.('(max-width: 768px)').matches;
    }

    document.addEventListener('touchstart', (event) => {
      if (!isMobileLayout()) return;
      if (event.touches.length !== 1) return;
      if (document.getElementById('sidebar')?.classList.contains('open')) return;

      const touch = event.touches[0];
      if (touch.clientX > edgeWidth) return;
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        tracking: true,
        claimed: false,
      };
    }, { passive: true });

    document.addEventListener('touchmove', (event) => {
      if (!gesture?.tracking || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;

      if (Math.abs(dy) > maxVerticalDrift && Math.abs(dy) > dx) {
        gesture = null;
        return;
      }

      if (dx > 28 && dx > Math.abs(dy) * 1.4) {
        gesture.claimed = true;
        event.preventDefault();
      }
    }, { passive: false });

    document.addEventListener('touchend', (event) => {
      if (!gesture?.tracking) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      const shouldOpen = gesture.claimed && dx >= openDistance && Math.abs(dy) <= maxVerticalDrift;
      gesture = null;
      if (shouldOpen) openSidebar();
    }, { passive: true });

    document.addEventListener('touchcancel', () => { gesture = null; }, { passive: true });
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

  return { openSidebar, toggleSidebar, closeSidebar, closeModal, setupDescPreview, bindSidebarEdgeSwipe, bindKeyboardShortcuts };
}

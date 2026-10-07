const DASHBOARD_METRICS = new Set([
  'total',
  'pending',
  'in_progress',
  'done',
  'overdue',
  'due_today',
  'due_week',
  'high_priority',
]);

export function createDashboardDrilldownFeature({
  document = globalThis.document,
  setDashboardDrilldown,
  setFilter,
  scrollToTodos = () => globalThis.document?.getElementById?.('todo-list')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
}) {
  let lastMetricFocus = null;

  function focusAfterRender(renderResult, selector) {
    Promise.resolve(renderResult).then(() => document.querySelector?.(selector)?.focus?.());
  }

  function bindDashboardDrilldownActions() {
    if (!document?.documentElement || document.documentElement.dataset.dashboardDrilldownActionsBound === '1') return;
    document.documentElement.dataset.dashboardDrilldownActionsBound = '1';

    document.addEventListener('click', event => {
      const metricButton = event.target?.closest?.('[data-dashboard-metric]');
      if (metricButton) {
        const metric = metricButton.dataset.dashboardMetric;
        if (!DASHBOARD_METRICS.has(metric)) return;
        event.preventDefault();
        setDashboardDrilldown(metric);
        const projectId = Number(metricButton.dataset.dashboardProjectId);
        const projectFilter = Number.isInteger(projectId) && projectId > 0 ? String(projectId) : null;
        lastMetricFocus = { metric, projectFilter };
        const renderResult = setFilter(projectFilter || 'all', { preserveDashboardDrilldown: true });
        focusAfterRender(renderResult, '[data-dashboard-drilldown-action="clear"]');
        scrollToTodos();
        return;
      }

      const clearButton = event.target?.closest?.('[data-dashboard-drilldown-action]');
      if (clearButton?.dataset.dashboardDrilldownAction === 'clear') {
        event.preventDefault();
        setDashboardDrilldown(null);
        const returnFilter = clearButton.dataset.dashboardReturnFilter || 'all';
        const renderResult = setFilter(returnFilter, { preserveDashboardDrilldown: true });
        if (lastMetricFocus) {
          const { metric, projectFilter } = lastMetricFocus;
          const selector = projectFilter
            ? `[data-dashboard-metric="${metric}"][data-dashboard-project-id="${projectFilter}"]`
            : `[data-dashboard-metric="${metric}"]:not([data-dashboard-project-id])`;
          focusAfterRender(renderResult, selector);
        }
        return;
      }

      const projectButton = event.target?.closest?.('[data-dashboard-project-nav-id]');
      if (!projectButton) return;
      const projectId = Number(projectButton.dataset.dashboardProjectNavId);
      if (!Number.isInteger(projectId) || projectId <= 0) return;
      event.preventDefault();
      setDashboardDrilldown(null);
      setFilter(String(projectId), { preserveDashboardDrilldown: true });
    });
  }

  return { bindDashboardDrilldownActions };
}

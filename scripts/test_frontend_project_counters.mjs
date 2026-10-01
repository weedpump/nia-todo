#!/usr/bin/env node
import assert from 'node:assert/strict';

globalThis.location = { origin: 'http://localhost' };

const projectList = { innerHTML: '' };
globalThis.document = {
  getElementById(id) {
    return id === 'project-list' ? projectList : null;
  },
};

const { createAppRenderingFeature } = await import('../web/static/js/features/app-rendering.js');

const projects = [
  { id: 1, name: 'Main project', parent_id: null, workspace_id: 10 },
  { id: 2, name: 'Child project', parent_id: 1, workspace_id: 10 },
  { id: 3, name: 'Grandchild project', parent_id: 2, workspace_id: 10 },
  { id: 4, name: 'Other workspace', parent_id: null, workspace_id: 20 },
];

const todos = [
  { id: 101, project_id: 1, status: 'pending' },
  { id: 102, project_id: 1, status: 'in_progress' },
  { id: 103, project_id: 1, status: 'done' },
  { id: 201, project_id: 2, status: 'pending' },
  { id: 202, project_id: 2, status: 'pending' },
  { id: 203, project_id: 2, status: 'in_progress' },
  { id: 301, project_id: 3, status: 'pending' },
  { id: 401, project_id: 4, status: 'pending' },
];

const { renderProjects } = createAppRenderingFeature({
  escapeHtml: value => String(value),
  escapeHtmlAttr: value => String(value),
  getTodos: () => todos,
  getProjects: () => projects,
  getCurrentFilter: () => 'all',
  getCurrentProjectId: () => null,
  getCurrentWorkspaceId: () => 10,
});

console.log('🧮 Running direct project badge counter test...');
renderProjects();

const badgeCounts = new Map(
  [...projectList.innerHTML.matchAll(/data-filter="(\d+)"[^>]*>[\s\S]*?<span class="badge">(\d+)<\/span>/g)]
    .map(([, projectId, count]) => [Number(projectId), Number(count)]),
);

assert.equal(badgeCounts.size, 3, 'exactly the active workspace projects must receive badges');
assert.equal(badgeCounts.get(1), 2, 'parent badge must count only its own active todos');
assert.equal(badgeCounts.get(2), 3, 'child badge must count only its own active todos');
assert.equal(badgeCounts.get(3), 1, 'grandchild badge must count only its own active todos');
assert.equal(badgeCounts.has(4), false, 'projects outside the active workspace must not be rendered');

console.log('✅ Direct project badge counter test passed');

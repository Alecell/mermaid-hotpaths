/**
 * Persists Mermaid Projects for the playground.
 *
 * Prefers the local dev server's file-backed API (.esbuild/projectsApi.ts) when it's
 * reachable — same behavior as always under `pnpm dev`. Falls back to localStorage when
 * there's no backend to talk to (e.g. a static deploy like GitHub Pages), so the editor
 * works with zero server.
 */

const STORAGE_KEY = 'mermaid-hotpaths.projects';

const HOTPATHS_SEED_CODE = `flowchart TD
  A@{ trigger: after-call, color: "#e53935" }
  B@{ listen: [after-call] }
  C@{ listen: [after-call] }
  D[some other node]
  A --> B --> C
  A --> D`;

let backendPromise;

async function detectServerBackend() {
  try {
    const res = await fetch('/api/projects', { headers: { Accept: 'application/json' } });
    return res.ok && (res.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}

function hasServerBackend() {
  backendPromise ??= detectServerBackend();
  return backendPromise;
}

function readLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeLocal(projects) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

function seedIfEmpty(projects) {
  if (Object.keys(projects).length > 0) {
    return projects;
  }
  const now = new Date().toISOString();
  const seed = {
    id: crypto.randomUUID(),
    name: 'Hotpaths example',
    code: HOTPATHS_SEED_CODE,
    createdAt: now,
    updatedAt: now,
  };
  const seeded = { [seed.id]: seed };
  writeLocal(seeded);
  return seeded;
}

const local = {
  async list() {
    const projects = seedIfEmpty(readLocal());
    return Object.values(projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async get(id) {
    return readLocal()[id];
  },
  async create({ name, code }) {
    const projects = readLocal();
    const now = new Date().toISOString();
    const project = {
      id: crypto.randomUUID(),
      name: name?.trim() || 'Untitled',
      code: typeof code === 'string' ? code : 'flowchart TD\n  A --> B',
      createdAt: now,
      updatedAt: now,
    };
    projects[project.id] = project;
    writeLocal(projects);
    return project;
  },
  async update(id, patch) {
    const projects = readLocal();
    const existing = projects[id];
    if (!existing) {
      throw new Error('Project not found');
    }
    const updated = {
      ...existing,
      ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
      ...(typeof patch.code === 'string' ? { code: patch.code } : {}),
      ...(patch.view ? { view: patch.view } : {}),
      ...(patch.layout ? { layout: patch.layout } : {}),
      ...(typeof patch.hotpathsEnabled === 'boolean'
        ? { hotpathsEnabled: patch.hotpathsEnabled }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    projects[id] = updated;
    writeLocal(projects);
    return updated;
  },
  async remove(id) {
    const projects = readLocal();
    delete projects[id];
    writeLocal(projects);
  },
};

const server = {
  async list() {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async get(id) {
    const res = await fetch(`/api/projects/${id}`);
    return res.ok ? res.json() : undefined;
  },
  async create({ name, code }) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async update(id, patch) {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async remove(id) {
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  },
};

async function backend() {
  return (await hasServerBackend()) ? server : local;
}

export async function listProjects() {
  return (await backend()).list();
}

export async function getProject(id) {
  return (await backend()).get(id);
}

export async function createProject(input) {
  return (await backend()).create(input);
}

export async function updateProject(id, patch) {
  return (await backend()).update(id, patch);
}

export async function deleteProject(id) {
  return (await backend()).remove(id);
}

/** Triggers a browser download of every project as one JSON file, for backup/portability. */
export async function downloadProjectsBackup() {
  const projects = await listProjects();
  const blob = new Blob([JSON.stringify(projects, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mermaid-hotpaths-projects-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Imports projects from a previously exported backup file (array or single project). */
export async function importProjectsFromJson(jsonText) {
  const incoming = JSON.parse(jsonText);
  const list = Array.isArray(incoming) ? incoming : [incoming];
  const created = [];
  for (const p of list) {
    if (typeof p?.code !== 'string') continue;
    created.push(await createProject({ name: p.name, code: p.code }));
  }
  return created;
}

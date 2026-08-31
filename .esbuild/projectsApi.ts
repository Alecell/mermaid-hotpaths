/**
 * Local persistence for the playground's Projects home: one JSON file per
 * project under playground-data/projects/, no database. Good enough for a
 * single-user dev tool.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

export interface ProjectView {
  x: number;
  y: number;
  scale: number;
}

export type LayoutEngine = 'dagre' | 'elk';

export interface MermaidProject {
  id: string;
  name: string;
  code: string;
  view?: ProjectView;
  layout?: LayoutEngine;
  hotpathsEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

function parseView(value: unknown): ProjectView | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as ProjectView).x !== 'number' ||
    typeof (value as ProjectView).y !== 'number' ||
    typeof (value as ProjectView).scale !== 'number'
  ) {
    return undefined;
  }
  const { x, y, scale } = value as ProjectView;
  return { x, y, scale };
}

function parseLayout(value: unknown): LayoutEngine | undefined {
  return value === 'dagre' || value === 'elk' ? value : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

const DATA_DIR = path.resolve('playground-data/projects');
const ID_PATTERN = /^[\da-f-]{36}$/i;

const HOTPATHS_SEED_CODE = `flowchart TD
  A@{ trigger: after-call, color: "#e53935" }
  B@{ listen: [after-call] }
  C@{ listen: [after-call] }
  D[some other node]
  A --> B --> C
  A --> D`;

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function projectFile(id: string): string {
  return path.join(DATA_DIR, `${id}.json`);
}

async function listProjectIds(): Promise<string[]> {
  await ensureDataDir();
  const entries = await readdir(DATA_DIR);
  return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
}

async function readProject(id: string): Promise<MermaidProject | undefined> {
  if (!ID_PATTERN.test(id)) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(projectFile(id), 'utf-8')) as MermaidProject;
  } catch {
    return undefined;
  }
}

async function writeProject(project: MermaidProject): Promise<void> {
  await ensureDataDir();
  await writeFile(projectFile(project.id), JSON.stringify(project, null, 2));
}

/** Seeds a working Hotpaths example the first time the store is empty. */
export async function seedProjectsIfEmpty(): Promise<void> {
  const ids = await listProjectIds();
  if (ids.length > 0) {
    return;
  }
  const now = new Date().toISOString();
  await writeProject({
    id: randomUUID(),
    name: 'Hotpaths example',
    code: HOTPATHS_SEED_CODE,
    createdAt: now,
    updatedAt: now,
  });
}

export function createProjectsRouter() {
  const router = express.Router();
  router.use(express.json());

  router.get('/api/projects', async (_req, res) => {
    const ids = await listProjectIds();
    const projects = (await Promise.all(ids.map((id) => readProject(id)))).filter(
      (p): p is MermaidProject => p !== undefined
    );
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json(projects);
  });

  router.get('/api/projects/:id', async (req, res) => {
    const project = await readProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(project);
  });

  router.post('/api/projects', async (req, res) => {
    const now = new Date().toISOString();
    const body = req.body as { name?: unknown; code?: unknown };
    const project: MermaidProject = {
      id: randomUUID(),
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled',
      code: typeof body.code === 'string' ? body.code : 'flowchart TD\n  A --> B',
      createdAt: now,
      updatedAt: now,
    };
    await writeProject(project);
    res.status(201).json(project);
  });

  router.put('/api/projects/:id', async (req, res) => {
    const existing = await readProject(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const body = req.body as {
      name?: unknown;
      code?: unknown;
      view?: unknown;
      layout?: unknown;
      hotpathsEnabled?: unknown;
    };
    const updated: MermaidProject = {
      ...existing,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name,
      code: typeof body.code === 'string' ? body.code : existing.code,
      view: parseView(body.view) ?? existing.view,
      layout: parseLayout(body.layout) ?? existing.layout,
      hotpathsEnabled: parseBoolean(body.hotpathsEnabled) ?? existing.hotpathsEnabled,
      updatedAt: new Date().toISOString(),
    };
    await writeProject(updated);
    res.json(updated);
  });

  router.delete('/api/projects/:id', async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    await rm(projectFile(req.params.id), { force: true });
    res.status(204).end();
  });

  return router;
}

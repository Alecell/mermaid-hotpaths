import { expect, type Locator, type Page } from '@playwright/test';

const STORAGE_KEY = 'mermaid-hotpaths.projects';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

/**
 * A small diagram with one subgraph, used by most specs: `B`/`C` live inside `s1`, `A` and
 * `D` at the root — enough to tell "created inside the subgraph" apart from "created at the
 * root", which several features hinge on.
 */
export const DIAGRAM_WITH_SUBGRAPH = `flowchart TD
  A["Start"]
  subgraph s1["Group one"]
    B["Inside B"]
    C["Inside C"]
  end
  D["Outside D"]
  A --> B
  B --> C
  C --> D
`;

/**
 * Seeds a single project straight into `localStorage` and opens the editor on it. The test
 * server has no projects API, so this is the store the app actually reads — no fixtures to
 * clean up, and nothing shared between tests.
 */
export async function openEditor(page: Page, code: string): Promise<void> {
  await page.addInitScript(
    ({ key, id, source }) => {
      const now = new Date().toISOString();
      localStorage.setItem(
        key,
        JSON.stringify({ [id]: { id, name: 'Test diagram', code: source, createdAt: now, updatedAt: now } })
      );
    },
    { key: STORAGE_KEY, id: PROJECT_ID, source: code }
  );
  await page.goto(`/editor.html?id=${PROJECT_ID}`);
  await expect(page.locator('#diagram svg')).toBeVisible();
  await expect(page.locator('#error')).toBeHidden();
}

/** The rendered `<g>` of a node, via mermaid's own `…-flowchart-<id>-<n>` dom id. */
export function node(page: Page, id: string): Locator {
  return page.locator(`#diagram svg g.node[id*="-flowchart-${id}-"]`);
}

/** The rendered `<g>` of a subgraph, whose dom id is just `{svgId}-{subgraphId}`. */
export function cluster(page: Page, id: string): Locator {
  return page.locator(`#diagram svg g.cluster[id$="-${id}"]`);
}

/** The current diagram source, as the code panel has it. */
export function source(page: Page): Promise<string> {
  return page.locator('#src').inputValue();
}

/** Clicks a node and waits until it's really the selection (toolbar up, ring drawn). */
export async function selectNode(page: Page, id: string): Promise<void> {
  await node(page, id).click();
  await expect(page.locator('#element-toolbar')).toBeVisible();
  await expect(page.locator('#selection-layer rect')).toBeVisible();
}

/** Same, for a subgraph: clicked near its top-left corner, away from its children. */
export async function selectCluster(page: Page, id: string): Promise<void> {
  await cluster(page, id).click({ position: { x: 6, y: 6 } });
  await expect(page.locator('#element-toolbar')).toBeVisible();
}

/** The "+" handle hanging under the current selection. */
export function plusHandle(page: Page): Locator {
  return page.locator('#selection-layer g');
}

/**
 * The whole "+ → what kind → which id → create" flow. `id` left out means letting the
 * editor auto-name it, which is what the ID field's placeholder promises.
 */
export async function createFromPlus(
  page: Page,
  kind: 'node' | 'subgraph',
  id?: string
): Promise<void> {
  await plusHandle(page).click();
  await page.locator(`#plus-menu-${kind}`).click();
  await expect(page.locator('#modal-backdrop')).toBeVisible();
  if (id) {
    await page.locator('#modal-id').fill(id);
  }
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#modal-backdrop')).toBeHidden();
}

/** The center of an element, in page coordinates — for gestures the mouse has to drive. */
export async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('element has no bounding box');
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A press-move-release drag. The intermediate steps matter: every drag gesture in the
 * editor ignores movement under a few pixels so that a plain click never reads as a drag,
 * so a straight jump from press to release would be treated as a click.
 */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 12);
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
}

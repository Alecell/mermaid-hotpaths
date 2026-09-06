import { expect, test } from '@playwright/test';
import {
  DIAGRAM_WITH_SUBGRAPH,
  centerOf,
  cluster,
  createFromPlus,
  drag,
  node,
  openEditor,
  selectCluster,
  selectNode,
  source,
} from './helpers';

/** The lines of `subgraph <id> … end`, so a test can assert on what's *inside* a subgraph. */
function subgraphBody(code: string, subgraphId: string): string[] {
  const lines = code.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*subgraph\\s+${subgraphId}\\b`).test(line));
  const end = lines.findIndex((line, i) => i > start && /^\s*end\s*$/.test(line));
  return lines.slice(start + 1, end).map((line) => line.trim());
}

test.describe('creating elements from a node’s "+"', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
  });

  test('offers node or subgraph, and asks for an id', async ({ page }) => {
    await selectNode(page, 'A');
    await page.locator('#selection-layer g').click();

    await expect(page.locator('#plus-menu')).toBeVisible();
    await expect(page.locator('#plus-menu-node')).toHaveText('Node');
    await expect(page.locator('#plus-menu-subgraph')).toHaveText('Subgraph');

    await page.locator('#plus-menu-node').click();
    await expect(page.locator('#modal-backdrop')).toBeVisible();
    await expect(page.locator('#modal-title')).toHaveText('New node');
    await expect(page.locator('#modal-id')).toBeFocused();
  });

  test('names the new node whatever the id prompt was given', async ({ page }) => {
    await selectNode(page, 'A');
    await createFromPlus(page, 'node', 'checkout');

    await expect(node(page, 'checkout')).toBeVisible();
    expect(await source(page)).toContain('A --> checkout');
  });

  test('rejects an id that is already taken', async ({ page }) => {
    await selectNode(page, 'A');
    await page.locator('#selection-layer g').click();
    await page.locator('#plus-menu-node').click();
    await page.locator('#modal-id').fill('B');
    await page.locator('#modal-confirm').click();

    await expect(page.locator('#modal-error')).toContainText('already used');
    await expect(page.locator('#modal-backdrop')).toBeVisible();
  });

  test('a node born from a node inside a subgraph lands inside that subgraph', async ({ page }) => {
    await selectNode(page, 'B');
    await createFromPlus(page, 'node', 'child');

    expect(subgraphBody(await source(page), 's1')).toContain('child["Node"]');
    expect(await source(page)).toContain('B --> child');
  });

  test('a subgraph born from a node inside a subgraph nests inside it', async ({ page }) => {
    await selectNode(page, 'B');
    await createFromPlus(page, 'subgraph', 'inner');

    await expect(cluster(page, 'inner')).toBeVisible();
    expect(subgraphBody(await source(page), 's1')).toContain('subgraph inner["Untitled subgraph"]');
    expect(await source(page)).toContain('B --> inner');
  });

  test('a stray mention at the root does not fool it about where a node lives', async ({
    page,
  }) => {
    // Real diagrams collect loose `id`-on-its-own lines at the root — this editor's own edge
    // deletion leaves them behind. Mermaid ignores them for placement (only blocks claim a
    // node), and so must we: the node here is drawn inside `inner`, so that's where the "+"
    // has to create.
    await openEditor(
      page,
      `flowchart TD
  A["Start"]
  target
  subgraph outer["Outer"]
    subgraph inner["Inner"]
      target["The target"]
    end
  end
  A --> target
  target
`
    );

    await selectNode(page, 'target');
    await createFromPlus(page, 'node', 'born');

    expect(subgraphBody(await source(page), 'inner')).toContain('born["Node"]');
  });

  test('a node born from a root node stays at the root', async ({ page }) => {
    await selectNode(page, 'A');
    await createFromPlus(page, 'node', 'loose');

    expect(subgraphBody(await source(page), 's1')).not.toContain('loose["Node"]');
    expect(await source(page)).toContain('loose["Node"]');
  });

  test('a subgraph’s "+" creates inside it, with no edge to its own member', async ({
    page,
  }) => {
    await selectCluster(page, 's1');
    await createFromPlus(page, 'node', 'member');

    expect(subgraphBody(await source(page), 's1')).toContain('member["Node"]');
    // A group pointing an arrow at something it contains is nobody's intent.
    expect(await source(page)).not.toContain('s1 --> member');
  });

  test('a subgraph’s "+" can create a nested subgraph too', async ({ page }) => {
    await selectCluster(page, 's1');
    await createFromPlus(page, 'subgraph', 'nested');

    await expect(cluster(page, 'nested')).toBeVisible();
    expect(subgraphBody(await source(page), 's1')).toContain('subgraph nested["Untitled subgraph"]');
  });

  test('dragging the "+" onto another node links them without creating anything', async ({
    page,
  }) => {
    await selectNode(page, 'A');
    await drag(
      page,
      await centerOf(page.locator('#selection-layer g')),
      await centerOf(node(page, 'C'))
    );

    const code = await source(page);
    expect(code).toContain('A --> C');
    expect(code).not.toContain('["Node"]');
  });
});

test.describe('turning a node into a subgraph', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
  });

  test('keeps the id, the label and every edge that pointed at it', async ({ page }) => {
    await selectNode(page, 'D');
    await page.locator('#et-subgraph-btn').click();

    await expect(cluster(page, 'D')).toBeVisible();
    const code = await source(page);
    expect(code).toContain('subgraph D["Outside D"]');
    // The edge that pointed at the node still points at the subgraph of the same id.
    expect(code).toContain('C --> D');
    // And it isn't left empty, which `pruneEmptySubgraphs` would sweep away.
    expect(subgraphBody(code, 'D')).toHaveLength(1);
  });

  test('a node inside a subgraph becomes a subgraph nested in the same parent', async ({
    page,
  }) => {
    await selectNode(page, 'C');
    await page.locator('#et-subgraph-btn').click();

    await expect(cluster(page, 'C')).toBeVisible();
    expect(subgraphBody(await source(page), 's1')).toContain('subgraph C["Inside C"]');
  });

  test('is offered for nodes but not for subgraphs', async ({ page }) => {
    await selectNode(page, 'A');
    await expect(page.locator('#et-subgraph-btn')).toBeVisible();

    await selectCluster(page, 's1');
    await expect(page.locator('#et-subgraph-btn')).toBeHidden();
    await expect(page.locator('#et-shape-btn')).toBeHidden();
  });
});

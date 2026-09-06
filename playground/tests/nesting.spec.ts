import { expect, test, type Locator } from '@playwright/test';
import {
  DIAGRAM_WITH_SUBGRAPH,
  centerOf,
  cluster,
  drag,
  node,
  openEditor,
  selectCluster,
  selectNode,
  source,
} from './helpers';

/** The lines inside `subgraph <id> … end`. */
function subgraphBody(code: string, subgraphId: string): string[] {
  const lines = code.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*subgraph\\s+${subgraphId}\\b`).test(line)
  );
  const end = lines.findIndex((line, i) => i > start && /^\s*end\s*$/.test(line));
  return lines.slice(start + 1, end).map((line) => line.trim());
}

/**
 * A point inside a subgraph but off its members — its title strip. Dropping onto a member
 * works too (it reads as "into that member's group"), but this keeps the test about the
 * group itself.
 */
async function titleStripOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('subgraph has no bounding box');
  }
  return { x: box.x + box.width / 2, y: box.y + 10 };
}

test.describe('nesting by dragging', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
  });

  test('dropping a node on a subgraph moves it in, edges intact', async ({ page }) => {
    await drag(page, await centerOf(node(page, 'D')), await titleStripOf(cluster(page, 's1')));

    await expect.poll(async () => subgraphBody(await source(page), 's1')).toContain('D["Outside D"]');
    const code = await source(page);
    expect(code).toContain('C --> D');
    // Moved, not copied.
    expect(code.match(/D\["Outside D"\]/g)).toHaveLength(1);
  });

  test('dropping a subgraph on another subgraph nests it', async ({ page }) => {
    await openEditor(
      page,
      `flowchart TD
  subgraph outer["Outer"]
    A["Inside outer"]
  end
  subgraph mover["Mover"]
    B["Inside mover"]
  end
  A --> B
`
    );

    await drag(page, await titleStripOf(cluster(page, 'mover')), await titleStripOf(cluster(page, 'outer')));

    await expect
      .poll(async () => subgraphBody(await source(page), 'outer'))
      .toContain('subgraph mover["Mover"]');
    // Its own member came along with it.
    expect(subgraphBody(await source(page), 'mover')).toContain('B["Inside mover"]');
  });

  test('a drag that lands on empty canvas changes nothing', async ({ page }) => {
    const before = await source(page);
    const box = await node(page, 'D').boundingBox();

    await drag(page, await centerOf(node(page, 'D')), { x: box!.x + 400, y: box!.y + 200 });

    expect(await source(page)).toBe(before);
  });
});

test.describe('the move button', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
  });

  test('moves a root node into a subgraph', async ({ page }) => {
    await selectNode(page, 'D');
    await page.locator('#et-move-btn').click();

    const menu = page.locator('#move-menu');
    await expect(menu).toBeVisible();
    // D is already at the root, so "root" isn't offered.
    await expect(menu.getByRole('button', { name: 'Root (no subgraph)' })).toHaveCount(0);
    await menu.getByRole('button', { name: 'Group one' }).click();

    await expect.poll(async () => subgraphBody(await source(page), 's1')).toContain('D["Outside D"]');
  });

  test('moves a nested node back out to the root', async ({ page }) => {
    await selectNode(page, 'B');
    await page.locator('#et-move-btn').click();
    await page.locator('#move-menu').getByRole('button', { name: 'Root (no subgraph)' }).click();

    await expect
      .poll(async () => subgraphBody(await source(page), 's1'))
      .not.toContain('B["Inside B"]');
    expect(await source(page)).toContain('B["Inside B"]');
    expect(await source(page)).toContain('A --> B');
  });

  test('never offers a subgraph itself or its own contents as a target', async ({ page }) => {
    await openEditor(
      page,
      `flowchart TD
  subgraph outer["Outer"]
    subgraph inner["Inner"]
      A["Deep"]
    end
  end
  B["Loose"]
`
    );

    await selectCluster(page, 'outer');
    await page.locator('#et-move-btn').click();

    const menu = page.locator('#move-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Outer' })).toHaveCount(0);
    await expect(menu.getByRole('button', { name: 'Inner' })).toHaveCount(0);
    await expect(menu.locator('.move-menu-empty')).toBeVisible();
  });

  test('is offered for subgraphs too, and not for edges', async ({ page }) => {
    // The edge first, while nothing is selected: a selected element's toolbar floats right
    // above it, and would sit between the mouse and the edge we mean to click.
    const midpoint = await page.evaluate(() => {
      const svg = document.querySelector('#diagram svg') as SVGSVGElement;
      const path = [...document.querySelectorAll('path.flowchart-link')].find((el) =>
        /L_A_B_/.test(el.id)
      ) as SVGPathElement;
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      const point = svg.createSVGPoint();
      point.x = mid.x;
      point.y = mid.y;
      const client = point.matrixTransform(svg.getScreenCTM()!);
      return { x: client.x, y: client.y };
    });
    await page.mouse.click(midpoint.x, midpoint.y);

    await expect(page.locator('#et-arrow-btn')).toBeVisible();
    await expect(page.locator('#et-move-btn')).toBeHidden();

    await selectCluster(page, 's1');
    await expect(page.locator('#et-move-btn')).toBeVisible();
  });
});

import { expect, test, type Locator } from '@playwright/test';
import {
  DIAGRAM_WITH_SUBGRAPH,
  centerOf,
  cluster,
  drag,
  node,
  openEditor,
  pointOnEdge,
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
 * The subgraph `id` is declared in, or null at the root — read straight off the source,
 * nesting-aware, so a test can say where an element ended up without caring about
 * indentation or line order.
 */
function enclosingOf(code: string, id: string): string | null {
  const stack: string[] = [];
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    const header = /^subgraph\s+([A-Za-z][\w-]*)/.exec(line);
    if (header) {
      if (header[1] === id) {
        return stack[stack.length - 1] ?? null;
      }
      stack.push(header[1]);
      continue;
    }
    if (/^end$/.test(line)) {
      stack.pop();
      continue;
    }
    if (line === id || line.startsWith(`${id}[`)) {
      return stack[stack.length - 1] ?? null;
    }
  }
  throw new Error(`${id} is declared nowhere`);
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

  test('dragging the "+" of a node inside a subgraph onto another subgraph links, never nests', async ({
    page,
  }) => {
    await openEditor(
      page,
      `flowchart TD
  subgraph login["Login"]
    apple["Apple"]
    email["Email"]
  end
  subgraph email_page["Email page"]
    forgot["Forgot"]
  end
`
    );
    await selectNode(page, 'email');
    // The "+" hangs just under its node — over its own group's background. A press there
    // used to double as "start dragging the group", so the drop nested all of `login`
    // inside `email_page` on top of drawing the edge.
    await drag(
      page,
      await centerOf(page.locator('#selection-layer g')),
      await titleStripOf(cluster(page, 'email_page'))
    );

    await expect.poll(() => source(page)).toContain('email --> email_page');
    const code = await source(page);
    expect(subgraphBody(code, 'email_page')).not.toContain('subgraph login["Login"]');
    expect(subgraphBody(code, 'login')).toEqual(['apple["Apple"]', 'email["Email"]']);
  });

  test('dragging an edge handle onto a node inside a subgraph relinks, never nests', async ({
    page,
  }) => {
    const midpoint = await pointOnEdge(page, 'L_A_B_');
    await page.mouse.click(midpoint.x, midpoint.y);
    const handles = page.locator('#selection-layer circle');
    await expect(handles).toHaveCount(2);

    // The start handle sits on A's own outline; pressing it used to also pick A up.
    const startHandle = (await page.evaluate(() => {
      const circles = [...document.querySelectorAll('#selection-layer circle')];
      const a = document.querySelector('#diagram svg g.node[id*="-flowchart-A-"]')!.getBoundingClientRect();
      const dist = (c: Element) => {
        const b = c.getBoundingClientRect();
        return Math.hypot(b.x + b.width / 2 - (a.x + a.width / 2), b.y + b.height / 2 - (a.y + a.height / 2));
      };
      return circles.map(dist).indexOf(Math.min(...circles.map(dist)));
    })) as number;
    await drag(page, await centerOf(handles.nth(startHandle)), await centerOf(node(page, 'C')));

    await expect.poll(() => source(page)).toContain('C --> B');
    const code = await source(page);
    expect(code).not.toContain('A --> B');
    // A is still a root node, not a new member of s1.
    expect(subgraphBody(code, 's1')).not.toContain('A["Start"]');
    expect(code).toContain('A["Start"]');
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
    const midpoint = await pointOnEdge(page, 'L_A_B_');
    await page.mouse.click(midpoint.x, midpoint.y);

    await expect(page.locator('#et-arrow-btn')).toBeVisible();
    await expect(page.locator('#et-move-btn')).toBeHidden();

    await selectCluster(page, 's1');
    await expect(page.locator('#et-move-btn')).toBeVisible();
  });
});

test.describe('the move-out button', () => {
  const moveOut = (page: Parameters<typeof selectNode>[0]) => page.locator('#et-move-out-btn');

  test('moves a nested node one level out, edges intact', async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    await selectNode(page, 'B');
    await moveOut(page).click();

    await expect.poll(async () => enclosingOf(await source(page), 'B')).toBeNull();
    const code = await source(page);
    expect(code).toContain('B["Inside B"]');
    expect(code).toContain('A --> B');
    expect(code).toContain('B --> C');
    // It stays selected, now at the root — where there is nothing left to step out of.
    await expect(page.locator('#element-toolbar')).toBeVisible();
    await expect(moveOut(page)).toBeHidden();
  });

  test('climbs exactly one subgraph per press', async ({ page }) => {
    await openEditor(
      page,
      `flowchart TD
  subgraph outer["Outer"]
    subgraph middle["Middle"]
      subgraph inner["Inner"]
        A["Deep"]
        A2["Deep too"]
      end
    end
  end
  B["Loose"]
  A --> B
`
    );
    await selectNode(page, 'A');

    await moveOut(page).click();
    await expect.poll(async () => enclosingOf(await source(page), 'A')).toBe('middle');

    await moveOut(page).click();
    await expect.poll(async () => enclosingOf(await source(page), 'A')).toBe('outer');

    await moveOut(page).click();
    await expect.poll(async () => enclosingOf(await source(page), 'A')).toBeNull();
    await expect(moveOut(page)).toBeHidden();

    // The rest of the structure is untouched: every subgraph still there, nested as before.
    const code = await source(page);
    expect(enclosingOf(code, 'inner')).toBe('middle');
    expect(enclosingOf(code, 'middle')).toBe('outer');
    expect(enclosingOf(code, 'A2')).toBe('inner');
    expect(code).toContain('A --> B');
  });

  test('steps a nested subgraph out along with its contents', async ({ page }) => {
    await openEditor(
      page,
      `flowchart TD
  subgraph outer["Outer"]
    subgraph inner["Inner"]
      A["Deep"]
    end
    C["Sibling"]
  end
`
    );
    await selectCluster(page, 'inner');
    await moveOut(page).click();

    await expect.poll(async () => enclosingOf(await source(page), 'inner')).toBeNull();
    const code = await source(page);
    expect(enclosingOf(code, 'A')).toBe('inner');
    expect(enclosingOf(code, 'C')).toBe('outer');
  });

  test('is not offered for root elements or edges', async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    await selectNode(page, 'D');
    await expect(page.locator('#element-toolbar')).toBeVisible();
    await expect(moveOut(page)).toBeHidden();

    await selectCluster(page, 's1');
    await expect(moveOut(page)).toBeHidden();

    await selectNode(page, 'B');
    await expect(moveOut(page)).toBeVisible();

    const midpoint = await pointOnEdge(page, 'L_C_D_');
    await page.mouse.click(midpoint.x, midpoint.y);
    await expect(page.locator('#et-arrow-btn')).toBeVisible();
    await expect(moveOut(page)).toBeHidden();
  });
});

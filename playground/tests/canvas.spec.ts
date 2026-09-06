import { expect, test } from '@playwright/test';
import { DIAGRAM_WITH_SUBGRAPH, node, openEditor, selectNode, source } from './helpers';

test.describe('canvas', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
  });

  test('the page itself never scrolls', async ({ page }) => {
    // Every scrollable region here has its own container; a scrollbar on the page means
    // something (mermaid's stray tooltip div, historically) is poking past the viewport.
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
    }));
    expect(metrics.scrollWidth).toBe(metrics.clientWidth);
    expect(metrics.innerWidth).toBe(metrics.clientWidth);
  });

  test('selection handles keep their screen size when zoomed out', async ({ page }) => {
    await selectNode(page, 'A');
    const plus = page.locator('#selection-layer g');
    const before = await plus.boundingBox();
    const nodeBefore = await node(page, 'A').boundingBox();

    for (let i = 0; i < 8; i++) {
      await page.locator('#zoom-out').click();
    }

    const after = await plus.boundingBox();
    const nodeAfter = await node(page, 'A').boundingBox();

    // The diagram really did shrink...
    expect(nodeAfter!.width).toBeLessThan(nodeBefore!.width / 4);
    // ...but the button you have to hit did not.
    expect(Math.abs(after!.width - before!.width)).toBeLessThan(1.5);
  });

  test('an edge’s click target keeps its screen width when zoomed out', async ({ page }) => {
    const widthInScreenPx = () =>
      page.evaluate(() => {
        const svg = document.querySelector('#diagram svg') as SVGSVGElement;
        const hit = document.querySelector('.edge-hit-area') as SVGPathElement;
        return parseFloat(hit.style.strokeWidth) * svg.getScreenCTM()!.a;
      });

    const before = await widthInScreenPx();
    for (let i = 0; i < 8; i++) {
      await page.locator('#zoom-out').click();
    }
    expect(Math.abs((await widthInScreenPx()) - before)).toBeLessThan(1.5);
  });

  test('clicking an edge selects it with a handle at each end', async ({ page }) => {
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

    await expect(page.locator('#selection-layer circle')).toHaveCount(2);
    await expect(page.locator('#et-arrow-btn')).toBeVisible();
  });

  test('deleting a node takes its edges with it, and undo puts everything back', async ({
    page,
  }) => {
    await selectNode(page, 'C');
    await page.keyboard.press('Backspace');

    await expect(node(page, 'C')).toHaveCount(0);
    const afterDelete = await source(page);
    expect(afterDelete).not.toContain('B --> C');
    expect(afterDelete).not.toContain('C --> D');

    await page.keyboard.press('Control+z');

    await expect(node(page, 'C')).toBeVisible();
    const afterUndo = await source(page);
    expect(afterUndo).toContain('B --> C');
    expect(afterUndo).toContain('C --> D');
  });

  test('renaming a node in place rewrites only its label', async ({ page }) => {
    await node(page, 'A').dblclick();
    const editor = page.locator('#inline-label-editor');
    await expect(editor).toBeVisible();
    await editor.fill('Kickoff');
    await editor.press('Enter');

    await expect(page.locator('#diagram svg')).toContainText('Kickoff');
    const code = await source(page);
    expect(code).toContain('A["Kickoff"]');
    expect(code).toContain('A --> B');
  });
});

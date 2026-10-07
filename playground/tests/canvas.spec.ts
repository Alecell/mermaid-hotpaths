import { expect, test } from '@playwright/test';
import {
  DIAGRAM_WITH_SUBGRAPH,
  clickEmptyCanvas,
  cluster,
  groupOffsetOfEdge,
  node,
  openEditor,
  panBy,
  pointOnEdge,
  selectNode,
  source,
} from './helpers';

/**
 * Two side-by-side groups, with an edge inside the first. Dagre places that group with a
 * translate of its own (the other one lands at the origin), so `B --> C` is drawn in a
 * coordinate space that is *not* the svg root's — the case every overlay has to get right.
 */
const DIAGRAM_WITH_OFFSET_GROUP = `flowchart TD
  subgraph s1["Group one"]
    B["Inside B"]
    C["Inside C"]
    E["Inside E"]
  end
  subgraph s2["Group two"]
    F["Inside F"]
    G["Inside G"]
  end
  B -->|go| C
`;

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
    const midpoint = await pointOnEdge(page, 'L_A_B_');

    await page.mouse.click(midpoint.x, midpoint.y);

    await expect(page.locator('#selection-layer circle')).toHaveCount(2);
    await expect(page.locator('#et-arrow-btn')).toBeVisible();
  });

  test('selecting an edge drawn inside a subgraph puts every overlay on the edge itself', async ({
    page,
  }) => {
    // Both ends of B --> C live in s1, so mermaid draws the edge inside s1's own group —
    // which it places with a translate of its own. The overlays live at the svg root, and
    // anything that copied the path's local geometry straight across landed a whole
    // group-offset away from the edge it was meant to mark.
    await openEditor(page, DIAGRAM_WITH_OFFSET_GROUP);
    expect(await groupOffsetOfEdge(page, 'L_B_C_')).toBeGreaterThan(10);
    const point = await pointOnEdge(page, 'L_B_C_', 0.25);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('#selection-layer circle')).toHaveCount(2);
    await expect(page.locator('#element-toolbar')).toBeVisible();

    const g = await page.evaluate(() => {
      const path = [...document.querySelectorAll('path.flowchart-link')].find((el) =>
        /L_B_C_/.test(el.id)
      ) as SVGPathElement;
      const rect = (el: Element) => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
      };
      const onScreen = (p: DOMPointInit) => new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
      const start = onScreen(path.getPointAtLength(0));
      const end = onScreen(path.getPointAtLength(path.getTotalLength()));
      return {
        path: rect(path),
        highlight: rect(document.querySelector('#selection-layer path')!),
        handles: [...document.querySelectorAll('#selection-layer circle')].map(rect),
        ends: [
          { x: start.x, y: start.y },
          { x: end.x, y: end.y },
        ],
        toolbar: rect(document.getElementById('element-toolbar')!),
      };
    });

    // The highlight traces the edge...
    expect(Math.abs(g.highlight.x - g.path.x)).toBeLessThan(3);
    expect(Math.abs(g.highlight.y - g.path.y)).toBeLessThan(3);
    expect(Math.abs(g.highlight.w - g.path.w)).toBeLessThan(3);
    expect(Math.abs(g.highlight.h - g.path.h)).toBeLessThan(3);
    // ...each handle sits on one of its ends...
    for (const handle of g.handles) {
      const nearest = Math.min(...g.ends.map((p) => Math.hypot(p.x - handle.cx, p.y - handle.cy)));
      expect(nearest).toBeLessThan(2);
    }
    // ...and the toolbar floats beside the edge, not beside where the edge isn't.
    expect(Math.hypot(g.toolbar.cx - g.path.cx, g.toolbar.cy - g.path.cy)).toBeLessThan(160);
  });

  test('selecting a labelled edge inside a subgraph leaves its label where it was', async ({
    page,
  }) => {
    await openEditor(page, DIAGRAM_WITH_OFFSET_GROUP);
    expect(await groupOffsetOfEdge(page, 'L_B_C_')).toBeGreaterThan(10);
    // Selection raises the label above the highlight; it must not drag it out of its
    // group's placement in the process, nor drift further on every re-selection.
    const label = page.locator('#diagram svg g.label[data-id="L_B_C_0"]');
    const before = await label.boundingBox();
    const point = await pointOnEdge(page, 'L_B_C_', 0.25);

    for (let i = 0; i < 2; i++) {
      await page.mouse.click(point.x, point.y);
      await expect(page.locator('#selection-layer circle')).toHaveCount(2);
      const after = await label.boundingBox();
      expect(Math.abs(after!.x - before!.x)).toBeLessThan(1.5);
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(1.5);
      await clickEmptyCanvas(page);
    }
  });

  test('each segment of a chain is its own edge, with handles and an arrow to retype', async ({
    page,
  }) => {
    // `C --> B --> A` used to parse as one edge C --> A labelled "> B" — the label-text
    // opener `--` swallowing the first arrowhead and the second arrow closing it — so the
    // real rendered segments had no source entry: selectable, but inert.
    await openEditor(
      page,
      `flowchart TD
  C --> B --> A
`
    );
    const midpoint = await pointOnEdge(page, 'L_B_A_');
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

  test('clicking empty canvas clears the selection, anywhere in the viewport', async ({
    page,
  }) => {
    await selectNode(page, 'A');

    // A corner of the canvas that is deliberately *outside* the drawing's own box — the
    // spot that used to leave the selection stuck on, because the click never reached the
    // element the handler was bound to.
    const spot = await page.evaluate(() => {
      const view = document.getElementById('viewport')!.getBoundingClientRect();
      const drawing = document.getElementById('diagram')!.getBoundingClientRect();
      const point = { x: view.left + 24, y: view.bottom - 24 };
      const insideDrawing =
        point.x >= drawing.left &&
        point.x <= drawing.right &&
        point.y >= drawing.top &&
        point.y <= drawing.bottom;
      return { point, insideDrawing };
    });
    expect(spot.insideDrawing).toBe(false);

    await page.mouse.click(spot.point.x, spot.point.y);

    await expect(page.locator('#selection-layer rect')).toHaveCount(0);
    await expect(page.locator('#element-toolbar')).toBeHidden();
  });

  test('deleting an edge keeps both of its nodes, and leaves no litter behind', async ({
    page,
  }) => {
    const midpoint = await pointOnEdge(page, 'L_A_B_');
    await page.mouse.click(midpoint.x, midpoint.y);
    await expect(page.locator('#selection-layer circle')).toHaveCount(2);

    await page.keyboard.press('Backspace');

    // Disconnecting two nodes must never delete them...
    await expect(node(page, 'A')).toBeVisible();
    await expect(node(page, 'B')).toBeVisible();
    const code = await source(page);
    expect(code).not.toContain('A --> B');
    // ...and B stays where it was, rather than being pulled out of its group by a leftover.
    expect(code).toContain('B["Inside B"]');
    // No `id`-on-its-own lines left over for ids that are declared anyway.
    expect(code.split('\n').filter((line) => /^\s*(A|B)\s*$/.test(line))).toHaveLength(0);
  });

  test('deleting a node leaves no edge pointing at it', async ({ page }) => {
    await selectNode(page, 'B');
    await page.keyboard.press('Backspace');

    await expect(node(page, 'B')).toHaveCount(0);
    const code = await source(page);
    // Nothing may still reference the id — neither endpoint of any edge.
    expect(code).not.toMatch(/(^|\s)B\s*(-|=|\.)/m);
    expect(code).not.toMatch(/(-|=|\.)>\s*B(\s|$)/m);
    // Its neighbours survive it.
    await expect(node(page, 'A')).toBeVisible();
    await expect(node(page, 'C')).toBeVisible();
  });

  test('deleting keeps every subgraph closed', async ({ page }) => {
    // Two root-level blocks: after the first `end` the scan is back at the root, where a
    // lone `end` looks exactly like a stray bare id — and with the word appearing again
    // further down, it used to be pruned as "redundant", unclosing every block but the last.
    await openEditor(
      page,
      `flowchart TD
  subgraph s1["Group one"]
    A["Inside A"]
  end
  subgraph s2["Group two"]
    B["Inside B"]
    C["Inside C"]
  end
  A --> B
`
    );
    await selectNode(page, 'C');
    await page.keyboard.press('Backspace');

    await expect(node(page, 'C')).toHaveCount(0);
    const code = await source(page);
    expect(code.split('\n').filter((line) => /^\s*end\s*$/.test(line))).toHaveLength(2);
    await expect(cluster(page, 's1')).toBeVisible();
    await expect(cluster(page, 's2')).toBeVisible();
  });

  test('double-clicking a long edge brings its label editor into view', async ({ page }) => {
    // A chain tall enough that, zoomed in and panned to the top, the A→H edge runs off the
    // bottom of the screen — and its label anchor (the midpoint) with it.
    await openEditor(
      page,
      `flowchart TD
  A["Start"] --> B["b"] --> C["c"] --> D["d"] --> E["e"] --> F["f"] --> G["g"] --> H["End"]
  A --> H
`
    );
    for (let i = 0; i < 5; i++) {
      await page.locator('#zoom-in').click();
    }
    await panBy(page, 0, 500);

    const geometry = await page.evaluate(() => {
      const svg = document.querySelector('#diagram svg') as SVGSVGElement;
      const path = [...document.querySelectorAll('path.flowchart-link')].find((el) =>
        /L_A_H_/.test(el.id)
      ) as SVGPathElement;
      const toClient = (length: number) => {
        const at = path.getPointAtLength(length);
        const point = svg.createSVGPoint();
        point.x = at.x;
        point.y = at.y;
        const client = point.matrixTransform(svg.getScreenCTM()!);
        return { x: client.x, y: client.y };
      };
      const view = document.getElementById('viewport')!.getBoundingClientRect();
      const inside = (p: { x: number; y: number }) =>
        p.x > view.left + 20 && p.x < view.right - 20 && p.y > view.top + 20 && p.y < view.bottom - 20;

      const total = path.getTotalLength();
      let visiblePoint: { x: number; y: number } | null = null;
      for (let i = 0; i <= 40 && !visiblePoint; i++) {
        const candidate = toClient((total * i) / 40);
        if (inside(candidate)) {
          visiblePoint = candidate;
        }
      }
      return {
        midpointVisible: inside(toClient(total / 2)),
        visiblePoint,
        view: { left: view.left, top: view.top, right: view.right, bottom: view.bottom },
      };
    });

    // The premise of the test: you can see part of the edge, but not where its label lives.
    expect(geometry.midpointVisible).toBe(false);
    expect(geometry.visiblePoint).not.toBeNull();

    await page.mouse.dblclick(geometry.visiblePoint!.x, geometry.visiblePoint!.y);

    const editor = page.locator('#inline-label-editor');
    await expect(editor).toBeVisible();
    const box = (await editor.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(geometry.view.left);
    expect(box.y).toBeGreaterThanOrEqual(geometry.view.top);
    expect(box.x + box.width).toBeLessThanOrEqual(geometry.view.right);
    expect(box.y + box.height).toBeLessThanOrEqual(geometry.view.bottom);
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

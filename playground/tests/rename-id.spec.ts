import { expect, test, type Page } from '@playwright/test';
import {
  DIAGRAM_WITH_SUBGRAPH,
  cluster,
  node,
  openEditor,
  pointOnEdge,
  selectCluster,
  selectNode,
  source,
} from './helpers';

/** Opens the rename prompt for the current selection, types `newId`, confirms. */
async function rename(page: Page, newId: string): Promise<void> {
  await page.locator('#et-rename-btn').click();
  await expect(page.locator('#modal-backdrop')).toBeVisible();
  await expect(page.locator('#modal-title')).toHaveText('Rename ID');
  await page.locator('#modal-id').fill(newId);
  await page.locator('#modal-confirm').click();
}

test.describe('renaming an id', () => {
  test('rewrites every reference, and no text that merely looks like one', async ({ page }) => {
    // Everything an id can be part of, on purpose in one diagram: its declaration inside
    // a subgraph, edges in every label style, a chain, a style line, a bare mention, and a
    // note with a reference — next to text (a label, two edge labels, the prose of the
    // note) that spells the very same id and must not change.
    await openEditor(
      page,
      `flowchart TD
  subgraph s1["Group one"]
    B["Inside B"]
    C["B"]
  end
  A["Start"]
  A --> B
  B -->|B| C
  B -- B --> A
  C --> B --> A
  style B fill:#f9f
  B
%% ---- Notes (managed by the Notes panel) ----
%% @note:node B about B, see @B and @C
`
    );
    await selectNode(page, 'B');
    await expect(page.locator('#modal-id')).toBeHidden();
    await page.locator('#et-rename-btn').click();
    // The prompt starts from the current id.
    await expect(page.locator('#modal-id')).toHaveValue('B');
    await page.locator('#modal-id').fill('LOGIN');
    await page.locator('#modal-confirm').click();
    await expect(page.locator('#modal-backdrop')).toBeHidden();

    await expect(node(page, 'LOGIN')).toBeVisible();
    expect(await source(page)).toBe(`flowchart TD
  subgraph s1["Group one"]
    LOGIN["Inside B"]
    C["B"]
  end
  A["Start"]
  A --> LOGIN
  LOGIN -->|B| C
  LOGIN -- B --> A
  C --> LOGIN --> A
  style LOGIN fill:#f9f
  LOGIN
%% ---- Notes (managed by the Notes panel) ----
%% @note:node LOGIN about B, see @LOGIN and @C
`);
    // Still selected, under its new name.
    await expect(page.locator('#element-toolbar')).toBeVisible();
    await expect(page.locator('#selection-layer rect')).toBeVisible();

    await page.keyboard.press('Control+z');
    await expect(node(page, 'B')).toBeVisible();
    expect(await source(page)).toContain('B["Inside B"]');
  });

  test('renames a subgraph, keeping its members and the edges aimed at it', async ({ page }) => {
    await openEditor(
      page,
      `flowchart TD
  subgraph s1["Group one"]
    B["Inside B"]
  end
  A["Start"]
  A --> s1
%% ---- Notes (managed by the Notes panel) ----
%% @note:subgraph s1 the group
`
    );
    await selectCluster(page, 's1');
    await rename(page, 'grp');

    await expect(cluster(page, 'grp')).toBeVisible();
    const code = await source(page);
    expect(code).toContain('subgraph grp["Group one"]');
    expect(code).toContain('B["Inside B"]');
    expect(code).toContain('A --> grp');
    expect(code).toContain('%% @note:subgraph grp the group');
    expect(code).not.toContain('s1');
  });

  test('leaves a longer id that merely starts the same alone', async ({ page }) => {
    await openEditor(
      page,
      `flowchart TD
  n1["One"]
  n10["Ten"]
  n1 --> n10
`
    );
    await selectNode(page, 'n1');
    await rename(page, 'first');

    expect(await source(page)).toBe(`flowchart TD
  first["One"]
  n10["Ten"]
  first --> n10
`);
  });

  test('refuses a taken, blank or malformed id, and treats the unchanged id as cancel', async ({
    page,
  }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    await selectNode(page, 'B');
    await page.locator('#et-rename-btn').click();

    await page.locator('#modal-id').fill('A');
    await page.locator('#modal-confirm').click();
    await expect(page.locator('#modal-error')).toContainText('already used');

    await page.locator('#modal-id').fill('');
    await page.locator('#modal-confirm').click();
    await expect(page.locator('#modal-error')).toContainText('required');

    await page.locator('#modal-id').fill('9lives');
    await page.locator('#modal-confirm').click();
    await expect(page.locator('#modal-error')).toContainText('Invalid');

    await page.locator('#modal-id').fill('B');
    await page.locator('#modal-confirm').click();
    await expect(page.locator('#modal-backdrop')).toBeHidden();
    expect(await source(page)).toBe(DIAGRAM_WITH_SUBGRAPH);
  });

  test('is offered for nodes and subgraphs, not for edges', async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    const midpoint = await pointOnEdge(page, 'L_A_B_');
    await page.mouse.click(midpoint.x, midpoint.y);
    await expect(page.locator('#et-arrow-btn')).toBeVisible();
    await expect(page.locator('#et-rename-btn')).toBeHidden();

    await selectNode(page, 'A');
    await expect(page.locator('#et-rename-btn')).toBeVisible();
    await selectCluster(page, 's1');
    await expect(page.locator('#et-rename-btn')).toBeVisible();
  });
});

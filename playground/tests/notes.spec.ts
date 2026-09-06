import { expect, test } from '@playwright/test';
import { DIAGRAM_WITH_SUBGRAPH, centerOf, drag, node, openEditor, selectNode, source } from './helpers';

test.describe('notes', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    await page.locator('#notes-panel-open').click();
    await expect(page.locator('#notes-panel')).toBeVisible();
  });

  test('a note is written into the diagram source itself', async ({ page }) => {
    await selectNode(page, 'B');
    await page.locator('.notes-textarea').click();
    await page.locator('.notes-textarea').pressSequentially('check the timeout here');
    // Committing happens on blur — clicking away is exactly how a user leaves the note.
    await node(page, 'A').click();

    expect(await source(page)).toContain('%% @note:node B check the timeout here');
  });

  test('dragging a node into the note drops in an @id reference', async ({ page }) => {
    await selectNode(page, 'B');
    const textarea = page.locator('.notes-textarea');
    await textarea.click();
    await textarea.pressSequentially('blocked by');

    await drag(page, await centerOf(node(page, 'D')), await centerOf(textarea));

    await expect(textarea).toHaveValue('blocked by @D');
    // The drop must not steal the selection — the note being written is still B's.
    await expect(page.locator('.notes-detail-header')).toHaveText('Node · B');
  });

  test('the reference is inserted at the caret, not just at the end', async ({ page }) => {
    await selectNode(page, 'B');
    const textarea = page.locator('.notes-textarea');
    await textarea.click();
    await textarea.pressSequentially('before after');
    // Put the caret between the two words.
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(6, 6);
      el.dispatchEvent(new Event('select', { bubbles: true }));
    });

    await drag(page, await centerOf(node(page, 'D')), await centerOf(textarea));

    await expect(textarea).toHaveValue('before @D after');
  });

  test('known references are clickable, unknown ones are not', async ({ page }) => {
    await selectNode(page, 'B');
    await page.locator('.notes-textarea').click();
    await page.locator('.notes-textarea').pressSequentially('see @D and @ghost');

    await expect(page.locator('.note-ref[data-ref-id="D"]')).toBeVisible();
    await expect(page.locator('.note-ref[data-ref-id="D"]')).not.toHaveClass(/unknown/);
    await expect(page.locator('.note-ref[data-ref-id="ghost"]')).toHaveClass(/unknown/);
  });

  test('clicking a reference jumps to that element', async ({ page }) => {
    await selectNode(page, 'B');
    await page.locator('.notes-textarea').click();
    await page.locator('.notes-textarea').pressSequentially('blocked by @D');

    await page.locator('.note-ref[data-ref-id="D"]').click();

    await expect(page.locator('.notes-detail-header')).toHaveText('Node · D');
    await expect(page.locator('#selection-layer rect')).toBeVisible();
    // Navigating must not have thrown the half-written note away.
    expect(await source(page)).toContain('%% @note:node B blocked by @D');
  });

  test('a note badge appears on the diagram once a note exists', async ({ page }) => {
    await selectNode(page, 'B');
    await page.locator('.notes-textarea').click();
    await page.locator('.notes-textarea').pressSequentially('note me');
    await node(page, 'A').click();

    await expect(page.locator('#note-badges g')).toHaveCount(1);
  });
});

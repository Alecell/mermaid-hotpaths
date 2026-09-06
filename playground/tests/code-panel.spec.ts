import { expect, test } from '@playwright/test';
import { DIAGRAM_WITH_SUBGRAPH, openEditor, selectNode } from './helpers';

/** A source long enough to scroll, with labels long enough to soft-wrap in the panel. */
function longSource(lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, i) => `  n${i + 1}["Node number ${i + 1} with a deliberately long label that wraps"]`
  );
  return `flowchart TD\n${body.join('\n')}\n`;
}

/**
 * The vertical offset of a source line, measured on the highlighted backdrop — the same
 * DOM the user is looking at, so it's a fair oracle for "did the panel scroll to the right
 * place" without re-using the editor's own arithmetic.
 */
async function measureLineTop(page: import('@playwright/test').Page, lineIndex: number) {
  return page.evaluate((index) => {
    const src = document.getElementById('src') as HTMLTextAreaElement;
    const backdropWrap = document.querySelector('.code-backdrop') as HTMLElement;
    const code = document.getElementById('code-highlight') as HTMLElement;
    const lines = src.value.split('\n');
    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += lines[i].length + 1;
    }
    const end = offset + Math.max(lines[index].length, 1);
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    let started = false;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue!.length;
      if (!started && seen + len >= offset) {
        range.setStart(node, offset - seen);
        started = true;
      }
      if (started && seen + len >= end) {
        range.setEnd(node, Math.min(end - seen, len));
        break;
      }
      seen += len;
    }
    const rect = range.getClientRects()[0];
    return {
      lineTop: rect.top - backdropWrap.getBoundingClientRect().top + backdropWrap.scrollTop,
      scrollTop: src.scrollTop,
      clientHeight: src.clientHeight,
    };
  }, lineIndex);
}

test.describe('code panel', () => {
  test('the highlighted backdrop is exactly as tall as the textarea', async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    // A source ending in a newline is the interesting case: the textarea renders the empty
    // final line, a <pre> doesn't — which used to leave the backdrop one line short, so at
    // the bottom of the file it painted every line one row off from the real text.
    await page.locator('#src').fill(longSource(60));

    const heights = await page.evaluate(() => ({
      textarea: document.getElementById('src')!.scrollHeight,
      backdrop: document.querySelector('.code-backdrop')!.scrollHeight,
    }));
    expect(heights.backdrop).toBe(heights.textarea);
  });

  test('stays aligned when scrolled to the very bottom', async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    await page.locator('#src').fill(longSource(60));

    // The invariant that actually broke: if the backdrop can't scroll as far as the
    // textarea, the last screenful is painted one line off from the real text.
    const maxScroll = await page.evaluate(() => {
      const src = document.getElementById('src') as HTMLTextAreaElement;
      const backdrop = document.querySelector('.code-backdrop') as HTMLElement;
      return {
        textarea: src.scrollHeight - src.clientHeight,
        backdrop: backdrop.scrollHeight - backdrop.clientHeight,
      };
    });
    expect(maxScroll.backdrop).toBe(maxScroll.textarea);
    expect(maxScroll.textarea).toBeGreaterThan(0);

    await page.locator('#src').evaluate((el: HTMLTextAreaElement) => {
      el.scrollTop = el.scrollHeight;
    });
    // The backdrop follows #src's own scroll event, which lands on a later frame.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const src = document.getElementById('src') as HTMLTextAreaElement;
          const backdrop = document.querySelector('.code-backdrop') as HTMLElement;
          return src.scrollTop - backdrop.scrollTop;
        })
      )
      .toBe(0);
  });

  test('"view in code" selects the element’s own line', async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    await selectNode(page, 'C');
    await page.locator('#et-code-btn').click();

    const selected = await page.evaluate(() => {
      const src = document.getElementById('src') as HTMLTextAreaElement;
      return src.value.slice(src.selectionStart, src.selectionEnd);
    });
    expect(selected.trim()).toBe('C["Inside C"]');
  });

  test('"view in code" scrolls the line into view even when lines wrap', async ({ page }) => {
    await openEditor(page, DIAGRAM_WITH_SUBGRAPH);
    await page.locator('#src').fill(longSource(60));
    // n55 sits far enough down that wrapped lines above it would throw off any
    // "line height × line number" estimate.
    await page.locator('#src').evaluate((el: HTMLTextAreaElement) => {
      el.scrollTop = 0;
    });

    const nodeEl = page.locator('#diagram svg g.node[id*="-flowchart-n55-"]');
    await nodeEl.scrollIntoViewIfNeeded().catch(() => undefined);
    await nodeEl.click();
    await page.locator('#et-code-btn').click();

    const { lineTop, scrollTop, clientHeight } = await measureLineTop(page, 55);
    expect(lineTop).toBeGreaterThanOrEqual(scrollTop);
    expect(lineTop).toBeLessThanOrEqual(scrollTop + clientHeight);
  });
});

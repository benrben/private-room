/** Shared helpers for the GH-issue regression specs. */

/** Load the mocked workspace fresh. `wipe` clears the per-room layout that
 * useLayout persists to localStorage, so a spec never inherits the previous
 * spec's rail/pane state. */
export async function openApp({ wipe = true } = {}) {
  await browser.url(browser.options.baseUrl);
  if (wipe) {
    await browser.execute(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("prLayout:")) localStorage.removeItem(k);
      }
    });
    await browser.url(browser.options.baseUrl);
  }
  await $(".activity-rail").waitForExist({ timeout: 20_000 });
}

/** Room actions (⋯) → a named item in the popup menu. Chained rather than a
 * single `.room-menu .pop-item=text` string: WebDriver's text selector has to
 * BE the whole selector, it can't be the tail of a descendant combinator. */
export async function roomMenu(itemText) {
  await (await $('button[aria-label="Open the room actions menu"]')).click();
  const item = await $(".room-menu").$(`.pop-item*=${itemText}`);
  await item.waitForDisplayed();
  await item.click();
}

/** A button inside `root` whose label contains `text`. */
export function buttonIn(root, text) {
  return $(root).$(`button*=${text}`);
}

/** Open a file from the library by its visible name. */
export async function openFile(name) {
  const row = await $(`.file-name=${name}`);
  await row.waitForExist({ timeout: 15_000 });
  await row.click();
}

/** The rendered width of an element, in CSS pixels. */
export async function widthOf(selector) {
  return browser.execute(
    (sel) => document.querySelector(sel)?.getBoundingClientRect().width ?? -1,
    selector,
  );
}

export async function copyText(text, browser = navigator, page = document) {
  try {
    if (browser.clipboard?.writeText) { await browser.clipboard.writeText(text); return true; }
  } catch { /* Clipboard permissions can fail; try the native selection fallback. */ }
  const input = page.createElement('textarea');
  input.value = text; input.setAttribute('readonly',''); input.className = 'clipboard-fallback';
  page.body.append(input); input.select();
  try { return page.execCommand('copy') === true; }
  catch { return false; }
  finally { input.remove(); }
}

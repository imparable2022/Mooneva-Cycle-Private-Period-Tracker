import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const out = 'web-evidence';
await mkdir(out, { recursive: true });
const base = 'http://127.0.0.1:4173';
for (let i = 0; ; i++) {
  try { if ((await fetch(base)).ok) break; } catch {}
  if (i === 60) throw new Error('Preview server did not become ready');
  await new Promise(r => setTimeout(r, 500));
}
const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const summary = [];
async function capture(id) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice']).analyze();
  await writeFile(out + '/' + id + '.axe.json', JSON.stringify(result, null, 2));
  await writeFile(out + '/' + id + '.aria.txt', await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: out + '/' + id + '.png', fullPage: true });
  summary.push({ id, violations: result.violations.map(({id, impact, nodes}) => ({id, impact, count: nodes.length})) });
}
async function button(name) { await page.getByRole('button', { name, exact: true }).click(); }
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Continue', exact: true }).waitFor();
  await capture('01-language');
  assert.equal(await page.getByRole('button', {name:'English',exact:true}).getAttribute('aria-pressed'), 'true');
  const sunday = page.getByRole('button',{name:'Sunday',exact:true});
  await sunday.focus();
  await page.keyboard.press('Space');
  assert.equal(await sunday.getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByRole('button',{name:'Monday',exact:true}).getAttribute('aria-pressed'),'false');
  await page.getByRole('button',{name:'Monday',exact:true}).click();
  await button('Continue');
  await page.getByRole('button', { name: 'Start Tracking', exact: true }).waitFor();
  await capture('02-privacy');
  await button('Start Tracking');
  await page.getByRole('button', { name: 'Next', exact: true }).waitFor();
  await capture('03-calibration');
  const unknown = page.getByRole('checkbox', {name:"I don't remember"});
  await unknown.focus();
  await page.keyboard.press('Space');
  assert.equal(await unknown.isChecked(),true);
  await page.getByRole('button',{name:'Increase Average Cycle Length'}).click();
  await page.getByRole('button',{name:'Decrease Average Cycle Length'}).click();
  await button('Next');
  await page.getByRole('button', { name: /Track Cycle/i }).click();
  assert.equal(await page.getByRole('button',{name:/Track Cycle/i}).getAttribute('aria-pressed'),'true');
  await capture('04-goal');
  await button('Continue');
  await capture('05-cycle-setup');
  await button('Continue');
  await page.getByRole('button', { name: 'Skip Tutorial', exact: true }).click();
  await page.getByRole('button', { name: "Let's Go", exact: true }).waitFor();
  await capture('06-get-started');
  await button("Let's Go");
  const nav = page.getByRole('navigation');
  await nav.waitFor();
  const dialog = page.getByRole('dialog', {name: "What's new"});
  if (await dialog.isVisible()) await dialog.getByRole('button', {name:'Close'}).click();
  await capture('07-calendar');
  const month = page.getByTestId('calendar-month-title');
  assert.ok((await month.getAttribute('aria-label')).includes((await month.textContent()).trim()));
  await month.click();
  assert.equal(await page.getByTestId('calendar-month-picker').locator('button[aria-pressed="true"]').count(),2);
  await page.getByTestId('calendar-month-picker').locator('button[aria-pressed="true"]').last().click();
  const today = page.locator('button[aria-current="date"]');
  assert.equal(await today.count(), 1);
  await today.click();
  await page.getByRole('tablist').waitFor();
  await capture('08-daily-log');
  await page.getByRole('tab',{name:'Notes',exact:true}).click();
  await page.getByRole('textbox',{name:'Notes',exact:true}).waitFor();
  await capture('08b-daily-notes');
  await page.getByRole('tablist').getByRole('tab').last().click();
  await capture('09-daily-log-last-tab');
  await nav.getByRole('button', { name:'Insights', exact:true }).click();
  await capture('10-insights');
  await nav.getByRole('button', { name:'Settings', exact:true }).click();
  await capture('11-settings');
  await page.getByRole('button',{name:/Export for Doctor/}).click();
  await page.getByRole('dialog').getByRole('button',{name:/Generate/i}).click();
  const symptoms = page.getByRole('checkbox',{name:'Include Symptoms'});
  await symptoms.waitFor({state:'attached'});
  await symptoms.focus();
  assert.equal(await symptoms.evaluate(e=>document.activeElement===e),true);
  const checked = await symptoms.isChecked();
  await page.keyboard.press('Space');
  assert.notEqual(await symptoms.isChecked(),checked);
  await capture('12-clinical-report');
  for (const result of summary) assert.ok(!result.violations.some(v=>v.id==='meta-viewport'), 'Zoom regression: '+result.id);
} finally {
  await writeFile(out + '/summary.json', JSON.stringify(summary, null, 2));
  await browser.close();
}
// Axe violations are recorded, not suppressed. Baseline is advisory;
// navigation failures are errors. A later reviewed regression gate is required.

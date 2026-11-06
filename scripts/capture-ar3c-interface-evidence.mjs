#!/usr/bin/env node

// Reproducible, local-only AR-3C browser evidence. This script drives the
// mounted production components through the development review entries. It
// never calls a model/provider, mutates accounting state, or submits feedback.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = String(process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '');
const OUTPUT = path.resolve(process.argv[3] || path.join(ROOT, 'docs/ar3c-interface-alpha-assets'));
const TEMP = mkdtempSync(path.join(os.tmpdir(), 'donna-ar3c-'));
const TEMP_PUBLIC = path.join(ROOT, 'public/.ar3c-evidence-temp');
const SESSION = `ar3c-evidence-${process.pid}`;
const AGENT_BROWSER = ['--yes', 'agent-browser@0.36.0'];
const EVIDENCE_DATE = '2026-09-02';

const LOCALES = Object.freeze([
  Object.freeze({ tag: 'en', direction: 'ltr', slug: 'en' }),
  Object.freeze({ tag: 'ar-AE', direction: 'rtl', slug: 'ar-ae' })
]);

const VIEWPORTS = Object.freeze([
  Object.freeze({ id: 'desktop-1280', width: 1280, height: 900, cssZoom: 1, zoomPercent: 100, label: '1280×900 · 100%' }),
  Object.freeze({ id: 'compact-390', width: 390, height: 844, cssZoom: 1, zoomPercent: 100, label: '390×844 · 100%' }),
  // Browser zoom reduces the CSS viewport. A 1280×900 window at 200% exposes
  // 640×450 CSS pixels and triggers the same responsive reflow as the real
  // browser/desktop zoom control; a body transform would not exercise it.
  Object.freeze({ id: 'zoom-200', width: 640, height: 450, cssZoom: 1, zoomPercent: 200, devicePixels: { width: 1280, height: 900 }, label: '1280×900 device · 200% zoom · 640×450 CSS' })
]);

const SURFACES = Object.freeze([
  Object.freeze({ id: 'settings', route: 'settings-production', expected: 'settings' }),
  Object.freeze({ id: 'lifecycle-mixed-row', route: 'workspaces', surface: 'lifecycle', expected: 'lifecycle' }),
  Object.freeze({ id: 'transaction-artifact', route: 'workspaces', surface: 'transaction', expected: 'transaction' }),
  Object.freeze({ id: 'financial-report', route: 'workspaces', surface: 'report', expected: 'report' }),
  Object.freeze({ id: 'donna-action-state', route: 'workspaces', surface: 'actions', expected: 'actions' }),
  Object.freeze({ id: 'feedback-modal', route: 'shell', surface: 'feedback', expected: 'feedback', modal: true }),
  Object.freeze({ id: 'toast', route: 'shell', surface: 'toast', expected: 'toast' }),
  Object.freeze({ id: 'upload-tray', route: 'shell', surface: 'upload', expected: 'upload' }),
  Object.freeze({ id: 'onboarding', route: 'shell', surface: 'onboarding', expected: 'onboarding' }),
  Object.freeze({ id: 'authentication', route: 'shell', surface: 'auth', expected: 'auth' }),
  Object.freeze({ id: 'failure-state', route: 'workspaces', surface: 'portal', portalScenario: 'states', expected: 'portal' }),
  Object.freeze({ id: 'owner-portal', route: 'workspaces', surface: 'portal', portalScenario: 'detail', expected: 'portal' })
]);

const BIDI_FIXTURES = Object.freeze([
  'شركة النور للتجارة',
  'AED 1,234.56',
  'د.إ ١٬٢٣٤٫٥٦',
  '(AED 25.00)',
  'INV-2026-001',
  'TRN 100483729100003',
  'AE070331234567890123456',
  'finance@example-ae.example',
  'https://donna.example/INV-2026-001',
  'فاتورة_INV-2026-001_شركة-النور.pdf'
]);

const browserEnv = {
  ...process.env,
  AGENT_BROWSER_SESSION: SESSION,
  AGENT_BROWSER_COLOR_SCHEME: 'light',
  AGENT_BROWSER_SCREENSHOT_FORMAT: 'jpeg',
  AGENT_BROWSER_SCREENSHOT_QUALITY: '84'
};

const run = (args, { allowFailure = false, env = browserEnv } = {}) => {
  const result = spawnSync('npx', [...AGENT_BROWSER, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw result.error || new Error([
      `agent-browser ${args.join(' ')} failed (${result.status})`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join('\n'));
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

const parseJsonOutput = (output) => {
  const trimmed = String(output || '').trim();
  if (!trimmed) throw new Error('Expected JSON output from agent-browser.');
  return JSON.parse(trimmed);
};

const evaluate = (source) => {
  const result = run(['eval', `JSON.stringify((() => { ${source} })())`]);
  const encoded = parseJsonOutput(result.stdout);
  return JSON.parse(encoded);
};

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const dimensions = (file) => {
  const result = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', file
  ], { encoding: 'utf8' });
  const stream = JSON.parse(result).streams[0];
  return { width: stream.width, height: stream.height };
};

const initScriptPath = path.join(TEMP, 'prepaint-observer.js');
writeFileSync(initScriptPath, `
(() => {
  const receipt = window.__ar3cEvidence = {
    consoleErrors: [],
    consoleWarnings: [],
    runtimeErrors: [],
    firstContentLocale: null,
    firstContentDirection: null
  };
  const wrap = (kind, target) => {
    const original = console[kind].bind(console);
    console[kind] = (...args) => {
      target.push(args.map((value) => value instanceof Error ? value.message : String(value)).join(' '));
      original(...args);
    };
  };
  wrap('error', receipt.consoleErrors);
  wrap('warn', receipt.consoleWarnings);
  addEventListener('error', (event) => receipt.runtimeErrors.push(String(event.error?.message || event.message || event.type)));
  addEventListener('unhandledrejection', (event) => receipt.runtimeErrors.push(String(event.reason?.message || event.reason || event.type)));
  const captureFirstContent = () => {
    if (receipt.firstContentLocale) return;
    const root = document.getElementById('root');
    if (!root || !root.textContent.trim()) return;
    receipt.firstContentLocale = document.documentElement.lang;
    receipt.firstContentDirection = document.documentElement.dir;
  };
  const observer = new MutationObserver(captureFirstContent);
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  addEventListener('DOMContentLoaded', captureFirstContent, { once: true });
})();
`);

rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });
rmSync(TEMP_PUBLIC, { recursive: true, force: true });
mkdirSync(TEMP_PUBLIC, { recursive: true });

const cells = [];
const failures = [];

const configureSurface = (surface, viewport) => evaluate(`
  const click = (selector) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error('Missing evidence control: ' + selector);
    target.click();
  };
  ${surface.surface ? `click('[data-surface-option="${surface.surface}"]');` : ''}
  ${surface.portalScenario ? `setTimeout(() => click('[data-portal-scenario="${surface.portalScenario}"]'), 0);` : ''}
  document.body.style.zoom = '${viewport.cssZoom}';
  return { configured: true };
`);

const inspectCell = (surface, locale, viewport) => evaluate(`
  const root = document.querySelector('[data-locale-preview]');
  const selectors = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [role="button"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])';
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const focusables = [...document.querySelectorAll(selectors)].filter(visible);
  const active = document.activeElement;
  const activeStyle = active ? getComputedStyle(active) : null;
  const activeRect = active?.getBoundingClientRect?.();
  const text = document.body.innerText;
  const resourceUrls = performance.getEntriesByType('resource').map((entry) => entry.name);
  const productionOptions = [...document.querySelectorAll('[data-interface-locale-selector] option')]
    .map((option) => ({ value: option.value, text: option.textContent, lang: option.lang, dir: option.dir }));
  return {
    lang: document.documentElement.lang,
    direction: document.documentElement.dir,
    datasetLocale: document.documentElement.dataset.interfaceLocale,
    firstContentLocale: window.__ar3cEvidence?.firstContentLocale || null,
    firstContentDirection: window.__ar3cEvidence?.firstContentDirection || null,
    rootPreview: root?.dataset.localePreview || null,
    rootSurface: root?.dataset.surface || null,
    bodyScrollWidth: document.scrollingElement.scrollWidth,
    bodyClientWidth: document.scrollingElement.clientWidth,
    horizontalOverflow: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1,
    positiveTabIndexes: [...document.querySelectorAll('[tabindex]')]
      .map((element) => Number(element.getAttribute('tabindex')))
      .filter((value) => value > 0),
    focusableCount: focusables.length,
    focusOrder: focusables.slice(0, 16).map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      text: (element.getAttribute('aria-label') || element.textContent || element.value || '').replace(/\\s+/g, ' ').trim().slice(0, 96)
    })),
    focused: active ? {
      tag: active.tagName.toLowerCase(),
      role: active.getAttribute('role'),
      text: (active.getAttribute('aria-label') || active.textContent || active.value || '').replace(/\\s+/g, ' ').trim().slice(0, 96),
      visible: Boolean(activeRect && activeRect.width > 0 && activeRect.height > 0 && activeRect.bottom >= 0 && activeRect.top <= innerHeight),
      focusVisible: active.matches?.(':focus-visible') || false,
      outlineStyle: activeStyle?.outlineStyle || '',
      outlineWidth: activeStyle?.outlineWidth || '',
      boxShadow: activeStyle?.boxShadow || ''
    } : null,
    bdiCount: document.querySelectorAll('bdi').length,
    explicitLanguageCount: document.querySelectorAll('[lang]').length,
    explicitDirectionCount: document.querySelectorAll('[dir]').length,
    arabicFontReady: document.fonts.check('16px "Donna Arabic UI"', 'العربية شركة النور'),
    arabicFontResources: resourceUrls.filter((url) => /NotoSansArabic-wdth-wght/i.test(url)),
    consoleErrors: window.__ar3cEvidence?.consoleErrors || [],
    consoleWarnings: window.__ar3cEvidence?.consoleWarnings || [],
    runtimeErrors: window.__ar3cEvidence?.runtimeErrors || [],
    productionOptions,
    bidiFixtures: ${JSON.stringify(BIDI_FIXTURES)}.map((fixture) => ({ fixture, present: text.includes(fixture) }))
  };
`);

try {
  run(['--init-script', initScriptPath, 'open', `${BASE_URL}/?locale-lab=settings-production`]);
  run(['network', 'route', 'https://**', '--abort']);
  run(['network', 'route', 'http://localhost/**', '--abort']);

  for (const locale of LOCALES) {
    for (const viewport of VIEWPORTS) {
      for (const [surfaceIndex, surface] of SURFACES.entries()) {
        const url = `${BASE_URL}/?locale-lab=${surface.route}`;
        run(['set', 'viewport', String(viewport.width), String(viewport.height)]);
        run(['open', url]);
        evaluate(`
          localStorage.setItem('donna.interface_preferences.v1', ${JSON.stringify(JSON.stringify({ locale: locale.tag, numberStyle: 'locale' }))});
          return true;
        `);
        run(['reload']);
        run(['wait', '350']);
        configureSurface(surface, viewport);
        run(['wait', surface.id.includes('portal') || surface.id === 'failure-state' ? '700' : '350']);

        if (!surface.modal) {
          evaluate(`
            document.body.setAttribute('tabindex', '-1');
            document.body.focus();
            document.body.removeAttribute('tabindex');
            return true;
          `);
        }
        run(['press', 'Tab']);

        const inspected = inspectCell(surface, locale, viewport);
        const axe = parseJsonOutput(run([
          'a11y', '--selector', '[data-locale-preview]',
          '--tags', 'wcag2a,wcag2aa,wcag21a,wcag21aa', '--json'
        ]).stdout).data;
        const cellName = `${String(surfaceIndex + 1).padStart(2, '0')}-${surface.id}-${locale.slug}-${viewport.id}.jpg`;
        const cellPath = path.join(TEMP, cellName);
        run(['screenshot', cellPath]);

        const cellFailures = [];
        if (inspected.lang !== locale.tag || inspected.direction !== locale.direction || inspected.datasetLocale !== locale.tag) {
          cellFailures.push(`document locale was ${inspected.lang}/${inspected.direction}/${inspected.datasetLocale}`);
        }
        if (inspected.firstContentLocale !== locale.tag || inspected.firstContentDirection !== locale.direction) {
          cellFailures.push(`first content painted as ${inspected.firstContentLocale}/${inspected.firstContentDirection}`);
        }
        if (inspected.rootSurface !== surface.expected) cellFailures.push(`surface was ${inspected.rootSurface}`);
        if (inspected.horizontalOverflow) cellFailures.push(`horizontal overflow ${inspected.bodyScrollWidth}>${inspected.bodyClientWidth}`);
        if (inspected.positiveTabIndexes.length) cellFailures.push('positive tabindex changed reading order');
        if (!inspected.focused?.visible || !inspected.focused?.focusVisible || inspected.focused?.outlineStyle === 'none') {
          cellFailures.push(`keyboard focus was not visibly retained: ${JSON.stringify(inspected.focused)}`);
        }
        if (locale.tag === 'ar-AE' && (!inspected.arabicFontReady || inspected.arabicFontResources.length === 0)) {
          cellFailures.push('offline Arabic UI font did not load from the local bundle');
        }
        if (inspected.consoleErrors.length || inspected.consoleWarnings.length || inspected.runtimeErrors.length) {
          cellFailures.push('browser console/runtime errors or warnings were captured');
        }
        if ((axe.counts?.violations || 0) !== 0) {
          cellFailures.push(`axe reported ${axe.counts.violations} violation groups: ${(axe.violations || []).map((entry) => entry.id).join(', ')}`);
        }
        if (surface.id === 'settings') {
          const expectedOptions = [
            { value: 'en', text: 'English', lang: 'en', dir: 'ltr' },
            { value: 'ar-AE', text: 'العربية — إصدار تجريبي', lang: 'ar-AE', dir: 'rtl' }
          ];
          if (JSON.stringify(inspected.productionOptions) !== JSON.stringify(expectedOptions)) {
            cellFailures.push(`production options drifted: ${JSON.stringify(inspected.productionOptions)}`);
          }
        }
        if (surface.id === 'donna-action-state') {
          const missing = inspected.bidiFixtures.filter((entry) => !entry.present).map((entry) => entry.fixture);
          if (missing.length) cellFailures.push(`missing bidi fixtures: ${missing.join(' | ')}`);
        }

        const receipt = {
          surface: surface.id,
          route: surface.route,
          locale: locale.tag,
          direction: locale.direction,
          viewport: {
            id: viewport.id,
            css_width: viewport.width,
            css_height: viewport.height,
            zoom_percent: viewport.zoomPercent,
            device_pixels: viewport.devicePixels || { width: viewport.width, height: viewport.height }
          },
          screenshot_sha256: sha256(cellPath),
          assertions: inspected,
          accessibility: {
            engine: `axe-core ${axe.axeVersion || '4.12.1'}`,
            passes: axe.counts?.passes || 0,
            violations: axe.counts?.violations || 0,
            incomplete: axe.counts?.incomplete || 0,
            violation_ids: (axe.violations || []).map((entry) => entry.id),
            incomplete_ids: (axe.incomplete || []).map((entry) => entry.id)
          },
          status: cellFailures.length ? 'FAIL' : 'PASS',
          failures: cellFailures
        };
        cells.push(receipt);
        if (cellFailures.length) failures.push(`${cellName}: ${cellFailures.join('; ')}`);
        process.stdout.write(`${receipt.status} ${cellName}${cellFailures.length ? ` — ${cellFailures.join('; ')}` : ''}\n`);
      }
    }
  }

  // Production selector lifecycle: use the actual select event, then reload to
  // prove persistence. A malformed preference must visibly fail to English.
  run(['set', 'viewport', '1280', '900']);
  run(['open', `${BASE_URL}/?locale-lab=settings-production`]);
  evaluate(`
    localStorage.setItem('donna.interface_preferences.v1', JSON.stringify({ locale: 'en', numberStyle: 'locale' }));
    return true;
  `);
  run(['reload']);
  run(['wait', '300']);
  run(['focus', '[data-interface-locale-selector]']);
  run(['select', '[data-interface-locale-selector]', 'ar-AE']);
  const immediateSwitch = evaluate(`
    const select = document.querySelector('[data-interface-locale-selector]');
    return {
      value: select.value,
      focused: document.activeElement === select,
      lang: document.documentElement.lang,
      direction: document.documentElement.dir,
      surface: document.querySelector('[data-locale-preview]')?.dataset.surface,
      stored: JSON.parse(localStorage.getItem('donna.interface_preferences.v1'))
    };
  `);
  run(['reload']);
  run(['wait', '300']);
  const persistedSwitch = evaluate(`
    return {
      value: document.querySelector('[data-interface-locale-selector]').value,
      lang: document.documentElement.lang,
      direction: document.documentElement.dir,
      firstContentLocale: window.__ar3cEvidence?.firstContentLocale,
      firstContentDirection: window.__ar3cEvidence?.firstContentDirection
    };
  `);
  evaluate(`
    localStorage.setItem('donna.interface_preferences.v1', '{broken');
    return true;
  `);
  run(['reload']);
  run(['wait', '300']);
  const invalidPreferenceFallback = evaluate(`
    return {
      lang: document.documentElement.lang,
      direction: document.documentElement.dir,
      fallback: document.documentElement.dataset.localeFallback,
      alertVisible: Boolean(document.querySelector('[role="alert"]')),
      messageKeysVisible: /(?:settings|mounted|portal|feedback)\\.[a-z]/.test(document.body.innerText)
    };
  `);
  if (JSON.stringify(immediateSwitch) !== JSON.stringify({
    value: 'ar-AE', focused: true, lang: 'ar-AE', direction: 'rtl', surface: 'settings',
    stored: { locale: 'ar-AE', numberStyle: 'locale' }
  })) failures.push(`immediate production switch failed: ${JSON.stringify(immediateSwitch)}`);
  if (JSON.stringify(persistedSwitch) !== JSON.stringify({
    value: 'ar-AE', lang: 'ar-AE', direction: 'rtl', firstContentLocale: 'ar-AE', firstContentDirection: 'rtl'
  })) failures.push(`persisted production switch failed: ${JSON.stringify(persistedSwitch)}`);
  if (JSON.stringify(invalidPreferenceFallback) !== JSON.stringify({
    lang: 'en', direction: 'ltr', fallback: 'preferences_invalid', alertVisible: true, messageKeysVisible: false
  })) failures.push(`invalid preference fallback failed: ${JSON.stringify(invalidPreferenceFallback)}`);

  // Changing locale above a mounted form must preserve the component instance,
  // draft, selected surface, focus, and scroll position.
  run(['open', `${BASE_URL}/?locale-lab=mounted`]);
  evaluate(`
    localStorage.setItem('donna.interface_preferences.v1', JSON.stringify({ locale: 'en', numberStyle: 'locale' }));
    return true;
  `);
  run(['reload']);
  run(['wait', '300']);
  run(['fill', '.firm-field textarea', 'شركة النور للتجارة · preserved draft']);
  run(['focus', '.firm-field textarea']);
  const preservation = evaluate(`
    const input = document.querySelector('.firm-field textarea');
    const before = { value: input.value, scrollX, scrollY };
    document.querySelector('[data-locale-option="ar-AE"]').click();
    return {
      before,
      after: { value: input.value, scrollX, scrollY },
      focused: document.activeElement === input,
      connected: input.isConnected,
      surface: document.querySelector('[data-locale-preview]').dataset.surface,
      lang: document.documentElement.lang,
      direction: document.documentElement.dir
    };
  `);
  if (!preservation.focused || !preservation.connected || preservation.before.value !== preservation.after.value
    || preservation.before.scrollX !== preservation.after.scrollX || preservation.before.scrollY !== preservation.after.scrollY
    || preservation.surface !== 'venture' || preservation.lang !== 'ar-AE' || preservation.direction !== 'rtl') {
    failures.push(`mounted state preservation failed: ${JSON.stringify(preservation)}`);
  }

  const sheets = [];
  for (const locale of LOCALES) {
    for (const viewport of VIEWPORTS) {
      const sheetCells = cells.filter((cell) => cell.locale === locale.tag && cell.viewport.id === viewport.id);
      const figures = sheetCells.map((cell, index) => {
        const source = path.join(TEMP, `${String(index + 1).padStart(2, '0')}-${cell.surface}-${locale.slug}-${viewport.id}.jpg`);
        const targetName = `${String(index + 1).padStart(2, '0')}-${cell.surface}.jpg`;
        copyFileSync(source, path.join(TEMP_PUBLIC, targetName));
        return `<figure><figcaption>${String(index + 1).padStart(2, '0')} · ${cell.surface}</figcaption><img src="./${targetName}" alt="${cell.surface}"></figure>`;
      }).join('\n');
      const htmlName = `sheet-${locale.slug}-${viewport.id}.html`;
      writeFileSync(path.join(TEMP_PUBLIC, htmlName), `<!doctype html>
<html lang="${locale.tag}" dir="${locale.direction}"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html{background:#efefec;color:#171513;font-family:system-ui,sans-serif}body{margin:0;padding:20px}header{direction:ltr;text-align:left;margin:0 0 16px}h1{font-size:22px;margin:0 0 4px}.meta{font:13px/1.4 ui-monospace,monospace;color:#555}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;direction:ltr}figure{margin:0;background:#fff;border:1px solid #cbc9c5;border-radius:8px;overflow:hidden}figcaption{padding:7px 9px;border-block-end:1px solid #ddd;font:12px/1.3 ui-monospace,monospace;text-align:left}img{display:block;width:100%;height:auto}
</style></head><body><header><h1>AR-3C Arabic Preview Alpha interface matrix</h1><div class="meta">locale=${locale.tag} · direction=${locale.direction} · viewport=${viewport.label} · 12/12 mounted states</div></header><main class="grid">${figures}</main></body></html>`);
      const sheetName = `interface-matrix-${locale.slug}-${viewport.id}.jpg`;
      const sheetPath = path.join(OUTPUT, sheetName);
      run(['set', 'viewport', '1440', '900']);
      run(['open', `${BASE_URL}/.ar3c-evidence-temp/${htmlName}`]);
      run(['wait', '500']);
      run(['screenshot', '--full', sheetPath]);
      const metadata = dimensions(sheetPath);
      sheets.push({
        file: sheetName,
        locale: locale.tag,
        direction: locale.direction,
        viewport: viewport,
        tile_order: sheetCells.map((cell) => cell.surface),
        sha256: sha256(sheetPath),
        bytes: readFileSync(sheetPath).length,
        width: metadata.width,
        height: metadata.height
      });
    }
  }

  const browserVersion = run(['eval', 'navigator.userAgent']).stdout.replace(/^"|"$/g, '');
  const fontPath = path.join(ROOT, 'server/donna/outbound/fonts/NotoSansArabic-wdth-wght.ttf');
  const manifest = {
    schema: 'donna.ar3c.interface-alpha-evidence.v1',
    evidence_date: EVIDENCE_DATE,
    source_base_sha: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    capture: {
      base_url: 'local Vite development server',
      browser_driver: 'agent-browser 0.36.0',
      browser_user_agent: browserVersion,
      accessibility_engine: 'axe-core 4.12.1',
      node: process.version,
      icu: process.versions.icu,
      cldr: process.versions.cldr,
      network_policy: 'external HTTP(S) aborted; only 127.0.0.1 assets allowed',
      model_provider_calls: 0,
      external_sends: 0
    },
    matrix: {
      locales: LOCALES,
      viewports: VIEWPORTS,
      surfaces: SURFACES.map(({ modal: _modal, ...surface }) => surface),
      expected_cells: LOCALES.length * VIEWPORTS.length * SURFACES.length,
      captured_cells: cells.length,
      pass_cells: cells.filter((cell) => cell.status === 'PASS').length,
      failed_cells: cells.filter((cell) => cell.status === 'FAIL').length
    },
    production_switch_receipt: {
      immediate: immediateSwitch,
      persisted_after_reload: persistedSwitch,
      invalid_preference_fallback: invalidPreferenceFallback,
      mounted_state_preservation: preservation
    },
    offline_arabic_font: {
      source: 'server/donna/outbound/fonts/NotoSansArabic-wdth-wght.ttf',
      sha256: sha256(fontPath),
      licensed_by: 'server/donna/outbound/fonts/OFL.txt',
      every_arabic_cell_loaded_local_font: cells.filter((cell) => cell.locale === 'ar-AE')
        .every((cell) => cell.assertions.arabicFontReady && cell.assertions.arabicFontResources.length > 0)
    },
    bidi_fixtures: BIDI_FIXTURES,
    contact_sheets: sheets,
    cells,
    result: failures.length ? 'FAIL' : 'PASS',
    failures
  };
  writeFileSync(path.join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (failures.length) {
    process.stderr.write(`\nAR-3C evidence failed (${failures.length}):\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`AR-3C evidence PASS: ${cells.length} cells, ${sheets.length} contact sheets.\n`);
  }
} finally {
  run(['close'], { allowFailure: true });
  rmSync(TEMP_PUBLIC, { recursive: true, force: true });
  rmSync(TEMP, { recursive: true, force: true });
}

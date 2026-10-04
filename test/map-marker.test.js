import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('map markers leave MapLibre positioning intact', async () => {
  const css = await readFile(new URL('../css/base.css', import.meta.url), 'utf8');
  const markerRule = css.match(/\.map-marker\s*\{([^}]*)\}/)?.[1];

  assert.ok(markerRule, 'the shared map marker rule exists');
  assert.doesNotMatch(markerRule, /\bposition\s*:/,
    'the shared marker rule must not override MapLibre absolute positioning');
});

test('index fingerprints the shared stylesheet so deployed mobile clients refresh it', async () => {
  const css = await readFile(new URL('../css/base.css', import.meta.url));
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const fingerprint = createHash('sha256').update(css).digest('hex').slice(0, 12);

  assert.ok(html.includes(`href="css/base.css?v=${fingerprint}"`),
    'the stylesheet URL must change whenever its contents change');
});

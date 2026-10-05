'use strict';
// Source PR25 packaging regression retained: the actual canonical helper is
// loaded once and Cloud Build escapes its dollar literals; no second reaper.
const fs = require('node:fs');
const path = require('node:path');
test('canonical helper contains no worker GitHub management path', () => {
  const helper = fs.readFileSync(path.join(__dirname, 'runner-cleanup.sh'), 'utf8');
  expect(helper).toContain('print-identity-token');
  expect(helper).toContain('CLEANUP_CONTROLLER_URL');
  expect(helper).not.toContain('secrets');
  expect(helper).not.toContain('api.github.com');
  expect(helper).not.toContain("'compute', 'instances', 'delete'");
});

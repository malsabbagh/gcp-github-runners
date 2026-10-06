const fs = require('node:fs');
const path = require('node:path');
// Runtime behavior is exercised by tests/lifecycle/test_cleanup.py with every
// cloud/HTTP operation intercepted. These checks protect the packaging seam.
test('bundles the same reviewed reaper as Terraform uses', () => {
  const bundled = fs.readFileSync(path.join(__dirname, 'runner-cleanup.sh'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '../../cloudbuild/runner-cleanup.sh'), 'utf8');
  expect(bundled).toBe(shared);
});

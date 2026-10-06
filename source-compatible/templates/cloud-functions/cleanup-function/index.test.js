const fs = require('node:fs');
const path = require('node:path');
const mockCloudBuild = { createBuild: jest.fn().mockResolvedValue([{ name: 'cleanup-build' }]) };
const mockFramework = { http: jest.fn(), cloudEvent: jest.fn() };
jest.mock('@google-cloud/cloudbuild', () => ({ CloudBuildClient: jest.fn(() => mockCloudBuild) }));
jest.mock('@google-cloud/functions-framework', () => mockFramework);
process.env.GOOGLE_CLOUD_PROJECT = 'PARITY_INPUT_168';
const { cleanupOldRunners } = require('./index');
const httpHandler = mockFramework.http.mock.calls[0][1];
const eventHandler = mockFramework.cloudEvent.mock.calls[0][1];
beforeEach(() => { mockCloudBuild.createBuild.mockReset().mockResolvedValue([{ name: 'cleanup-build' }]); });

test('submits the actual conservative reaper with Cloud Build dollar escaping', async () => {
  expect(await cleanupOldRunners(4)).toEqual({ name: 'cleanup-build' });
  const submitted = mockCloudBuild.createBuild.mock.calls[0][0];
  expect(submitted.projectId).toBe('PARITY_INPUT_168');
  expect(submitted.build.options.logging).toBe('CLOUD_LOGGING_ONLY');
  const raw = fs.readFileSync(path.join(__dirname, 'runner-cleanup.sh'), 'utf8');
  expect(submitted.build.steps[0].args[1]).toBe(
    'echo "Cleaning up runner instances older than 4 hours..."\nexport MAX_AGE_HOURS=4\n' + raw.replace(/\$/g, '$$$$'));
});
test('loads its required bundled reaper once rather than for each invocation', async () => {
  const read=jest.spyOn(fs,'readFileSync');
  try {
    let cleanup;
    jest.isolateModules(()=>{cleanup=require('./index').cleanupOldRunners;});
    await cleanup();await cleanup();
    expect(read.mock.calls.filter(([name])=>String(name).endsWith('/runner-cleanup.sh'))).toHaveLength(1);
  } finally {read.mockRestore();}
});
test('missing bundled reaper fails initialization before registering handlers or submitting builds', () => {
  const realRead=fs.readFileSync;
  const read=jest.spyOn(fs,'readFileSync').mockImplementation((name,...args)=>{
    if(String(name).endsWith('/runner-cleanup.sh')) throw Object.assign(new Error('ENOENT: runner-cleanup.sh'),{code:'ENOENT'});
    return realRead(name,...args);
  });
  const handlers=mockFramework.http.mock.calls.length+mockFramework.cloudEvent.mock.calls.length;
  try {
    expect(()=>jest.isolateModules(()=>require('./index'))).toThrow('ENOENT: runner-cleanup.sh');
    expect(mockFramework.http.mock.calls.length+mockFramework.cloudEvent.mock.calls.length).toBe(handlers);
    expect(mockCloudBuild.createBuild).not.toHaveBeenCalled();
  } finally {read.mockRestore();}
});
test.each([-1, NaN, Infinity, 1.5, '2', 8761, Number.MAX_SAFE_INTEGER])('rejects invalid age %p before submitting', async age => {
  await expect(cleanupOldRunners(age)).rejects.toThrow('maxAge');
  expect(mockCloudBuild.createBuild).not.toHaveBeenCalled();
});
test('propagates build submission failure', async () => {
  mockCloudBuild.createBuild.mockRejectedValueOnce(new Error('offline build failure'));
  await expect(cleanupOldRunners()).rejects.toThrow('offline build failure');
});
function response() { const res = { status: jest.fn(), send: jest.fn() }; res.status.mockReturnValue(res); return res; }
test.each(['-1', '2.5', '2suffix', 'NaN', '9007199254740992', '8761'])('HTTP rejects invalid maxAge %s', async maxAge => {
  const res = response(); await httpHandler({ query: { maxAge } }, res);
  expect(res.status).toHaveBeenCalledWith(400); expect(mockCloudBuild.createBuild).not.toHaveBeenCalled();
});
test.each([undefined, '0', '4'])('HTTP submits age %s and acknowledges submission', async maxAge => {
  const res = response(); await httpHandler({ query: { maxAge } }, res);
  expect(res.status).toHaveBeenCalledWith(200); expect(mockCloudBuild.createBuild).toHaveBeenCalledTimes(1);
});
test('HTTP reports submission failure', async () => {
  mockCloudBuild.createBuild.mockRejectedValueOnce(new Error('offline build failure'));
  const res = response(); await httpHandler({ query: {} }, res); expect(res.status).toHaveBeenCalledWith(500);
});
test('scheduled handler submits default age and propagates failure', async () => {
  await eventHandler({}); expect(mockCloudBuild.createBuild).toHaveBeenCalledTimes(1);
  mockCloudBuild.createBuild.mockRejectedValueOnce(new Error('offline failure'));
  await expect(eventHandler({})).rejects.toThrow('offline failure');
});

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
const {configuration,createCleanupInvoker}=require('./index');
test('OIDC scheduler adapter posts canonical empty JSON and exact origin audience without redirect',async()=> {
  const env={CLEANUP_CONTROLLER_URL:'https://controller.example/management/scheduled',CONTROLLER_AUDIENCE:'https://controller.example'};
  const request=jest.fn(async()=>({status:200,data:{ok:true,code:'MANAGEMENT_HANDLED',status:'completed'}}));
  const factory=jest.fn(async()=>({request})),invoke=createCleanupInvoker({environment:env,identityClientFactory:factory});
  expect(await invoke()).toEqual({status:'completed'});await invoke();expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith(env.CONTROLLER_AUDIENCE);expect(request).toHaveBeenCalledWith(expect.objectContaining({url:env.CLEANUP_CONTROLLER_URL,data:{},maxRedirects:0}));
});
test.each([{},{CLEANUP_CONTROLLER_URL:'http://controller.example/management/scheduled'}, {CLEANUP_CONTROLLER_URL:'https://evil@controller.example/management/scheduled',CONTROLLER_AUDIENCE:'https://controller.example'}, {CLEANUP_CONTROLLER_URL:'https://controller.example/management/scheduled?q=x',CONTROLLER_AUDIENCE:'https://controller.example'}, {CLEANUP_CONTROLLER_URL:'https://controller.example/management/scheduled',CONTROLLER_AUDIENCE:'https://other.example'}])('invalid cleanup identity/configuration fails before invocation %j',env=>expect(()=>configuration(env)).toThrow());
test.each([undefined,{status:301,data:{}},{status:200,data:{ok:true,code:'MANAGEMENT_HANDLED',status:'retired'}},{status:200,data:{ok:false}}])('unknown cleanup provider response preserves resources %j',async value=> {
  const invoke=createCleanupInvoker({environment:{CLEANUP_CONTROLLER_URL:'https://controller.example/management/scheduled',CONTROLLER_AUDIENCE:'https://controller.example'},identityClientFactory:async()=>({request:async()=>value})});
  await expect(invoke()).rejects.toThrow('cleanup_invocation_uncertain');
});

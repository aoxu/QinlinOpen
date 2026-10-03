import test from 'node:test';
import assert from 'node:assert/strict';
import {observeLogin,historyText} from '../public/login-history.js';

test('history persists first failure time and does not mistake status or network failures for upstream validation',()=>{
  let records=observeLogin([],{loginId:'a',loggedInAt:1000,observedAt:1000,loggedIn:true},'login',true,'r1');
  observeLogin(records,{loginId:'a',observedAt:2000,loggedIn:true},'status',true);
  assert.equal(records[0].lastVerifiedAt,undefined);
  observeLogin(records,{loginId:'a',observedAt:3000,loggedIn:true},'doors',false);
  assert.equal(records[0].endedAt,undefined);
  observeLogin(records,{loginId:'a',observedAt:4000,loggedIn:true},'doors',true);
  assert.equal(records[0].lastVerifiedAt,4000);
  const failure={loginId:'a',observedAt:6000,detectedAt:5000,loggedIn:false,reason:'upstream_unauthorized',message:'亲邻拒绝凭据',businessCode:401};
  observeLogin(records,failure,'doors',false,'r2'); observeLogin(records,{...failure,observedAt:9000},'status',true);
  assert.equal(records[0].events.length,1); assert.equal(records[0].events[0].elapsedMs,4000);
  assert.match(historyText(records),/亲邻拒绝凭据/);
});

test('missing cookies close the previous login, and renewed access can restore the same login',()=>{
  const info={loginId:'a',loggedInAt:1000,observedAt:1000,loggedIn:true};
  let records=observeLogin([],info,'login',true);
  observeLogin(records,{observedAt:5000,loggedIn:false,reason:'cookie_unavailable',message:'无法确定'},'status',true);
  assert.equal(records[0].endedAt,5000);
  observeLogin(records,{...info,observedAt:6000},'unlock',true);
  assert.equal(records[0].endedAt,undefined); assert.equal(records[0].events.length,1);
  records=observeLogin(records,{...info,loginId:'b',loggedInAt:7000,observedAt:7000},'login',true);
  assert.equal(records[1].events.at(-1).reason,'replaced');
  const legacy=observeLogin([],{observedAt:9000,loggedIn:true},'status',true);
  assert.equal(legacy.length,0);
});

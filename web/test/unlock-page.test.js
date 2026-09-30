import test from 'node:test';
import assert from 'node:assert/strict';

test('unlock UI requires verification, consumes each token and respects server cooldown',async()=>{
  class Element {
    constructor() {this.value='';this.listeners={};this.children=[];this.dataset={};this.disabled=false;}
    addEventListener(name,handler) {this.listeners[name]=handler;}
    append(...items) {this.children.push(...items);}
    replaceChildren(...items) {this.children=items;}
    setAttribute() {}
  }
  const elements = new Map();
  const get = id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let widgetOptions, resets=0; const calls=[];
  const original={document:globalThis.document,window:globalThis.window,sessionStorage:globalThis.sessionStorage,fetch:globalThis.fetch,setInterval:globalThis.setInterval};
  const sdk={render:(selector,options)=>{assert.equal(selector,'#turnstile-widget');widgetOptions=options;return 'widget';},reset:()=>{resets++;}};
  globalThis.document={getElementById:get,createElement:()=>new Element(),querySelectorAll:selector=>selector==='button'?[get('unlock-submit')]:[],
    head:{append(script) {assert.match(script.src,/challenges.cloudflare.com/);globalThis.window.turnstile=sdk;script.onload();}}};
  // A named DOM element must never be mistaken for the SDK global.
  globalThis.window={turnstile:new Element()};
  globalThis.sessionStorage={getItem:()=>null,setItem(){}};
  globalThis.setInterval=()=>0;
  globalThis.fetch=async(path,options)=>{
    calls.push({path,body:options?.body && JSON.parse(options.body)});
    if (path.endsWith('/status')) return Response.json({unlocked:false,loggedIn:false,turnstileSitekey:'fake-sitekey'});
    return Response.json({error:'冷却中',retryAfter:60},{status:429});
  };
  const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
  try {
    await import('../public/app.js');await settle();
    assert.equal(widgetOptions.action,'unlock');
    assert.equal(get('unlock-submit').disabled,true);
    get('unlock-form').listeners.submit({preventDefault(){}});await settle();
    assert.equal(calls.filter(c=>c.path.endsWith('/unlock')).length,0);
    widgetOptions.callback('fresh-token');
    assert.equal(get('unlock-submit').disabled,false);
    get('password').value='wrong-password-long-enough';
    get('unlock-form').listeners.submit({preventDefault(){}});await settle();
    assert.equal(calls.at(-1).body.turnstileToken,'fresh-token');assert.equal(resets,1);
    assert.equal(get('unlock-submit').disabled,true);assert.match(get('unlock-submit').textContent,/秒后重试/);
    widgetOptions.callback('new-token');
    assert.equal(get('unlock-submit').disabled,true);
    get('unlock-form').listeners.submit({preventDefault(){}});await settle();
    assert.equal(calls.filter(c=>c.path.endsWith('/unlock')).length,1);
    assert.ok(!get('log-output').textContent.includes('fresh-token'));
  } finally {Object.assign(globalThis,original);}
});

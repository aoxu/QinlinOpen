import test from 'node:test';
import assert from 'node:assert/strict';

test('page auto-opens once on load, saves switches without opening, and list refresh does not open',async()=>{
  class Element {
    constructor() {this.value='';this.children=[];this.listeners={};this.dataset={};}
    addEventListener(name,handler) {this.listeners[name]=handler;}
    append(...items) {this.children.push(...items);}
    replaceChildren(...items) {this.children=items;}
    setAttribute() {}
  }
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const calls=[];
  const original={document:globalThis.document,sessionStorage:globalThis.sessionStorage,fetch:globalThis.fetch,setInterval:globalThis.setInterval};
  globalThis.document={getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]};
  globalThis.sessionStorage={getItem:()=>null,setItem(){}};
  globalThis.setInterval=()=>0;
  globalThis.fetch=async(path,options)=>{
    calls.push(path);
    const preferences={selectedIds:['1:2'],autoOpen:true};
    if(path.endsWith('/status'))return Response.json({unlocked:true,loggedIn:true,openEnabled:true});
    if(path.endsWith('/doors'))return Response.json({doors:[{stableId:'1:2',doorName:'测试门',communityName:'测试小区'}],preferences});
    if(path.endsWith('/preferences'))return Response.json({preferences:{...preferences,...JSON.parse(options.body)}});
    return Response.json({results:[{doorName:'测试门',ok:true,message:'请求已接受'}],loggedIn:true});
  };
  const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
  try {
    await import('../public/app.js'); await settle();
    assert.equal(calls.filter(p=>p.endsWith('/open-selected')).length,1);
    assert.equal(get('auto-open').checked,true);
    assert.match(get('open-selected').textContent,/1/);
    get('refresh').listeners.click(); await settle();
    get('auto-open').checked=false; get('auto-open').listeners.change(); await settle();
    assert.equal(get('auto-open').checked,false);
    assert.equal(calls.filter(p=>p.endsWith('/open-selected')).length,1);
    get('open-selected').listeners.click(); await settle();
    assert.equal(calls.filter(p=>p.endsWith('/open-selected')).length,2);
  } finally {Object.assign(globalThis,original);}
});

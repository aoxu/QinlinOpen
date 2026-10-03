import test from 'node:test';
import assert from 'node:assert/strict';

test('shortcut page loads without opening, binds, displays credential and clears it on revoke/leave',async()=>{
  class Element {
    constructor(){this.value='';this.children=[];this.listeners={};this.hidden=true;}
    addEventListener(name,fn){this.listeners[name]=fn;}
    append(item){this.children.push(item);}
    replaceChildren(){this.children=[];}
  }
  const elements=new Map(),events={},calls=[];
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const original={document:globalThis.document,window:globalThis.window,location:globalThis.location,fetch:globalThis.fetch};
  let bound=false;
  globalThis.document={getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]};
  globalThis.window={addEventListener:(name,fn)=>events[name]=fn};
  globalThis.location={origin:'https://test.example'};
  globalThis.fetch=async(path)=>{
    calls.push(path);
    if(path==='/api/status') return Response.json({unlocked:true,loggedIn:true});
    if(path==='/api/shortcut/status') return Response.json({bound,expiresAt:Date.now()+60000});
    if(path==='/api/doors') return Response.json({doors:[{stableId:'1:2',doorName:'测试门'}],preferences:{selectedIds:['1:2']}});
    if(path==='/api/shortcut/bind'){bound=true;return Response.json({token:'test-credential'});}
    if(path==='/api/shortcut/revoke'){bound=false;return Response.json({ok:true});}
    throw new Error('Unexpected endpoint '+path);
  };
  try {
    await import('../public/shortcuts.js');
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(get('bind').disabled,false);
    assert.equal(get('selected-doors').children[0].textContent,'测试门');
    await get('bind').listeners.click();
    assert.equal(get('authorization').value,'Bearer test-credential');
    assert.equal(get('endpoint').value,'https://test.example/api/shortcut/open-selected');
    assert.equal(get('credentials').hidden,false);
    events.pagehide(); assert.equal(get('authorization').value,'');
    await get('revoke').listeners.click();
    assert.equal(get('credentials').hidden,true); assert.equal(bound,false);
    assert.ok(!calls.some(path=>path.includes('open-selected')));
  } finally {Object.assign(globalThis,original);}
});

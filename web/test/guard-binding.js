import { UnlockGuard } from '../src/unlock-guard.js';
export function guardContext(values = new Map()) {
  let pending = Promise.resolve();
  return {storage:{
    get:async key=>structuredClone(values.get(key)),
    put:async(key,value)=>values.set(key,structuredClone(value)),
    deleteAll:async()=>values.clear(), setAlarm:async time=>values.set('alarm',time)
  },blockConcurrencyWhile(task) {
    const result = pending.then(task); pending = result.catch(()=>{}); return result;
  }};
}
export function guardBinding(env, verifier = async token=>token === 'valid') {
  const objects = new Map();
  return {idFromName:name=>name,get(name) {
    if (!objects.has(name)) objects.set(name,new UnlockGuard(guardContext(),env,verifier));
    return objects.get(name);
  }};
}

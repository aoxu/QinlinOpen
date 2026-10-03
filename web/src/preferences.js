// One persistent object per account; shortcut sessions are encrypted by the Worker.
export class DoorPreferences {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const preferences = await this.ctx.storage.get('preferences') ?? {selectedIds:[], autoOpen:false};
      if (new URL(request.url).pathname === '/shortcut/refresh') {
        const saved = await this.ctx.storage.get('shortcut');
        if (saved?.id && saved.exp > Date.now()) {
          const {session} = await request.json();
          await this.ctx.storage.put('shortcut', {...saved,session});
        }
        return Response.json({ok:true});
      }
      if (new URL(request.url).pathname === '/shortcut') {
        if (request.method === 'POST') {
          const value = await request.json();
          await this.ctx.storage.put('shortcut', value);
        }
        return Response.json(await this.ctx.storage.get('shortcut') ?? null);
      }
      if (request.method === 'POST') {
        const update = await request.json();
        if (typeof update.autoOpen === 'boolean') preferences.autoOpen = update.autoOpen;
        if (update.stableId) {
          const ids = new Set(preferences.selectedIds);
          if (update.selected) ids.add(update.stableId); else ids.delete(update.stableId);
          if (ids.size > 100) return Response.json({error:'最多选择 100 把钥匙'}, {status:400});
          preferences.selectedIds = [...ids];
        }
        await this.ctx.storage.put('preferences', preferences);
      }
      return Response.json(preferences);
    });
  }
}

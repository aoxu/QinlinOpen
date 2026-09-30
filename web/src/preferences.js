// One persistent object per account; no credentials are stored here.
export class DoorPreferences {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const preferences = await this.ctx.storage.get('preferences') ?? {selectedIds:[], autoOpen:false};
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

import path from 'node:path';
import fs from 'node:fs/promises';
import { fail } from './colloidalReader.js';

// Explicit maintenance action, not a timer started by the API. Clearing a photo
// never removes its SHA, size, result, entry linkage or failure history.
export async function purgeOriginals({ db, root, days, apply = false, now = new Date(), batchSize = 100 }) {
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw fail(400, 'RETENTION_UNSET', '请先明确配置照片留存天数');
    const before = new Date(now.getTime() - days * 86400000);
    let cursor, examined = 0, bytes = 0, purged = 0;
    for (;;) {
        const rows = await db.colloidalAttempt.findMany({ where: { created_at: { lt: before }, photo_state: { in: ['present', 'purging'] }, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: batchSize });
        if (!rows.length) break;
        for (const row of rows) {
            cursor = row.id;
            if (!/^[a-f0-9]{24}\/[a-f0-9-]{36}\.(jpg|png|webp|heic)$/i.test(row.photo_key || '')) throw fail(500, 'INVALID_PHOTO_KEY', '照片索引不合法，清理已停止');
            examined++; bytes += row.photo_size;
            if (!apply) continue;
            await db.colloidalAttempt.update({ where: { id: row.id }, data: { photo_state: 'purging' } });
            try { await fs.unlink(path.join(root, row.photo_key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            await db.colloidalAttempt.update({ where: { id: row.id }, data: { photo_state: 'purged', photo_purged_at: now } });
            purged++;
        }
    }
    return { before: before.toISOString(), apply, examined, bytes, purged };
}

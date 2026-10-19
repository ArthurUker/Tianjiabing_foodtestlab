// Operator command. Dry-run by default. No automatic retention period is chosen.
import { PrismaClient } from '@prisma/client';
import { createTenantClient, disconnectAllTenantClients } from '../lib/tenantClient.js';
import { readRetentionDays } from '../lib/colloidalReader.js';
import { photoRoot } from '../routes/colloidalRoutes.js';
import { purgeOriginals } from '../lib/colloidalRetention.js';

if (!process.env.DATABASE_URL) throw new Error('请由运行环境提供DATABASE_URL，不自动加载其他环境');
const days = readRetentionDays();
if (!days) throw new Error('COLLOIDAL_PHOTO_RETENTION_DAYS尚未确定，未执行清理');
const apply = process.argv.includes('--apply');
// eslint-disable-next-line no-restricted-syntax -- Standalone maintenance process: one public base client; every school uses createTenantClient below.
const prisma = new PrismaClient();
try {
    const schools = await prisma.school.findMany({ select: { code: true } });
    for (const code of [null, ...schools.map(s => s.code)]) {
        const db = code ? createTenantClient(prisma, code) : prisma;
        console.log(JSON.stringify({ school: code || 'public', ...(await purgeOriginals({ db, root: photoRoot(), days, apply })) }));
    }
} finally { await disconnectAllTenantClients(); await prisma.$disconnect(); }

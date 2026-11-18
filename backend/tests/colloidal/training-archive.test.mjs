import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TrainingArchive, localTrainingConfig } from '../../lib/colloidalTrainingArchive.js';

const a = { tenant: 'school_a', userId: 1 }, b = { tenant: 'school_b', userId: 1 };
const done = async archive => { for (let i=0; i<100 && (archive.running || archive.queue.length); i++) await new Promise(r=>setTimeout(r,10)); assert.equal(archive.running,false); };
test('training capture is disabled by default and rejects production databases', () => {
    assert.equal(localTrainingConfig({}), null);
    assert.throws(() => localTrainingConfig({ NODE_ENV:'production', DATABASE_URL:'postgresql://localhost/business', COLLOIDAL_TRAINING_ARCHIVE_DIR:'/tmp/archive' }), /isolated/);
});
test('acknowledged bytes are immutable, retries are idempotent, identities are scoped', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'colloidal-training-'));
    const archive = new TrainingArchive({root}, async () => ({ status:'candidates',interpretation:null }));
    const id = randomUUID(), bytes = Buffer.from('source photo bytes');
    try {
        const saved = await archive.save({identity:a,id,bytes,mime:'image/jpeg',ext:'jpg',metadata:{background:'木纹桌面',physicalCardGroup:'卡A'}});
        assert.equal(saved.record.photo_sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.deepEqual(await fs.readFile(path.join(root,saved.record.object_key)),bytes);
        assert.equal(saved.record.annotation_status,'unreviewed');
        assert.equal(saved.record.training_assignment,'unassigned');
        assert.equal((await archive.save({identity:a,id,bytes,mime:'image/jpeg',ext:'jpg'})).reused,true);
        await assert.rejects(archive.save({identity:a,id,bytes:Buffer.from('different'),mime:'image/jpeg',ext:'jpg'}),{status:409});
        await assert.rejects(archive.get(b,id),{status:404});
        await done(archive);
        assert.equal((await archive.get(a,id)).ai_state,'completed');
        assert.equal((await archive.list(a)).length,1);
        assert.equal((await archive.list(b)).length,0);
        assert.equal('object_key' in archive.publicRecord(saved.record),false);
    } finally { await done(archive); await fs.rm(root,{recursive:true,force:true}); }
});
test('AI failure retains original and verification frames remain explicitly tagged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'colloidal-training-'));
    const archive = new TrainingArchive({root},async()=>{throw Error('decode failed');});
    try {
        const id=randomUUID(), bytes=Buffer.from('unsupported raw file');
        const {record}=await archive.save({identity:a,id,bytes,mime:'application/octet-stream',ext:'bin',metadata:{purpose:'verification'}});
        await done(archive);const result=await archive.get(a,id);
        assert.equal(result.ai_state,'failed');assert.equal(result.purpose,'verification');
        assert.deepEqual(await fs.readFile(path.join(root,record.object_key)),bytes);
    } finally { await done(archive);await fs.rm(root,{recursive:true,force:true}); }
});
test('pending jobs resume after restart without replacing the source photo', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'colloidal-training-'));
    const archive = new TrainingArchive({root},async()=>({status:'candidates'}));
    try {
        const id=randomUUID();await archive.save({identity:a,id,bytes:Buffer.from('photo'),mime:'image/jpeg',ext:'jpg'});await done(archive);
        const row=await archive.get(a,id);row.ai_state='processing';await archive.atomicJson(archive.capturePath(a,id),row);
        await archive.resume();await done(archive);
        assert.equal((await archive.get(a,id)).ai_state,'completed');
        assert.deepEqual(await fs.readFile(path.join(root,row.object_key)),Buffer.from('photo'));
    } finally {await done(archive);await fs.rm(root,{recursive:true,force:true});}
});

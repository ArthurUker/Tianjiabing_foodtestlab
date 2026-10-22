import { fail, projectById, PIPELINE, CORE_COMMIT, normalizeContext, canonical } from '../lib/colloidalReader.js';
import { buildRecordWriteData } from '../lib/recordNormalize.js';
import { writeTenantAuditLog } from '../lib/auditLog.js';
import { resultText } from '../../frontend/js/colloidal/contract.js';
import { samplingSummary } from '../../frontend/js/colloidal/sampling.js';
import { sameSamplingContext } from '../lib/colloidalSampling.js';

// The entry is the transactional/idempotent boundary for one physical card.
export async function finalizeColloidalEntry({ db, entryId, userId, body, ip }) {
    return db.$transaction(async tx => {
            // This conditional update locks the entry for all submit/retry paths.
            const locked = await tx.colloidalEntry.updateMany({ where: { id: entryId, created_by: userId, status: 'open' }, data: { status: 'finalizing' } });
            const entry = await tx.colloidalEntry.findFirst({ where: { id: entryId, created_by: userId } });
            if (!entry) throw fail(404, 'NOT_FOUND', '检测不存在');
            if (!locked.count) {
                if (entry.status === 'completed') return { records: await tx.testRecord.findMany({ where: { id: { in: entry.record_ids } } }), deduplicated: true };
                throw fail(409, 'ENTRY_BUSY', '检测正在保存，请稍后查询');
            }
            const project = projectById(entry.project_id);
            // 保存前复核上下文完整性；允许客户端在保存这一刻补齐/修正样本信息。
            const context = normalizeContext(body.context || entry.context, project);
            if (!sameSamplingContext(entry, context)) throw fail(409, 'SAMPLING_CONTEXT', '定时采样已绑定样本信息，请新建检测点位修改');
            if (canonical(context) !== canonical(entry.context)) {
                await tx.colloidalEntry.update({ where: { id: entry.id }, data: { context } });
                entry.context = context;
            }
            const attempts = await tx.colloidalAttempt.findMany({ where: { entry_id: entry.id }, orderBy: { created_at: 'asc' } });
            if (attempts.some(a => !a.completed_at)) throw fail(409, 'ATTEMPT_RUNNING', '请先完成或结束正在进行的识别');
            const adopted = attempts.find(a => a.id === body.attemptId);
            const summary = samplingSummary(entry.sampling, attempts, project);
            if (entry.sampling?.state === 'running') throw fail(409, 'SAMPLING_RUNNING', '请先完成或结束三次自动采样');
            if (body.mode === 'auto' && summary && (!summary.eligible || summary.adoptedAttemptId !== adopted?.id)) throw fail(400, 'SAMPLING_NOT_CONSISTENT', '未取得至少两次有效且一致的采样，请重测或手工录入');
            if (body.mode === 'auto' && (!adopted || adopted.photo_state !== 'present' || !adopted.result?.eligible)) throw fail(400, 'NO_VALID_AUTO_RESULT', '没有满足有效时间及通道条件的自动结果');
            const entryPath = entry.sampling ? (body.mode === 'auto' ? 'auto_two_of_three_consistent' : 'manual_after_sampling')
                : body.mode === 'auto' ? 'auto_success' : attempts.length ? (attempts.some(a => !a.result?.eligible) ? 'manual_after_auto_failure' : 'manual_after_photo') : 'direct_manual';
            const records = [];
            for (const channel of project.channels) {
                const value = body.mode === 'auto' ? resultText(adopted.result.channels.find(c => c.id === channel.id)?.final_result) : body.manualResults?.[channel.id];
                if (!['合格', '不合格'].includes(value)) throw fail(400, 'MISSING_CHANNEL_RESULT', `请填写${channel.name}的合格／不合格结果`);
                const { customFields, ...context } = entry.context;
                const built = buildRecordWriteData(project.module, { ...customFields, ...context, batchNo: channel.label, result: value });
                if (!built.ok) throw fail(400, built.code, built.message);
                built.data.result_data.photoRecognition = { entryId: entry.id, projectId: project.id, channelId: channel.id, resultSource: body.mode === 'auto' ? 'photo_auto' : 'manual', entryPath, adoptedAttemptId: adopted?.id || null, pipeline: PIPELINE, coreCommit: CORE_COMMIT };
                if (entry.sampling) built.data.result_data.photoRecognition.sampling = { id: entry.sampling.id, planId: entry.sampling.planId, status: summary.status, agreeCount: summary.agreeCount, hasDisagreement: summary.hasDisagreement, attemptIds: summary.samples.map(s => s.attemptId) };
                built.data.result_data.resultSource = body.mode === 'auto' ? 'photo_auto' : 'manual';
                built.data.result_data.entryPath = entryPath;
                records.push(await tx.testRecord.create({ data: { ...built.data, record_code: `CG-${entry.id}-${channel.id}`, created_by: userId, version: 1 } }));
            }
            await tx.colloidalEntry.update({ where: { id: entry.id }, data: { status: 'completed', record_ids: records.map(r => r.id), result_source: body.mode === 'auto' ? 'photo_auto' : 'manual', entry_path: entryPath, adopted_attempt_id: adopted?.id || null, completed_at: new Date() } });
            await writeTenantAuditLog(tx, { actorId: userId, action: 'create', resourceType: 'test_record', resourceId: records[0].id, details: { colloidal_entry_id: entry.id, record_ids: records.map(r => r.id), entry_path: entryPath }, ip: ip });
            return { records, deduplicated: false };
        });
}

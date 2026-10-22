import { fail, uuid, canonical, projectById, PIPELINE, CORE_COMMIT, compactResult, normalizeContext } from './colloidalReader.js';
import { samplingPlan, captureInSlot, samplingSummary } from '../../frontend/js/colloidal/sampling.js';
import { randomUUID } from 'node:crypto';

// Same row lock as finalization; start/stop cannot race a formal save.
export async function lockSamplingEntry(tx, id, userId) {
    const lock = await tx.colloidalEntry.updateMany({ where: { id, created_by: userId, status: 'open' }, data: { status: 'open' } });
    if (!lock.count) throw fail(409, 'ENTRY_CLOSED', '该检测已保存或不存在');
    return tx.colloidalEntry.findUnique({ where: { id } });
}
export function samplingCaptureData(entry, body) {
    const s = entry.sampling;
    if (!s || s.state !== 'running' || body.samplingId !== s.id || ![1, 2, 3].includes(body.sampleIndex)
        || body.source !== 'camera' || body.timeSource !== 'scheduled_camera') throw fail(409, 'SAMPLING_INPUT', '自动采样会话或相机时点无效');
    let capturedAt = null;
    if (body.capturedAt !== null && body.capturedAt !== undefined) {
        capturedAt = new Date(body.capturedAt);
        if (!Number.isFinite(capturedAt.getTime()) || !captureInSlot(s.planId, body.sampleIndex, body.elapsedSeconds)
            || Math.abs((capturedAt.getTime() - Date.parse(s.startedAt)) / 1000 - body.elapsedSeconds) > 2)
            throw fail(400, 'CAPTURE_TIME', '实际拍摄时间不在计划时点范围内，不能补拍替代');
    } else if (body.elapsedSeconds !== null) throw fail(400, 'CAPTURE_TIME', '未拍到照片时不能填写有效拍摄时距');
    return { sample_index: body.sampleIndex, captured_at: capturedAt };
}
export async function startSampling({ db, entryId, userId, body }) {
    const plan = samplingPlan(body.planId);
    const startedAt = new Date(body.startedAt);
    if (!plan || !uuid(body.id) || !Number.isFinite(startedAt.getTime())) throw fail(400, 'SAMPLING_PLAN', '采样计划或加样确认时间无效');
    return db.$transaction(async tx => {
        const entry = await lockSamplingEntry(tx, entryId, userId);
        if (entry.sampling) {
            if (entry.sampling.id === body.id && entry.sampling.planId === body.planId && entry.sampling.startedAt === startedAt.toISOString()) return entry;
            throw fail(409, 'SAMPLING_EXISTS', '本次检测已有采样会话，请使用新的检测点位');
        }
        if (await tx.colloidalAttempt.count({ where: { entry_id: entry.id } })) throw fail(409, 'HAS_PHOTOS', '本次检测已有照片，请新建检测点位再开始自动采样');
        // Start requires complete, stable sample information.
        normalizeContext(entry.context, projectById(entry.project_id));
        const sampling = { id: body.id, planId: plan.id, startedAt: startedAt.toISOString(), receivedAt: new Date().toISOString(),
            state: 'running', policy: 'two_of_three_agree', clock: 'client_monotonic_and_wall', reason: null };
        return tx.colloidalEntry.update({ where: { id: entry.id }, data: { sampling } });
    });
}
export async function finishSampling({ db, entryId, userId, body }) {
    return db.$transaction(async tx => {
        const entry = await lockSamplingEntry(tx, entryId, userId);
        if (!entry.sampling || entry.sampling.id !== body.id || !['completed', 'interrupted'].includes(body.state)) throw fail(400, 'SAMPLING_INPUT', '自动采样结束参数无效');
        if (entry.sampling.state === 'running') {
            const attempts = await tx.colloidalAttempt.findMany({ where: { entry_id: entry.id } });
            if (body.state === 'completed' && attempts.some(a => !a.completed_at)) throw fail(409, 'ATTEMPT_RUNNING', '仍有照片正在处理，请等待或结束采样');
            const reason = String(body.reason || (body.state === 'interrupted' ? '自动采样中断' : '未在计划时点拍到照片')).slice(0, 240);
            for (const index of [1, 2, 3]) {
                const a = attempts.find(item => item.sample_index === index);
                if (a?.completed_at) continue;
                const result = compactResult({ status: 'sample_missed', error: reason, channels: [] }, projectById(entry.project_id), null);
                if (a) await tx.colloidalAttempt.update({ where: { id: a.id }, data: { status: 'failed', result, completed_at: new Date() } });
                else await tx.colloidalAttempt.create({ data: { id: randomUUID(), entry_id: entry.id, sample_index: index, time_source: 'scheduled_camera',
                    input_mode: 'auto', source: 'camera', pipeline: PIPELINE, core_commit: CORE_COMMIT, status: 'failed', result, completed_at: new Date() } });
            }
            entry.sampling = { ...entry.sampling, state: body.state, reason: body.state === 'interrupted' ? reason : null, endedAt: new Date().toISOString() };
            await tx.colloidalEntry.update({ where: { id: entry.id }, data: { sampling: entry.sampling } });
        }
        const attempts = await tx.colloidalAttempt.findMany({ where: { entry_id: entry.id }, orderBy: { created_at: 'asc' } });
        const summary = samplingSummary(entry.sampling, attempts, projectById(entry.project_id));
        const { status, eligible, validCount, agreeCount, hasDisagreement } = summary;
        entry.sampling = { ...entry.sampling, outcome: { status, eligible, validCount, agreeCount, hasDisagreement } };
        await tx.colloidalEntry.update({ where: { id: entry.id }, data: { sampling: entry.sampling } });
        return { entry, summary };
    });
}
export const sameSamplingContext = (entry, context) => !entry.sampling || canonical(entry.context) === canonical(context);

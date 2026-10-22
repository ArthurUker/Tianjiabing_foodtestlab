// Acquisition policy only. The selected v5 optical algorithm is unchanged.
export const SAMPLING_PLANS = Object.freeze({
    minutes_5_6_7: Object.freeze({ id: 'minutes_5_6_7', seconds: Object.freeze([300, 360, 420]), label: '第5、6、7分钟' }),
});
export const SAMPLING_WINDOW = Object.freeze({ min: 300, max: 480, maxDelay: 15 });
export const samplingPlan = id => SAMPLING_PLANS[id] || null;
export function captureInSlot(planId, index, elapsed) {
    const target = samplingPlan(planId)?.seconds[index - 1];
    return Number.isInteger(index) && target !== undefined && Number.isFinite(elapsed)
        && elapsed >= target && elapsed <= Math.min(target + SAMPLING_WINDOW.maxDelay, SAMPLING_WINDOW.max);
}
export function samplingSummary(session, attempts, project) {
    if (!session) return null;
    const plan = samplingPlan(session.planId);
    const samples = [1, 2, 3].map(index => {
        const a = attempts.find(row => row.sample_index === index);
        const originalExisted = a?.photo_state === 'present' || (['purged', 'purging'].includes(a?.photo_state) && !!a?.photo_sha256);
        const eligible = !!plan && !!a?.completed_at && originalExisted && !!a.captured_at
            && a.time_source === 'scheduled_camera' && captureInSlot(session.planId, index, a.elapsed_seconds)
            && a.result?.eligible === true && a.result.channels?.length === project.channels.length
            && project.channels.every((c, i) => a.result.channels[i]?.id === c.id
                && a.result.channels[i].rule_status === 'within_time'
                && ['negative', 'positive'].includes(a.result.channels[i].final_result));
        return { index, scheduledSeconds: plan?.seconds[index - 1] ?? null, attemptId: a?.id || null,
            elapsedSeconds: a?.elapsed_seconds ?? null, capturedAt: a?.captured_at || null,
            status: !a ? 'pending' : !a.completed_at ? 'processing' : a.result?.status || 'interrupted',
            error: a?.result?.error || null,
            eligible, channels: a?.result?.channels || [] };
    });
    const valid = samples.filter(s => s.eligible);
    // Triplex votes are whole-card vectors, never a mix of different photos.
    const groups = new Map();
    for (const sample of valid) {
        const key = JSON.stringify(sample.channels.map(c => c.final_result));
        const group = groups.get(key) || []; group.push(sample); groups.set(key, group);
    }
    const matching = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
    const consistent = matching.length >= 2;
    const eligible = ['completed', 'interrupted'].includes(session.state) && consistent;
    return { state: session.state, eligible, consistent, validCount: valid.length, agreeCount: matching.length,
        hasDisagreement: groups.size > 1,
        status: eligible ? 'consistent' : session.state === 'interrupted' ? 'interrupted' : session.state !== 'completed' ? 'running'
            : valid.length < 2 ? 'incomplete' : 'inconsistent',
        adoptedAttemptId: eligible ? matching.at(-1).attemptId : null, samples };
}
export const formatElapsed = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;

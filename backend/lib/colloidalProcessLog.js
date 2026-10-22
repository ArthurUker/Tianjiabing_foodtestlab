// Business recognition receipts, separate from security audit logs. No images,
// profiles, local paths, tokens or arbitrary client payloads enter this log.
export const processEvent = (stage, state, details = {}, origin = 'server') => ({
    at: new Date().toISOString(), origin, stage, state, details,
});

const clientStages = new Set(['camera_requested', 'camera_ready', 'capture_started', 'photo_captured', 'file_selected', 'sampling_started', 'capture_failed']);
export function clientProcessEvents(input) {
    if (!Array.isArray(input)) return [];
    return input.slice(0, 16).flatMap(item => {
        if (!clientStages.has(item?.stage) || !Number.isFinite(Date.parse(item.at))) return [];
        const details = {};
        for (const key of ['width', 'height', 'bytes', 'elapsedSeconds', 'sampleIndex', 'previewRotation']) {
            const n = item.details?.[key];
            if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000000) details[key] = n;
        }
        for (const key of ['previewMirrorX', 'previewMirrorY']) if (typeof item.details?.[key] === 'boolean') details[key] = item.details[key];
        return [{ at: new Date(item.at).toISOString(), origin: 'browser', stage: item.stage, state: 'observed', details }];
    });
}

export async function appendProcessEvents(db, attemptId, events) {
    if (!events?.length) return;
    // The tenant client supplies the schema. Serialize concurrent upload,
    // queue and completion receipts without replacing earlier events.
    await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "ColloidalAttempt" WHERE id = ${attemptId} FOR UPDATE`;
        const attempt = await tx.colloidalAttempt.findUnique({ where: { id: attemptId }, select: { process_log: true } });
        if (!attempt) return;
        const previous = Array.isArray(attempt.process_log) ? attempt.process_log : [];
        if (previous.length >= 256) return;
        await tx.colloidalAttempt.update({ where: { id: attemptId }, data: { process_log: [...previous, ...events].slice(0, 256) } });
    });
}

// Python emits only this bounded, documented diagnostic structure. Legacy
// workers without the observer remain usable and explicitly show that gap.
export function algorithmProcessEvents(input) {
    if (!Array.isArray(input)) return [processEvent('algorithm_log_unavailable', 'warning')];
    const allowed = new Set(['decode', 'core_started', 'board_geometry', 'window_candidates', 'outline_search', 'window_selection', 'localization', 'measurement', 'image_classification', 'optical_audit', 'learning_shadow', 'core_finished']);
    const detailKeys = new Set(('duration_ms format width height exif_orientation bytes decoded_width decoded_height coordinate_space project_id core_patch mode expected_channels marker_ids inliers rms_mm rms_gate_mm px_per_mm layout_id layout_version geometry_patch slot_polygon_source physical_layout_validated rotation_quarters direction_basis count edge_exposure_normalized centers_slot note expected_center_x matched expanded_search polygon_slot expected_count selected_count polygons_slot require_upper input_kind window_shapes marker_refinement expanded_outline_search geometry_fallbacks window_polygons_source measurement_polygons_source channel_id measurement_lines_source c t c_present threshold noise positions indices method acquisition_quality fit_evaluations transverse_rows reason status elapsed_ms error channels rule_status image_result decision_role version').split(' '));
    const clean = (value, depth = 0) => {
        if (depth > 6) return null;
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string') return value.slice(0, 300);
        if (Array.isArray(value)) return value.slice(0, 32).map(v => clean(v, depth + 1));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 35).filter(([k]) => /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(k) && !['raw_profile', 'signal_profile', 'background_profile', 'path', 'photo_key', 'token', 'image_bytes'].includes(k)).map(([k, v]) => [k, clean(v, depth + 1)]));
        return null;
    };
    return input.slice(0, 160).filter(e => allowed.has(e?.stage)).map(e => ({
        at: Number.isFinite(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString(),
        origin: 'algorithm', stage: e.stage, state: ['ok', 'started', 'failed', 'warning'].includes(e.state) ? e.state : 'observed',
        elapsed_ms: typeof e.elapsed_ms === 'number' && Number.isFinite(e.elapsed_ms) ? Math.max(0, e.elapsed_ms) : null,
        details: clean(Object.fromEntries(Object.entries(e.details || {}).filter(([key]) => detailKeys.has(key)))),
    }));
}

// One-time cleanup: deletes the events this app created in your Google Calendar earlier.
// Only events recorded in calendar_events are touched; anything you made yourself is left alone.
// Call repeatedly until "remaining" is 0 (max 25 per call keeps it under Cloudflare's request limit).

import { getAccessToken } from '../_lib/google.js';

const BATCH = 25;

export async function onRequest(context) {
    if (context.request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
    if (!isAuthorized(context)) return json({ error: 'Unauthorized' }, 401);

    const { DB } = context.env;
    if (!DB) return json({ error: 'D1 database not configured' }, 500);

    const auth = await getAccessToken(context.env);
    if (auth.error) return json({ error: auth.error, code: auth.code }, auth.status);

    const rows = await DB.prepare('SELECT task_id, event_id FROM calendar_events ORDER BY updated_at ASC LIMIT ?')
        .bind(BATCH).all();

    let deleted = 0, failed = 0;
    const errorSamples = [];
    const now = Math.floor(Date.now() / 1000);

    for (const row of rows.results) {
        try {
            const resp = await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(row.event_id)}`,
                { method: 'DELETE', headers: { Authorization: `Bearer ${auth.accessToken}` } }
            );
            // 404/410 = already gone, which is what we want
            if (resp.ok || resp.status === 404 || resp.status === 410) {
                await DB.prepare('DELETE FROM calendar_events WHERE task_id = ?').bind(row.task_id).run();
                await DB.prepare('DELETE FROM calendar_event_state WHERE task_id = ?').bind(row.task_id).run().catch(() => {});
                deleted++;
            } else {
                failed++;
                const data = await resp.json().catch(() => ({}));
                const msg = `${resp.status} ${data.error?.message || ''}`.trim();
                if (errorSamples.length < 3 && !errorSamples.includes(msg)) errorSamples.push(msg);
                // send it to the back of the queue so one bad event cannot block the rest
                await DB.prepare('UPDATE calendar_events SET updated_at = ? WHERE task_id = ?').bind(now, row.task_id).run();
            }
        } catch (err) {
            failed++;
            if (errorSamples.length < 3) errorSamples.push(err.message);
        }
    }

    const left = await DB.prepare('SELECT COUNT(*) AS n FROM calendar_events').first();
    return json({ ok: true, deleted, failed, remaining: left?.n ?? 0, errorSamples });
}

function isAuthorized(context) {
    const token = context.request.headers.get('X-App-Token');
    return context.env.PASSWORD && token === context.env.PASSWORD;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

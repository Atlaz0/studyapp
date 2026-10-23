// Pushes tasks to Google Calendar as events.
// Body: { tasks: [{ id, title, description?, date: 'YYYY-MM-DD', time?: 'HH:MM' }] }  (max 25 per request)
// Unchanged events are skipped, so repeat syncs make few Google calls
// (Pages Functions allow ~50 outgoing fetches per request).

import { getAccessToken } from '../_lib/google.js';

const TIME_ZONE = 'Europe/Tallinn';
const MAX_TASKS = 25;

export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return json({ error: 'Method Not Allowed' }, 405);
    }
    if (!isAuthorized(context)) return json({ error: 'Unauthorized' }, 401);

    const { DB } = context.env;
    if (!DB) return json({ error: 'D1 database not configured' }, 500);

    let body;
    try {
        body = await context.request.json();
    } catch {
        return json({ error: 'Invalid JSON body' }, 400);
    }

    const { tasks } = body;
    if (!Array.isArray(tasks)) return json({ error: 'tasks must be an array' }, 400);
    if (tasks.length > MAX_TASKS) return json({ error: `Send at most ${MAX_TASKS} tasks per request` }, 400);

    const auth = await getAccessToken(context.env);
    if (auth.error) return json({ error: auth.error, code: auth.code }, auth.status);
    const accessToken = auth.accessToken;

    const existing = await DB.prepare('SELECT task_id, event_id FROM calendar_events').all();
    const eventMap = new Map(existing.results.map(r => [r.task_id, r.event_id]));

    // last event body we sent per task, so unchanged ones can be skipped
    let stateMap = new Map();
    let stateOk = true;
    try {
        const st = await DB.prepare('SELECT task_id, body FROM calendar_event_state').all();
        stateMap = new Map(st.results.map(r => [r.task_id, r.body]));
    } catch {
        stateOk = false; // table missing: still works, just re-sends everything
    }

    const stats = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, errorSamples: [] };
    const fail = (msg) => {
        stats.errors++;
        if (msg && stats.errorSamples.length < 3 && !stats.errorSamples.includes(msg)) stats.errorSamples.push(msg);
    };
    const now = () => Math.floor(Date.now() / 1000);

    for (const task of tasks) {
        const taskId = task && task.id != null ? String(task.id) : '';
        const ev = taskId ? buildEvent(task) : null;
        if (!ev) { stats.skipped++; continue; }

        const evJson = JSON.stringify(ev);
        if (eventMap.has(taskId) && stateMap.get(taskId) === evJson) { stats.unchanged++; continue; }

        try {
            let ok = false;

            if (eventMap.has(taskId)) {
                const resp = await fetch(
                    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventMap.get(taskId))}`,
                    {
                        method: 'PUT',
                        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...ev, status: 'confirmed' }),
                    }
                );
                if (resp.ok) {
                    stats.updated++;
                    ok = true;
                } else if (resp.status === 404 || resp.status === 410) {
                    // event was deleted in Google: make a new one
                    const created = await createEvent(accessToken, ev);
                    if (created.id) {
                        await DB.prepare('UPDATE calendar_events SET event_id = ?, updated_at = ? WHERE task_id = ?')
                            .bind(created.id, now(), taskId).run();
                        stats.created++;
                        ok = true;
                    } else fail(created.error);
                } else {
                    fail(await errorText(resp));
                }
            } else {
                const created = await createEvent(accessToken, ev);
                if (created.id) {
                    await DB.prepare('INSERT OR REPLACE INTO calendar_events (task_id, event_id, updated_at) VALUES (?, ?, ?)')
                        .bind(taskId, created.id, now()).run();
                    stats.created++;
                    ok = true;
                } else fail(created.error);
            }

            if (ok && stateOk) {
                await DB.prepare('INSERT OR REPLACE INTO calendar_event_state (task_id, body) VALUES (?, ?)')
                    .bind(taskId, evJson).run().catch(() => {});
            }
        } catch (err) {
            fail(err.message);
        }
    }

    return json({ ok: true, ...stats });
}

function buildEvent(task) {
    const date = String(task.date || '');
    const title = String(task.title || '').trim().slice(0, 200);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) return null;

    const ev = { summary: title };
    if (task.description) ev.description = String(task.description).slice(0, 2000);

    if (task.time && /^\d{2}:\d{2}$/.test(task.time)) {
        const [h, m] = task.time.split(':').map(Number);
        const endTotal = h * 60 + m + 60;
        const endDate = endTotal >= 1440 ? addDays(date, 1) : date;
        const eh = Math.floor((endTotal % 1440) / 60);
        const em = endTotal % 60;
        ev.start = { dateTime: `${date}T${pad(h)}:${pad(m)}:00`, timeZone: TIME_ZONE };
        ev.end = { dateTime: `${endDate}T${pad(eh)}:${pad(em)}:00`, timeZone: TIME_ZONE };
    } else {
        // all-day events need an exclusive end date (the next day), otherwise Google returns 400
        ev.start = { date };
        ev.end = { date: addDays(date, 1) };
    }
    return ev;
}

function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function pad(n) {
    return String(n).padStart(2, '0');
}

async function createEvent(accessToken, ev) {
    const resp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
    });
    if (!resp.ok) return { error: await errorText(resp) };
    const data = await resp.json();
    return data.id ? { id: data.id } : { error: 'Google returned no event id' };
}

async function errorText(resp) {
    const data = await resp.json().catch(() => ({}));
    return `${resp.status} ${data.error?.message || data.error || ''}`.trim();
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

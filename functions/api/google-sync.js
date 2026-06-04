export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return json({ error: 'Method Not Allowed' }, 405);
    }
    if (!isAuthorized(context)) return json({ error: 'Unauthorized' }, 401);

    const { DB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = context.env;
    if (!DB) return json({ error: 'D1 database not configured' }, 500);

    let body;
    try {
        body = await context.request.json();
    } catch {
        return json({ error: 'Invalid JSON body' }, 400);
    }

    const { tasks } = body;
    if (!Array.isArray(tasks)) return json({ error: 'tasks must be an array' }, 400);

    const row = await DB.prepare('SELECT * FROM google_tokens WHERE id = 1').first();
    if (!row) return json({ error: 'Google Calendar not connected', code: 'not_connected' }, 401);

    let accessToken = row.access_token;
    if (row.expires_at < Math.floor(Date.now() / 1000) + 60) {
        const refreshed = await refreshToken(row.refresh_token, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
        if (!refreshed.ok) return json({ error: 'Failed to refresh Google token: ' + refreshed.error }, 500);
        accessToken = refreshed.access_token;
        const newExpiry = Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600);
        await DB.prepare('UPDATE google_tokens SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE id = 1')
            .bind(accessToken, refreshed.refresh_token || null, newExpiry).run();
    }

    const existing = await DB.prepare('SELECT task_id, event_id FROM calendar_events').all();
    const eventMap = new Map(existing.results.map(r => [r.task_id, r.event_id]));

    let created = 0, updated = 0, errors = 0;

    for (const task of tasks) {
        if (!task.date || !task.id || !task.title) continue;

        let start, end;
        if (task.time && /^\d{2}:\d{2}$/.test(task.time)) {
            const [h, m] = task.time.split(':').map(Number);
            const endH = (h + 1) % 24;
            start = { dateTime: `${task.date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`, timeZone: 'Europe/Tallinn' };
            end   = { dateTime: `${task.date}T${String(endH).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`, timeZone: 'Europe/Tallinn' };
        } else {
            start = { date: task.date };
            end   = { date: task.date };
        }

        const eventBody = { summary: task.title, start, end };

        try {
            if (eventMap.has(task.id)) {
                const eventId = eventMap.get(task.id);
                const resp = await fetch(
                    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
                    {
                        method: 'PUT',
                        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(eventBody),
                    }
                );
                if (resp.ok) {
                    updated++;
                } else if (resp.status === 404) {
                    const ev = await createEvent(accessToken, eventBody);
                    if (ev.id) {
                        await DB.prepare('UPDATE calendar_events SET event_id = ?, updated_at = ? WHERE task_id = ?')
                            .bind(ev.id, Math.floor(Date.now() / 1000), task.id).run();
                        created++;
                    } else { errors++; }
                } else { errors++; }
            } else {
                const ev = await createEvent(accessToken, eventBody);
                if (ev.id) {
                    await DB.prepare('INSERT OR REPLACE INTO calendar_events (task_id, event_id, updated_at) VALUES (?, ?, ?)')
                        .bind(task.id, ev.id, Math.floor(Date.now() / 1000)).run();
                    created++;
                } else { errors++; }
            }
        } catch {
            errors++;
        }
    }

    return json({ ok: true, created, updated, errors });
}

async function createEvent(accessToken, eventBody) {
    const resp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody),
    });
    return resp.json();
}

async function refreshToken(refreshTokenVal, clientId, clientSecret) {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshTokenVal,
            client_id: clientId,
            client_secret: clientSecret,
        }),
    });
    const data = await resp.json();
    return { ok: resp.ok && !data.error, ...data };
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

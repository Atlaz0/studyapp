// Reads events from your primary Google Calendar so they can be shown in the app.
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }  (to is exclusive, at most ~2 months)
// Events this app created itself (from tasks) are left out so nothing shows twice.

import { getAccessToken } from '../_lib/google.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequest(context) {
    if (context.request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
    if (!isAuthorized(context)) return json({ error: 'Unauthorized' }, 401);

    const { DB } = context.env;
    if (!DB) return json({ error: 'D1 database not configured' }, 500);

    let body;
    try {
        body = await context.request.json();
    } catch {
        return json({ error: 'Invalid JSON body' }, 400);
    }

    const { from, to } = body;
    if (!YMD.test(from || '') || !YMD.test(to || '')) return json({ error: 'from and to must be YYYY-MM-DD' }, 400);
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (!(days > 0 && days <= 62)) return json({ error: 'Range must be 1 to 62 days' }, 400);

    const auth = await getAccessToken(context.env);
    if (auth.error) return json({ error: auth.error, code: auth.code }, auth.status);

    // one extra day each side so timezone edges are not cut off; the page trims to the real range
    const params = new URLSearchParams({
        timeMin: `${addDays(from, -1)}T00:00:00Z`,
        timeMax: `${addDays(to, 1)}T00:00:00Z`,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        fields: 'items(id,summary,status,start,end)',
    });
    const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        return json({ error: `Google ${resp.status}: ${data.error?.message || 'request failed'}` }, 502);
    }

    const ours = await DB.prepare('SELECT event_id FROM calendar_events').all();
    const ownIds = new Set(ours.results.map(r => r.event_id));

    const events = (data.items || [])
        .filter(e => e.status !== 'cancelled' && !ownIds.has(e.id) && e.start)
        .map(e => ({
            id: e.id,
            title: e.summary || '(no title)',
            allDay: !!e.start.date,
            start: e.start.date || e.start.dateTime,
            end: (e.end && (e.end.date || e.end.dateTime)) || e.start.date || e.start.dateTime,
        }));

    return json({ events });
}

function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
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

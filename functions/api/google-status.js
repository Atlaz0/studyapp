export async function onRequest(context) {
    if (!isAuthorized(context)) return json({ error: 'Unauthorized' }, 401);

    const { DB, GOOGLE_CLIENT_ID } = context.env;
    if (!GOOGLE_CLIENT_ID) return json({ connected: false, reason: 'not_configured' });
    if (!DB) return json({ connected: false, reason: 'no_db' });
    try {
        const row = await DB.prepare('SELECT id FROM google_tokens WHERE id = 1').first();
        let pushed = 0;
        try {
            const left = await DB.prepare('SELECT COUNT(*) AS n FROM calendar_events').first();
            pushed = left?.n ?? 0;
        } catch { /* table missing: nothing was ever pushed */ }
        return json({ connected: !!row, pushed });
    } catch {
        return json({ connected: false, reason: 'db_error' });
    }
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

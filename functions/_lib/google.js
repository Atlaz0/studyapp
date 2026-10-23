// Shared Google helper: returns a valid access token, refreshing it when needed.
// No onRequest export, so Pages does not turn this file into a route.

export async function getAccessToken(env) {
    const { DB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
    const row = await DB.prepare('SELECT * FROM google_tokens WHERE id = 1').first();
    if (!row) return { error: 'Google Calendar not connected', code: 'not_connected', status: 401 };

    if (row.expires_at >= Math.floor(Date.now() / 1000) + 60) {
        return { accessToken: row.access_token };
    }

    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: row.refresh_token,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
        }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
        return {
            error: 'Failed to refresh Google token: ' + (data.error_description || data.error) + ' (try Disconnect, then Connect again)',
            status: 500,
        };
    }

    const newExpiry = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
    await DB.prepare('UPDATE google_tokens SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE id = 1')
        .bind(data.access_token, data.refresh_token || null, newExpiry).run();
    return { accessToken: data.access_token };
}

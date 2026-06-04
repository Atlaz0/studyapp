export async function onRequest(context) {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DB } = context.env;
    const url = new URL(context.request.url);
    const stateParam = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');

    // Verify CSRF state
    const cookieHeader = context.request.headers.get('Cookie') || '';
    const stateCookie = cookieHeader.split(';').map(c => c.trim())
        .find(c => c.startsWith('oauth_state='))?.slice('oauth_state='.length);

    if (!stateCookie || stateCookie !== stateParam) {
        return html('<p>Invalid OAuth state. Please try connecting again. <a href="/">Go back</a></p>', 403);
    }

    if (error) {
        return html(`<p>Google OAuth error: ${escHtml(error)}. <a href="/">Go back</a></p>`);
    }
    if (!code) {
        return html('<p>Missing code parameter. <a href="/">Go back</a></p>', 400);
    }
    if (!DB) {
        return html('<p>D1 database not bound. Check dashboard bindings.</p>', 500);
    }

    const redirectUri = `${url.origin}/api/google-callback`;

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        }),
    });

    const tokens = await tokenResp.json();
    if (!tokenResp.ok || tokens.error) {
        return html(`<p>Token exchange failed: ${escHtml(tokens.error_description || tokens.error || String(tokenResp.status))}. <a href="/">Go back</a></p>`, 500);
    }

    const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600);

    try {
        await DB.prepare(`
            INSERT INTO google_tokens (id, access_token, refresh_token, expires_at)
            VALUES (1, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
                access_token = excluded.access_token,
                refresh_token = COALESCE(excluded.refresh_token, refresh_token),
                expires_at = excluded.expires_at
        `).bind(tokens.access_token, tokens.refresh_token || null, expiresAt).run();
    } catch (e) {
        return html(`<p>Failed to save tokens: ${escHtml(e.message)}. <a href="/">Go back</a></p>`, 500);
    }

    return new Response(null, {
        status: 302,
        headers: {
            'Location': `${url.origin}/?google=connected`,
            'Set-Cookie': 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/',
        },
    });
}

function html(body, status = 200) {
    return new Response(`<!doctype html><html><body>${body}</body></html>`, {
        status,
        headers: { 'Content-Type': 'text/html' },
    });
}

function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

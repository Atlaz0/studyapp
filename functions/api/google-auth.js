export async function onRequest(context) {
    const { GOOGLE_CLIENT_ID } = context.env;
    if (!GOOGLE_CLIENT_ID) {
        return new Response('GOOGLE_CLIENT_ID is not configured', { status: 500 });
    }

    const state = crypto.randomUUID();
    const origin = new URL(context.request.url).origin;
    const redirectUri = `${origin}/api/google-callback`;

    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
        access_type: 'offline',
        prompt: 'consent',
        state,
    });

    return new Response(null, {
        status: 302,
        headers: {
            'Location': `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
            'Set-Cookie': `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=300; Path=/`,
        },
    });
}

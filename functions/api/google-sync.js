// Disabled on purpose: this app no longer sends anything to Google Calendar.
// It only reads events from Google (see google-events.js).
// You can delete this file; it exists so an old copy of the endpoint cannot linger.

export async function onRequest() {
    return new Response(JSON.stringify({ error: 'Pushing tasks to Google Calendar is disabled.' }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
    });
}

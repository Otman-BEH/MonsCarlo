// Where the web page finds the Mons Carlo API (the backend). Change this when the API runs somewhere else,
// for example the address of the hosted backend. Local dev (serve_web.py on :5173) uses the local API; anywhere else the
// page assumes the API is on its own address (the Docker image serves both). A ?api=... parameter in the page's address overrides it.
window.MONS_CARLO_API = location.port === '5173' || location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';

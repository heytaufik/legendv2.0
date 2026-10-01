const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fyers Market Dashboard</title></head>
<body><script>location.href = '/dashboard';</script></body>
</html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return Response.json({ ok: true, received: true });
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true, trading: false });
    }
    return new Response(html, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
  }
};
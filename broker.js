/**
 * Minimal in-memory channel broker for Claude Code cross-session messaging (spike).
 *
 * Transport:
 *   subscribe -> WebSocket  ws://127.0.0.1:8787/sub?channel=<name>&as=<display-name>
 *   publish   -> HTTP POST  http://127.0.0.1:8787/pub  {channel, sender, text}
 *   inspect   -> HTTP GET   http://127.0.0.1:8787/health
 *
 * Each published message is fanned out to every live subscriber of the channel
 * as one WebSocket text frame, which Monitor turns into a single conversation
 * event. Nothing touches the filesystem; all state dies with the process.
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const HOST = '127.0.0.1';
const PORT = 8787;

/** channel name -> Set of live sockets */
const channels = new Map();

function subscribers(channel) {
  if (!channels.has(channel)) channels.set(channel, new Set());
  return channels.get(channel);
}

function fanout(channel, line) {
  let delivered = 0;
  for (const sock of subscribers(channel)) {
    if (sock.readyState === sock.OPEN) {
      sock.send(line);
      delivered += 1;
    }
  }
  return delivered;
}

function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/pub') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (err) {
        respond(res, 400, { error: `invalid JSON: ${err.message}` });
        return;
      }
      const { channel, sender, text } = msg;
      if (!channel || !sender || !text) {
        respond(res, 400, { error: 'channel, sender and text are all required' });
        return;
      }
      const delivered = fanout(channel, `[${channel}] ${sender}: ${text}`);
      console.log(`[broker] ${sender} -> ${channel} (${delivered} delivered)`);
      respond(res, 200, { delivered });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const state = {};
    for (const [name, socks] of channels) state[name] = socks.size;
    respond(res, 200, { ok: true, channels: state });
    return;
  }

  respond(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
});

const wss = new WebSocketServer({ server, path: '/sub' });

wss.on('connection', (sock, req) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const channel = url.searchParams.get('channel');
  const as = url.searchParams.get('as') || 'anonymous';
  if (!channel) {
    sock.close(1008, 'channel query parameter is required');
    return;
  }
  subscribers(channel).add(sock);
  console.log(`[broker] ${as} joined ${channel} (${subscribers(channel).size} online)`);
  sock.send(`[${channel}] -- subscribed as ${as} --`);
  sock.on('close', () => {
    subscribers(channel).delete(sock);
    console.log(`[broker] ${as} left ${channel} (${subscribers(channel).size} online)`);
  });
});

server.on('error', (err) => {
  console.error(`[broker] server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[broker] listening on http://${HOST}:${PORT}`);
});

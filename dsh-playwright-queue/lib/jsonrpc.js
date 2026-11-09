// Minimal newline-delimited JSON-RPC 2.0 helpers (MCP stdio framing).
export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

// One message per line; JSON.stringify never emits a raw newline.
export const encode = (msg) => `${JSON.stringify(msg)}\n`;

export const errorResponse = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: data === undefined ? { code, message } : { code, message, data },
});

// Accumulates text chunks and calls onLine for every complete non-empty line (CRLF tolerated).
// A line growing past maxLineBytes without a newline is discarded up to the next newline (onOverflow is told).
export function createLineReader(onLine, { maxLineBytes = DEFAULT_MAX_LINE_BYTES, onOverflow = () => {} } = {}) {
  let buf = '';
  let dropping = false;
  const emit = (line) => {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (l.trim().length > 0) onLine(l);
  };
  return {
    push(chunk) {
      if (dropping && chunk.indexOf('\n') < 0) return; // still inside an oversized line: discard without buffering
      // Only the new chunk can hold a newline: everything already in buf was scanned (scanned = its length).
      let nl = chunk.indexOf('\n');
      if (nl < 0) { buf += chunk; } else {
        let start = 0;
        while (nl >= 0) {
          const line = buf + chunk.slice(start, nl);
          buf = '';
          if (dropping) dropping = false;
          else if (line.length > maxLineBytes) onOverflow(); // completed within one chunk but over the cap
          else emit(line);
          start = nl + 1;
          nl = chunk.indexOf('\n', start);
        }
        buf = chunk.slice(start);
      }
      if (buf.length > maxLineBytes) {
        buf = '';
        if (!dropping) onOverflow();
        dropping = true;
      }
    },
    end() {
      if (!dropping && buf.length > 0) emit(buf);
      buf = '';
    },
  };
}

// Returns { msg } for a JSON object, else { error } holding a ready JSON-RPC error response.
export function parseLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { error: errorResponse(null, ERR.PARSE, 'Parse error') };
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return { error: errorResponse(null, ERR.INVALID_REQUEST, 'Invalid Request: expected a JSON object') };
  }
  return { msg };
}

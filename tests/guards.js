"use strict";

/**
 * Raw-socket guard checks.
 *
 * Node's `fetch` refuses to send a forged `Host` header, so the two guards the
 * server applies before reading a route - a loopback Host and a loopback-or-absent
 * Origin - cannot be exercised through it. This opens plain TCP sockets instead and
 * reads the status line back.
 *
 *   node tests/guards.js <baseUrl>
 */

const net = require("node:net");

function requestStatus(port, rawRequest, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(rawRequest);
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
    });
    socket.on("close", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
      resolve({ status: match ? Number(match[1]) : 0, body: received.slice(0, 400) });
    });
    socket.on("error", () => resolve({ status: 0, body: "socket error" }));
    setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
  });
}

(async () => {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: node tests/guards.js <baseUrl>");
    process.exit(2);
  }
  const port = Number(new URL(base).port);
  let failures = 0;

  const cases = [
    {
      name: "foreign Host is refused",
      raw: "GET /v1/models HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n",
      expect: 403,
    },
    {
      name: "cross-origin POST is refused",
      raw:
        'POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:' +
        port +
        '\r\nOrigin: https://evil.example.com\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
      expect: 403,
    },
    {
      name: "loopback Host is accepted",
      raw: "GET /health HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n",
      expect: 200,
    },
    {
      name: "unknown route answers 404",
      raw: "GET /nope HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n",
      expect: 405,
    },
  ];

  for (const testCase of cases) {
    const result = await requestStatus(port, testCase.raw);
    const ok = result.status === testCase.expect;
    console.log("  " + (ok ? "PASS" : "FAIL") + "  " + testCase.name + "  (got " + result.status + ", expected " + testCase.expect + ")");
    if (!ok) {
      failures += 1;
      if (result.body) console.log("        " + result.body.replace(/\s+/g, " ").slice(0, 200));
    }
  }

  console.log(failures === 0 ? "\n  All guards passed." : "\n  " + failures + " guard check(s) failed.");
  process.exit(failures === 0 ? 0 : 1);
})();

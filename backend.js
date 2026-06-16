/**
 * PHANTOM VAULT - ZERO-DEPENDENCY ENTERPRISE BACKEND
 * Native Node.js HTTP & File System Architecture
 * Port: 8080 (Configurable)
 * Max File Size limit: 50MB
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'payloads');
const MAX_PAYLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit

// Ensure the storage directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Generates a high-entropy, unique 6-character alphanumeric key
 */
function generateShortKey() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

/**
 * Sends a clean JSON response with proper CORS headers
 */
function sendJSON(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
    // Handle CORS preflight options request
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // Route 1: Serve main frontend app (index.html)
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const indexPath = path.join(__dirname, 'index.html');
        fs.readFile(indexPath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error: Make sure index.html is in the same directory as backend.js');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            }
        });
        return;
    }

    // Route 2: Create a secure "Ghost Drop" payload
    if (req.method === 'POST' && pathname === '/api/drop') {
        let body = '';
        let bodyLength = 0;

        req.on('data', chunk => {
            body += chunk;
            bodyLength += chunk.length;
            if (bodyLength > MAX_PAYLOAD_SIZE) {
                sendJSON(res, 413, { error: 'Payload exceeds maximum limit of 50MB.' });
                req.destroy();
            }
        });

        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                if (!parsed.payload) {
                    return sendJSON(res, 400, { error: 'Missing encrypted data payload.' });
                }

                const key = generateShortKey();
                const filePath = path.join(UPLOAD_DIR, `${key}.json`);

                const fileData = {
                    payload: parsed.payload,
                    tier: parsed.tier || '1',
                    created: Date.now()
                };

                fs.writeFile(filePath, JSON.stringify(fileData), (err) => {
                    if (err) {
                        return sendJSON(res, 500, { error: 'Failed to write data to disk.' });
                    }
                    sendJSON(res, 200, { success: true, key: key });
                });
            } catch (e) {
                sendJSON(res, 400, { error: 'Malformed JSON body.' });
            }
        });
        return;
    }

    // Route 3: Retrieve an encrypted payload
    if (req.method === 'GET' && pathname.startsWith('/api/drop/')) {
        const key = pathname.split('/')[3];
        if (!key || key.length !== 6 || !/^[A-Z0-9]+$/i.test(key)) {
            return sendJSON(res, 400, { error: 'Invalid key signature.' });
        }

        const filePath = path.join(UPLOAD_DIR, `${key.toUpperCase()}.json`);
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                return sendJSON(res, 404, { error: 'Secure Drop payload not found or expired.' });
            }
            try {
                const parsed = JSON.parse(data);
                sendJSON(res, 200, parsed);
            } catch (e) {
                sendJSON(res, 500, { error: 'Error parsing stored transaction data.' });
            }
        });
        return;
    }

    // Fallback handler
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`PHANTOM SECURE BACKEND RUNNING ON PORT: ${PORT}`);
    console.log(`Storage Directory verified: ${UPLOAD_DIR}`);
    console.log(`===================================================`);
});

/**
 * PHANTOM VAULT - ZERO-DEPENDENCY ENTERPRISE NODE
 * Protocol: HTTP | Storage: Local FS | External Dependencies: 0
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- SYSTEM CONFIGURATION ---
const PORT = process.env.PORT || 8080;
const VAULT_DIR = path.join(__dirname, 'vault_data');
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50MB Hard Limit

// Initialize Physical Vault Storage
if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });

// --- CRYPTOGRAPHIC UTILS ---
const generateVaultKey = () => crypto.randomBytes(3).toString('hex').toUpperCase();

const sendJSON = (res, status, data) => {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
};

// --- CORE ROUTER ---
const server = http.createServer((req, res) => {
    // 1. CORS Preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // 2. Serve Frontend Application
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const indexPath = path.join(__dirname, 'index.html');
        fs.readFile(indexPath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                return res.end('CRITICAL ERROR: index.html not found in server root.');
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
        return;
    }

    // 3. INGRESS: Seal Data into Vault (POST /api/seal)
    if (req.method === 'POST' && pathname === '/api/seal') {
        let body = '';
        let byteCount = 0;

        req.on('data', chunk => {
            body += chunk;
            byteCount += chunk.length;
            if (byteCount > MAX_PAYLOAD_BYTES) {
                sendJSON(res, 413, { error: 'Payload exceeds 50MB architectural limit.' });
                req.destroy(); // Sever connection instantly to protect RAM
            }
        });

        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                if (!parsed.payloadHex) return sendJSON(res, 400, { error: 'Invalid payload schema.' });

                const vaultId = generateVaultKey();
                const filePath = path.join(VAULT_DIR, `${vaultId}.json`);
                
                const artifact = { tier: parsed.tier || '1', hex: parsed.payloadHex, timestamp: Date.now() };

                fs.writeFile(filePath, JSON.stringify(artifact), (err) => {
                    if (err) return sendJSON(res, 500, { error: 'Disk write failure.' });
                    sendJSON(res, 200, { success: true, vaultId: vaultId });
                });
            } catch (e) {
                sendJSON(res, 400, { error: 'Malformed JSON payload.' });
            }
        });
        return;
    }

    // 4. EGRESS: Extract Data from Vault (GET /api/open/:id)
    if (req.method === 'GET' && pathname.startsWith('/api/open/')) {
        const vaultId = pathname.split('/')[3];
        
        // Strict Path Traversal Prevention
        if (!vaultId || !/^[A-Z0-9]{6}$/.test(vaultId)) {
            return sendJSON(res, 400, { error: 'Invalid Vault ID format.' });
        }

        const filePath = path.join(VAULT_DIR, `${vaultId}.json`);
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) return sendJSON(res, 404, { error: 'Vault artifact not found or destroyed.' });
            try {
                sendJSON(res, 200, JSON.parse(data));
            } catch (e) {
                sendJSON(res, 500, { error: 'Corrupted vault artifact.' });
            }
        });
        return;
    }

    // Fallback
    res.writeHead(404);
    res.end('Route Not Found');
});

// --- IGNITION ---
server.listen(PORT, () => {
    console.log(`\n=== PHANTOM VAULT BACKEND SECURE NODE ===`);
    console.log(`[+] Status   : ONLINE`);
    console.log(`[+] Port     : ${PORT}`);
    console.log(`[+] Storage  : ${VAULT_DIR}`);
    console.log(`[+] Max Size : ${MAX_PAYLOAD_BYTES / (1024 * 1024)} MB`);
    console.log(`=========================================\n`);
});

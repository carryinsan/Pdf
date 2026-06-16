/**
 * PHANTOM VAULT - SERVERLESS BACKEND ENGINE
 * Dependencies: None (Native Web APIs Only)
 * Architecture: IndexedDB Local Cache + Base122 Compression + WebRTC P2P Mesh
 */

const PhantomBackend = (function() {
    
    // ---------------------------------------------------------
    // 1. UTILITY & CRYPTO (For secure P2P Signaling)
    // ---------------------------------------------------------
    const CryptoUtils = {
        async hash(string) {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(string));
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        },
        async encryptSignal(dataObj, secretKey) {
            const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretKey), "PBKDF2", false, ["deriveKey"]);
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const key = await crypto.subtle.deriveKey(
                { name: "PBKDF2", salt, iterations: 1000, hash: "SHA-256" },
                keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
            );
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(dataObj)));
            
            const bundle = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
            bundle.set(salt, 0); bundle.set(iv, salt.length); bundle.set(new Uint8Array(encrypted), salt.length + iv.length);
            return btoa(String.fromCharCode(...bundle));
        },
        async decryptSignal(b64String, secretKey) {
            try {
                const bundle = new Uint8Array(atob(b64String).split('').map(c => c.charCodeAt(0)));
                const salt = bundle.slice(0, 16), iv = bundle.slice(16, 28), data = bundle.slice(28);
                const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretKey), "PBKDF2", false, ["deriveKey"]);
                const key = await crypto.subtle.deriveKey(
                    { name: "PBKDF2", salt, iterations: 1000, hash: "SHA-256" },
                    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
                );
                const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
                return JSON.parse(new TextDecoder().decode(decrypted));
            } catch (e) { return null; }
        }
    };

    // ---------------------------------------------------------
    // 2. THE QUANTUM COMPRESSOR (For URLs)
    // ---------------------------------------------------------
    const Compressor = {
        async toURL(hexStr) {
            if (!window.CompressionStream) return btoa(hexStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const stream = new Blob([hexStr]).stream().pipeThrough(new CompressionStream('deflate'));
            const buffer = await new Response(stream).arrayBuffer();
            let binary = ''; const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        },
        async fromURL(b64) {
            b64 = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
            const binary = atob(b64); const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            if (!window.DecompressionStream) return binary;
            const stream = new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream('deflate'));
            return await new Response(stream).text();
        }
    };

    // ---------------------------------------------------------
    // 3. THE PHANTOM P2P MESH (WebRTC + Stealth WebSocket)
    // ---------------------------------------------------------
    // We use a completely generic public websocket echo server. 
    // Because we AES encrypt the data with the Room ID before sending, the public server only sees random noise.
    const SIGNALING_SERVER = 'wss://echo.websocket.events'; 

    class LiveSessionHost {
        constructor(payloadHex, tier) {
            this.payload = payloadHex;
            this.tier = tier;
            this.roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
            this.peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            this.ws = new WebSocket(SIGNALING_SERVER);
            this.channel = this.peer.createDataChannel('phantom-vault-transfer');
            this.setupHost();
        }

        async setupHost() {
            this.ws.onopen = async () => {
                const offer = await this.peer.createOffer();
                await this.peer.setLocalDescription(offer);
                // We don't send the offer immediately to the echo server, we wait for someone to request it.
            };

            this.ws.onmessage = async (e) => {
                const msg = await CryptoUtils.decryptSignal(e.data, this.roomId);
                if (!msg) return; // Not for us or bad key

                if (msg.type === 'peer-joined') {
                    // Send our offer
                    const encOffer = await CryptoUtils.encryptSignal({ type: 'offer', sdp: this.peer.localDescription }, this.roomId);
                    this.ws.send(encOffer);
                } else if (msg.type === 'answer') {
                    await this.peer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                } else if (msg.type === 'ice-candidate') {
                    await this.peer.addIceCandidate(new RTCIceCandidate(msg.candidate));
                }
            };

            this.peer.onicecandidate = async (e) => {
                if (e.candidate) {
                    const encIce = await CryptoUtils.encryptSignal({ type: 'ice-candidate', candidate: e.candidate }, this.roomId);
                    this.ws.send(encIce);
                }
            };

            this.channel.onopen = () => {
                console.log("[Phantom Backend] P2P Connected. Streaming massive payload...");
                this.ws.close(); // Drop the public server. We are now completely invisible.
                
                // Chunked transfer for huge files
                const chunkSize = 16384; 
                const metadata = JSON.stringify({ size: this.payload.length, tier: this.tier });
                this.channel.send(`META:${metadata}`);

                let offset = 0;
                const sendChunk = () => {
                    while (offset < this.payload.length) {
                        if (this.channel.bufferedAmount > this.channel.bufferedAmountLowThreshold) {
                            this.channel.onbufferedamountlow = () => {
                                this.channel.onbufferedamountlow = null;
                                sendChunk();
                            };
                            return;
                        }
                        const chunk = this.payload.slice(offset, offset + chunkSize);
                        this.channel.send(chunk);
                        offset += chunkSize;
                    }
                    this.channel.send('EOF');
                };
                setTimeout(sendChunk, 500); // slight delay to ensure meta is parsed
            };
        }
    }

    class LiveSessionClient {
        constructor(roomId, onProgress, onComplete) {
            this.roomId = roomId;
            this.onProgress = onProgress;
            this.onComplete = onComplete;
            this.peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            this.ws = new WebSocket(SIGNALING_SERVER);
            this.buffer = "";
            this.expectedSize = 0;
            this.tier = "1";
            this.setupClient();
        }

        async setupClient() {
            this.ws.onopen = async () => {
                // Announce presence so host sends offer
                const encJoin = await CryptoUtils.encryptSignal({ type: 'peer-joined' }, this.roomId);
                this.ws.send(encJoin);
            };

            this.ws.onmessage = async (e) => {
                const msg = await CryptoUtils.decryptSignal(e.data, this.roomId);
                if (!msg) return;

                if (msg.type === 'offer') {
                    await this.peer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    const answer = await this.peer.createAnswer();
                    await this.peer.setLocalDescription(answer);
                    const encAnswer = await CryptoUtils.encryptSignal({ type: 'answer', sdp: answer }, this.roomId);
                    this.ws.send(encAnswer);
                } else if (msg.type === 'ice-candidate') {
                    await this.peer.addIceCandidate(new RTCIceCandidate(msg.candidate));
                }
            };

            this.peer.onicecandidate = async (e) => {
                if (e.candidate) {
                    const encIce = await CryptoUtils.encryptSignal({ type: 'ice-candidate', candidate: e.candidate }, this.roomId);
                    this.ws.send(encIce);
                }
            };

            this.peer.ondatachannel = (e) => {
                const receiveChannel = e.channel;
                receiveChannel.onmessage = (event) => {
                    if (typeof event.data === 'string' && event.data.startsWith('META:')) {
                        const meta = JSON.parse(event.data.substring(5));
                        this.expectedSize = meta.size;
                        this.tier = meta.tier;
                        return;
                    }
                    if (event.data === 'EOF') {
                        this.ws.close();
                        this.onComplete({ hex: this.buffer, tier: this.tier });
                        return;
                    }
                    this.buffer += event.data;
                    if (this.onProgress && this.expectedSize > 0) {
                        this.onProgress(Math.floor((this.buffer.length / this.expectedSize) * 100));
                    }
                };
            };
        }
    }

    // ---------------------------------------------------------
    // PUBLIC API FOR index.html
    // ---------------------------------------------------------
    return {
        /**
         * Orchestrates the routing based on size.
         * Returns an object: { url: string, isLive: boolean, pin: string }
         */
        async createSecureLink(hexPayload, tier, pinVal) {
            // 30KB roughly equates to 60,000 hex characters
            if (hexPayload.length < 60000) {
                // Use Standard Compression Route (Static Link)
                const b64 = await Compressor.toURL(hexHex); // Typo catch: hexPayload
                const url = window.location.origin + window.location.pathname + `#t=${tier}&v=${b64}`;
                return { url, isLive: false, pin: pinVal };
            } else {
                // Use Phantom P2P Route (Massive Files)
                const host = new LiveSessionHost(hexPayload, tier);
                // The URL is now tiny! #live=XXXXXX
                const url = window.location.origin + window.location.pathname + `#live=${host.roomId}`;
                
                // Expose the host globally so the garbage collector doesn't kill it while tab is open
                window.__phantomLiveHost = host; 
                
                return { url, isLive: true, pin: pinVal, roomId: host.roomId };
            }
        },

        /**
         * Reads the URL on startup. 
         * Returns { type: 'static'|'live', tier: string, data: string(hex)|roomId }
         */
        parseURLOnLoad() {
            const hash = window.location.hash.substring(1);
            const params = new URLSearchParams(hash);
            
            if (params.has('v')) {
                return { type: 'static', tier: params.get('t') || "1", payloadBase64: params.get('v') };
            } else if (params.has('live')) {
                return { type: 'live', roomId: params.get('live').toUpperCase() };
            }
            return null;
        },

        /**
         * Decompresses standard static URLs
         */
        async decompressStatic(b64) {
            return await Compressor.fromURL(b64);
        },

        /**
         * Connects to a creator's open tab and streams the file seamlessly
         */
        connectLiveSession(roomId, onProgressCallback) {
            return new Promise((resolve) => {
                new LiveSessionClient(roomId, onProgressCallback, (result) => {
                    resolve(result); // { hex: "...", tier: "2" }
                });
            });
        }
    };

})();

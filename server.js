const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const readline = require('readline');

const app = express();
const server = http.createServer(app);
// UPDATED: Heavy payload configuration with a built-in safety shield
const wss = new WebSocket.Server({ 
    server, 
    maxPayload: 500 * 1024 * 1024 // Expanded to 500MB so large photos/videos easily fit!
});

// The Safety Shield: Prevents the server from crashing if a payload error happens
wss.on('error', (err) => {
    console.log(`\x1b[31m[SERVER ERROR SHIELD]: Intercepted payload anomaly: ${err.message}\x1b[0m`);
});

app.use(express.static(__dirname));

let db;
const liveConnections = {}; 
const pendingRequests = {}; // Temporarily holds users waiting for admin approval

// Set up terminal input reading machine
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function initDatabase() {
    db = await open({
        filename: './linker_storage.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
            roomCode TEXT PRIMARY KEY,
            password TEXT,
            isLocked INTEGER DEFAULT 0,
            adminToken TEXT
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            msgId TEXT PRIMARY KEY,
            roomCode TEXT,
            username TEXT,
            avatar TEXT,
            type TEXT,
            text TEXT,
            data TEXT,
            mimeType TEXT,
            burnDuration INTEGER,
            timestamp INTEGER
        )
    `);

    console.log(`\x1b[32m[DATABASE]: LOCAL STORAGE NOTEBOOK IS READY\x1b[0m`);
    handleTerminalInput(); // Start watching your cmd line for Y/N inputs
}

// TERMINAL GATEKEEPER INTERACTION ENGINE
function handleTerminalInput() {
    rl.question('', async (input) => {
        const cleanInput = input.trim().toLowerCase();
        const nextRequestKey = Object.keys(pendingRequests)[0];

        if (nextRequestKey) {
            const req = pendingRequests[nextRequestKey];
            
            if (cleanInput === 'y') {
                console.log(`\x1b[32m[ACCESS GRANTED]: Allowing ${req.username} to attach to node.\x1b[0m`);
                
                // 1. Temporarily unlock the room in the database so they can slip in
                await db.run(`UPDATE rooms SET isLocked = 0 WHERE roomCode = ?`, [req.roomCode]);
                
                // 2. Tell the user they are allowed to join!
                req.ws.send(JSON.stringify({ 
                    type: 'request_approved', 
                    roomCode: req.roomCode, 
                    password: req.password 
                }));
                
                // 3. Delete the request from our active queue
                delete pendingRequests[nextRequestKey];
            } 
            else if (cleanInput === 'n') {
                console.log(`\x1b[31m[ACCESS DENIED]: Denied entry for ${req.username}.\x1b[0m`);
                
                req.ws.send(JSON.stringify({ 
                    type: 'request_denied', 
                    message: 'SORRY, ADMIN HAS NOT ALLOWED TO UNLOCK THE LINK.' 
                }));
                
                delete pendingRequests[nextRequestKey];
            } 
            else {
                console.log(`\x1b[33mInvalid input. Please enter 'Y' or 'N' for ${req.username}: \x1b[0m`);
            }
        }
        
        // Loop back to keep terminal input listening alive
        handleTerminalInput();
    });
}

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 6);
}

wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'create_room') {
                let newCode = generateRoomCode();
                await db.run(
                    `INSERT INTO rooms (roomCode, password, isLocked, adminToken) VALUES (?, ?, 0, ?)`,
                    [newCode, data.password, data.adminToken]
                );

                if (!liveConnections[newCode]) liveConnections[newCode] = new Set();
                liveConnections[newCode].add(ws);
                
                ws.roomCode = newCode; 
                ws.username = data.username; 
                ws.avatar = data.avatar;
                ws.isAdmin = true;

                ws.send(JSON.stringify({ type: 'system', status: 'room_created', roomCode: newCode, password: data.password, isAdmin: true }));
                ws.send(JSON.stringify({ type: 'history_dump', history: [] }));
                broadcastRoomCount(newCode);
            } 
            
            else if (data.type === 'join_room') {
                const room = await db.get(`SELECT * FROM rooms WHERE roomCode = ?`, [data.roomCode]);

                if (!room) {
                    ws.send(JSON.stringify({ type: 'system', status: 'error', errCode: 'ROOM_EXPIRED', roomCode: data.roomCode, message: 'TRANSMISSION LINK EXPIRED OR DESTROYED IN FILE ENGINE' }));
                    return;
                }

                // IF ROOM IS LOCKED, TRIGGER THE LOBBY REQUEST FILTER
                if (room.isLocked === 1) {
                    ws.send(JSON.stringify({ 
                        type: 'system', 
                        status: 'error', 
                        errCode: 'ROOM_LOCKED_GATEWAY', 
                        username: data.username,
                        roomCode: data.roomCode,
                        password: data.password
                    }));
                    return;
                }

                if (room.password === data.password) {
                    if (!liveConnections[data.roomCode]) liveConnections[data.roomCode] = new Set();
                    liveConnections[data.roomCode].add(ws);
                    
                    ws.roomCode = data.roomCode; 
                    ws.username = data.username; 
                    ws.avatar = data.avatar;
                    ws.isAdmin = (room.adminToken === data.adminToken);

                    const history = await db.all(`SELECT * FROM messages WHERE roomCode = ? ORDER BY timestamp ASC`, [data.roomCode]);

                    ws.send(JSON.stringify({ type: 'system', status: 'room_joined', roomCode: data.roomCode, password: data.password, isAdmin: ws.isAdmin }));
                    ws.send(JSON.stringify({ type: 'history_dump', history: history }));
                    
                    broadcastToRoom(ws.roomCode, { type: 'system_msg', text: `Authorized Personnel [${data.username}] connected to transmission.` }, ws);
                    broadcastRoomCount(ws.roomCode);
                } else {
                    ws.send(JSON.stringify({ type: 'system', status: 'error', errCode: 'BAD_PIN', message: 'AUTHENTICATION FAILURE: INVALID SECURITY PIN' }));
                }
            }

            // USER ACTIVATES THE REQUEST ACCESS BUTTON
            else if (data.type === 'request_access_signal') {
                const reqKey = `${data.username}_${data.roomCode}`;
                pendingRequests[reqKey] = {
                    ws: ws,
                    username: data.username,
                    roomCode: data.roomCode,
                    password: data.password
                };

                // Print out the question line directly inside your black cmd panel!
                console.log(`\n\x1b[35m[REQUEST]: ${data.username} is asking for you to unlock the link. Want to unlock? (Y/N):\x1b[0m `);
            }
            
            else if (data.type === 'chat' || data.type === 'media') {
                if (ws.roomCode) {
                    const ts = Date.now();
                    await db.run(
                        `INSERT INTO messages (msgId, roomCode, username, avatar, type, text, data, mimeType, burnDuration, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [data.msgId, ws.roomCode, ws.username, ws.avatar, data.type, data.text || null, data.data || null, data.mimeType || null, data.burnDuration || null, ts]
                    );
                    broadcastToRoom(ws.roomCode, { ...data, timestamp: ts }, ws);
                }
            }
            
            else if (data.type === 'delete_msg') {
                if (ws.roomCode) {
                    await db.run(`DELETE FROM messages WHERE msgId = ?`, [data.msgId]);
                    broadcastToRoom(ws.roomCode, data, ws);
                }
            }
            
            else if (data.type === 'clear_history') {
                if (ws.roomCode) {
                    await db.run(`DELETE FROM messages WHERE roomCode = ?`, [ws.roomCode]);
                    broadcastToRoom(ws.roomCode, { type: 'clear_history' }, ws);
                }
            }
            
            else if (data.type === 'typing') {
                if (ws.roomCode) {
                    broadcastToRoom(ws.roomCode, { type: 'typing', username: ws.username, isTyping: data.isTyping }, ws);
                }
            }

            else if (data.type === 'status_change') {
                if (ws.roomCode) {
                    broadcastToRoom(ws.roomCode, { type: 'status_update', username: ws.username, status: data.status }, ws);
                }
            }

            else if (data.type === 'admin_lock') {
                if (ws.roomCode && ws.isAdmin) {
                    const lockVal = data.lockState ? 1 : 0;
                    await db.run(`UPDATE rooms SET isLocked = ? WHERE roomCode = ?`, [lockVal, ws.roomCode]);
                    broadcastToRoom(ws.roomCode, { type: 'system_msg', text: `NODE LOCK STATE UPDATED: ${data.lockState ? 'SECURED' : 'OPENED'}` }, null);
                }
            }
            else if (data.type === 'admin_kick') {
                if (ws.roomCode && ws.isAdmin) {
                    if (liveConnections[ws.roomCode]) {
                        liveConnections[ws.roomCode].forEach(client => {
                            if (client.username === data.targetUser) {
                                client.send(JSON.stringify({ type: 'system', status: 'kicked', message: 'TERMINATED BY ADMINISTRATIVE OVERRIDE' }));
                                client.terminate();
                            }
                        });
                    }
                }
            }
        } catch (err) {
            console.error("[ERROR]: Corrupted Data Packet Process", err);
        }
    });

    ws.on('close', () => {
        if (ws.roomCode && liveConnections[ws.roomCode]) {
            liveConnections[ws.roomCode].delete(ws);
            broadcastRoomCount(ws.roomCode);
        }
        // Clean up pending approvals if user disconnects while waiting
        for (const key in pendingRequests) {
            if (pendingRequests[key].ws === ws) delete pendingRequests[key];
        }
    });
});

function broadcastToRoom(roomCode, data, senderWs) {
    if (liveConnections[roomCode]) {
        const payload = JSON.stringify(data);
        liveConnections[roomCode].forEach(client => {
            if (client !== senderWs && client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
}

function broadcastRoomCount(roomCode) {
    if (liveConnections[roomCode]) {
        const count = liveConnections[roomCode].size;
        const payload = JSON.stringify({ type: 'occupancy_update', count: count });
        liveConnections[roomCode].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    await initDatabase();
    console.log(`\n==================================================`);
    console.log(`🔴 WEB LINKER V1.a1 TERMINAL GATEKEEPER ONLINE 🔴`);
    console.log(`==================================================\n`);
});
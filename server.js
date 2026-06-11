const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    maxHttpBufferSize: 5e7 // 50MB Limit for heavy images
});

// CLOUD ROUTING: Uses Render's permanent disk, defaults to local folder on your PC
const dbPath = process.env.RENDER ? '/data/linker_storage.db' : path.join(__dirname, 'linker_storage.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("❌ Database Connection Error:", err.message);
    else console.log("📦 SQLite Database successfully connected at:", dbPath);
});

// Database Architecture Setup
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        roomCode TEXT PRIMARY KEY,
        pin TEXT,
        createdAt INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roomCode TEXT,
        alias TEXT,
        avatar TEXT,
        text TEXT,
        media TEXT,
        timestamp INTEGER,
        FOREIGN KEY(roomCode) REFERENCES rooms(roomCode)
    )`);
});

// Serve Frontend Static Web UI Files
app.use(express.static(__dirname));

app.get('/', (valueReq, valueRes) => {
    valueRes.sendFile(path.join(__dirname, 'index.html'));
});

// Real-time Data Packet Network Engine
io.on('connection', (socket) => {
    let assignedRoom = null;

    socket.on('join-room', ({ roomCode, pin }) => {
        db.get("SELECT * FROM rooms WHERE roomCode = ?", [roomCode], (err, row) => {
            if (err) return socket.emit('error-msg', 'Database processing error.');
            
            if (!row) {
                // Generate a brand new secure node room
                const now = Date.now();
                db.run("INSERT INTO rooms (roomCode, pin, createdAt) VALUES (?, ?, ?)", [roomCode, pin, now], (insertErr) => {
                    if (insertErr) return socket.emit('error-msg', 'Failed to generate cloud node.');
                    executeJoin(roomCode);
                });
            } else {
                // Verify structural data security pin
                if (row.pin === pin) {
                    executeJoin(roomCode);
                } else {
                    socket.emit('bad-pin');
                }
            }
        });
    });

    function executeJoin(roomCode) {
        assignedRoom = roomCode;
        socket.join(roomCode);
        
        // Retrieve historical packet logs
        db.all("SELECT alias, avatar, text, media, timestamp FROM messages WHERE roomCode = ? ORDER BY id ASC", [roomCode], (err, rows) => {
            if (!err && rows) {
                socket.emit('load-history', rows);
            }
        });
    }

    socket.on('send-chat', (packet) => {
        if (!assignedRoom) return;
        const now = Date.now();

        db.run("INSERT INTO messages (roomCode, alias, avatar, text, media, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            [assignedRoom, packet.alias, packet.avatar, packet.text, packet.media || null, now],
            function(err) {
                if (!err) {
                    io.to(assignedRoom).emit('receive-chat', {
                        alias: packet.alias,
                        avatar: packet.avatar,
                        text: packet.text,
                        media: packet.media || null,
                        timestamp: now
                    });
                }
            }
        );
    });

    socket.on('disconnect', () => {
        if(assignedRoom) socket.leave(assignedRoom);
    });
});

// CLOUD ROUTING: Dynamically bind port assigned by host environment
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 WEB LINKER SYSTEM OPERATIONAL`);
    console.log(`📡 Broadcast Engine Listening on port: ${PORT}\n`);
});
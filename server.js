const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Yahan hum aapka naya API Bridge path use kar rahe hain
const API_URL = "https://matkaexch.live/api/game_api.php"; 

app.get('/', (req, res) => {
    res.send("Railway Cloud Engine is 100% Live with API Bridge!");
});

io.on('connection', (socket) => {
    console.log(`New player connected: ${socket.id}`);

    socket.on('join_table', async (data) => {
        try {
            const { userId, entryPoints } = data;
            
            // MySQL ki jagah hum direct aapki PHP API se points check kar rahe hain
            const response = await fetch(`${API_URL}?user_id=${userId}`);
            const dbData = await response.json();
            
            if (dbData.success) {
                const userPoints = dbData.points;
                if (userPoints >= entryPoints) {
                    socket.emit('table_joined', { success: true });
                } else {
                    socket.emit('error', { message: "Insufficient points." });
                }
            } else {
                socket.emit('error', { message: dbData.message || "User not found in DB." });
            }
        } catch (error) {
            console.error("API Fetch Error:", error.message);
            socket.emit('error', { message: "Database bridge connection issue." });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
    });
});

// Railway hamesha process.env.PORT khud assign karta hai
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Engine running perfectly on port ${PORT} using API Bridge!`);
});

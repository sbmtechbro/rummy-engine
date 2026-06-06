const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Crash-Proof Database Connection
const db = mysql.createPool({
    host: '54.39.160.85', // <-- Apna cPanel Shared IP zarur daalein
    user: 'motkrj_matkaexchfinal', 
    password: 'motkrj_matkaexchfinal', 
    database: 'motkrj_matkaexchfinal',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// DB Check on Startup
db.getConnection()
    .then(connection => {
        console.log("✅ Database Connected Successfully from Railway!");
        connection.release();
    })
    .catch(err => {
        console.error("❌ DB Connection Failed! Check cPanel IP or Remote MySQL settings.");
        console.error("Error Details:", err.message);
    });

app.get('/', (req, res) => {
    res.send("Railway Cloud Engine is 100% Live!");
});

io.on('connection', (socket) => {
    console.log(`New player connected: ${socket.id}`);

    socket.on('join_table', async (data) => {
        try {
            const { userId, entryPoints } = data;
            const [rows] = await db.execute('SELECT available_points FROM users WHERE id = ?', [userId]);
            
            if (rows.length > 0) {
                const userPoints = rows[0].available_points;
                if (userPoints >= entryPoints) {
                    socket.emit('table_joined', { success: true });
                } else {
                    socket.emit('error', { message: "Insufficient points." });
                }
            } else {
                socket.emit('error', { message: "User not found." });
            }
        } catch (error) {
            console.error("Game DB Error:", error.message);
            socket.emit('error', { message: "Database connection issue." });
        }
    });
});

// Railway hamesha process.env.PORT khud assign karta hai
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Engine running perfectly on port ${PORT}`);
});

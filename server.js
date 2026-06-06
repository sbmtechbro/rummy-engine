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

// Aapki cPanel Wallet API ka path
const WALLET_API_URL = "https://matkaexch.live/api/wallet_api.php"; 

// Game State: Yahan hum tables ka data store kar rahe hain
const tables = {
    'pool_201': { players: [], pot: 0, entryFee: 50 },
    'points_1': { players: [], pot: 0, entryFee: 10 }
};

app.get('/', (req, res) => {
    res.send("Pro Railway Game Engine is Live with Wallet Integration!");
});

io.on('connection', (socket) => {
    console.log(`New player connected: ${socket.id}`);

    // --- EVENT 1: JOIN TABLE & DEDUCT ENTRY FEE ---
    socket.on('join_table', async (data) => {
        const { userId, tableId } = data;
        const table = tables[tableId];

        if (!table) return socket.emit('error', { message: "Table not found." });

        try {
            // Node.js se PHP (cPanel) ko POST request bhej rahe hain fee katne ke liye
            const formData = new URLSearchParams();
            formData.append('user_id', userId);
            formData.append('amount', table.entryFee);
            formData.append('action', 'deduct_entry');
            formData.append('remark', `Entry Fee Paid for Table: ${tableId}`);

            const response = await fetch(WALLET_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData.toString()
            });

            const dbData = await response.json();

            if (dbData.success) {
                // Paise kat gaye -> Player ko table mein add karo aur Pot badao
                table.players.push(userId);
                table.pot += table.entryFee;

                socket.join(tableId); // Player ko room mein daal diya
                socket.userId = userId;
                socket.tableId = tableId;

                // Table par sabko batao ki naya player aaya aur pot kitna hua
                io.to(tableId).emit('table_update', { 
                    message: `Player ${userId} joined!`,
                    currentPot: table.pot,
                    totalPlayers: table.players.length
                });

                socket.emit('table_joined', { success: true, message: "Entry fee deducted. Game Started!" });
            } else {
                socket.emit('error', { message: dbData.message || "Balance deduction failed." });
            }
        } catch (error) {
            console.error("Wallet API Error:", error.message);
            socket.emit('error', { message: "Transaction server down." });
        }
    });

    // --- EVENT 2: DECLARE WINNER & DISTRIBUTE PRIZE (ADMIN PROFIT CUT) ---
    socket.on('declare_win', async () => {
        const userId = socket.userId;
        const tableId = socket.tableId;
        const table = tables[tableId];

        if (!userId || !tableId || !table) {
            return socket.emit('error', { message: "Invalid game state." });
        }

        try {
            const totalPot = table.pot;
            
            // Winnings distribute karne ke liye PHP API call
            const formData = new URLSearchParams();
            formData.append('user_id', userId);
            formData.append('amount', totalPot);
            formData.append('action', 'add_win');
            formData.append('remark', `Won Table: ${tableId}`);

            const response = await fetch(WALLET_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData.toString()
            });

            const dbData = await response.json();

            if (dbData.success) {
                // Table par sabko alert bhejo ki game khatam
                io.to(tableId).emit('game_over', { 
                    winner: userId, 
                    totalPot: totalPot,
                    creditedAmount: dbData.credited, // 10% admin profit katne ke baad ka amount
                    message: `Player ${userId} Won! ₹${dbData.credited} credited to wallet.`
                });

                // Game khatam hone ke baad table reset kar do agli game ke liye
                table.pot = 0;
                table.players = [];
                io.socketsLeave(tableId); // Sabko room se bahar nikal do
            } else {
                socket.emit('error', { message: "Failed to credit winnings." });
            }

        } catch (error) {
            console.error("Wallet API Error:", error.message);
            socket.emit('error', { message: "Prize distribution failed." });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        // Yahan par hum penalty logic laga sakte hain agar koi beech mein bhagta hai
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Pro Engine running perfectly on port ${PORT} with Real-Money Logic!`);
});

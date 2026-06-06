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

const WALLET_API_URL = "https://matkaexch.live/api/wallet_api.php"; 

// --- SAARE GAMES KI TABLES ---
const tables = {
    'points_1': { players: [], pot: 0, entryFee: 80, activeTurn: 0, timer: null },
    'pool_201': { players: [], pot: 0, entryFee: 50, activeTurn: 0, timer: null },
    'deals_2':  { players: [], pot: 0, entryFee: 100, activeTurn: 0, timer: null }
};

app.get('/', (req, res) => res.send("Advanced Rummy Engine Live: 3-Strike Rule Active!"));

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    // --- EVENT 1: JOIN LOBBY (Paisa Katna) ---
    socket.on('join_table', async (data) => {
        const { userId, tableId } = data;
        const table = tables[tableId];
        
        if (!table) return socket.emit('error', { message: "Table not found." });

        const existingPlayer = table.players.find(p => p.id == userId);
        if(existingPlayer) return socket.emit('table_joined', { success: true, tableId });

        try {
            const formData = new URLSearchParams();
            formData.append('user_id', userId);
            formData.append('amount', table.entryFee);
            formData.append('action', 'deduct_entry');
            formData.append('remark', tableId); 

            const response = await fetch(WALLET_API_URL, { method: 'POST', body: formData });
            const dbData = await response.json();

            if (dbData.success) {
                // Naya Player: missedTurns = 0 set kiya hai
                table.players.push({ id: userId, socketId: null, status: 'active', missedTurns: 0 });
                table.pot += table.entryFee;
                socket.emit('table_joined', { success: true, tableId });
            } else {
                socket.emit('error', { message: dbData.message || "Balance issue." });
            }
        } catch (err) {
            socket.emit('error', { message: "Wallet API is down." });
        }
    });

    // --- EVENT 2: RECONNECT ON GAME PAGE ---
    socket.on('enter_game_room', (data) => {
        const { userId, tableId } = data;
        const table = tables[tableId];

        if (table) {
            socket.userId = userId;
            socket.tableId = tableId;
            socket.join(tableId);

            const player = table.players.find(p => p.id == userId);
            if(player) player.socketId = socket.id;

            io.to(tableId).emit('update_table_ui', {
                players: table.players,
                pot: table.pot
            });

            if (table.players.length >= 2 && !table.timer) {
                startNextTurn(tableId);
            }
        }
    });

    // --- TIMEOUT & 3-STRIKE DROP LOGIC ---
    function startNextTurn(tableId) {
        const table = tables[tableId];
        if (!table) return;

        clearTimeout(table.timer);

        const activePlayers = table.players.filter(p => p.status === 'active');
        
        // AUTO-WIN LOGIC
        if (activePlayers.length === 1) {
            return processWin(activePlayers[0].id, tableId);
        }
        if (activePlayers.length === 0) return; 

        // Next player turn
        table.activeTurn = (table.activeTurn + 1) % table.players.length;
        let currentPlayer = table.players[table.activeTurn];

        if (currentPlayer.status !== 'active') {
            return startNextTurn(tableId);
        }

        io.to(tableId).emit('turn_update', { activeUserId: currentPlayer.id, time: 15 });

        // 15 Second Timer -> 3 Strikes Logic
        table.timer = setTimeout(() => {
            currentPlayer.missedTurns++; // Chance Count Badhao
            
            if (currentPlayer.missedTurns >= 3) {
                // 3 Baar miss kar diya -> DROP
                io.to(tableId).emit('sys_message', `Player ${currentPlayer.id} dropped after 3 Timeouts!`);
                currentPlayer.status = 'dropped';
            } else {
                // Warning Bhejo
                io.to(tableId).emit('sys_message', `Player ${currentPlayer.id} missed turn. Warning: ${currentPlayer.missedTurns}/3`);
            }
            
            startNextTurn(tableId); // Agle player par jao
        }, 15000); 
    }

    // --- EVENT 3: MANUAL DROP ---
    socket.on('drop_game', () => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if (table) {
            const player = table.players.find(p => p.id == userId);
            if(player && player.status === 'active') {
                player.status = 'dropped';
                socket.emit('sys_message', "You dropped out.");
                
                if(table.players[table.activeTurn].id == userId) {
                    startNextTurn(tableId);
                } else {
                    const activePlayers = table.players.filter(p => p.status === 'active');
                    if(activePlayers.length === 1) processWin(activePlayers[0].id, tableId);
                }
            }
        }
    });

    // --- EVENT 4: DECLARE WIN (MANUAL) ---
    socket.on('declare_win', () => {
        const { userId, tableId } = socket;
        if (!userId || !tableId) return socket.emit('error', { message: "Invalid game state. Refresh page." });
        processWin(userId, tableId);
    });

    // Winnings Process Function
    async function processWin(winnerId, tableId) {
        const table = tables[tableId];
        if (!table || table.pot <= 0) return;

        clearTimeout(table.timer);
        table.timer = null;
        const totalPot = table.pot;
        
        try {
            const formData = new URLSearchParams();
            formData.append('user_id', winnerId);
            formData.append('amount', totalPot);
            formData.append('action', 'add_win');
            formData.append('remark', tableId);

            const response = await fetch(WALLET_API_URL, { method: 'POST', body: formData });
            const dbData = await response.json();

            if (dbData.success) {
                io.to(tableId).emit('game_over', { 
                    winner: winnerId, 
                    creditedAmount: dbData.credited,
                    message: `Game Over! Player ${winnerId} Won ₹${dbData.credited}.`
                });

                table.pot = 0;
                table.players = [];
                table.activeTurn = 0;
            } else {
                console.error("Wallet Error:", dbData.message);
            }
        } catch (err) {
            console.error("Prize API Error", err);
        }
    }

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Advanced Engine Running on Port ${PORT}`));

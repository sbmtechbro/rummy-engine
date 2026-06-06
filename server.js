const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const WALLET_API_URL = "https://matkaexch.live/api/wallet_api.php"; 

const tables = {}; 

// Real Card Deck Generator
const suits = [{s: '♥', c: 'red'}, {s: '♦', c: 'red'}, {s: '♣', c: 'black'}, {s: '♠', c: 'black'}];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function getShuffledDeck() {
    let deck = [];
    for (let suit of suits) {
        for (let value of values) {
            deck.push({ value, suit: suit.s, color: suit.c });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const indianBotNames = ["Rahul", "Pooja", "Amit", "Sneha", "Vikram", "Anjali", "Karan", "Priya"];

app.get('/', (req, res) => res.send("Pro Rummy Engine: Real Cards Fix Active!"));

io.on('connection', (socket) => {
    
    // 1. JOIN LOBBY
    socket.on('join_table', async (data) => {
        const { userId, tableId, entryFee } = data;
        
        if (!tables[tableId]) {
            tables[tableId] = { players: [], pot: 0, entryFee: parseInt(entryFee), activeTurn: 0, timer: null, deck: [], state: 'waiting' };
        }
        
        const table = tables[tableId];
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
                // Card save karne ke liye 'hand: []' add kiya hai
                table.players.push({ id: userId, isBot: false, socketId: null, status: 'active', missedTurns: 0, hand: [] });
                table.pot += table.entryFee;
                socket.emit('table_joined', { success: true, tableId });
            } else {
                socket.emit('error', { message: dbData.message || "Balance issue." });
            }
        } catch (err) {
            socket.emit('error', { message: "Wallet API is down." });
        }
    });

    // 2. ENTER GAME ROOM (Page Load)
    socket.on('enter_game_room', (data) => {
        const { userId, tableId } = data;
        const table = tables[tableId];

        if (table) {
            socket.userId = userId;
            socket.tableId = tableId;
            socket.join(tableId);

            const player = table.players.find(p => p.id == userId);
            if(player) {
                player.socketId = socket.id;
                
                // Agar game start ho chuka hai aur cards bat gaye hain, toh wapas bhejo
                if (player.hand.length > 0) {
                    socket.emit('deal_cards', player.hand);
                }
            }

            io.to(tableId).emit('update_table_ui', { players: table.players, pot: table.pot });

            // INSTANT BOT LOGIC (Jab player room me aa jaye tabhi start karo)
            if (table.players.length === 1 && table.state === 'waiting') {
                setTimeout(() => {
                    if (table.players.length === 1) { // Still alone
                        let botName = indianBotNames[Math.floor(Math.random() * indianBotNames.length)];
                        let botId = "BOT_" + Math.random().toString(36).substr(2, 5);
                        
                        table.players.push({ id: botId, name: botName, isBot: true, status: 'active', missedTurns: 0, hand: [] });
                        table.pot += table.entryFee;
                        
                        io.to(tableId).emit('update_table_ui', { players: table.players, pot: table.pot });
                        io.to(tableId).emit('sys_message', `${botName} joined! Dealing cards...`);
                        
                        startGame(tableId);
                    }
                }, 3000); // 3 sec ka buffer diya taaki page puri tarah load ho jaye
            } else if (table.players.length >= 2 && table.state === 'waiting') {
                startGame(tableId);
            }
        }
    });

    // 3. START GAME (Card Distribution)
    function startGame(tableId) {
        const table = tables[tableId];
        table.state = 'playing';
        table.deck = getShuffledDeck();

        // Sabko cards baanto aur array me save karo
        table.players.forEach(p => {
            p.hand = table.deck.splice(0, 13);
            if (!p.isBot && p.socketId) {
                io.to(p.socketId).emit('deal_cards', p.hand);
            }
        });

        startNextTurn(tableId);
    }

    // 4. TURN LOGIC
    function startNextTurn(tableId) {
        const table = tables[tableId];
        if (!table) return;

        clearTimeout(table.timer);
        const activePlayers = table.players.filter(p => p.status === 'active');
        
        if (activePlayers.length === 1 && !activePlayers[0].isBot) {
            return processWin(activePlayers[0].id, tableId);
        } else if (activePlayers.length === 1 && activePlayers[0].isBot) {
            io.to(tableId).emit('game_over', { winner: "BOT", message: "Bot Won. Better luck next time!" });
            table.pot = 0; table.players = []; table.deck = []; table.state = 'waiting';
            return;
        }
        if (activePlayers.length === 0) return; 

        table.activeTurn = (table.activeTurn + 1) % table.players.length;
        let currentPlayer = table.players[table.activeTurn];

        if (currentPlayer.status !== 'active') return startNextTurn(tableId);

        io.to(tableId).emit('turn_update', { activeUserId: currentPlayer.id, time: 15 });

        if (currentPlayer.isBot) {
            setTimeout(() => {
                io.to(tableId).emit('sys_message', `${currentPlayer.name} played their turn.`);
                startNextTurn(tableId);
            }, 3000); 
            return;
        }

        table.timer = setTimeout(() => {
            currentPlayer.missedTurns++; 
            if (currentPlayer.missedTurns >= 3) {
                io.to(tableId).emit('sys_message', `Player dropped after 3 Timeouts!`);
                currentPlayer.status = 'dropped';
            } else {
                io.to(tableId).emit('sys_message', `Turn missed. Warning: ${currentPlayer.missedTurns}/3`);
            }
            startNextTurn(tableId);
        }, 15000); 
    }

    // 5. DROP & WIN LOGIC
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
                    if(activePlayers.length === 1 && !activePlayers[0].isBot) processWin(activePlayers[0].id, tableId);
                }
            }
        }
    });

    socket.on('declare_win', () => {
        const { userId, tableId } = socket;
        processWin(userId, tableId);
    });

    async function processWin(winnerId, tableId) {
        const table = tables[tableId];
        if (!table || table.pot <= 0) return;

        clearTimeout(table.timer); table.timer = null;
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
                    winner: winnerId, creditedAmount: dbData.credited,
                    message: `Game Over! You Won ₹${dbData.credited}.`
                });
                table.pot = 0; table.players = []; table.activeTurn = 0; table.deck = []; table.state = 'waiting';
            }
        } catch (err) { console.error(err); }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Engine Running with Persistent Cards!`));

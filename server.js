const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const WALLET_API_URL = "https://matkaexch.live/api/wallet_api.php"; 

// Dynamic Tables Storage
const tables = {}; 

// Card Deck Generator
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

app.get('/', (req, res) => res.send("Pro Rummy Engine: Bots & Real Cards Active!"));

io.on('connection', (socket) => {
    
    socket.on('join_table', async (data) => {
        const { userId, tableId, entryFee } = data;
        
        // Dynamically create table if it doesn't exist
        if (!tables[tableId]) {
            tables[tableId] = { players: [], pot: 0, entryFee: parseInt(entryFee), activeTurn: 0, timer: null, deck: [] };
        }
        
        const table = tables[tableId];
        const existingPlayer = table.players.find(p => p.id == userId);
        if(existingPlayer) return socket.emit('table_joined', { success: true, tableId });

        try {
            // Deduct Wallet Balance
            const formData = new URLSearchParams();
            formData.append('user_id', userId);
            formData.append('amount', table.entryFee);
            formData.append('action', 'deduct_entry');
            formData.append('remark', tableId); 

            const response = await fetch(WALLET_API_URL, { method: 'POST', body: formData });
            const dbData = await response.json();

            if (dbData.success) {
                table.players.push({ id: userId, isBot: false, socketId: null, status: 'active', missedTurns: 0 });
                table.pot += table.entryFee;
                socket.emit('table_joined', { success: true, tableId });

                // INSTANT BOT LOGIC: If player is alone, add a bot after 2 seconds
                if (table.players.length === 1) {
                    setTimeout(() => {
                        if (table.players.length === 1) { // Still alone?
                            let botName = indianBotNames[Math.floor(Math.random() * indianBotNames.length)];
                            let botId = "BOT_" + Math.random().toString(36).substr(2, 5);
                            
                            table.players.push({ id: botId, name: botName, isBot: true, status: 'active', missedTurns: 0 });
                            table.pot += table.entryFee; // Bot also contributes to pot
                            
                            io.to(tableId).emit('update_table_ui', { players: table.players, pot: table.pot });
                            io.to(tableId).emit('sys_message', `${botName} joined the table!`);
                            
                            startNextTurn(tableId); // Start game!
                        }
                    }, 2000);
                }

            } else {
                socket.emit('error', { message: dbData.message || "Balance issue." });
            }
        } catch (err) {
            socket.emit('error', { message: "Wallet API is down." });
        }
    });

    socket.on('enter_game_room', (data) => {
        const { userId, tableId } = data;
        const table = tables[tableId];

        if (table) {
            socket.userId = userId;
            socket.tableId = tableId;
            socket.join(tableId);

            const player = table.players.find(p => p.id == userId);
            if(player) player.socketId = socket.id;

            io.to(tableId).emit('update_table_ui', { players: table.players, pot: table.pot });

            if (table.players.length >= 2 && !table.timer) {
                startNextTurn(tableId);
            }
        }
    });

    function startNextTurn(tableId) {
        const table = tables[tableId];
        if (!table) return;

        // If game just started, deal REAL CARDS
        if (table.deck.length === 0) {
            table.deck = getShuffledDeck();
            table.players.forEach(p => {
                if(!p.isBot && p.socketId) {
                    let userCards = table.deck.splice(0, 13);
                    io.to(p.socketId).emit('deal_cards', userCards);
                } else if(p.isBot) {
                    table.deck.splice(0, 13); // Remove bot's cards from deck
                }
            });
        }

        clearTimeout(table.timer);
        const activePlayers = table.players.filter(p => p.status === 'active');
        
        if (activePlayers.length === 1 && !activePlayers[0].isBot) {
            return processWin(activePlayers[0].id, tableId);
        } else if (activePlayers.length === 1 && activePlayers[0].isBot) {
            // Bot won, reset table
            io.to(tableId).emit('game_over', { winner: "BOT", message: "Bot Won. Better luck next time!" });
            table.pot = 0; table.players = []; table.deck = [];
            return;
        }
        if (activePlayers.length === 0) return; 

        table.activeTurn = (table.activeTurn + 1) % table.players.length;
        let currentPlayer = table.players[table.activeTurn];

        if (currentPlayer.status !== 'active') return startNextTurn(tableId);

        io.to(tableId).emit('turn_update', { activeUserId: currentPlayer.id, time: 15 });

        // BOT PLAY LOGIC
        if (currentPlayer.isBot) {
            setTimeout(() => {
                io.to(tableId).emit('sys_message', `${currentPlayer.name} played a card.`);
                startNextTurn(tableId);
            }, 3000); // Bot takes 3 seconds to play
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
                table.pot = 0; table.players = []; table.activeTurn = 0; table.deck = [];
            }
        } catch (err) { console.error(err); }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Engine Running on Port ${PORT}`));

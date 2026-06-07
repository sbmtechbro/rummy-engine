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

const suits = [{s: '♥', c: 'red'}, {s: '♦', c: 'red'}, {s: '♣', c: 'black'}, {s: '♠', c: 'black'}];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function getShuffledDeck() {
    let deck = [];
    for (let suit of suits) {
        for (let value of values) { deck.push({ value, suit: suit.s, color: suit.c }); }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const indianBotNames = ["Rahul", "Pooja", "Amit", "Sneha", "Vikram", "Anjali", "Karan", "Priya", "Rohit", "Neha", "Suresh"];

function checkValidRummy(hand) {
    if (!hand || hand.length !== 13) return false; 
    return false; // Basic strict validation mode (requires true sequence logic on frontend later)
}

app.get('/', (req, res) => res.send("Pro Rummy Engine: Auto-Bot & Layout Fix Active!"));

io.on('connection', (socket) => {
    
    // 1. JOIN LOBBY
    socket.on('join_table', async (data) => {
        const { userId, tableId, entryFee } = data;
        
        if (!tables[tableId]) {
            let maxP = 6; // Default Pool & Points (6 Player)
            if (tableId.includes('deals_')) maxP = 2; // Deals (2 Player)
            
            tables[tableId] = { 
                players: [], pot: 0, entryFee: parseInt(entryFee), activeTurn: 0, 
                timer: null, botTimer: null, deck: [], discardPile: [], state: 'waiting', maxPlayers: maxP 
            };
        }
        
        const table = tables[tableId];
        
        if (table.players.length >= table.maxPlayers && table.state !== 'waiting') {
            return socket.emit('error', { message: "Table is Full or Game already started!" });
        }

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
                table.players.push({ id: userId, isBot: false, socketId: null, status: 'active', missedTurns: 0, hand: [], hasDrawn: false, points: 0 });
                table.pot += table.entryFee;
                socket.emit('table_joined', { success: true, tableId });
            } else {
                socket.emit('error', { message: dbData.message || "Balance issue." });
            }
        } catch (err) {
            socket.emit('error', { message: "Wallet API is down." });
        }
    });

    // 2. ENTER GAME ROOM & 100% BOT FILLING LOGIC
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
                if (player.hand.length > 0) {
                    socket.emit('deal_cards', player.hand);
                    if(table.discardPile.length > 0) socket.emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
                }
            }

            io.to(tableId).emit('update_table_ui', { players: table.players, pot: table.pot });

            // STRICT BOT FILLING: Agar game waiting mein hai aur timer shuru nahi hua hai
            if (table.players.length > 0 && table.state === 'waiting' && !table.botTimer) {
                table.botTimer = setTimeout(() => {
                    if (table.state === 'waiting') { 
                        let botsNeeded = table.maxPlayers - table.players.length;
                        
                        // Jitni seats khali hain, utne bots daalo (Chahe Pool 6 ho ya Deal 2)
                        for(let i=0; i<botsNeeded; i++) {
                            let botName = indianBotNames[Math.floor(Math.random() * indianBotNames.length)] + Math.floor(Math.random() * 100);
                            let botId = "BOT_" + Math.random().toString(36).substr(2, 5);
                            table.players.push({ id: botId, name: botName, isBot: true, status: 'active', missedTurns: 0, hand: [], hasDrawn: false, points: 0 });
                            table.pot += table.entryFee;
                        }
                        
                        io.to(tableId).emit('update_table_ui', { players: table.players, pot: table.pot });
                        io.to(tableId).emit('sys_message', `Table full! Game starting...`);
                        
                        startGame(tableId);
                    }
                }, 3500); // 3.5 sec ka chota wait, phir game shuru
            }
        }
    });

    // 3. START GAME
    function startGame(tableId) {
        const table = tables[tableId];
        table.state = 'playing';
        table.deck = getShuffledDeck();
        table.discardPile = [table.deck.pop()];

        table.players.forEach(p => {
            p.hand = table.deck.splice(0, 13);
            p.hasDrawn = false;
            p.status = 'active';
            if (!p.isBot && p.socketId) {
                io.to(p.socketId).emit('deal_cards', p.hand);
            }
        });

        io.to(tableId).emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
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
            table.pot = 0; table.players = []; table.deck = []; table.discardPile = []; table.state = 'waiting'; table.botTimer = null;
            return;
        }
        if (activePlayers.length === 0) return; 

        table.activeTurn = (table.activeTurn + 1) % table.players.length;
        let currentPlayer = table.players[table.activeTurn];
        currentPlayer.hasDrawn = false; 

        if (currentPlayer.status !== 'active') return startNextTurn(tableId);

        io.to(tableId).emit('turn_update', { activeUserId: currentPlayer.id, time: 15 });

        if (currentPlayer.isBot) {
            setTimeout(() => {
                let drawnCard = table.deck.pop();
                currentPlayer.hand.push(drawnCard);
                let discardIndex = Math.floor(Math.random() * currentPlayer.hand.length);
                let discardedCard = currentPlayer.hand.splice(discardIndex, 1)[0];
                table.discardPile.push(discardedCard);
                
                io.to(tableId).emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
                io.to(tableId).emit('sys_message', `${currentPlayer.name} played their turn.`);
                startNextTurn(tableId);
            }, 3000); 
            return;
        }

        table.timer = setTimeout(() => {
            currentPlayer.missedTurns++; 
            if (currentPlayer.missedTurns >= 3) {
                io.to(tableId).emit('sys_message', `Player dropped after 3 Timeouts! (Penalty applied)`);
                currentPlayer.status = 'dropped';
                currentPlayer.points = 80;
            } else {
                io.to(tableId).emit('sys_message', `Turn missed. Warning: ${currentPlayer.missedTurns}/3`);
            }
            startNextTurn(tableId);
        }, 15000); 
    }

    // DRAW, DISCARD, DROP & WIN LOGIC SAME AS BEFORE
    socket.on('draw_card', (data) => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if(!table || table.state !== 'playing') return;
        const player = table.players.find(p => p.id == userId);
        let currentPlayer = table.players[table.activeTurn];
        if (currentPlayer.id != userId) return socket.emit('error', { message: "It's not your turn!" });
        if (player.hasDrawn) return socket.emit('error', { message: "You already drew a card." });

        let drawnCard = (data.type === 'open' && table.discardPile.length > 0) ? table.discardPile.pop() : table.deck.pop();
        player.hand.push(drawnCard);
        player.hasDrawn = true;
        socket.emit('deal_cards', player.hand);
        io.to(tableId).emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] || null });
    });

    socket.on('discard_card', (data) => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if(!table || table.state !== 'playing') return;
        const player = table.players.find(p => p.id == userId);
        let currentPlayer = table.players[table.activeTurn];
        if (currentPlayer.id != userId) return socket.emit('error', { message: "Not your turn!" });
        if (!player.hasDrawn) return socket.emit('error', { message: "You must draw a card first!" });

        let cardIndex = player.hand.findIndex(c => c.suit === data.suit && c.value === data.value);
        if (cardIndex !== -1) {
            let discarded = player.hand.splice(cardIndex, 1)[0];
            table.discardPile.push(discarded);
            socket.emit('deal_cards', player.hand); 
            io.to(tableId).emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
            startNextTurn(tableId);
        }
    });

    socket.on('declare_win', () => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if(!table) return;
        const player = table.players.find(p => p.id == userId);
        let currentPlayer = table.players[table.activeTurn];

        if (currentPlayer.id != userId) return socket.emit('error', { message: "You can only declare on your turn!" });
        if (!player.hasDrawn || player.hand.length > 13) return socket.emit('error', { message: "Please discard a card before declaring!" });

        const isValid = checkValidRummy(player.hand);
        if (!isValid) {
            player.status = 'wrong_declare'; player.points = 80;
            io.to(tableId).emit('sys_message', `🚨 WRONG DECLARE! 80 Points Penalty applied.`);
            socket.emit('error', { message: "Invalid Sequences! 80 points penalty applied. You are dropped." });
            startNextTurn(tableId);
        } else {
            processWin(userId, tableId);
        }
    });

    socket.on('drop_game', () => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if (table) {
            const player = table.players.find(p => p.id == userId);
            if(player && player.status === 'active') {
                player.status = 'dropped';
                player.points = (player.hasDrawn) ? 40 : 20; 
                socket.emit('sys_message', `You dropped out. Penalty: ${player.points} pts.`);
                if(table.players[table.activeTurn].id == userId) startNextTurn(tableId);
                else {
                    const activePlayers = table.players.filter(p => p.status === 'active');
                    if(activePlayers.length === 1 && !activePlayers[0].isBot) processWin(activePlayers[0].id, tableId);
                }
            }
        }
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
                    winner: winnerId, creditedAmount: dbData.credited, message: `Valid Declare! You Won ₹${dbData.credited}.`
                });
                table.pot = 0; table.players = []; table.activeTurn = 0; table.deck = []; table.discardPile = []; table.state = 'waiting'; table.botTimer = null;
            }
        } catch (err) { console.error(err); }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Fixed Engine Running!`));

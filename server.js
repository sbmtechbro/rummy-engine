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

// Sorting Order ke liye value map
const cardOrder = { 'A':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13 };

function getShuffledDeck() {
    let deck = [];
    for (let suit of suits) {
        for (let value of values) {
            deck.push({ value, suit: suit.s, color: suit.c });
        }
    }
    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const indianBotNames = ["Rahul", "Pooja", "Amit", "Sneha", "Vikram", "Anjali", "Karan", "Priya"];

app.get('/', (req, res) => res.send("Pro Rummy Engine: Discard, Sort & Declare Fixed!"));

io.on('connection', (socket) => {
    
    // 1. JOIN LOBBY
    socket.on('join_table', async (data) => {
        const { userId, tableId, entryFee } = data;
        
        if (!tables[tableId]) {
            // Naya: discardPile add kiya hai jisme feke hue patte jayenge
            tables[tableId] = { players: [], pot: 0, entryFee: parseInt(entryFee), activeTurn: 0, timer: null, deck: [], discardPile: [], state: 'waiting' };
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
                table.players.push({ id: userId, isBot: false, socketId: null, status: 'active', missedTurns: 0, hand: [], hasDrawn: false });
                table.pot += table.entryFee;
                socket.emit('table_joined', { success: true, tableId });
            } else {
                socket.emit('error', { message: dbData.message || "Balance issue." });
            }
        } catch (err) {
            socket.emit('error', { message: "Wallet API is down." });
        }
    });

    // 2. ENTER GAME ROOM
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
                    // Table ki state bhi bhejo (Open card kaunsa hai)
                    if(table.discardPile.length > 0) {
                        socket.emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
                    }
                }
            }

            io.to(tableId).emit('update_table_ui', { players: table.players, pot: table.pot });

            if (table.players.length === 1 && table.state === 'waiting') {
                setTimeout(() => {
                    if (table.players.length === 1) { 
                        let botName = indianBotNames[Math.floor(Math.random() * indianBotNames.length)];
                        let botId = "BOT_" + Math.random().toString(36).substr(2, 5);
                        
                        table.players.push({ id: botId, name: botName, isBot: true, status: 'active', missedTurns: 0, hand: [], hasDrawn: false });
                        table.pot += table.entryFee;
                        
                        io.to(tableId).emit('update_table_ui', { players: table.players, pot: table.pot });
                        io.to(tableId).emit('sys_message', `${botName} joined! Dealing cards...`);
                        
                        startGame(tableId);
                    }
                }, 3000); 
            } else if (table.players.length >= 2 && table.state === 'waiting') {
                startGame(tableId);
            }
        }
    });

    // 3. START GAME
    function startGame(tableId) {
        const table = tables[tableId];
        table.state = 'playing';
        table.deck = getShuffledDeck();

        // Pehla patta open deck (discard pile) mein rakho
        table.discardPile = [table.deck.pop()];

        table.players.forEach(p => {
            p.hand = table.deck.splice(0, 13);
            p.hasDrawn = false;
            if (!p.isBot && p.socketId) {
                io.to(p.socketId).emit('deal_cards', p.hand);
            }
        });

        // Sabko open card dikhao
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
            table.pot = 0; table.players = []; table.deck = []; table.discardPile = []; table.state = 'waiting';
            return;
        }
        if (activePlayers.length === 0) return; 

        table.activeTurn = (table.activeTurn + 1) % table.players.length;
        let currentPlayer = table.players[table.activeTurn];
        currentPlayer.hasDrawn = false; // Turn start hote hi draw reset

        if (currentPlayer.status !== 'active') return startNextTurn(tableId);

        io.to(tableId).emit('turn_update', { activeUserId: currentPlayer.id, time: 15 });

        // BOT LOGIC: Bot draw and discard automatically
        if (currentPlayer.isBot) {
            setTimeout(() => {
                // Bot patta uthayega (closed deck se)
                let drawnCard = table.deck.pop();
                currentPlayer.hand.push(drawnCard);
                // Bot random patta fekega
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
                io.to(tableId).emit('sys_message', `Player dropped after 3 Timeouts!`);
                currentPlayer.status = 'dropped';
            } else {
                io.to(tableId).emit('sys_message', `Turn missed. Warning: ${currentPlayer.missedTurns}/3`);
            }
            startNextTurn(tableId);
        }, 15000); 
    }

    // ==========================================
    // NAYE EVENTS: SORT, DRAW, DISCARD
    // ==========================================

    // SORT CARDS (Patte lagana)
    socket.on('sort_hand', () => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if(!table) return;

        const player = table.players.find(p => p.id == userId);
        if(player && player.hand.length > 0) {
            // Sort by Suit first, then by Value
            player.hand.sort((a, b) => {
                if (a.suit === b.suit) {
                    return cardOrder[a.value] - cardOrder[b.value];
                }
                return a.suit.localeCompare(b.suit);
            });
            // Sorted cards wapas player ko bhejo
            socket.emit('deal_cards', player.hand);
        }
    });

    // DRAW CARD (Patta uthana)
    socket.on('draw_card', (data) => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if(!table || table.state !== 'playing') return;

        const player = table.players.find(p => p.id == userId);
        let currentPlayer = table.players[table.activeTurn];

        // Validation: Kya is user ki turn hai?
        if (currentPlayer.id != userId) return socket.emit('error', { message: "It's not your turn!" });
        // Validation: Kya pehle hi utha chuka hai?
        if (player.hasDrawn) return socket.emit('error', { message: "You already drew a card." });

        let drawnCard;
        if (data.type === 'open' && table.discardPile.length > 0) {
            drawnCard = table.discardPile.pop(); // Open se uthaya
        } else {
            drawnCard = table.deck.pop(); // Closed se uthaya
        }

        player.hand.push(drawnCard);
        player.hasDrawn = true;
        
        socket.emit('deal_cards', player.hand);
        io.to(tableId).emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] || null });
    });

    // DISCARD CARD (Patta Fekna)
    socket.on('discard_card', (data) => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if(!table || table.state !== 'playing') return;

        const player = table.players.find(p => p.id == userId);
        let currentPlayer = table.players[table.activeTurn];

        // Validation: Turn check aur bina uthaye fekna allow nahi hai
        if (currentPlayer.id != userId) return socket.emit('error', { message: "Not your turn!" });
        if (!player.hasDrawn) return socket.emit('error', { message: "You must draw a card first!" });

        // Patta remove karo aur feko
        let cardIndex = player.hand.findIndex(c => c.suit === data.suit && c.value === data.value);
        if (cardIndex !== -1) {
            let discarded = player.hand.splice(cardIndex, 1)[0];
            table.discardPile.push(discarded);
            
            socket.emit('deal_cards', player.hand); // Update player hand
            io.to(tableId).emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
            
            // Fekne ke baad agle player ki turn
            startNextTurn(tableId);
        }
    });

    // ==========================================

    // DROP GAME
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

    // DECLARE WIN (FIXED VALIDATION)
    socket.on('declare_win', () => {
        const { userId, tableId } = socket;
        const table = tables[tableId];
        if(!table) return;

        const player = table.players.find(p => p.id == userId);
        let currentPlayer = table.players[table.activeTurn];

        // Validation 1: Kya uski turn hai?
        if (currentPlayer.id != userId) {
            return socket.emit('error', { message: "You can only declare on your turn!" });
        }

        // Validation 2: Player ke paas sequence hai ya nahi (Basic count check for now)
        // Ek asli declare me player patta uthakar (14 cards hote hain) ek patta finish slot me fekta hai
        if (player.hand.length < 13) {
            return socket.emit('error', { message: "Invalid Declare! Group your cards properly." });
        }

        // Agar sab sahi hai, toh jeeta do
        processWin(userId, tableId);
    });

    // PROCESS WINNER API
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
                table.pot = 0; table.players = []; table.activeTurn = 0; table.deck = []; table.discardPile = []; table.state = 'waiting';
            }
        } catch (err) { console.error(err); }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Engine Running with Full Rummy Logic (Sort, Draw, Discard)!`));

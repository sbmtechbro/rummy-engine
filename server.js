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
const valueRank = { 'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

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

function autoSortHand(hand) {
    return hand.sort((a, b) => {
        if (a.suit === b.suit) {
            return valueRank[a.value] - valueRank[b.value];
        }
        return a.suit.localeCompare(b.suit);
    });
}

const indianBotNames = ["Rahul_99", "PoojaK", "Amit_007", "Sneha_Roy", "Vikram23", "Anjali_S", "Karan_G", "Priya_11", "Rohit_Sharma", "Neha_V", "Suresh_88"];

function checkValidRummy(hand) {
    if (!hand || hand.length !== 13) return false; 
    return false; // Valid Rummy sequence check pending
}

app.get('/', (req, res) => res.send("Pro Rummy Engine: Real-Player Bot Illusion Active!"));

io.on('connection', (socket) => {
    
    socket.on('join_table', async (data) => {
        const { userId, tableId, entryFee, userName } = data;
        
        if (!tables[tableId]) {
            let maxP = 6; 
            if (tableId.includes('deals_')) maxP = 2; 
            
            tables[tableId] = { 
                players: [], pot: 0, entryFee: parseInt(entryFee), activeTurn: 0, 
                timer: null, botTimer: null, deck: [], discardPile: [], state: 'waiting', maxPlayers: maxP 
            };
        }
        
        const table = tables[tableId];
        
        if (table.players.length >= table.maxPlayers && table.state !== 'waiting') {
            return socket.emit('error', { message: "Table is Full!" });
        }

        const existingPlayer = table.players.find(p => p.id == userId);
        if(existingPlayer) return socket.emit('table_joined', { success: true, tableId });

        try {
            table.players.push({ id: userId, name: userName || "Player", isBot: false, socketId: null, status: 'active', missedTurns: 0, hand: [], hasDrawn: false, points: 0 });
            table.pot += table.entryFee;
            socket.emit('table_joined', { success: true, tableId });
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
            if(player) {
                player.socketId = socket.id;
                if (player.hand.length > 0) {
                    socket.emit('deal_cards', autoSortHand(player.hand)); 
                    if(table.discardPile.length > 0) socket.emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
                }
            }

            io.to(tableId).emit('update_table_ui', { players: table.players.map(p => ({id: p.id, name: p.name, status: p.status})), pot: table.pot });

            if (table.players.length > 0 && table.state === 'waiting') {
                if (!table.botTimer) {
                    table.botTimer = setTimeout(() => {
                        if (table.state === 'waiting') { 
                            let botsNeeded = table.maxPlayers - table.players.length;
                            
                            for(let i=0; i<botsNeeded; i++) {
                                let botName = indianBotNames[Math.floor(Math.random() * indianBotNames.length)];
                                let botId = "USR_" + Math.floor(100000 + Math.random() * 900000); 
                                table.players.push({ id: botId, name: botName, isBot: true, status: 'active', missedTurns: 0, hand: [], hasDrawn: false, points: 0 });
                                table.pot += table.entryFee;
                            }
                            
                            io.to(tableId).emit('update_table_ui', { players: table.players.map(p => ({id: p.id, name: p.name, status: p.status})), pot: table.pot });
                            io.to(tableId).emit('sys_message', `Table full! Game starting...`);
                            
                            startGame(tableId);
                        }
                    }, 4000);
                }
            }
        }
    });

    function startGame(tableId) {
        const table = tables[tableId];
        table.state = 'playing';
        table.deck = getShuffledDeck();
        table.discardPile = [table.deck.pop()];

        table.players.forEach(p => {
            p.hand = table.deck.splice(0, 13);
            p.hand = autoSortHand(p.hand); 
            p.hasDrawn = false;
            p.status = 'active';
            if (!p.isBot && p.socketId) {
                io.to(p.socketId).emit('deal_cards', p.hand);
            }
        });

        io.to(tableId).emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
        startNextTurn(tableId);
    }

    function startNextTurn(tableId) {
        const table = tables[tableId];
        if (!table) return;

        clearTimeout(table.timer);
        const activePlayers = table.players.filter(p => p.status === 'active');
        
        if (activePlayers.length === 1 && !activePlayers[0].isBot) {
            return processWin(activePlayers[0].id, tableId);
        } else if (activePlayers.length === 1 && activePlayers[0].isBot) {
            io.to(tableId).emit('game_over', { winner: activePlayers[0].name, message: `${activePlayers[0].name} Won the game! Better luck next time.` });
            table.pot = 0; table.players = []; table.deck = []; table.discardPile = []; table.state = 'waiting'; table.botTimer = null;
            return;
        }
        if (activePlayers.length === 0) return; 

        table.activeTurn = (table.activeTurn + 1) % table.players.length;
        let currentPlayer = table.players[table.activeTurn];
        currentPlayer.hasDrawn = false; 

        if (currentPlayer.status !== 'active') return startNextTurn(tableId);

        io.to(tableId).emit('turn_update', { activeUserId: currentPlayer.id, activeUserName: currentPlayer.name, time: 15 });

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
                io.to(tableId).emit('sys_message', `${currentPlayer.name} dropped out (Timeouts).`);
                currentPlayer.status = 'dropped';
                currentPlayer.points = 80;
            } else {
                io.to(tableId).emit('sys_message', `Turn missed by ${currentPlayer.name}. Warning: ${currentPlayer.missedTurns}/3`);
            }
            startNextTurn(tableId);
        }, 15000); 
    }

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
        
        player.hand = autoSortHand(player.hand); 
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
            
            player.hand = autoSortHand(player.hand); 
            socket.emit('deal_cards', player.hand); 
            io.to(tableId).emit('table_state', { topDiscard: table.discardPile[table.discardPile.length - 1] });
            startNextTurn(tableId);
        }
    });

    async function processWin(winnerId, tableId) {
        const table = tables[tableId];
        if (!table) return;
        const winner = table.players.find(p=> p.id === winnerId);
        io.to(tableId).emit('game_over', { winner: winner.name, message: `${winner.name} Won the game!` });
        table.pot = 0; table.players = []; table.deck = []; table.discardPile = []; table.state = 'waiting'; table.botTimer = null;
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server Running on Port ${PORT}`));

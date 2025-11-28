const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game state
const gameRooms = new Map();

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = new Map();
        this.gameState = {
            towers: this.createTowers(),
            minions: [],
            gameRunning: true,
            gameStartTime: Date.now()
        };
    }
    
    createTowers() {
        return [
            // Mortal towers (left side)
            { id: 'mortal_t1', team: 'mortal', x: 100, y: 300, health: 300, maxHealth: 300, range: 150, damage: 10 },
            { id: 'mortal_t2', team: 'mortal', x: 300, y: 300, health: 300, maxHealth: 300, range: 150, damage: 10 },
            { id: 'mortal_base', team: 'mortal', x: 500, y: 300, health: 500, maxHealth: 500, range: 200, damage: 15, isBase: true },
            
            // Ancient towers (right side)
            { id: 'ancient_t1', team: 'ancient', x: 900, y: 300, health: 300, maxHealth: 300, range: 150, damage: 10 },
            { id: 'ancient_t2', team: 'ancient', x: 700, y: 300, health: 300, maxHealth: 300, range: 150, damage: 10 },
            { id: 'ancient_base', team: 'ancient', x: 500, y: 300, health: 500, maxHealth: 500, range: 200, damage: 15, isBase: true }
        ];
    }
    
    addPlayer(playerId, ws) {
        const team = this.players.size % 2 === 0 ? 'mortal' : 'ancient';
        const spawnX = team === 'mortal' ? 200 : 800;
        
        const player = {
            id: playerId,
            ws: ws,
            team: team,
            hero: {
                type: team,
                x: spawnX,
                y: 300,
                health: 100,
                maxHealth: 100,
                speed: 4,
                attackRange: 30,
                attackDamage: 15,
                attackCooldown: 0,
                skills: {
                    q: { cooldown: 0, maxCooldown: 120 },
                    w: { cooldown: 0, maxCooldown: 180 },
                    e: { cooldown: 0, maxCooldown: 150 },
                    r: { cooldown: 0, maxCooldown: 300 }
                }
            }
        };
        
        this.players.set(playerId, player);
        
        // Notify all players
        this.broadcast({
            type: 'playerJoined',
            player: {
                id: playerId,
                team: team,
                hero: player.hero
            }
        });
        
        return player;
    }
    
    removePlayer(playerId) {
        this.players.delete(playerId);
        this.broadcast({
            type: 'playerLeft',
            playerId: playerId
        });
    }
    
    handlePlayerAction(playerId, action) {
        const player = this.players.get(playerId);
        if (!player) return;
        
        switch (action.type) {
            case 'move':
                player.hero.x = action.x;
                player.hero.y = action.y;
                this.broadcast({
                    type: 'playerMoved',
                    playerId: playerId,
                    x: action.x,
                    y: action.y
                });
                break;
                
            case 'ability':
                this.handleAbility(playerId, action.ability);
                break;
                
            case 'attack':
                this.handleAttack(playerId);
                break;
        }
    }
    
    handleAbility(playerId, ability) {
        const player = this.players.get(playerId);
        if (!player || player.hero.skills[ability].cooldown > 0) return;
        
        player.hero.skills[ability].cooldown = player.hero.skills[ability].maxCooldown;
        
        this.broadcast({
            type: 'abilityUsed',
            playerId: playerId,
            ability: ability,
            position: { x: player.hero.x, y: player.hero.y }
        });
        
        // Apply ability effects
        this.applyAbilityEffect(playerId, ability);
    }
    
    applyAbilityEffect(playerId, ability) {
        const player = this.players.get(playerId);
        const enemyPlayer = Array.from(this.players.values()).find(p => p.id !== playerId);
        
        if (!enemyPlayer) return;
        
        const distance = this.getDistance(player.hero, enemyPlayer.hero);
        
        switch (ability) {
            case 'q': // AOE
                if (distance <= 100) {
                    const damage = distance <= 50 ? 10 : 20;
                    this.applyDamage(enemyPlayer.hero, damage);
                }
                break;
                
            case 'w': // Speed Boost
                player.hero.speed = 6; // Boosted speed
                setTimeout(() => {
                    if (player.hero) player.hero.speed = 4;
                }, 4000);
                break;
                
            case 'e': // Pull
                if (distance <= 150) {
                    // Pull enemy toward player
                    const angle = Math.atan2(player.hero.y - enemyPlayer.hero.y, player.hero.x - enemyPlayer.hero.x);
                    enemyPlayer.hero.x += Math.cos(angle) * 50;
                    enemyPlayer.hero.y += Math.sin(angle) * 50;
                    this.applyDamage(enemyPlayer.hero, 10);
                }
                break;
                
            case 'r': // Health Boost
                const bonus = Math.min(100, player.hero.maxHealth - player.hero.health);
                player.hero.health += bonus;
                setTimeout(() => {
                    if (player.hero) {
                        player.hero.health = Math.max(1, player.hero.health - bonus);
                    }
                }, 10000);
                break;
        }
    }
    
    handleAttack(playerId) {
        const player = this.players.get(playerId);
        const enemyPlayer = Array.from(this.players.values()).find(p => p.id !== playerId);
        
        if (enemyPlayer && player.hero.attackCooldown <= 0) {
            const distance = this.getDistance(player.hero, enemyPlayer.hero);
            if (distance < player.hero.attackRange) {
                this.applyDamage(enemyPlayer.hero, player.hero.attackDamage);
                player.hero.attackCooldown = 90;
            }
        }
    }
    
    applyDamage(target, damage) {
        // Apply Ancient passive (30% damage reduction)
        if (target.team === 'ancient') {
            damage = Math.floor(damage * 0.7);
        }
        
        target.health -= damage;
        
        if (target.health <= 0) {
            target.health = 0;
            this.checkWinCondition();
        }
        
        this.broadcast({
            type: 'damage',
            target: target,
            damage: damage,
            newHealth: target.health
        });
    }
    
    checkWinCondition() {
        const mortalBase = this.gameState.towers.find(t => t.team === 'mortal' && t.isBase);
        const ancientBase = this.gameState.towers.find(t => t.team === 'ancient' && t.isBase);
        
        let winner = null;
        
        // Check if bases are destroyed
        if (mortalBase.health <= 0) {
            winner = 'Ancient';
        } else if (ancientBase.health <= 0) {
            winner = 'Mortal';
        }
        
        // Check if heroes are dead
        this.players.forEach(player => {
            if (player.hero.health <= 0) {
                winner = player.team === 'mortal' ? 'Ancient' : 'Mortal';
            }
        });
        
        if (winner) {
            this.endGame(winner);
        }
    }
    
    endGame(winner) {
        this.gameState.gameRunning = false;
        
        this.broadcast({
            type: 'gameOver',
            winner: winner
        });
    }
    
    getDistance(obj1, obj2) {
        return Math.sqrt((obj1.x - obj2.x) ** 2 + (obj1.y - obj2.y) ** 2);
    }
    
    broadcast(message) {
        this.players.forEach(player => {
            if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify(message));
            }
        });
    }
    
    getGameState() {
        return {
            players: Array.from(this.players.values()).map(p => ({
                id: p.id,
                team: p.team,
                hero: p.hero
            })),
            towers: this.gameState.towers,
            gameRunning: this.gameState.gameRunning
        };
    }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    let playerId = uuidv4();
    let currentRoom = null;
    
    console.log('Player connected:', playerId);
    
    // Find or create room
    let room = null;
    for (let [roomId, gameRoom] of gameRooms) {
        if (gameRoom.players.size < 2) {
            room = gameRoom;
            break;
        }
    }
    
    if (!room) {
        const roomId = uuidv4();
        room = new GameRoom(roomId);
        gameRooms.set(roomId, room);
        console.log('Created new room:', roomId);
    }
    
    currentRoom = room;
    const player = room.addPlayer(playerId, ws);
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        playerId: playerId,
        team: player.team,
        gameState: room.getGameState()
    }));
    
    // Handle messages from client
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'playerAction') {
                currentRoom.handlePlayerAction(playerId, message.action);
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });
    
    // Handle disconnect
    ws.on('close', () => {
        console.log('Player disconnected:', playerId);
        if (currentRoom) {
            currentRoom.removePlayer(playerId);
            
            // Clean up empty rooms
            if (currentRoom.players.size === 0) {
                gameRooms.delete(currentRoom.roomId);
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// HTTP routes
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'MOBA Multiplayer Server Running!',
        activeRooms: gameRooms.size,
        totalPlayers: Array.from(gameRooms.values()).reduce((sum, room) => sum + room.players.size, 0)
    });
});

app.get('/api/rooms', (req, res) => {
    const rooms = Array.from(gameRooms.values()).map(room => ({
        roomId: room.roomId,
        playerCount: room.players.size,
        gameRunning: room.gameState.gameRunning
    }));
    res.json(rooms);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 MOBA Multiplayer Server running on port ${PORT}`);
    console.log(`👉 Health check: http://localhost:${PORT}/health`);
    console.log(`👉 Rooms API: http://localhost:${PORT}/api/rooms`);
});

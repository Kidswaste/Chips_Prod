/*
 * Multi‑room, real‑time word game server
 *
 * Ce serveur utilise Express et Socket.IO pour permettre à plusieurs parties
 * (« rooms ») de se jouer en parallèle. Chaque room maintient son propre
 * état (joueurs, scores, thème courant, tour en cours, etc.). Les joueurs
 * rejoignent une room via un code, un peu comme un lobby. Lorsque le dernier
 * joueur quitte une room ou qu'elle reste inactive trop longtemps, elle est
 * nettoyée automatiquement. Cette architecture découple les différentes
 * parties et évite que les états se mélangent.
 *
 * La logique de jeu inclut :
 *  - Un thème choisi aléatoirement pour chaque round
 *  - Un timer qui décroît de 10 s à 1 s au fil des tours
 *  - L'élimination des joueurs qui n'envoient pas de mot, qui se doublonnent
 *    ou qui ne respectent pas le thème (validation par banque de mots)
 *  - La mémorisation des mots déjà validés pour interdire leur ré‑utilisation
 *  - Un tableau final des scores avec options de rematch ou retour menu
 *
 * Pour ajouter de nouvelles fonctionnalités, voyez les commentaires placés
 * avant chaque section de code. Par exemple, vous pouvez ajouter des jokers,
 * des thèmes personnalisés, un chat intégré, etc.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// Import modules
const { CONFIG } = require("./config/messages");
const { rooms, killRoom, onlineCount } = require("./game/roomManager");
const {
  handlePlayerJoin,
  handleGameStart,
  handleGameMenu,
  handleGameRestart,
  handleTurnSubmit,
  handleTurnVote,
  handleDisconnect,
} = require("./socket/handlers");

// Express and Socket.IO setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Middleware for serving static files from public directory
app.use(express.static("public"));

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  // Player join room
  socket.on("player:join", (data, ack) => {
    handlePlayerJoin(socket, data, ack, io);
  });

  // Host starts game
  socket.on("game:start", () => {
    handleGameStart(socket, io);
  });

  // Host returns to menu
  socket.on("game:menu", () => {
    handleGameMenu(socket, io);
  });

  // Host restarts game
  socket.on("game:restart", () => {
    handleGameRestart(socket, io);
  });

  // Player submits word
  socket.on("turn:submit", (word) => {
    handleTurnSubmit(socket, word, io);
  });

  // Player votes against word
  socket.on('turn:vote', (data) => {
    handleTurnVote(socket, data, io);
  });

  // Player disconnects
  socket.on("disconnect", () => {
    handleDisconnect(socket, io);
  });
});

/**
 * Janitor : loop that runs regularly to close inactive rooms
 * or rooms that are too old. Each room has two timestamps:
 * createdAt (creation date) and lastActivity (date of last
 * significant event). According to CONFIG.ROOM_MAX_AGE_MS and
 * CONFIG.ROOM_IDLE_MS, we decide whether to delete a room or not.
 */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const tooOld = now - room.createdAt > CONFIG.ROOM_MAX_AGE_MS;
    const tooIdle = now - room.lastActivity > CONFIG.ROOM_IDLE_MS;
    if (onlineCount(room) === 0 || tooOld || tooIdle) {
      killRoom(code, tooOld ? "max_age" : tooIdle ? "idle" : "empty", io);
    }
  }
}, 60_000); // check every minute

// Start server
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

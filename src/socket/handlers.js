const { normalizeWord } = require("../utils/wordUtils");
const { getRoom, touchRoom, onlineCount, aliveIds, killRoom, serializeRoom } = require("../game/roomManager");
const { startNewRound } = require("../game/gameLogic");
const { addBot, removeBot } = require("../config/bot");

/**
 * Rejoindre une room. Le client doit envoyer un objet contenant
 * { name, code }. Si le code est vide, la room « public » est utilisée.
 * Le serveur associe le socket à la room et diffuse l'état mis à jour.
 */
function handlePlayerJoin(socket, { name, code }, ack, io) {
  const cleanName = String(name || "Joueur").trim().slice(0, 20) || "Joueur";
  const roomCode = String(code || "public").slice(0, 32);
  // Récupérer ou créer la room
  const room = getRoom(roomCode);
  socket.join(roomCode);
  socket.data.room = roomCode;
  // Ajouter le joueur à la room
  room.players.set(socket.id, {
    name: cleanName,
    score: 0,
    alive: false,
    online: true,
  });
  // Attribuer l'host s'il n'existe pas encore
  if (!room.hostId) room.hostId = socket.id;
  // Si un bot est présent et qu'il y a maintenant au moins deux joueurs
  // humains connectés, on peut retirer le bot car il n'est plus nécessaire.
  let humanOnline = 0;
  room.players.forEach((p, id) => {
    if (id !== room.botId && p.online) humanOnline++;
  });
  if (room.botId && humanOnline >= 2) {
    removeBot(room);
  }
  // Diffuser l'état
  io.to(roomCode).emit("lobby:update", serializeRoom(room));
  if (typeof ack === "function") {
    ack({ ok: true, host: room.hostId === socket.id });
  }
  touchRoom(room);
}

/**
 * L'host démarre une partie. Vérifie qu'il y a au moins deux joueurs en
 * ligne, puis lance le premier round. Si ce n'est pas le cas, renvoie
 * une erreur uniquement à l'host.
 */
function handleGameStart(socket, io) {
  const code = socket.data.room;
  const room = getRoom(code);
  if (!room) return;
  if (socket.id !== room.hostId) return;
  // Empêcher de lancer une partie si une autre est en cours ou si
  // moins de deux joueurs humains sont en ligne. On compte les joueurs
  // humains (id différent du bot) qui sont connectés. Si le total est
  // inférieur à 2, on insère un bot pour permettre de jouer en solo.
  if (room.gameActive) {
    io.to(socket.id).emit("game:error", {
      message: "Problème de création du Lobby, Demande à Kiddy",
    });
    return;
  }
  // Compter les humains en ligne (on ignore le bot si déjà présent)
  let humanCount = 0;
  room.players.forEach((p, id) => {
    if (id !== room.botId && p.online) humanCount++;
  });
  // Si moins de deux humains, ajouter un bot
  if (humanCount < 2) {
    addBot(room);
  }
  // Après ajout du bot, vérifier qu'au moins deux joueurs (humain ou bot)
  // sont présents. Sinon, renvoyer une erreur.
  if (onlineCount(room) < 2) {
    io.to(socket.id).emit("game:error", {
      message: "Problème de création du Lobby, Demande à Kiddy",
    });
    return;
  }
  // Initialiser la partie : remettre le niveau et les lettres punies à zéro
  room.gameActive = true;
  room.level = 0;
  room.punishedLetters = [];
  startNewRound(code, room, io);
}

/**
 * L'host demande un retour au menu sans relancer de partie. On ne fait
 * qu'informer les clients de l'évènement, ils restent dans le lobby.
 */
function handleGameMenu(socket, io) {
  const code = socket.data.room;
  const room = getRoom(code);
  if (!room) return;
  if (socket.id !== room.hostId) return;
  io.to(code).emit("game:menu");
  touchRoom(room);
}

/**
 * L'host relance une partie après la fin d'un round. Même contrôle que
 * game:start.
 */
function handleGameRestart(socket, io) {
  const code = socket.data.room;
  const room = getRoom(code);
  if (!room) return;
  if (socket.id !== room.hostId) return;
  // Empêcher le relancement si une partie est en cours. Si trop peu
  // d'humains en ligne, on insère un bot comme pour game:start.
  if (room.gameActive) {
    io.to(socket.id).emit("game:error", {
      message: "Problème de création du Lobby, Demande à Kiddy",
    });
    return;
  }
  // Compter les joueurs humains en ligne
  let humanCount = 0;
  room.players.forEach((p, id) => {
    if (id !== room.botId && p.online) humanCount++;
  });
  if (humanCount < 2) {
    addBot(room);
  }
  if (onlineCount(room) < 2) {
    io.to(socket.id).emit("game:error", {
      message: "Problème de création du Lobby, Demande à Kiddy",
    });
    return;
  }
  room.gameActive = true;
  room.level = 0;
  room.punishedLetters = [];
  startNewRound(code, room, io);
}

/**
 * Soumission d'un mot pour le tour en cours. Un mot est accepté s'il
 * n'a pas encore été utilisé dans le round (room.usedWords) et s'il
 * appartient à la banque de mots pour le thème courant. Les duplicats
 * ou les mots invalides renvoient la même erreur afin de ne pas donner
 * d'indice aux joueurs.
 */
function handleTurnSubmit(socket, word, io) {
  const code = socket.data.room;
  const room = getRoom(code);
  if (!room || !room.accepting) return;
  const p = room.players.get(socket.id);
  if (!p || !p.alive) return;
  const normalized = normalizeWord(word);
  if (!normalized) return;
  // Vérifier si le mot a déjà été utilisé, s'il n'est pas dans la banque
  // ou s'il contient une lettre punie. Tous ces cas renvoient la même
  // erreur afin de ne pas donner d'indice.
  const alreadyUsed = room.usedWords.has(normalized);
  const notInBank = room.wordSet.size > 0 && !room.wordSet.has(normalized);
  const hasPunished = room.punishedLetters.some((letter) => normalized.includes(letter));
  if (alreadyUsed || notInBank || hasPunished) {
    io.to(socket.id).emit("turn:error", { message: "Mot invalide! Relis les règles!" });
    return;
  }
  if (!room.submissions.has(socket.id)) {
    room.submissions.set(socket.id, normalized);
    // Enregistrer le timestamp de soumission pour calculer la vitesse de
    // réponse. Si turnStartedAt n'est pas défini (cas improbable), on
    // stocke Date.now() quand même.
    if (!room.submissionTimes) {
      room.submissionTimes = new Map();
    }
    room.submissionTimes.set(socket.id, Date.now());
    io.to(socket.id).emit("turn:ack", { lockedWord: normalized });
    io.to(code).emit("turn:progress", { submitted: room.submissions.size });
    touchRoom(room);
  }
}

/**
 * Vote contre la validité d'un mot. Chaque joueur vivant peut voter
 * une fois contre un mot qu'il estime hors‑sujet. Lorsqu'une majorité
 * est atteinte, le joueur ciblé est éliminé immédiatement. Les votes
 * sont enregistrés pendant une période définie dans endTurn() et
 * finalisés par finalizeVote(). Ce handler permet aussi l'élimination
 * précoce (dès qu'un seuil est franchi) pour accélérer la décision.
 */
function handleTurnVote(socket, { target }, io) {
  const code = socket.data.room;
  const room = getRoom(code);
  if (!room || !room.votingActive) return;
  const voter = room.players.get(socket.id);
  const targetPlayer = room.players.get(target);
  // Vérifier que le vote est valide
  if (!voter || !voter.alive) return;          // votant doit être vivant
  if (!targetPlayer || !targetPlayer.alive) return; // cible doit être vivante
  if (target === socket.id) return;            // on ne vote pas contre soi
  // Vérifier que le mot appartient à la soumission courante
  if (!room.submissions.has(target)) return;
  // Enregistrer le vote si non déjà enregistré
  if (!room.votes.has(target)) {
    room.votes.set(target, new Set());
  }
  const votersSet = room.votes.get(target);
  if (votersSet.has(socket.id)) return; // déjà voté
  votersSet.add(socket.id);
  // Vérifier si le seuil est atteint pour élimination précoce
  const alive = aliveIds(room);
  const effectiveVoters = alive.filter((sid) => sid !== target);
  const effCount = effectiveVoters.length;
  const effThreshold = Math.floor(effCount / 2) + 1;
  if (votersSet.size >= effThreshold) {
    // Éliminer immédiatement
    const p = room.players.get(target);
    if (p) p.alive = false;
    const word = room.submissions.get(target);
    if (word) room.usedWords.delete(word);
    io.to(code).emit('vote:eliminated', { ids: [target] });
    // Mettre à jour l'état du lobby
    io.to(code).emit('lobby:update', serializeRoom(room));
  }
  touchRoom(room);
}

/**
 * Gestion de la déconnexion. On marque le joueur offline et l'élimine
 * immédiatement si une partie est en cours. Si l'host quitte, on
 * réattribue l'host au prochain joueur en ligne. Si plus aucun joueur
 * n'est en ligne, on supprime la room.
 */
function handleDisconnect(socket, io) {
  const code = socket.data.room;
  const room = getRoom(code);
  if (!room) return;
  const wasHost = socket.id === room.hostId;
  const p = room.players.get(socket.id);
  if (p) {
    p.online = false;
    p.alive = false;
  }
  if (wasHost) {
    // Choisir un nouvel host parmi les joueurs en ligne
    room.hostId = [...room.players.keys()].find((id) => room.players.get(id)?.online) || null;
  }
  // Si la partie est en cours et qu'il ne reste qu'un seul joueur humain
  // en ligne, ajouter un bot pour permettre de continuer en solo. On
  // compte les joueurs online en excluant le bot si présent.
  if (room.gameActive) {
    let humanOnline = 0;
    room.players.forEach((pl, id) => {
      if (id !== room.botId && pl.online) humanOnline++;
    });
    if (humanOnline < 2) {
      addBot(room);
    }
  }
  // Si plus aucun joueur online, fermer la room
  if (onlineCount(room) === 0) {
    killRoom(code, "empty", io);
  } else {
    io.to(code).emit("lobby:update", serializeRoom(room));
  }
}

module.exports = {
  handlePlayerJoin,
  handleGameStart,
  handleGameMenu,
  handleGameRestart,
  handleTurnSubmit,
  handleTurnVote,
  handleDisconnect,
};

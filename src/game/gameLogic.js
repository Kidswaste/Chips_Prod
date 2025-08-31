const { getTurnDuration } = require("../config/timers");
const { MESSAGES, DELAY_CONFIG, TIMER_CONFIG } = require("../config/messages");
const { generatePunishedLetters, pickRandom } = require("../utils/wordUtils");
const { loadWordSetForTheme } = require("../data/wordBank");
const { scheduleBotSubmission } = require("../config/bot");

/**
 * Commence un nouveau round dans une room. On remet à zéro les mots
 * utilisés, on charge la banque de mots pour le thème et on "réanime"
 * les joueurs en ligne. Le premier tour commence après une courte pause
 * pour permettre aux clients de se mettre à jour.
 *
 * @param {string} code Le code de la room
 * @param {Object} room L'état de la room
 * @param {Object} io L'instance Socket.IO
 */
async function startNewRound(code, room, io) {
  room.round += 1;
  room.turn = 0;
  room.theme = pickRandom(room.themes);
  room.usedWords.clear();
  room.submissions.clear();
  // Charger la banque de mots pour le thème courant (async)
  room.wordSet = await loadWordSetForTheme(room.theme);
  // Réinitialiser les lettres punies pour le nouveau round. Elles seront
  // générées à la volée au début de chaque tour en fonction du niveau.
  room.punishedLetters = [];
  // Revivre les joueurs en ligne
  room.players.forEach((p) => {
    if (p.online) p.alive = true;
  });
  io.to(code).emit("round:start", { round: room.round, theme: room.theme });
  io.to(code).emit("lobby:update", serializeRoom(room));
  // Démarrer le premier tour après 600 ms
  room.timers.nextTurn = setTimeout(() => startNextTurn(code, room, io), 600);
  touchRoom(room);
}

/**
 * Démarre le tour suivant ou met fin au round si un ou zéro joueur reste en
 * vie. La durée du tour diminue à chaque tour mais ne descend pas sous
 * minTurnMs. Les clients gèrent l'affichage du timer.
 *
 * @param {string} code Le code de la room
 * @param {Object} room L'état de la room
 * @param {Object} io L'instance Socket.IO
 */
function startNextTurn(code, room, io) {
  const alive = aliveIds(room);
  // Si un seul joueur survit, terminer immédiatement le round
  if (alive.length <= 1) {
    endRound(code, room, alive[0] || null, io);
    return;
  }
  // Incrémenter le numéro de tour pour ce round
  room.turn += 1;
  // Incrémenter le niveau global. Au premier tour d'une partie,
  // room.level est initialisé à 0 lors de game:start. On passe donc
  // au niveau 1 ici.
  room.level = (room.level || 0) + 1;
  room.submissions.clear();
  room.accepting = true;
  // Calculer la durée du tour à partir du niveau (en secondes puis ms)
  const sec = getTurnDuration(room.level);
  const turnMs = Math.round(sec * 1000);
  // Enregistrer le début et la durée du tour pour le calcul des scores
  room.turnStartedAt = Date.now();
  room.currentTurnDuration = turnMs;
  // Réinitialiser les timestamps de soumission
  room.submissionTimes.clear();
  // Générer les lettres punies à partir du niveau
  if (room.level >= 10) {
    room.punishedLetters = generatePunishedLetters(room.level);
  } else {
    room.punishedLetters = [];
  }
  // Émettre le début du tour avec la durée et les lettres punies
  io.to(code).emit("turn:start", {
    turn: room.turn,
    turnMs,
    punishedLetters: room.punishedLetters,
  });
  // Planifier la fin du tour
  room.timers.endTurn = setTimeout(() => endTurn(code, room, io), turnMs);
  // Planifier la soumission du bot si nécessaire. Le bot enverra un mot
  // automatiquement après une fraction du timer (voir BOT_CONFIG.delayFactor).
  scheduleBotSubmission(code, room, io);
  touchRoom(room);
}

/**
 * Termine le tour en cours. Les joueurs sans soumission ou ayant un mot
 * doublon sont éliminés. Les mots uniques et valides sont ajoutés à
 * room.usedWords pour ne plus pouvoir être réutilisés. Après le traitement,
 * la fonction décide de lancer un nouveau tour ou de finir le round.
 *
 * @param {string} code Le code de la room
 * @param {Object} room L'état de la room
 * @param {Object} io L'instance Socket.IO
 */
function endTurn(code, room, io) {
  // On arrête de recevoir des soumissions
  room.accepting = false;
  // Construire la fréquence des mots soumis
  const freq = new Map();
  for (const [sid, word] of room.submissions) {
    if (!freq.has(word)) freq.set(word, []);
    freq.get(word).push(sid);
  }
  // Déterminer les joueurs éliminés et les raisons (pas de soumission, doublon)
  const eliminated = new Set();
  const noSubmissionIds = [];
  const duplicateIds = [];
  // Joueurs vivants sans soumission
  room.players.forEach((p, sid) => {
    if (p.alive && !room.submissions.has(sid)) {
      eliminated.add(sid);
      noSubmissionIds.push(sid);
    }
  });
  // Joueurs ayant soumis un mot doublon
  for (const [w, ids] of freq) {
    if (ids.length >= 2) {
      ids.forEach((sid) => {
        eliminated.add(sid);
        duplicateIds.push(sid);
      });
    }
  }
  // Préparer les messages à envoyer aux clients
  // Si aucun mot soumis, on envoie le message correspondant
  const messages = [];
  if (room.submissions.size === 0) {
    messages.push(MESSAGES.noSubmission);
  }
  // S'il y a des doublons, on collecte les noms pour le message
  if (duplicateIds.length > 0) {
    const names = duplicateIds.map((sid) => room.players.get(sid)?.name || '?');
    // retirer les doublés d'éventuelles répétitions
    const uniqueNames = Array.from(new Set(names));
    messages.push(MESSAGES.duplicate(uniqueNames));
  }
  // Envoyer les messages aux clients via log:message
  messages.forEach((msg) => {
    if (msg) io.to(code).emit('log:message', { message: msg });
  });
  // Préparer la liste des éliminations pour le popup
  const elimList = [];
  eliminated.forEach((sid) => {
    const p = room.players.get(sid);
    const name = p?.name || '?';
    let reason = 'duplicate';
    if (noSubmissionIds.includes(sid)) reason = 'noSubmission';
    elimList.push({ id: sid, name, reason });
    // appliquer l'élimination immédiatement dans l'état
    if (p) p.alive = false;
  });
  // Fonction qui termine le tour : attribution des points, envoi de turn:end et lancement du vote
  const finalizeTurn = () => {
    // Attribuer des points aux joueurs non éliminés en fonction de la rapidité
    if (room.turnStartedAt && room.currentTurnDuration) {
      for (const [sid] of room.submissions) {
        if (eliminated.has(sid)) continue;
        const submitTs = room.submissionTimes.get(sid);
        if (!submitTs) continue;
        const elapsed = submitTs - room.turnStartedAt;
        const dur = room.currentTurnDuration;
        let score = 10 - Math.floor((elapsed / dur) * 10);
        if (score < 1) score = 1;
        if (score > 10) score = 10;
        const player = room.players.get(sid);
        if (player) player.score += score;
      }
    }
    // Mise à jour du lobby
    io.to(code).emit('lobby:update', serializeRoom(room));
    // Mémoriser les mots valides pour empêcher la réutilisation
    for (const [sid, word] of room.submissions) {
      if (!eliminated.has(sid)) room.usedWords.add(word);
    }
    // Envoyer l'événement de fin de tour aux clients
    io.to(code).emit('turn:end', {
      submissions: [...room.submissions.entries()].map(([sid, word]) => ({
        id: sid,
        name: room.players.get(sid)?.name || '?',
        word,
      })),
      eliminated: [...eliminated],
      usedWords: [...room.usedWords],
      voteDurationMs: TIMER_CONFIG.voteDurationMs,
    });
    // Préparer la phase de vote
    room.votes = new Map();
    room.votingActive = true;
    for (const [sid] of room.submissions) {
      room.votes.set(sid, new Set());
    }
    const voteMs = TIMER_CONFIG.voteDurationMs;
    room.timers.voteEnd = setTimeout(() => finalizeVote(code, room, io), voteMs);
    touchRoom(room);
  };
  // Si des joueurs sont éliminés, envoyer un popup et attendre un délai avant de poursuivre
  if (elimList.length > 0) {
    io.to(code).emit('elim:popup', { eliminations: elimList });
    setTimeout(finalizeTurn, DELAY_CONFIG.eliminationPopupMs);
  } else {
    finalizeTurn();
  }
}

/**
 * Finalise la phase de vote pour une room. Cette fonction est appelée
 * automatiquement après une période déterminée (voir VOTING_TIME_MS dans
 * endTurn()). On parcourt toutes les soumissions et on calcule si
 * l'invalidation a été votée par la majorité des joueurs encore en vie.
 * Si c'est le cas, on élimine le joueur correspondant et on supprime
 * éventuellement son mot de la liste des mots utilisés. Puis on lance
 * un nouveau tour ou on termine le round si nécessaire. Les votes
 * ne sont plus acceptés après l'appel.
 *
 * @param {string} code Code de la room
 * @param {Object} room L'état de la room
 * @param {Object} io L'instance Socket.IO
 */
function finalizeVote(code, room, io) {
  // Si la phase de vote est terminée ou inexistante, ne rien faire
  if (!room.votingActive) return;
  room.votingActive = false;
  // Arrêter le timer de vote
  if (room.timers.voteEnd) {
    clearTimeout(room.timers.voteEnd);
    room.timers.voteEnd = null;
  }
  // Liste des survivants avant vote
  const aliveBefore = aliveIds(room);
  // Déterminer les joueurs éliminés par vote (majorité absolue)
  const eliminatedByVote = new Set();
  for (const [targetId, voters] of room.votes) {
    // Ignorer si déjà mort
    if (!room.players.get(targetId)?.alive) continue;
    // Calculer la majorité en excluant le joueur ciblé
    const effective = aliveBefore.filter((sid) => sid !== targetId);
    const effThreshold = Math.floor(effective.length / 2) + 1;
    if (voters.size >= effThreshold) {
      eliminatedByVote.add(targetId);
    }
  }
  // Préparer les événements de popup off‑topic
  const popupEvents = [];
  eliminatedByVote.forEach((sid) => {
    const p = room.players.get(sid);
    if (p) {
      const msg = MESSAGES.offTopic(p.name);
      popupEvents.push({
        players: [ { id: sid, name: p.name } ],
        message: msg,
      });
    }
  });
  // Fonction interne pour appliquer les éliminations et continuer
  const proceedAfterPopup = () => {
    // Appliquer l'élimination et nettoyer usedWords
    for (const sid of eliminatedByVote) {
      const p = room.players.get(sid);
      if (p) p.alive = false;
      const word = room.submissions.get(sid);
      if (word) room.usedWords.delete(word);
    }
    // Nettoyer les votes
    room.votes = new Map();
    // Vérifier les conditions de fin de partie (niveau >= 20 ou un seul joueur en vie)
    const remaining = aliveIds(room);
    const levelExceeded = room.level >= 20;
    if (levelExceeded || remaining.length <= 1) {
      // Message de fin de partie
      io.to(code).emit('log:message', { message: MESSAGES.gameOver });
      // Après un délai, afficher le tableau de scores final
      room.timers.newRound = setTimeout(() => {
        // Déterminer le gagnant (plus haut score) ou null
        let bestId = null;
        let maxScore = -Infinity;
        room.players.forEach((p, id) => {
          if (p.score > maxScore) {
            maxScore = p.score;
            bestId = id;
          }
        });
        endRound(code, room, bestId, io);
      }, DELAY_CONFIG.gameOverMs);
      return;
    }
    // Sinon, enchaîner sur le tour suivant (aucun délai supplémentaire)
    const delay = room.level >= 10 ? 0 : 900;
    room.timers.nextTurn = setTimeout(() => startNextTurn(code, room, io), delay);
  };
  if (popupEvents.length > 0) {
    // Envoi d'un événement spécifique pour signaler l'élimination par vote
    io.to(code).emit('vote:eliminated', { ids: [...eliminatedByVote] });
    // Envoi de log et popup pour chaque joueur hors‑sujet
    for (const ev of popupEvents) {
      io.to(code).emit('log:message', { message: ev.message });
    }
    io.to(code).emit('elim:popup', { events: popupEvents });
    // Attente du délai d'affichage avant de poursuivre
    room.timers.newRound = setTimeout(proceedAfterPopup, DELAY_CONFIG.eliminationPopupMs);
  } else {
    // Aucune élimination par vote : continuer normalement
    proceedAfterPopup();
  }
}

/**
 * Termine un round. Les points sont attribués (+3 pour le gagnant, +1 pour
 * chaque survivant). Toutes les informations nécessaires sont envoyées aux
 * clients : le gagnant, le numéro de round et le tableau de scores.
 * La room reste active mais n'auto‑relance pas un nouveau round : c'est
 * l'host qui décidera en cliquant sur « Rejouer ».
 *
 * @param {string} code Le code de la room
 * @param {Object} room L'état de la room
 * @param {string|null} winnerId Id du gagnant ou null si personne
 * @param {Object} io L'instance Socket.IO
 */
function endRound(code, room, winnerId, io) {
  let winner = null;
  if (winnerId && room.players.has(winnerId)) {
    const wp = room.players.get(winnerId);
    winner = { id: winnerId, name: wp.name };
    wp.score += 3;
  }
  // 1 point aux survivants
  room.players.forEach((p) => {
    if (p.alive) p.score += 1;
  });
  // Construire le tableau de scores (inclut les joueurs offline)
  const scores = [...room.players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score,
    online: p.online,
  }));
  scores.sort((a, b) => b.score - a.score);
  // Informer de la fin du round et du jeu
  io.to(code).emit("round:end", { winner, round: room.round });
  // Indiquer que la partie est terminée et réinitialiser le jeu. On
  // désactive gameActive afin que le bouton Démarrer redevienne
  // disponible pour l'host. Le round et les mots utilisés sont remis
  // à zéro. Les joueurs restent dans le lobby avec leurs scores.
  room.gameActive = false;
  room.accepting = false;
  room.submissions.clear();
  room.theme = null;
  room.turn = 0;
  room.usedWords.clear();
  // Tous les joueurs sont considérés comme morts jusqu'à la prochaine partie
  room.players.forEach((p) => {
    p.alive = false;
  });
  // Diffuser l'état mis à jour du lobby (incluant gameActive=false)
  io.to(code).emit("lobby:update", serializeRoom(room));
  // Envoyer le tableau final des scores. Les clients afficheront un
  // overlay avec possibilité de rejouer ou revenir au menu.
  io.to(code).emit("game:end", { winner, round: room.round, scores });
  touchRoom(room);
}

// Import the required functions from roomManager
const { touchRoom, aliveIds, serializeRoom } = require("./roomManager");

module.exports = {
  startNewRound,
  startNextTurn,
  endTurn,
  finalizeVote,
  endRound,
};

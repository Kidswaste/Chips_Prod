/**
 * Configuration du bot d'auto‑test
 *
 * Pour permettre de tester le jeu en solo, on peut injecter un bot dans la
 * room lorsque l'host démarre une partie avec moins de deux joueurs humains.
 * Ce bot choisit automatiquement un mot valide et le soumet au milieu du
 * temps imparti pour le tour. Vous pouvez ajuster le comportement du bot
 * ici :
 * - delayFactor : fraction du temps du tour à attendre avant l'envoi du mot
 *   (0.5 signifie que le bot soumettra après la moitié du timer). Réglez
 *   cette valeur entre 0 et 1 selon la difficulté souhaitée.
 */
const BOT_CONFIG = {
  delayFactor: 0.5,
};

/**
 * Ajoute un bot à la room si aucun n'est présent. Le bot est identifié
 * par un identifiant unique (prefixe "bot-" avec un timestamp). Il est
 * ajouté à la Map players avec un nom « Bot », un score initial nul et
 * un statut online. Son champ alive est mis à false ; il sera réanimé
 * au début du round via startNewRound().
 *
 * @param {Object} room La room où ajouter le bot
 */
function addBot(room) {
  if (room.botId) return;
  const botId = `bot-${Date.now()}`;
  room.players.set(botId, {
    name: "Bot",
    score: 0,
    alive: false,
    online: true,
  });
  room.botId = botId;
}

/**
 * Supprime le bot de la room s'il existe. Utilisé lorsque suffisamment
 * de joueurs humains sont présents pour jouer sans l'aide du bot.
 *
 * @param {Object} room La room où retirer le bot
 */
function removeBot(room) {
  if (room.botId) {
    room.players.delete(room.botId);
    room.botId = null;
  }
}

/**
 * Sélectionne un mot pour le bot. Parcourt la banque de mots de la room
 * (room.wordSet) et renvoie le premier mot qui n'a pas encore été utilisé
 * (room.usedWords), qui n'a pas été soumis dans le tour courant et qui
 * ne contient pas de lettre punie. Les mots sont normalisés (sans
 * accent). Si aucun mot valide n'est trouvé, renvoie null.
 *
 * @param {Object} room La room contenant wordSet, usedWords, punishedLetters
 * @returns {string|null} Un mot valide pour le bot ou null
 */
function pickBotWord(room) {
  for (const word of room.wordSet) {
    if (room.usedWords.has(word)) continue;
    if (room.submissions.has(room.botId)) continue;
    let skip = false;
    // Vérifier les lettres punies
    if (Array.isArray(room.punishedLetters) && room.punishedLetters.length > 0) {
      for (const l of room.punishedLetters) {
        if (word.includes(l)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
    }
    // Vérifier que personne n'a soumis le même mot dans ce tour
    let duplicateFound = false;
    for (const [, w] of room.submissions) {
      if (w === word) {
        duplicateFound = true;
        break;
      }
    }
    if (duplicateFound) continue;
    return word;
  }
  return null;
}

/**
 * Planifie la soumission automatique du bot pour le tour en cours. On
 * utilise room.currentTurnDuration et BOT_CONFIG.delayFactor pour
 * déterminer à quel moment envoyer le mot. Si le bot est mort ou absent
 * (room.botId null) ou si room.accepting est false, aucune soumission
 * n'est planifiée. Un seul timer de soumission est actif par room
 * (stocké dans room.timers.botSubmit) et annulé au début de chaque tour.
 *
 * @param {string} code Le code de la room (pour l'émission Socket.IO)
 * @param {Object} room L'état de la room
 * @param {Object} io L'instance Socket.IO
 */
function scheduleBotSubmission(code, room, io) {
  // Annuler toute soumission déjà planifiée
  if (room.timers.botSubmit) {
    clearTimeout(room.timers.botSubmit);
    room.timers.botSubmit = null;
  }
  // Pas de bot ? rien à faire
  if (!room.botId) return;
  const botPlayer = room.players.get(room.botId);
  if (!botPlayer || !botPlayer.alive) return;
  // Tour non actif ? ne pas planifier
  if (!room.accepting || !room.currentTurnDuration) return;
  // Calculer le délai
  const delay = Math.max(0, Math.min(room.currentTurnDuration - 50, Math.floor(room.currentTurnDuration * BOT_CONFIG.delayFactor)));
  room.timers.botSubmit = setTimeout(() => {
    // Vérifier que le tour est toujours actif
    if (!room.accepting) return;
    const word = pickBotWord(room);
    if (!word) return;
    // Enregistrer la soumission et le timestamp
    if (!room.submissions.has(room.botId)) {
      room.submissions.set(room.botId, word);
      if (!room.submissionTimes) room.submissionTimes = new Map();
      room.submissionTimes.set(room.botId, Date.now());
      // Diffuser au bot un ack (facultatif) et mise à jour progression
      io.to(code).emit('turn:progress', { submitted: room.submissions.size });
    }
  }, delay);
}

module.exports = {
  BOT_CONFIG,
  addBot,
  removeBot,
  pickBotWord,
  scheduleBotSubmission,
};

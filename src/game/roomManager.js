/**
 * Instancie une nouvelle room (partie) avec tous les paramètres par défaut.
 * Chaque room possède son propre état indépendant (joueurs, scores,
 * statistiques de tour, timers, etc.). Si vous souhaitez ajouter de
 * nouvelles mécaniques (par exemple des jokers, un chat, des scores
 * spéciaux), vous pouvez enrichir cet objet ici.
 *
 * Les clés les plus importantes à connaître :
 * - players : Map associant chaque socketId à un objet {name, score, alive, online}
 *   → Permet de suivre l'état de chaque joueur (nom, points, statut).
 * - themes : liste des thèmes disponibles pour la partie. Modifiez ce
 *   tableau pour introduire vos propres catégories. Un thème est choisi
 *   aléatoirement à chaque round.
 * - gameActive : booléen indiquant si une partie est en cours (empêche
 *   d'en lancer une autre). Passe à true sur game:start et redevient
 *   false après endRound().
 * - level : niveau global (augmente à chaque tour) utilisé pour
 *   calculer la durée du timer et le nombre de lettres interdites.
 * - punishedLetters : tableau des lettres interdites pour le tour.
 *   Généré à partir du niveau (voir generatePunishedLetters()).
 * - turnStartedAt / currentTurnDuration / submissionTimes :
 *   utilisées pour calculer le score en fonction de la rapidité de
 *   réponse (voir endTurn()).
 *
 * Les timers (nextTurn, endTurn, newRound, voteEnd) sont stockés afin
 * d'être annulés proprement si nécessaire (fermeture de room, élimination
 * immédiate, etc.).
 */
function createRoom() {
  return {
    players: new Map(),      // socketId -> { name, score, alive, online }
    hostId: null,
    round: 0,
    theme: null,
    turn: 0,
    baseTurnMs: 10000,
    minTurnMs: 1000,
    turnDecayMs: 100,
    accepting: false,
    submissions: new Map(),  // socketId -> word
    usedWords: new Set(),    // mots validés durant le round
    wordSet: new Set(),      // banque de mots pour le thème courant
    createdAt: Date.now(),   // date de création (pour la purge) 
    lastActivity: Date.now(),// date de dernière action (pour le timeout)
    // Timers utilisés pour les callbacks asynchrones. Un timer supplémentaire
    // voteEnd sera utilisé pendant la phase de vote pour annuler si besoin.
    timers: { nextTurn: null, endTurn: null, newRound: null, voteEnd: null, botSubmit: null },
    // Structure de votes (initialisée lorsqu'un tour se termine)
    votes: new Map(),
    votingActive: false,
    themes: [
      // Les thèmes proposés; on peut personnaliser cette liste à loisir
      "Jeux Vidéos (Nom Exact)",
      "Personnage de LoL",
      "Pokémons",
      "Couleurs",
      "Métiers",
      "Pays",
      "Prénoms",
      "Marques",
      "Anime",
    ],
    // Indique si une partie est en cours. Empêche de démarrer une seconde
    // partie alors que la précédente n'est pas terminée. Lors du démarrage
    // (game:start) on passe gameActive à true et on le remet à false à
    // l'issue du jeu (endRound).
    gameActive: false,
    // Niveau global du jeu. Il s'incrémente à chaque tour, tous rounds
    // confondus. Le niveau 1 correspond au tout premier tour. Lorsque le
    // niveau atteint 20, la partie se termine et on désigne le gagnant
    // selon le score total. Initialisé à 0 et incrémenté avant chaque
    // démarrage de tour.
    level: 0,
    // Lettres interdites (« punies ») pour le tour courant. À partir du
    // niveau 10, certaines lettres sont tirées au hasard et interdisent
    // l'utilisation de mots les contenant. Ce tableau est renouvelé à
    // chaque tour et envoyé au client via turn:start.
    punishedLetters: [],
    // Identifiant du bot (s'il existe). Lorsque l'host démarre une partie
    // avec moins de deux joueurs humains, un bot est automatiquement
    // ajouté à la room afin de permettre de tester le jeu en solo. Ce
    // champ stocke l'identifiant du bot dans la Map `players`. S'il est
    // null, aucun bot n'est présent. Le bot est traité comme un
    // joueur normal (score, online, alive) et peut être éliminé.
    botId: null,
    /**
     * Horodatage du début du tour courant (en ms). Il est défini dans
     * startNextTurn() afin de calculer le temps écoulé pour chaque
     * soumission et ainsi attribuer des points en fonction de la rapidité
     * de réponse. Reset à chaque tour.
     */
    turnStartedAt: null,
    /**
     * Durée du tour courant en millisecondes. Utilisée pour calculer le
     * pourcentage de temps utilisé par un joueur et déterminer le score
     * correspondant. Définie dans startNextTurn().
     */
    currentTurnDuration: null,
    /**
     * Table des timestamps de soumission. Pour chaque joueur ayant soumis
     * un mot, on stocke l'instant (Date.now()) auquel la soumission a été
     * faite. Cela permet de calculer des points proportionnels à la
     * vitesse de réponse (score 10 à 1). La table est vidée en début de
     * tour dans startNextTurn().
     */
    submissionTimes: new Map(),
  };
}

// Registre de toutes les rooms. Chaque entrée est un objet RoomState.
const rooms = new Map();

/**
 * Récupère une room existante ou en crée une nouvelle si elle n'existe pas.
 * Les codes de room sont utilisés tels quels et ne sont pas normalisés (le
 * client doit assurer une longueur raisonnable). Une room vide est
 * automatiquement retirée lorsque le dernier joueur quitte.
 *
 * @param {string} code Le code de la room (clé dans le dictionnaire rooms)
 * @returns {Object} La room correspondante
 */
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, createRoom());
  return rooms.get(code);
}

/**
 * Met à jour le timestamp d'activité d'une room. Appelez cette fonction à
 * chaque action significative (démarrage de partie, soumission de mot, etc.)
 * afin de réinitialiser le compteur d'inactivité. Les rooms inactives sont
 * fermées automatiquement par le janitor.
 *
 * @param {Object} room La room à mettre à jour
 */
function touchRoom(room) {
  room.lastActivity = Date.now();
}

/**
 * Annule tous les timers d'une room (tour, fin de tour, démarrage de round).
 * Ceci permet de s'assurer qu'aucune callback ne sera appelée après la
 * fermeture d'une room, évitant ainsi des comportements inattendus.
 *
 * @param {Object} room La room dont on supprime les timers
 */
function clearRoomTimers(room) {
  const { nextTurn, endTurn, newRound, voteEnd, botSubmit } = room.timers;
  if (nextTurn) clearTimeout(nextTurn);
  if (endTurn) clearTimeout(endTurn);
  if (newRound) clearTimeout(newRound);
  if (voteEnd) clearTimeout(voteEnd);
  if (botSubmit) clearTimeout(botSubmit);
  room.timers = { nextTurn: null, endTurn: null, newRound: null, voteEnd: null, botSubmit: null };
}

/**
 * Compte le nombre de joueurs en ligne dans une room.
 *
 * @param {Object} room La room
 * @returns {number} Le nombre de joueurs actuellement online
 */
function onlineCount(room) {
  let n = 0;
  room.players.forEach((p) => {
    if (p.online) n++;
  });
  return n;
}

/**
 * Retourne les identifiants (socketId) des joueurs encore en vie dans une room.
 *
 * @param {Object} room La room
 * @returns {string[]} Tableau d'identifiants
 */
function aliveIds(room) {
  return [...room.players.entries()]
    .filter(([, p]) => p.alive)
    .map(([id]) => id);
}

/**
 * Ferme et supprime une room. Les timers sont annulés et un
 * événement room:closed est envoyé aux clients pour qu'ils se déconnectent
 * ou retournent au menu. Après l'appel, la room n'existe plus dans
 * l'objet rooms.
 *
 * @param {string} code Le code de la room à supprimer
 * @param {string} reason Code ou message indiquant pourquoi elle est fermée
 * @param {Object} io L'instance Socket.IO
 */
function killRoom(code, reason = "closed", io) {
  const room = rooms.get(code);
  if (!room) return;
  clearRoomTimers(room);
  io.to(code).emit("room:closed", { reason });
  rooms.delete(code);
}

/**
 * Prépare la représentation du lobby pour l'envoyer aux clients. On
 * convertit la Map des joueurs en tableau pour faciliter le JSON et on
 * sélectionne uniquement les informations nécessaires.
 *
 * @param {Object} room La room
 * @returns {Object} Les données de lobby à envoyer
 */
function serializeRoom(room) {
  return {
    players: [...room.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
      alive: p.alive,
      online: p.online,
    })),
    hostId: room.hostId,
    round: room.round,
    turn: room.turn,
    theme: room.theme,
    accepting: room.accepting,
    // Indique si une partie est en cours. Permet au client de
    // désactiver le bouton Démarrer quand gameActive vaut true.
    gameActive: room.gameActive,
    // Niveau actuel (tours cumulés). Peut être utilisé côté client
    // pour afficher le niveau ou adapter l'UI.
    level: room.level,
  };
}

module.exports = {
  createRoom,
  getRoom,
  touchRoom,
  clearRoomTimers,
  onlineCount,
  aliveIds,
  killRoom,
  serializeRoom,
  rooms,
};

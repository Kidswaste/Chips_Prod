/*
 * Multi‑room, real‑time word game server
 *
 * Ce serveur utilise Express et Socket.IO pour permettre à plusieurs parties
 * (« rooms ») de se jouer en parallèle. Chaque room maintient son propre
 * état (joueurs, scores, thème courant, tour en cours, etc.). Les joueurs
 * rejoignent une room via un code, un peu comme un lobby. Lorsque le dernier
 * joueur quitte une room ou qu’elle reste inactive trop longtemps, elle est
 * nettoyée automatiquement. Cette architecture découple les différentes
 * parties et évite que les états se mélangent.
 *
 * La logique de jeu inclut :
 *  - Un thème choisi aléatoirement pour chaque round
 *  - Un timer qui décroît de 10 s à 1 s au fil des tours
 *  - L’élimination des joueurs qui n’envoient pas de mot, qui se doublonnent
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
const fs = require("node:fs/promises");
const path = require("node:path");

// Répertoire contenant les fichiers texte servant de banque de mots.
// Chaque fichier porte le nom d’un thème normalisé (voir normalizeKey). Le
// fichier « global.txt » est utilisé en dernier recours si le thème
// n’est pas trouvé.
const DATA_DIR = path.join(__dirname, "data");

// Cache pour ne charger les banques de mots qu’une seule fois par thème.
const wordBankCache = new Map();

// -----------------------------------------------------------------------------
// Configuration des timers
//
// Les durées des tours sont réparties en plages de niveaux. Plutôt que
// d'encoder ces durées en dur au sein du code, on les expose ici afin
// de pouvoir les modifier facilement sans avoir à parcourir toutes les
// fonctions. Chaque entrée du tableau `levelRanges` définit un intervalle
// [start, end] en niveaux inclusifs et les durées (en secondes) en début
// et fin d'intervalle. Une interpolation linéaire est utilisée entre
// start et end. Par exemple, pour l'intervalle {start:1, end:10, startSec:10,
// endSec:8}, le niveau 1 durera 10 s, le niveau 10 durera 8 s et les
// niveaux intermédiaires seront répartis de façon uniforme. Lorsque le
// niveau est supérieur au dernier intervalle, la dernière valeur est
// utilisée. La valeur `voteDurationMs` détermine la durée de la phase
// d'invalidation (vote) après chaque tour. Vous pouvez ajuster ces
// valeurs selon vos besoins.
// -----------------------------------------------------------------------------
// TIMER_CONFIG
//
// Cette constante centralise toutes les durées utilisées par le jeu.
// - levelRanges : liste d’intervalles de niveaux (inclusifs) avec la durée
//   associée au début et à la fin de l’intervalle (en secondes). Le temps
//   d’un tour est interpolé linéairement entre startSec et endSec. Par
//   exemple, {start:1, end:10, startSec:10, endSec:8} signifie qu’au
//   niveau 1, le tour dure 10 s et qu’au niveau 10 il dure 8 s. Entre les
//   deux, la durée diminue progressivement. Ajoutez ou modifiez des
//   entrées selon vos besoins.
// - voteDurationMs : durée de la fenêtre de vote pour invalider un mot
//   (après un tour), exprimée en millisecondes. Vous pouvez la réduire ou
//   l’augmenter selon le confort des joueurs.
//
// Ces paramètres sont faciles à ajuster pour tester différentes mécaniques.
const TIMER_CONFIG = {
  levelRanges: [
    { start: 1, end: 10, startSec: 15, endSec: 10 },
    { start: 10, end: 15, startSec: 10, endSec: 8 },
    { start: 15, end: 20, startSec: 8, endSec: 4 },
  ],
  voteDurationMs: 2000,
};

// Configuration générale des rooms : vieillissement et inactivité
const CONFIG = {
  ROOM_MAX_AGE_MS: 6 * 60 * 60 * 1000, // durée de vie maximale d’une room (6 heures)
  ROOM_IDLE_MS:    20 * 60 * 1000,     // durée d’inactivité avant fermeture (20 minutes)
};

// Registre de toutes les rooms. Chaque entrée est un objet RoomState.
const rooms = new Map();

// Express et Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Middleware pour servir les fichiers du dossier public (HTML, CSS, JS côté client)
app.use(express.static("public"));

/**
 * Fonction utilitaire : normalise un mot en minuscule sans accent. Ceci
 * permet de comparer des mots avec ou sans accent de la même manière.
 *
 * @param {string} w Le mot à normaliser
 * @returns {string} Le mot transformé
 */
function normalizeWord(w) {
  if (!w) return "";
  const s = String(w).trim().toLowerCase();
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Produit un identifiant de fichier à partir d’un thème. Les espaces,
 * accents et autres caractères non alphanumériques sont convertis en
 * underscores. Ceci permet de retrouver le fichier texte associé à un
 * thème quelle que soit son écriture dans la liste des thèmes.
 *
 * @param {string} s Le thème brut
 * @returns {string} Nom de fichier normalisé
 */
function normalizeKey(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Génère plusieurs variantes d’un nom normalisé (singulier/pluriel)
 * pour augmenter les chances de trouver un fichier correspondant. Par
 * exemple, “pokemons” donnera aussi “pokemon” et vice‑versa.
 *
 * @param {string} norm Nom normalisé (accents et ponctuation retirés)
 * @returns {string[]} Liste de variantes possibles
 */
function nameVariants(norm) {
  const variants = new Set([norm]);
  // Si se termine par un « s », essayer sans « s »
  if (norm.endsWith("s")) variants.add(norm.slice(0, -1));
  // Si ne se termine pas par « s », essayer avec « s »
  else variants.add(norm + "s");
  // Cas particulier des mots en « x » (ex: jeux -> jeu)
  if (norm.endsWith("x")) variants.add(norm.slice(0, -1));
  // Cas simple: tenter en ajoutant « x » si absent
  if (!norm.endsWith("x")) variants.add(norm + "x");
  return Array.from(variants);
}

/**
 * Recherche dans le répertoire de données un fichier .txt dont le nom
 * normalisé correspond au thème donné. On tolère les variantes (singulier,
 * pluriel, accents, parenthèses). Si plusieurs fichiers matchent, le
 * premier trouvé est renvoyé. Si aucun ne correspond, on renvoie null.
 *
 * @param {string} dir Répertoire des banques de mots
 * @param {string} theme Nom du thème (tel qu'affiché dans la liste)
 * @returns {Promise<string|null>} Chemin du fichier ou null
 */
async function resolveDatasetPath(dir, theme) {
  const targetKey = normalizeKey(theme);
  const variants = nameVariants(targetKey);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (e) {
    return null;
  }
  // Filtrer les .txt uniquement
  const txtFiles = files.filter((f) => /\.txt$/i.test(f));
  // Chercher un match exact parmi les variantes
  for (const file of txtFiles) {
    const base = file.replace(/\.[^.]+$/, "");
    const normBase = normalizeKey(base);
    if (variants.includes(normBase)) {
      return path.join(dir, file);
    }
  }
  // Tentative de match partiel (nom commençant ou finissant par targetKey)
  for (const file of txtFiles) {
    const base = file.replace(/\.[^.]+$/, "");
    const normBase = normalizeKey(base);
    if (variants.some((v) => normBase.startsWith(v) || v.startsWith(normBase))) {
      return path.join(dir, file);
    }
  }
  return null;
}

/**
 * Charge la banque de mots pour un thème donné. Le serveur lit un fichier
 * portant le nom du thème normalisé (ex. « animaux.txt »). Si ce fichier
 * n’existe pas, il tente « global.txt » comme liste de secours. Chaque ligne
 * correspond à un mot valide (les commentaires commençant par # sont ignorés).
 * Les mots sont normalisés lors du chargement pour accélérer les comparaisons.
 *
 * @param {string} theme Le nom du thème
 * @returns {Promise<Set<string>>} Un ensemble de mots normalisés
 */
async function loadWordSetForTheme(theme) {
  const key = normalizeKey(theme);
  // Si déjà chargé, on récupère le cache
  if (wordBankCache.has(key)) return wordBankCache.get(key);
  // Chercher un fichier spécifique au thème en tenant compte des variantes
  const themeFile = await resolveDatasetPath(DATA_DIR, theme);
  // fichier global optionnel
  const globalFile = path.join(DATA_DIR, "global.txt");
  const filesToLoad = [];
  if (themeFile) filesToLoad.push(themeFile);
  try {
    await fs.access(globalFile);
    filesToLoad.push(globalFile);
  } catch (_) {
    // pas de fichier global, ce n'est pas bloquant
  }
  let text = "";
  for (const f of filesToLoad) {
    try {
      const t = await fs.readFile(f, "utf8");
      text += t;
      if (!text.endsWith("\n")) text += "\n";
    } catch (e) {
      console.warn(`[data] Échec lecture: ${f} -> ${e.message}`);
    }
  }
  const set = new Set();
  if (text) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.split("#")[0].trim();
      if (!line) continue;
      set.add(normalizeWord(line));
    }
  } else {
    console.warn(
      `[data] Aucun dataset trouvé pour le thème "${theme}" (clé: ${key}).`
    );
  }
  wordBankCache.set(key, set);
  return set;
}

/**
 * Crée un nouvel objet de room avec l’état initial. Une room correspond à
 * une partie indépendante : elle possède sa propre liste de joueurs, ses
 * timers, son thème, etc. Les timers sont stockés afin de pouvoir les
 * annuler proprement lors de la fermeture de la room.
 *
 * @returns {Object} Un nouvel objet RoomState
 */
/**
 * Instancie une nouvelle room (partie) avec tous les paramètres par défaut.
 * Chaque room possède son propre état indépendant (joueurs, scores,
 * statistiques de tour, timers, etc.). Si vous souhaitez ajouter de
 * nouvelles mécaniques (par exemple des jokers, un chat, des scores
 * spéciaux), vous pouvez enrichir cet objet ici.
 *
 * Les clés les plus importantes à connaître :
 * - players : Map associant chaque socketId à un objet {name, score, alive, online}
 *   → Permet de suivre l’état de chaque joueur (nom, points, statut).
 * - themes : liste des thèmes disponibles pour la partie. Modifiez ce
 *   tableau pour introduire vos propres catégories. Un thème est choisi
 *   aléatoirement à chaque round.
 * - gameActive : booléen indiquant si une partie est en cours (empêche
 *   d’en lancer une autre). Passe à true sur game:start et redevient
 *   false après endRound().
 * - level : niveau global (augmente à chaque tour) utilisé pour
 *   calculer la durée du timer et le nombre de lettres interdites.
 * - punishedLetters : tableau des lettres interdites pour le tour.
 *   Généré à partir du niveau (voir generatePunishedLetters()).
 * - turnStartedAt / currentTurnDuration / submissionTimes :
 *   utilisées pour calculer le score en fonction de la rapidité de
 *   réponse (voir endTurn()).
 *
 * Les timers (nextTurn, endTurn, newRound, voteEnd) sont stockés afin
 * d’être annulés proprement si nécessaire (fermeture de room, élimination
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
    timers: { nextTurn: null, endTurn: null, newRound: null, voteEnd: null },
    // Structure de votes (initialisée lorsqu’un tour se termine)
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
	  //"Films",
	  //"Séries",
	  //"Top 500 Spotify" https://github.com/EduardLupu/ ,
	  //"
    ],
    // Indique si une partie est en cours. Empêche de démarrer une seconde
    // partie alors que la précédente n'est pas terminée. Lors du démarrage
    // (game:start) on passe gameActive à true et on le remet à false à
    // l’issue du jeu (endRound).
    gameActive: false,
    // Niveau global du jeu. Il s’incrémente à chaque tour, tous rounds
    // confondus. Le niveau 1 correspond au tout premier tour. Lorsque le
    // niveau atteint 20, la partie se termine et on désigne le gagnant
    // selon le score total. Initialisé à 0 et incrémenté avant chaque
    // démarrage de tour.
    level: 0,
    // Lettres interdites (« punies ») pour le tour courant. À partir du
    // niveau 10, certaines lettres sont tirées au hasard et interdisent
    // l’utilisation de mots les contenant. Ce tableau est renouvelé à
    // chaque tour et envoyé au client via turn:start.
    punishedLetters: [],
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
     * un mot, on stocke l’instant (Date.now()) auquel la soumission a été
     * faite. Cela permet de calculer des points proportionnels à la
     * vitesse de réponse (score 10 à 1). La table est vidée en début de
     * tour dans startNextTurn().
     */
    submissionTimes: new Map(),
  };
}

/**
 * Récupère une room existante ou en crée une nouvelle si elle n’existe pas.
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
 * Met à jour le timestamp d’activité d’une room. Appelez cette fonction à
 * chaque action significative (démarrage de partie, soumission de mot, etc.)
 * afin de réinitialiser le compteur d’inactivité. Les rooms inactives sont
 * fermées automatiquement par le janitor.
 *
 * @param {Object} room La room à mettre à jour
 */
function touchRoom(room) {
  room.lastActivity = Date.now();
}

/**
 * Annule tous les timers d’une room (tour, fin de tour, démarrage de round).
 * Ceci permet de s’assurer qu’aucune callback ne sera appelée après la
 * fermeture d’une room, évitant ainsi des comportements inattendus.
 *
 * @param {Object} room La room dont on supprime les timers
 */
function clearRoomTimers(room) {
  const { nextTurn, endTurn, newRound, voteEnd } = room.timers;
  if (nextTurn) clearTimeout(nextTurn);
  if (endTurn) clearTimeout(endTurn);
  if (newRound) clearTimeout(newRound);
  if (voteEnd) clearTimeout(voteEnd);
  room.timers = { nextTurn: null, endTurn: null, newRound: null, voteEnd: null };
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
 * @returns {string[]} Tableau d’identifiants
 */
function aliveIds(room) {
  return [...room.players.entries()]
    .filter(([, p]) => p.alive)
    .map(([id]) => id);
}

/**
 * Ferme et supprime une room. Les timers sont annulés et un
 * événement room:closed est envoyé aux clients pour qu’ils se déconnectent
 * ou retournent au menu. Après l’appel, la room n’existe plus dans
 * l’objet rooms.
 *
 * @param {string} code Le code de la room à supprimer
 * @param {string} reason Code ou message indiquant pourquoi elle est fermée
 */
function killRoom(code, reason = "closed") {
  const room = rooms.get(code);
  if (!room) return;
  clearRoomTimers(room);
  io.to(code).emit("room:closed", { reason });
  rooms.delete(code);
}

/**
 * Prépare la représentation du lobby pour l’envoyer aux clients. On
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
    // pour afficher le niveau ou adapter l’UI.
    level: room.level,
  };
}

/**
 * Commence un nouveau round dans une room. On remet à zéro les mots
 * utilisés, on charge la banque de mots pour le thème et on “réanime”
 * les joueurs en ligne. Le premier tour commence après une courte pause
 * pour permettre aux clients de se mettre à jour.
 *
 * @param {string} code Le code de la room
 * @param {Object} room L’état de la room
 */
async function startNewRound(code, room) {
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
  // Démarrer le premier tour après 600 ms
  room.timers.nextTurn = setTimeout(() => startNextTurn(code, room), 600);
  touchRoom(room);
}

/**
 * Démarre le tour suivant ou met fin au round si un ou zéro joueur reste en
 * vie. La durée du tour diminue à chaque tour mais ne descend pas sous
 * minTurnMs. Les clients gèrent l’affichage du timer.
 *
 * @param {string} code Le code de la room
 * @param {Object} room L’état de la room
 */
function startNextTurn(code, room) {
  const alive = aliveIds(room);
  // Si un seul joueur survit, terminer immédiatement le round
  if (alive.length <= 1) {
    endRound(code, room, alive[0] || null);
    return;
  }
  // Incrémenter le numéro de tour pour ce round
  room.turn += 1;
  // Incrémenter le niveau global. Au premier tour d’une partie,
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
  room.timers.endTurn = setTimeout(() => endTurn(code, room), turnMs);
  touchRoom(room);
}

/**
 * Termine le tour en cours. Les joueurs sans soumission ou ayant un mot
 * doublon sont éliminés. Les mots uniques et valides sont ajoutés à
 * room.usedWords pour ne plus pouvoir être réutilisés. Après le traitement,
 * la fonction décide de lancer un nouveau tour ou de finir le round.
 *
 * @param {string} code Le code de la room
 * @param {Object} room L’état de la room
 */
function endTurn(code, room) {
  room.accepting = false;
  // Fréquence des mots soumis
  const freq = new Map();
  for (const [sid, word] of room.submissions) {
    if (!freq.has(word)) freq.set(word, []);
    freq.get(word).push(sid);
  }
  const eliminated = new Set();
  // Éliminer les joueurs qui n’ont rien soumis
  room.players.forEach((p, sid) => {
    if (p.alive && !room.submissions.has(sid)) eliminated.add(sid);
  });
  // Éliminer les doublons de ce tour
  for (const [w, ids] of freq) {
    if (ids.length >= 2) ids.forEach((sid) => eliminated.add(sid));
  }
  // Appliquer l’élimination
  eliminated.forEach((sid) => {
    const p = room.players.get(sid);
    if (p) p.alive = false;
  });
  // Attribuer des points aux réponses valides en fonction de la rapidité
  // de soumission. Les joueurs éliminés au tour (doublons ou pas de mot)
  // ne reçoivent pas de points. Le score est calculé entre 10 et 1
  // en fonction du pourcentage de temps écoulé: 10 pour une réponse
  // immédiate, 1 pour une réponse en fin de timer. On recourt à la
  // fonction Math.floor() pour définir des paliers.
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
      if (player) {
        player.score += score;
      }
    }
  }
  // Après l’attribution des points, mettre à jour les clients sur le lobby
  io.to(code).emit("lobby:update", serializeRoom(room));
  // Mémoriser les mots uniques et valides du tour pour éviter la réutilisation
  for (const [sid, word] of room.submissions) {
    if (!eliminated.has(sid)) room.usedWords.add(word);
  }
  // Informer les clients de la fin du tour
  io.to(code).emit("turn:end", {
    submissions: [...room.submissions.entries()].map(([sid, word]) => ({
      id: sid,
      name: room.players.get(sid)?.name || "?",
      word,
    })),
    eliminated: [...eliminated],
    usedWords: [...room.usedWords],
    // Exposer la durée de vote au client pour qu’il puisse animer la barre de vote
    voteDurationMs: TIMER_CONFIG.voteDurationMs,
  });
  // Démarrer une phase de vote interactif : chaque joueur peut voter
  // contre un mot s’il le juge hors‑sujet. Une room.votes est créée pour
  // stocker les votes. Une fois la période écoulée, les éliminations
  // définitives sont traitées dans finalizeVote().
  room.votes = new Map();
  room.votingActive = true;
  // Initialiser les entrées de votes pour chaque soumission
  for (const [sid] of room.submissions) {
    room.votes.set(sid, new Set());
  }
  // Planifier la fin de la phase de vote. On attend quelques secondes
  // afin que chaque joueur ait le temps de voter. La durée est
  // configurable via TIMER_CONFIG.voteDurationMs.
  const voteMs = TIMER_CONFIG.voteDurationMs;
  room.timers.voteEnd = setTimeout(() => finalizeVote(code, room), voteMs);
  touchRoom(room);
}

/**
 * Termine un round. Les points sont attribués (+3 pour le gagnant, +1 pour
 * chaque survivant). Toutes les informations nécessaires sont envoyées aux
 * clients : le gagnant, le numéro de round et le tableau de scores.
 * La room reste active mais n’auto‑relance pas un nouveau round : c’est
 * l’host qui décidera en cliquant sur « Rejouer ».
 *
 * @param {string} code Le code de la room
 * @param {Object} room L’état de la room
 * @param {string|null} winnerId Id du gagnant ou null si personne
 */
function endRound(code, room, winnerId) {
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
  // disponible pour l’host. Le round et les mots utilisés sont remis
  // à zéro. Les joueurs restent dans le lobby avec leurs scores.
  room.gameActive = false;
  room.accepting = false;
  room.submissions.clear();
  room.theme = null;
  room.turn = 0;
  room.usedWords.clear();
  // Tous les joueurs sont considérés comme morts jusqu’à la prochaine partie
  room.players.forEach((p) => {
    p.alive = false;
  });
  // Diffuser l’état mis à jour du lobby (incluant gameActive=false)
  io.to(code).emit("lobby:update", serializeRoom(room));
  // Envoyer le tableau final des scores. Les clients afficheront un
  // overlay avec possibilité de rejouer ou revenir au menu.
  io.to(code).emit("game:end", { winner, round: room.round, scores });
  touchRoom(room);
}

/**
 * Finalise la phase de vote pour une room. Cette fonction est appelée
 * automatiquement après une période déterminée (voir VOTING_TIME_MS dans
 * endTurn()). On parcourt toutes les soumissions et on calcule si
 * l'invalidation a été votée par la majorité des joueurs encore en vie.
 * Si c'est le cas, on élimine le joueur correspondant et on supprime
 * éventuellement son mot de la liste des mots utilisés. Puis on lance
 * un nouveau tour ou on termine le round si nécessaire. Les votes
 * ne sont plus acceptés après l’appel.
 *
 * @param {string} code Code de la room
 * @param {Object} room L’état de la room
 */
function finalizeVote(code, room) {
  if (!room.votingActive) return; // sécurité
  room.votingActive = false;
  // Stop the voting timer if it is running
  if (room.timers.voteEnd) {
    clearTimeout(room.timers.voteEnd);
    room.timers.voteEnd = null;
  }
  // Calcule le nombre de joueurs encore en vie avant le vote
  const alive = aliveIds(room);
  const aliveCount = alive.length;
  // Seuil de majorité stricte : plus de la moitié
  const threshold = Math.floor(aliveCount / 2) + 1;
  const eliminated = new Set();
  // Pour chaque soumission, vérifier si les votes dépassent le seuil
  for (const [targetId, voters] of room.votes) {
    // Si le joueur ciblé n’est plus en vie, ignorer
    if (!room.players.get(targetId)?.alive) continue;
    // Le joueur voté ne compte pas parmi les votants — la majorité
    // est calculée uniquement sur la base des autres survivants
    const effectiveVoters = alive.filter((sid) => sid !== targetId);
    const effCount = effectiveVoters.length;
    const effThreshold = Math.floor(effCount / 2) + 1;
    if (voters.size >= effThreshold) {
      eliminated.add(targetId);
    }
  }
  // Appliquer l’élimination et retirer leurs mots de usedWords
  for (const sid of eliminated) {
    const p = room.players.get(sid);
    if (p) p.alive = false;
    // Retirer le mot de usedWords pour le rendre réutilisable
    const word = room.submissions.get(sid);
    if (word) {
      room.usedWords.delete(word);
    }
  }
  // Informer les clients des éliminations par vote
  if (eliminated.size > 0) {
    io.to(code).emit('vote:eliminated', { ids: [...eliminated] });
  }
  // Nettoyer les votes
  room.votes = new Map();
  // Si le niveau atteint ou dépasse 20, terminer définitivement la partie
  if (room.level >= 20) {
    // Déterminer le joueur avec le score le plus élevé (en cas de égalité, le premier rencontré est pris)
    let maxScore = -Infinity;
    let bestId = null;
    room.players.forEach((p, id) => {
      if (p.score > maxScore) {
        maxScore = p.score;
        bestId = id;
      }
    });
    // Finir le round et donc la partie; endRound mettra gameActive à false et affichera les scores
    endRound(code, room, bestId);
    return;
  }
  // Reprendre le déroulement normal du jeu
  const remaining = aliveIds(room);
  if (remaining.length <= 1) {
    endRound(code, room, remaining[0] || null);
  } else {
    // Niveau >=10 : on enchaîne directement sans délai entre les tours
    const delay = room.level >= 10 ? 0 : 900;
    room.timers.nextTurn = setTimeout(() => startNextTurn(code, room), delay);
  }
}

/**
 * Choisit un élément aléatoire dans un tableau. Utilisé pour le thème.
 *
 * @param {Array} arr Tableau d’éléments
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Calcule la durée d’un tour en fonction du niveau global. Les
 * premières manches démarrent à 10 s et décroissent jusqu’à 8 s au
 * niveau 10, puis 6 s au niveau 15 et enfin 4 s au niveau 20. Entre
 * ces seuils, une interpolation linéaire est utilisée. Au‑delà du
 * niveau 20, la durée reste fixée à 4 s.
 *
 * @param {number} level Le niveau courant (>=1)
 * @returns {number} Durée en secondes
 */
function getTurnDuration(level) {
  // Parcourt les intervalles définis dans TIMER_CONFIG pour déterminer
  // dans lequel se trouve le niveau actuel. Utilise ensuite une
  // interpolation linéaire entre startSec et endSec. Si le niveau est
  // en-dessous du premier intervalle, on renvoie la durée du premier.
  // Si le niveau est au-dessus du dernier, on renvoie la durée finale.
  if (!Array.isArray(TIMER_CONFIG.levelRanges) || TIMER_CONFIG.levelRanges.length === 0) {
    return 4;
  }
  const ranges = TIMER_CONFIG.levelRanges;
  for (let i = 0; i < ranges.length; i++) {
    const { start, end, startSec, endSec } = ranges[i];
    if (level < start) {
      return startSec;
    }
    if (level >= start && level <= end) {
      // Nombre de paliers dans l'intervalle
      const steps = end - start;
      if (steps === 0) return endSec;
      const stepSize = (startSec - endSec) / steps;
      return startSec - (level - start) * stepSize;
    }
  }
  // Si le niveau est supérieur au dernier intervalle, renvoyer la dernière valeur
  const last = ranges[ranges.length - 1];
  return last.endSec;
}

/**
 * Génère un ensemble de lettres interdites (« punies ») en fonction du
 * niveau. À partir du niveau 10, des lettres aléatoires sont tirées :
 * 1 lettre aux niveaux 10‑12, 2 lettres aux niveaux 13‑15 et 3 lettres
 * aux niveaux 16‑20. Les lettres sont distinctes et choisies dans
 * l’alphabet latin (a‑z). Si le niveau est inférieur à 10, aucune
 * lettre n’est punie.
 *
 * @param {number} level Le niveau courant
 * @returns {string[]} Tableau de lettres minuscules interdites
 */
function generatePunishedLetters(level) {
  let count = 0;
  if (level >= 16) {
    count = 3;
  } else if (level >= 13) {
    count = 2;
  } else if (level >= 10) {
    count = 1;
  }
  const letters = [];
  while (letters.length < count) {
    const letter = String.fromCharCode(97 + Math.floor(Math.random() * 26));
    if (!letters.includes(letter)) letters.push(letter);
  }
  return letters;
}

// Gestion des connexions Socket.IO
io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  /**
   * Rejoindre une room. Le client doit envoyer un objet contenant
   * { name, code }. Si le code est vide, la room « public » est utilisée.
   * Le serveur associe le socket à la room et diffuse l’état mis à jour.
   */
  socket.on("player:join", async ({ name, code }, ack) => {
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
    // Attribuer l’host s’il n’existe pas encore
    if (!room.hostId) room.hostId = socket.id;
    // Diffuser l’état
    io.to(roomCode).emit("lobby:update", serializeRoom(room));
    if (typeof ack === "function") {
      ack({ ok: true, host: room.hostId === socket.id });
    }
    touchRoom(room);
  });

  /**
   * L’host démarre une partie. Vérifie qu’il y a au moins deux joueurs en
   * ligne, puis lance le premier round. Si ce n’est pas le cas, renvoie
   * une erreur uniquement à l’host.
   */
  socket.on("game:start", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    // Empêcher de lancer une partie si une autre est en cours ou si
    // moins de deux joueurs sont connectés. On renvoie toujours le même
    // message d’erreur pour éviter de donner trop de détails.
    if (room.gameActive || onlineCount(room) < 2) {
      io.to(socket.id).emit("game:error", {
        message: "Problème de création du Lobby, Demande à Kiddy",
      });
      return;
    }
    // Initialiser la partie : remettre le niveau et les lettres punies à zéro
    room.gameActive = true;
    room.level = 0;
    room.punishedLetters = [];
    startNewRound(code, room);
  });

  /**
   * L’host demande un retour au menu sans relancer de partie. On ne fait
   * qu’informer les clients de l’évènement, ils restent dans le lobby.
   */
  socket.on("game:menu", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    io.to(code).emit("game:menu");
    touchRoom(room);
  });

  /**
   * L’host relance une partie après la fin d’un round. Même contrôle que
   * game:start.
   */
  socket.on("game:restart", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    // Empêcher le relancement si une partie est en cours ou s’il n’y a pas
    // assez de joueurs. Même message d’erreur que pour game:start.
    if (room.gameActive || onlineCount(room) < 2) {
      io.to(socket.id).emit("game:error", {
        message: "Problème de création du Lobby, Demande à Kiddy",
      });
      return;
    }
    room.gameActive = true;
    room.level = 0;
    room.punishedLetters = [];
    startNewRound(code, room);
  });

  /**
   * Soumission d’un mot pour le tour en cours. Un mot est accepté s’il
   * n’a pas encore été utilisé dans le round (room.usedWords) et s’il
   * appartient à la banque de mots pour le thème courant. Les duplicats
   * ou les mots invalides renvoient la même erreur afin de ne pas donner
   * d’indice aux joueurs.
   */
  socket.on("turn:submit", (word) => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room || !room.accepting) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    const normalized = normalizeWord(word);
    if (!normalized) return;
    // Vérifier si le mot a déjà été utilisé, s’il n’est pas dans la banque
    // ou s’il contient une lettre punie. Tous ces cas renvoient la même
    // erreur afin de ne pas donner d’indice.
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
      // réponse. Si turnStartedAt n’est pas défini (cas improbable), on
      // stocke Date.now() quand même.
      if (!room.submissionTimes) {
        room.submissionTimes = new Map();
      }
      room.submissionTimes.set(socket.id, Date.now());
      io.to(socket.id).emit("turn:ack", { lockedWord: normalized });
      io.to(code).emit("turn:progress", { submitted: room.submissions.size });
      touchRoom(room);
    }
  });

  /**
   * Vote contre la validité d’un mot. Chaque joueur vivant peut voter
   * une fois contre un mot qu’il estime hors‑sujet. Lorsqu’une majorité
   * est atteinte, le joueur ciblé est éliminé immédiatement. Les votes
   * sont enregistrés pendant une période définie dans endTurn() et
   * finalisés par finalizeVote(). Ce handler permet aussi l’élimination
   * précoce (dès qu’un seuil est franchi) pour accélérer la décision.
   */
  socket.on('turn:vote', ({ target }) => {
    const code = socket.data.room;
    const room = rooms.get(code);
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
      // Mettre à jour l’état du lobby
      io.to(code).emit('lobby:update', serializeRoom(room));
    }
    touchRoom(room);
  });

  /**
   * Gestion de la déconnexion. On marque le joueur offline et l’élimine
   * immédiatement si une partie est en cours. Si l’host quitte, on
   * réattribue l’host au prochain joueur en ligne. Si plus aucun joueur
   * n’est en ligne, on supprime la room.
   */
  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
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
    // Si plus aucun joueur online, fermer la room
    if (onlineCount(room) === 0) {
      killRoom(code, "empty");
    } else {
      io.to(code).emit("lobby:update", serializeRoom(room));
    }
  });
});

/**
 * Janitor : boucle qui passe régulièrement pour fermer les rooms inactives
 * ou trop anciennes. Chaque room possède deux timestamps : createdAt
 * (date de création) et lastActivity (date du dernier événement significatif).
 * Selon CONFIG.ROOM_MAX_AGE_MS et CONFIG.ROOM_IDLE_MS, on décide de
 * supprimer ou non une room.
 */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const tooOld = now - room.createdAt > CONFIG.ROOM_MAX_AGE_MS;
    const tooIdle = now - room.lastActivity > CONFIG.ROOM_IDLE_MS;
    if (onlineCount(room) === 0 || tooOld || tooIdle) {
      killRoom(code, tooOld ? "max_age" : tooIdle ? "idle" : "empty");
    }
  }
}, 60_000); // vérifie toutes les minutes

// Démarrage du serveur
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
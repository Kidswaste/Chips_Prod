/**
 * Configuration des messages et délais
 *
 * Ces constantes contrôlent les messages affichés lors d'événements
 * particuliers (aucune soumission, doublons, hors-sujet et fin de partie) et
 * les délais d'affichage des popups associés. Modifiez ces valeurs pour
 * personnaliser l'expérience utilisateur sans parcourir tout le code.
 */

/**
 * Messages personnalisables pour les notifications de jeu. Vous pouvez
 * modifier ces chaînes pour ajuster le feedback affiché aux joueurs.
 * - noSubmission : message lorsqu'aucun joueur n'a soumis de mot durant
 *   un tour (tous les joueurs sont éliminés).
 * - duplicate(names) : message généré lorsqu'un ou plusieurs joueurs ont
 *   soumis le même mot. Le paramètre `names` est un tableau contenant les
 *   prénoms des joueurs concernés ; la fonction compose une phrase en
 *   listant les noms séparés par des virgules et le dernier avec « et ».
 * - offTopic(name) : message lorsqu'un joueur est éliminé pour avoir
 *   proposé un mot hors‑sujet (vote majoritaire contre lui).
 * - gameOver : message affiché dans les logs lorsque la partie se termine.
 */
const MESSAGES = {
  noSubmission: '"Personne" n\'a pas eu le temps',
  duplicate: (names) => {
    if (!names || names.length === 0) return '';
    if (names.length === 1) return `"${names[0]}" a fait chips!`;
    if (names.length === 2) return `"${names[0]}" et "${names[1]}" ont fait chips!`;
    const allButLast = names.slice(0, -1).map((n) => `"${n}"`).join(', ');
    const last = `"${names[names.length - 1]}"`;
    return `${allButLast} et ${last} ont fait chips!`;
  },
  offTopic: (name) => `"${name}" a utilisé un mot hors‑sujet`,
  gameOver: 'Game Over!',
};

const DELAY_CONFIG = {
  eliminationPopupMs: 2000, // temps du popup d'élimination (en ms)
  gameOverMs: 3500,         // délai avant le tableau de score final (en ms)
};

// Configuration générale des rooms : vieillissement et inactivité
const CONFIG = {
  ROOM_MAX_AGE_MS: 6 * 60 * 60 * 1000, // durée de vie maximale d'une room (6 heures)
  ROOM_IDLE_MS:    20 * 60 * 1000,     // durée d'inactivité avant fermeture (20 minutes)
};

module.exports = {
  MESSAGES,
  DELAY_CONFIG,
  CONFIG,
};

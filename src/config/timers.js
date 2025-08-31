/**
 * Configuration des timers
 *
 * Les durées des tours sont réparties en plages de niveaux. Plutôt que
 * d'encoder ces durées en dur au sein du code, on les expose ici afin
 * de pouvoir les modifier facilement sans avoir à parcourir toutes les
 * fonctions. Chaque entrée du tableau `levelRanges` définit un intervalle
 * [start, end] en niveaux inclusifs et les durées (en secondes) en début
 * et fin d'intervalle. Une interpolation linéaire est utilisée entre
 * start et end. Par exemple, pour l'intervalle {start:1, end:10, startSec:10,
 * endSec:8}, le niveau 1 durera 10 s, le niveau 10 durera 8 s et les
 * niveaux intermédiaires seront répartis de façon uniforme. Lorsque le
 * niveau est supérieur au dernier intervalle, la dernière valeur est
 * utilisée. La valeur `voteDurationMs` détermine la durée de la phase
 * d'invalidation (vote) après chaque tour. Vous pouvez ajuster ces
 * valeurs selon vos besoins.
 */

const TIMER_CONFIG = {
  levelRanges: [
    { start: 1, end: 10, startSec: 10, endSec: 8 },
    { start: 10, end: 15, startSec: 8, endSec: 6 },
    { start: 15, end: 20, startSec: 6, endSec: 4 },
  ],
  voteDurationMs: 2000,
};

/**
 * Calcule la durée d'un tour en fonction du niveau global. Les
 * premières manches démarrent à 10 s et décroissent jusqu'à 8 s au
 * niveau 10, puis 6 s au niveau 15 et enfin 4 s au niveau 20. Entre
 * ces seuils, une interpolation linéaire est utilisée. Au-delà du
 * niveau 20, la durée reste fixée à 4 s.
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

module.exports = {
  TIMER_CONFIG,
  getTurnDuration,
};

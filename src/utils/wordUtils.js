/**
 * Fonction utilitaire : normalise un mot en minuscule sans accent. Ceci
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
 * Produit un identifiant de fichier à partir d'un thème. Les espaces,
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
 * Génère plusieurs variantes d'un nom normalisé (singulier/pluriel)
 * pour augmenter les chances de trouver un fichier correspondant. Par
 * exemple, "pokemons" donnera aussi "pokemon" et vice‑versa.
 *
 * @param {string} norm Nom normalisé (accents et ponctuation retirés)
 * @returns {string[]} Liste de variantes possibles
 */
function nameVariants(norm) {
  const variants = new Set([norm]);
  // Si se termine par un « s », essayer sans « s »
  if (norm.endsWith("s")) variants.add(norm.slice(0, -1));
  // Si ne se termine pas par « s », essayer avec « s »
  else variants.add(norm + "s");
  // Cas particulier des mots en « x » (ex: jeux -> jeu)
  if (norm.endsWith("x")) variants.add(norm.slice(0, -1));
  // Cas simple: tenter en ajoutant « x » si absent
  if (!norm.endsWith("x")) variants.add(norm + "x");
  return Array.from(variants);
}

/**
 * Choisit un élément aléatoire dans un tableau. Utilisé pour le thème.
 *
 * @param {Array} arr Tableau d'éléments
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Génère un ensemble de lettres interdites (« punies ») en fonction du
 * niveau. À partir du niveau 10, des lettres aléatoires sont tirées :
 * 1 lettre aux niveaux 10‑12, 2 lettres aux niveaux 13‑15 et 3 lettres
 * aux niveaux 16‑20. Les lettres sont distinctes et choisies dans
 * l'alphabet latin (a‑z). Si le niveau est inférieur à 10, aucune
 * lettre n'est punie.
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

module.exports = {
  normalizeWord,
  normalizeKey,
  nameVariants,
  pickRandom,
  generatePunishedLetters,
};

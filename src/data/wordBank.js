const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeKey, nameVariants, normalizeWord } = require("../utils/wordUtils");

// Répertoire contenant les fichiers texte servant de banque de mots.
// Chaque fichier porte le nom d'un thème normalisé (voir normalizeKey). Le
// fichier « global.txt » est utilisé en dernier recours si le thème
// n'est pas trouvé.
const DATA_DIR = path.join(__dirname, "../../data");

// Cache pour ne charger les banques de mots qu'une seule fois par thème.
const wordBankCache = new Map();

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
 * portant le nom du thème normalisé (ex. « animaux.txt »). Si ce fichier
 * n'existe pas, il tente « global.txt » comme liste de secours. Chaque ligne
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

module.exports = {
  loadWordSetForTheme,
  DATA_DIR,
};

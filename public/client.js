(() => {
  /*
   * Script côté client pour Unique Word Game. Ce fichier gère la connexion
   * Socket.IO, l’interface utilisateur et les événements du jeu. Chaque
   * section est commentée pour expliquer son rôle et suggérer des pistes
   * d’amélioration. Par exemple, vous pouvez ajouter une auto‑complétion
   * des mots ou un chat entre joueurs.
   */
  // Establish Socket.IO connection
  const socket = io();
  // Local state
  let joined = false;
  let isHost = false;
  let iAmAlive = false;
  let lockedWord = null;
  let timerRaf = null;
  // DOM references
  const joinEl = document.getElementById('join');
  const nameInput = document.getElementById('name');
  const roomCodeInput = document.getElementById('roomCode');
  const joinBtn = document.getElementById('joinBtn');
  const lobbyEl = document.getElementById('lobby');
  const startBtn = document.getElementById('startBtn');
  const playersEl = document.getElementById('players');
  const usedWordsListEl = document.getElementById('usedWordsList');
  const roundEl = document.getElementById('round');
  const themeEl = document.getElementById('theme');
  const turnEl = document.getElementById('turn');
  const turnAreaEl = document.getElementById('turnArea');
  const wordInput = document.getElementById('word');
  const wordForm = document.getElementById('wordForm');
  const turnInfoEl = document.getElementById('turnInfo');
  const timerBar = document.getElementById('timerBar');
  const timerFill = document.getElementById('timerFill');
  // Références pour la barre de progression de vote
  const voteTimerEl = document.getElementById('voteTimer');
  const voteBar = voteTimerEl ? voteTimerEl.querySelector('.vote-bar') : null;
  const voteFill = voteTimerEl ? voteTimerEl.querySelector('.vote-fill') : null;
  const logEl = document.getElementById('log');
  const endOverlay = document.getElementById('endOverlay');
  const scoreTableEl = document.getElementById('scoreTable');
  const btnMenu = document.getElementById('btnMenu');
  const btnReplay = document.getElementById('btnReplay');

  // Références pour l’affichage des lettres punies (punies) à partir du niveau 10
  const punishedEl = document.getElementById('punished');
  const punishedLettersEl = document.getElementById('punishedLetters');
  // Titre des lettres punies/obligatoires (élément <h3> dans #punished)
  const punishedTitleEl = document.querySelector('#punished h3');

  // Zone d’élimination (KO) pour afficher les joueurs éliminés et leur raison
  const elimPopup = document.getElementById('elimPopup');

  // Indicateur qu'un pop‑up d'élimination est en cours d'affichage.
  // Utilisé pour retarder l'affichage du tableau des scores afin de
  // laisser le temps aux joueurs de lire les raisons d'élimination.
  let elimPopupActive = false;

  // Zone de vote pour signaler les mots hors‑sujet
  const voteAreaEl = document.getElementById('voteArea');

  // Soumissions et votes du tour courant
  let currentSubmissions = [];
  let votedTargets = new Set();
  // Variables pour l'animation de la barre de vote
  let voteTimerRaf = null;

  // Rejoindre le lobby quand l’utilisateur clique ou presse Entrée. Le code
  // de la room est lu dans l’input ou dans l’URL (?room=XXX). S’il est
  // absent, la room publique "public" est utilisée.
  joinBtn.addEventListener('click', doJoin);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doJoin();
    }
  });

  /**
   * Envoyé lorsqu’on tente de rejoindre une partie. On collecte le nom et
   * éventuellement un code de room. Si aucun code n’est saisi, on
   * récupère un paramètre "room" depuis l’URL (?room=xxxx) ou on
   * utilise "public" par défaut.
   */
  function doJoin() {
    const name = nameInput.value.trim() || 'Joueur';
    // Récupérer le code dans l’input ou l’URL
    let code = roomCodeInput.value.trim();
    if (!code) {
      const params = new URLSearchParams(window.location.search);
      code = params.get('room') || 'public';
    }
    // Envoyer un objet { name, code } au serveur. L’acknowledgement
    // renvoie ok et host (true si on est l’host).
    socket.emit('player:join', { name, code }, (res) => {
      if (res?.ok) {
        joined = true;
        isHost = !!res.host;
        joinEl.classList.add('hidden');
        lobbyEl.classList.remove('hidden');
        startBtn.classList.toggle('hidden', !isHost);
        appendLog(`✅ Connecté en tant que <b>${escapeHtml(name)}</b> dans la room <b>${escapeHtml(code)}</b>.`);
      }
    });
  }

  // Host starts a game
  startBtn.addEventListener('click', () => {
    socket.emit('game:start');
  });
  // Buttons on end overlay
  btnMenu.addEventListener('click', () => {
    socket.emit('game:menu');
  });
  btnReplay.addEventListener('click', () => {
    socket.emit('game:restart');
  });
  // Submit a word on form submit
  wordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (lockedWord) return;
    const word = wordInput.value.trim();
    if (!word) return;
    socket.emit('turn:submit', word);
  });

  // Handle lobby updates (player list, round info, host, accepting)
  socket.on('lobby:update', (data) => {
    const me = data.players.find((p) => p.id === socket.id);
    iAmAlive = !!(me && me.alive);
    isHost = data.hostId === socket.id;
    // Masquer le bouton Démarrer si on n’est pas host ou si une partie est en cours
    startBtn.classList.toggle('hidden', !(isHost && !data.gameActive));
    renderPlayers(data.players);
    roundEl.textContent = data.round;
    themeEl.textContent = data.theme || '-';
    turnEl.textContent = data.turn;
    // If the ack was lost, but we appear in player list, show lobby
    if (!joined && me) {
      joined = true;
      joinEl.classList.add('hidden');
      lobbyEl.classList.remove('hidden');
    }
    // Disable input if not alive or not accepting submissions
    wordInput.disabled = !iAmAlive || !data.accepting;
    // Hide turn area if no round is active
    turnAreaEl.classList.toggle('hidden', !data.theme);
  });

  // Round start: announce theme and round
  socket.on('round:start', ({ round, theme }) => {
    appendLog(`<b>Round ${round}</b> — Thème: <b>${escapeHtml(theme)}</b>`);
    lockedWord = null;
    wordInput.value = '';
    wordInput.disabled = !iAmAlive;
    turnInfoEl.textContent = '';
    usedWordsListEl.innerHTML = '';
    turnAreaEl.classList.remove('hidden');
    endOverlay.classList.add('hidden');
    // Réinitialiser la zone de vote
    voteAreaEl.classList.add('hidden');
    voteAreaEl.innerHTML = '';
    // Masquer les lettres punies au début d'un nouveau round
    punishedEl.classList.add('hidden');
    punishedLettersEl.textContent = '';
    // Masquer et réinitialiser la zone d’élimination
    if (elimPopup) {
      elimPopup.classList.add('hidden');
      elimPopup.innerHTML = '';
    }
    // Arrêter la barre de vote lorsque le round commence
    stopVoteTimer();
  });

  // Turn start : reset, afficher le timer et les lettres punies/obligatoires. Le serveur
  // transmet également punishedLetters et letterRuleType lorsque le niveau le permet.
  socket.on('turn:start', ({ turn, turnMs, punishedLetters, letterRuleType }) => {
    turnEl.textContent = turn;
    lockedWord = null;
    turnInfoEl.textContent = '';
    // Préparer l’input selon qu’on est vivant ou non
    if (iAmAlive) {
      wordInput.disabled = false;
      wordInput.value = '';
      wordInput.focus();
    } else {
      wordInput.disabled = true;
      wordInput.value = '';
    }
    // Afficher la durée du tour dans le log
    appendLog(`⏱️ Tour ${turn} — ${(turnMs / 1000).toFixed(1)}s`);
    startTimer(turnMs);
    // Masquer la zone de vote en début de tour
    voteAreaEl.classList.add('hidden');
    voteAreaEl.innerHTML = '';
    // Mettre à jour l’affichage des lettres punies ou obligatoires. On adapte
    // le titre et la couleur selon letterRuleType. Si aucune lettre, on masque.
    if (punishedLetters && punishedLetters.length) {
      punishedEl.classList.remove('hidden');
      const type = letterRuleType === 'require' ? 'require' : 'forbid';
      if (punishedTitleEl) {
        punishedTitleEl.textContent = (type === 'require') ? 'Lettres Obligatoires :' : 'Lettres Bannies :';
        punishedTitleEl.style.color = (type === 'require') ? '#1db954' : '';
      }
      punishedLettersEl.style.color = (type === 'require') ? '#1db954' : '';
      punishedLettersEl.textContent = punishedLetters.map((c) => c.toUpperCase()).join(' ');
    } else {
      punishedEl.classList.add('hidden');
      punishedLettersEl.textContent = '';
    }
    // Cacher et réinitialiser le pop‑up d’élimination au début du tour
    if (elimPopup) {
      elimPopup.classList.add('hidden');
      elimPopup.innerHTML = '';
    }
    // Stop vote timer at the beginning of a turn (phase de vote terminée)
    stopVoteTimer();
  });

  // Acknowledgement of a word submission locks it
  socket.on('turn:ack', ({ lockedWord: word }) => {
    if (word) {
      lockedWord = word;
      wordInput.value = word;
      wordInput.disabled = true;
      turnInfoEl.textContent = 'Mot verrouillé. Révélation à la fin du timer.';
    }
  });
  // Error feedback for duplicate/invalid words
  socket.on('turn:error', ({ message }) => {
    turnInfoEl.textContent = `⚠️ ${escapeHtml(message)}`;
  });
  // Show how many have submitted
  socket.on('turn:progress', ({ submitted }) => {
    turnInfoEl.textContent = `${submitted} joueur(s) ont soumis.`;
  });
  // Turn end: reveal submissions and elimination results
  socket.on('turn:end', ({ submissions, eliminated, usedWords, voteDurationMs }) => {
    // Arrêter la barre de tour
    stopTimer();
    // Réinitialiser et démarrer la barre de vote avec la durée fournie
    if (voteDurationMs) startVoteTimer(voteDurationMs);
    const lines = submissions.map((s) => {
      const elim = eliminated.includes(s.id);
      return `${escapeHtml(s.name)} → <code>${escapeHtml(s.word)}</code> ${elim ? '❌' : '✅'}`;
    }).join('<br>');
    appendLog(lines || '(Aucune soumission)');
    renderUsedWords(usedWords);
    wordInput.disabled = true;
    // Préparer la phase de vote : stocker les soumissions et réinitialiser le suivi des votes.
    currentSubmissions = submissions;
    votedTargets = new Set();
    // Afficher ou masquer la zone de vote selon si on est vivant
    if (iAmAlive) {
      renderVoteArea(submissions);
      voteAreaEl.classList.remove('hidden');
    } else {
      voteAreaEl.classList.add('hidden');
      voteAreaEl.innerHTML = '';
    }
    // Masquer la zone d’élimination une fois que la phase de vote commence
    if (elimPopup) {
      elimPopup.classList.add('hidden');
      elimPopup.innerHTML = '';
    }
  });
  // Round end: announce winner if any
  socket.on('round:end', ({ winner, round }) => {
    if (winner) {
      appendLog(`🏆 <b>${escapeHtml(winner.name)}</b> gagne le round ${round}!`);
    } else {
      appendLog('⚠️ Tout le monde a été éliminé.');
    }
    // Cacher la zone de vote à la fin d’un round
    voteAreaEl.classList.add('hidden');
    voteAreaEl.innerHTML = '';
    // Masquer les lettres punies en fin de round
    punishedEl.classList.add('hidden');
    punishedLettersEl.textContent = '';
    // Masquer la zone d’élimination en fin de round
    if (elimPopup) {
      elimPopup.classList.add('hidden');
      elimPopup.innerHTML = '';
    }
    // Arrêter la barre de vote en fin de round
    stopVoteTimer();
  });
  // Game end: display scoreboard overlay. On attend la fin d'un éventuel
  // pop‑up d’élimination avant d'afficher le tableau, afin que les joueurs
  // aient le temps de lire les raisons d’élimination.
  socket.on('game:end', (data) => {
    const showGameEnd = () => {
      const { winner, round, scores } = data;
      endOverlay.classList.remove('hidden');
      // Construire le tableau des scores
      let html = '<table class="scoreTable"><thead><tr><th>Joueur</th><th>Score</th></tr></thead><tbody>';
      scores.forEach((s) => {
        html += `<tr><td>${escapeHtml(s.name)}${s.online ? '' : ' <span class="muted">(hors-ligne)</span>'}</td><td>${s.score}</td></tr>`;
      });
      html += '</tbody></table>';
      scoreTableEl.innerHTML = html;
      // Cacher la zone de vote en fin de partie
      voteAreaEl.classList.add('hidden');
      voteAreaEl.innerHTML = '';
      // Cacher également les lettres punies
      punishedEl.classList.add('hidden');
      punishedLettersEl.textContent = '';
      // Cacher la zone d’élimination en fin de partie
      if (elimPopup) {
        elimPopup.classList.add('hidden');
        elimPopup.innerHTML = '';
      }
      // Afficher les boutons Menu/Replay uniquement pour l'host
      btnMenu.classList.toggle('hidden', !isHost);
      btnReplay.classList.toggle('hidden', !isHost);
      // Arrêter la barre de vote en fin de partie
      stopVoteTimer();
    };
    // S'il y a un pop‑up d’élimination en cours, attendre qu'il disparaisse
    // avant d'afficher le tableau des scores. La durée (2000 ms) doit
    // correspondre à celle définie pour l'auto‑masquage du pop‑up.
    if (elimPopupActive) {
      setTimeout(showGameEnd, 2000);
    } else {
      showGameEnd();
    }
  });
  // Host sends players back to menu: hide overlay and turn area
  socket.on('game:menu', () => {
    endOverlay.classList.add('hidden');
    turnAreaEl.classList.add('hidden');
    // Masquer la zone de vote
    voteAreaEl.classList.add('hidden');
    voteAreaEl.innerHTML = '';
    // Masquer les lettres punies
    punishedEl.classList.add('hidden');
    punishedLettersEl.textContent = '';
    // Masquer la zone d’élimination
    if (elimPopup) {
      elimPopup.classList.add('hidden');
      elimPopup.innerHTML = '';
    }
    // Arrêter la barre de vote au retour au menu
    stopVoteTimer();
  });
  // Display errors for game start/restart
  socket.on('game:error', ({ message }) => {
    appendLog(`⚠️ ${escapeHtml(message)}`);
  });

  /**
   * Affiche la zone de vote avec un bouton « Signaler » pour chaque mot.
   * Les joueurs vivants peuvent voter contre les mots d’autres joueurs.
   * Une fois qu’un vote est envoyé, le bouton est désactivé localement.
   *
   * @param {Array} submissions Liste des soumissions {id, name, word}
   */
  function renderVoteArea(submissions) {
    // Construire les lignes HTML de vote. On évite de voter contre soi‑même.
    const rows = submissions.map((sub) => {
      const isMine = sub.id === socket.id;
      const alreadyVoted = votedTargets.has(sub.id);
      const disabled = isMine || alreadyVoted || !iAmAlive;
      // Bouton affiché : un checkmark pour signaler. On utilise une croix si le bouton est désactivé.
      const label = disabled ? '❌' : '✅';
      const btnHtml = `<button data-target="${sub.id}" ${disabled ? 'disabled' : ''}>${label}</button>`;
      return `<div class="vote-row">${escapeHtml(sub.name)} → <code>${escapeHtml(sub.word)}</code>${btnHtml}</div>`;
    }).join('');
    voteAreaEl.innerHTML = rows;
    // Ajouter des écouteurs de clic aux boutons
    voteAreaEl.querySelectorAll('button[data-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-target');
        // Vérifier conditions locales avant d'émettre
        if (!votedTargets.has(target) && iAmAlive && target !== socket.id) {
          votedTargets.add(target);
          socket.emit('turn:vote', { target });
          // Désactiver et changer le label en croix
          btn.disabled = true;
          btn.textContent = '❌';
        }
      });
    });
  }

  /**
   * Réception d'une élimination par vote. Le serveur envoie les ids
   * des joueurs disqualifiés. On met à jour l’état local, on affiche
   * un message et on désactive l'input si nous sommes éliminé.
   */
  socket.on('vote:eliminated', ({ ids }) => {
    ids.forEach((id) => {
      // Trouver la soumission correspondante pour récupérer le nom
      const sub = currentSubmissions.find((s) => s.id === id);
      if (sub) {
        appendLog(`⚠️ ${escapeHtml(sub.name)} est disqualifié pour mot hors‑sujet.`);
      }
      if (id === socket.id) {
        iAmAlive = false;
        wordInput.disabled = true;
      }
    });
    // Cacher la zone de vote après élimination pour éviter les votes tardifs
    voteAreaEl.classList.add('hidden');
    voteAreaEl.innerHTML = '';
    // Arrêter la barre de vote lorsque les éliminations sont prononcées
    stopVoteTimer();
  });

  /**
   * Gestion de la fermeture d’une room côté client. Le serveur émet
   * room:closed lorsque la room est supprimée (vidée, trop vieille ou
   * inactive). On affiche un message et on réinitialise l’interface en
   * remettant le joueur sur l’écran de connexion.
   */
  socket.on('room:closed', ({ reason }) => {
    appendLog(`⚠️ La room a été fermée (${escapeHtml(reason)}). Vous retournez à l'accueil.`);
    // Réinitialiser l’UI
    lobbyEl.classList.add('hidden');
    endOverlay.classList.add('hidden');
    joinEl.classList.remove('hidden');
    // Réinitialiser les champs
    lockedWord = null;
    iAmAlive = false;
    isHost = false;
    joined = false;
    wordInput.value = '';
    nameInput.value = '';
    roomCodeInput.value = '';
    playersEl.innerHTML = '';
    usedWordsListEl.innerHTML = '';
    roundEl.textContent = '0';
    themeEl.textContent = '-';
    turnEl.textContent = '0';
    logEl.innerHTML = '';
    // Réinitialiser la zone d’élimination
    if (elimPopup) {
      elimPopup.classList.add('hidden');
      elimPopup.innerHTML = '';
    }
  });

  /**
   * Réception d’un pop‑up d’élimination. Le serveur envoie soit une liste
   * d’« eliminations » (cas des joueurs n’ayant pas soumis ou ayant
   * doublonné), soit une liste d’« events » (cas des votes hors‑sujet).
   * On construit une liste de lignes affichant pour chaque joueur son
   * nom et la raison de son élimination. Cette zone est distincte du
   * journal des logs afin d’être bien visible. Elle s’efface après un
   * court délai pour permettre la poursuite du jeu.
   */
  socket.on('elim:popup', (data) => {
    if (!elimPopup) return;
    let html = '';
    // Cas des éliminations simples
    if (data && Array.isArray(data.eliminations)) {
      html = data.eliminations.map((item) => {
        let reasonText = '';
        if (item.reason === 'noSubmission') {
          reasonText = "n'a pas écrit de mot à temps";
        } else if (item.reason === 'duplicate') {
          reasonText = 'a fait Chips';
        } else {
          // Par défaut, considérer que c'est un mot hors‑sujet
          reasonText = 'mot hors‑sujet';
        }
        return `<div class="elim-row"><strong>${escapeHtml(item.name)}</strong> — ${escapeHtml(reasonText)}</div>`;
      }).join('');
    } else if (data && Array.isArray(data.events)) {
      // Cas des éliminations par vote : chaque event contient une liste de players
      html = data.events.map((ev) => {
        return ev.players.map((pl) => {
          const reasonText = 'mot hors‑sujet';
          return `<div class="elim-row"><strong>${escapeHtml(pl.name)}</strong> — ${escapeHtml(reasonText)}</div>`;
        }).join('');
      }).join('');
    }
    if (html) {
      elimPopup.innerHTML = html;
      elimPopup.classList.remove('hidden');
      // Marquer le pop‑up comme actif. Il sera désactivé après un court délai.
      elimPopupActive = true;
      // Auto‑masquage après un délai (synchronisé avec DELAY_CONFIG.eliminationPopupMs)
      setTimeout(() => {
        elimPopup.classList.add('hidden');
        elimPopup.innerHTML = '';
        elimPopupActive = false;
      }, 2000);
    }
  });

  /**
   * Render the list of players with their status and scores.
   * @param {Array} players
   */
  function renderPlayers(players) {
    const rows = players.map((p) => {
      const tag = p.id === socket.id ? ' (toi)' : '';
      const status = p.alive ? 'alive' : 'dead';
      const offline = p.online ? '' : ' <span class="muted">(hors-ligne)</span>';
      return `<div class="player ${status}"><span>• ${escapeHtml(p.name)}${tag}${offline}</span><span>${p.score} pts</span></div>`;
    }).join('');
    playersEl.innerHTML = rows || '<em>Aucun joueur…</em>';
  }
  /**
   * Render the list of used words in the current round.
   * @param {Array} words
   */
  function renderUsedWords(words) {
    usedWordsListEl.innerHTML = (words && words.length)
      ? words.map((w) => `<code>${escapeHtml(w)}</code>`).join(' ')
      : '<em>Aucun pour le moment</em>';
  }
  /**
   * Start a visual timer for the given duration. Uses requestAnimationFrame
   * so the fill bar animates smoothly.
   * @param {number} ms
   */
  function startTimer(ms) {
    const start = performance.now();
    const end = start + ms;
    timerFill.style.transition = 'none';
    timerFill.style.width = '0%';
    function frame(now) {
      const t = Math.min(1, (now - start) / ms);
      timerFill.style.width = `${Math.round(t * 100)}%`;
      timerFill.style.transition = 'width linear';
      if (now < end) {
        timerRaf = requestAnimationFrame(frame);
      }
    }
    timerRaf = requestAnimationFrame(frame);
  }
  /**
   * Stop and reset the timer bar.
   */
  function stopTimer() {
    timerFill.style.width = '0%';
    if (timerRaf) {
      cancelAnimationFrame(timerRaf);
      timerRaf = null;
    }
  }

  /**
   * Démarre la barre de vote pour la phase de signalement.
   * @param {number} ms Durée en millisecondes du vote
   */
  function startVoteTimer(ms) {
    if (!voteTimerEl || !voteFill) return;
    // Réinitialiser l'état visuel et afficher la barre
    voteFill.style.transition = 'none';
    voteFill.style.width = '0%';
    voteTimerEl.classList.remove('hidden');
    const start = performance.now();
    const end = start + ms;
    function frame(now) {
      const t = Math.min(1, (now - start) / ms);
      voteFill.style.width = `${Math.round(t * 100)}%`;
      voteFill.style.transition = 'width linear';
      if (now < end) {
        voteTimerRaf = requestAnimationFrame(frame);
      }
    }
    voteTimerRaf = requestAnimationFrame(frame);
  }

  /**
   * Arrête et masque la barre de vote.
   */
  function stopVoteTimer() {
    if (!voteTimerEl || !voteFill) return;
    voteFill.style.width = '0%';
    if (voteTimerRaf) {
      cancelAnimationFrame(voteTimerRaf);
      voteTimerRaf = null;
    }
    voteTimerEl.classList.add('hidden');
  }
  /**
   * Append an HTML string to the log area.
   * @param {string} html
   */
  function appendLog(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
  /**
   * Escape HTML entities for safe rendering.
   * @param {string} str
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
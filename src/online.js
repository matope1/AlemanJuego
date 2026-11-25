import { ONLINE_CONFIGURED, SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase-config.js';

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]);
export function rankOnlinePlayers(players = []) {
  const ordered = [...players].sort((a, b) => b.score - a.score);
  const winningScore = ordered[0]?.score;
  return { ordered, winners: ordered.filter(player => player.score === winningScore), winningScore };
}

export class OnlineRoomController {
  constructor({ onClose = () => {}, onToast = () => {} } = {}) {
    this.onClose = onClose;
    this.onToast = onToast;
    this.client = null;
    this.room = null;
    this.roomId = null;
    this.busy = false;
    this.timer = null;
    this.channel = null;
    this.root = $('#online-content');
    this.root.addEventListener('click', event => this.handleClick(event));
    this.root.addEventListener('submit', event => this.handleSubmit(event));
    $('#online-close').addEventListener('click', () => this.close());
    this.renderHome();
  }

  async ensureClient() {
    if (!ONLINE_CONFIGURED) throw new Error('Falta configurar Supabase. Sigue los pasos de README.md.');
    if (!this.client) {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      this.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      const { data: { session }, error } = await this.client.auth.getSession();
      if (error) throw error;
      if (!session) {
        const { error: signInError } = await this.client.auth.signInAnonymously();
        if (signInError) throw signInError;
      }
    }
    return this.client;
  }

  renderHome(message = '') {
    const configured = ONLINE_CONFIGURED;
    this.root.innerHTML = `<div class="online-heading"><div class="eyebrow">UNA PARTIDA, CUATRO MÓVILES</div><h1>El pique se<br><em>comparte.</em></h1><p>Juega en tiempo real con tu gente. Hasta cuatro personas, mismas palabras, carrera por la racha.</p></div>
      ${!configured ? `<div class="setup-notice"><span>⌁</span><div><b>El modo online necesita una conexión a Supabase</b><small>La partida individual funciona ya. Configura las claves y ejecuta la migración siguiendo README.md.</small></div></div>` : ''}
      <div class="online-forms"><form class="online-panel" data-form="create"><div class="online-panel-icon">＋</div><div class="eyebrow">TÚ PONES LA SALA</div><h2>Crea una partida</h2><label>Tu nombre<input name="name" maxlength="18" required placeholder="Lena" autocomplete="nickname"></label><div class="online-form-row"><label>Preguntas<select name="length"><option>10</option><option selected>20</option><option>30</option><option>50</option></select></label><label>Segundos por ronda<select name="seconds"><option>10</option><option selected>15</option><option>20</option><option>30</option></select></label></div><button class="start-button" type="submit" ${configured ? '' : 'disabled'}>Crear sala privada <span>→</span></button><small class="online-hint">Comparte el código de 6 letras con 1–3 amigos.</small></form>
      <form class="online-panel" data-form="join"><div class="online-panel-icon join-icon">↗</div><div class="eyebrow">YA TIENES CÓDIGO</div><h2>Únete a una sala</h2><label>Tu nombre<input name="name" maxlength="18" required placeholder="Lena" autocomplete="nickname"></label><label>Código de la sala<input name="code" maxlength="6" required placeholder="AB3K9Q" autocomplete="off" autocapitalize="characters" class="room-code-input"></label><button class="secondary-start" type="submit" ${configured ? '' : 'disabled'}>Entrar en la sala <span>→</span></button><small class="online-hint">Las salas privadas admiten hasta 4 personas.</small></form></div>
      ${message ? `<div class="online-error" role="alert">${escapeHtml(message)}</div>` : ''}<p class="online-footnote">Entras sin correo ni contraseña con una identidad temporal del dispositivo.</p>`;
  }

  async open() {
    const savedCode = localStorage.getItem('brava-online-room');
    if (!savedCode || !ONLINE_CONFIGURED) return this.renderHome();
    try {
      await this.ensureClient();
      this.roomCode = savedCode;
      await this.refreshState();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.refreshState(), 3000);
    } catch (error) {
      this.roomCode = savedCode;
      this.renderHome(`No se pudo recuperar la sala; conserva el código ${savedCode} e inténtalo de nuevo. ${error.message}`);
    }
  }

  async handleSubmit(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    if (this.busy) return;
    this.busy = true;
    const values = new FormData(form);
    const name = String(values.get('name') || '').trim();
    try {
      const client = await this.ensureClient();
      if (form.dataset.form === 'create') {
        const { data, error } = await client.rpc('brava_create_room', { p_display_name: name, p_question_count: Number(values.get('length')), p_turn_seconds: Number(values.get('seconds')) });
        if (error) throw error;
        await this.enterRoom(data.code);
      } else {
        const code = String(values.get('code') || '').replace(/\s/g, '').toUpperCase();
        const { data, error } = await client.rpc('brava_join_room', { p_code: code, p_display_name: name });
        if (error) throw error;
        await this.enterRoom(data.code);
      }
    } catch (error) { this.renderHome(error.message); }
    finally { this.busy = false; }
  }

  async enterRoom(code) {
    localStorage.setItem('brava-online-room', code);
    this.roomCode = code;
    clearInterval(this.timer);
    if (this.channel) await this.client.removeChannel(this.channel);
    this.channel = null;
    this.roomId = null;
    await this.refreshState();
    this.timer = setInterval(() => this.refreshState(), 3000);
  }

  setupRealtime() {
    if (!this.client || !this.roomId) return;
    if (this.channel) this.client.removeChannel(this.channel);
    this.channel = this.client.channel(`brava-room:${this.roomId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brava_rooms', filter: `id=eq.${this.roomId}` }, () => this.refreshState())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brava_players', filter: `room_id=eq.${this.roomId}` }, () => this.refreshState())
      .subscribe();
  }

  async refreshState() {
    if (!this.client || !this.roomCode || this.refreshing) return;
    this.refreshing = true;
    try {
      const { data, error } = await this.client.rpc('brava_room_state', { p_code: this.roomCode });
      if (error) throw error;
      this.room = data;
      this.roomId = data.id;
      if (!this.channel) this.setupRealtime();
      this.renderRoom();
    } catch (error) {
      if (this.roomCode && !this.root.querySelector('.online-error')) this.renderConnectionError(error.message);
    } finally { this.refreshing = false; }
  }

  renderRoom() {
    if (!this.room) return;
    const room = this.room;
    const players = room.players || [];
    const me = players.find(player => player.is_me);
    const onlineCount = players.filter(player => player.is_connected).length;
    const header = `<div class="room-topline"><div class="eyebrow">SALA PRIVADA · ${escapeHtml(room.code)}</div><button data-action="copy" class="copy-code">Copiar código ↗</button></div>`;
    if (room.phase === 'waiting') {
      this.root.innerHTML = `${header}<div class="room-waiting"><div class="room-art">♧<span>✳</span></div><div class="eyebrow">SALA DE ESPERA</div><h1>Que llegue<br><em>la pandilla.</em></h1><p>${onlineCount < 2 ? 'En cuanto llegue otra persona, podréis empezar.' : 'Ya podéis empezar cuando queráis.'} Código para invitar:</p><button class="big-room-code" data-action="copy">${escapeHtml(room.code)} <span>⧉</span></button><div class="roster"><div class="roster-head"><b>EN LA SALA</b><span>${onlineCount} / 4 conectados</span></div>${players.map((player,index)=>`<div class="roster-player"><span class="player-avatar avatar-${index % 4}">${escapeHtml(player.display_name.charAt(0).toLocaleUpperCase())}</span><b>${escapeHtml(player.display_name)}${player.is_me?' <small>(tú)</small>':''}</b>${player.is_host?'<span class="host-pill">ANFITRIÓN</span>':''}<i class="connection-dot ${player.is_connected?'':'is-offline'}"></i></div>`).join('')}</div>${me?.is_host?`<button class="start-button room-start" data-action="start" ${onlineCount<2?'disabled':''}>Empezar partida <span>→</span></button>`:`<div class="waiting-message"><span class="waiting-pulse"></span> Esperando a que el anfitrión empiece</div>`}<button class="text-action" data-action="leave">Salir de la sala</button></div>`;
      return;
    }
    const seconds = room.deadline_at ? Math.max(0, Math.ceil((new Date(room.deadline_at).getTime() - Date.now())/1000)) : 0;
    if (room.phase === 'question') {
      this.root.innerHTML = `${header}<div class="online-game-meta"><div><span>PREGUNTA ${room.question_no} / ${room.question_count}</span><div class="online-progress"><i style="width:${(room.question_no-1)/room.question_count*100}%"></i></div></div><div class="online-clock ${seconds<=5?'clock-urgent':''}">◷ <b>${seconds}</b><small>s</small></div><div class="online-points">✳ <b>${me?.score||0}</b><small>pts</small></div></div><div class="online-question"><div class="eyebrow">${escapeHtml(room.category||'VOCABULARIO').toLocaleUpperCase()}</div><h1>${escapeHtml(room.current_word)}</h1><p>¿Qué artículo lleva?</p></div>${room.my_answered?`<div class="answer-wait"><span class="waiting-pulse"></span> Respuesta enviada. Esperando a los demás (${room.answered_count}/${onlineCount})</div>`:`<div class="answer-buttons online-answer-buttons"><button class="answer-button answer-der" data-action="answer" data-article="der"><span class="answer-symbol">◆</span><b>DER</b><small>masculino</small></button><button class="answer-button answer-die" data-action="answer" data-article="die"><span class="answer-symbol">●</span><b>DIE</b><small>femenino</small></button><button class="answer-button answer-das" data-action="answer" data-article="das"><span class="answer-symbol">■</span><b>DAS</b><small>neutro</small></button></div>`}<div class="online-roster-strip">${players.map(player=>`<div class="online-player-chip ${player.is_me?'mine':''}"><i class="connection-dot ${player.is_connected?'':'is-offline'}"></i>${escapeHtml(player.display_name)}<b>${player.score}</b>${player.is_me&&player.streak>1?`<small>🔥 ${player.streak}</small>`:''}</div>`).join('')}</div><button class="text-action" data-action="leave">Salir de la sala</button>`;
      return;
    }
    if (room.phase === 'reveal') {
      const correctPlayers = players.filter(player=>player.last_answer_correct);
      this.root.innerHTML = `${header}<div class="round-reveal"><div class="eyebrow">${room.question_no} / ${room.question_count} · RESULTADO DE RONDA</div><h1>${escapeHtml(room.correct_article?.toLocaleUpperCase())} <span>${escapeHtml(room.current_word)}</span></h1><p>${escapeHtml(room.translation)}</p><div class="round-cheer">${correctPlayers.length===players.length?'¡Todos lo clavaron!':`${correctPlayers.length} de ${players.length} ${correctPlayers.length===1?'acertó':'acertaron'}`}</div><div class="round-results">${players.map(player=>`<div class="round-result-row"><span class="player-avatar avatar-${players.indexOf(player)%4}">${escapeHtml(player.display_name.charAt(0).toLocaleUpperCase())}</span><b>${escapeHtml(player.display_name)}${player.is_me?' <small>(tú)</small>':''}</b><span class="round-answer ${player.last_answer_correct?'answer-good':'answer-bad'}">${player.last_answer_correct?'✓':'×'} ${player.last_answer_correct?'¡Correcto!':player.last_answer_article?`Puso ${escapeHtml(player.last_answer_article.toLocaleUpperCase())}`:'Se acabó el tiempo'}</span><strong class="round-points ${player.last_answer_points?'':'zero-points'}">+${player.last_answer_points||0}</strong></div>`).join('')}</div><div class="next-round-note"><span class="waiting-pulse"></span> Siguiente pregunta en breve</div></div>`;
      return;
    }
    if (room.phase === 'finished') {
      const { ordered, winners, winningScore: winnerScore } = rankOnlinePlayers(players);
      this.root.innerHTML = `${header}<div class="online-finished"><div class="winner-cup">✳</div><div class="eyebrow">PARTIDA TERMINADA</div><h1>${winners.length===1?`¡${escapeHtml(winners[0].display_name)} gana!`:'¡Empate!'}</h1><p>${winners.length>1?winners.map(p=>escapeHtml(p.display_name)).join(' y '):'Menuda partida. ¿Otra ronda?'}</p><div class="leaderboard">${ordered.map((player,index)=>`<div class="leader-row ${player.score===winnerScore?'top-player':''}"><span class="rank">${index===0?'✦':`0${index+1}`}</span><b>${escapeHtml(player.display_name)}${player.is_me?' <small>(tú)</small>':''}</b><span>${player.correct_count} ✓ · ${player.wrong_count} ×</span><strong>${player.score}<small> pts</small></strong></div>`).join('')}</div><div class="individual-recap"><b>PARA REPASAR</b><div>${[...new Set(me?.wrong_words||[])].slice(0,10).map(word=>`<span>${escapeHtml(word)}</span>`).join('')||'¡No tienes palabras pendientes de repaso!'}</div></div><button class="start-button" data-action="home">Volver al inicio <span>→</span></button></div>`;
    }
  }

  async handleClick(event) {
    const button=event.target.closest('[data-action]');
    if(!button)return;
    const action=button.dataset.action;
    try {
      if(action==='copy') {
        const invite=`¡Juega conmigo a Deutsch Brava! Código de sala: ${this.roomCode}`;
        if(navigator.share) await navigator.share({title:'Deutsch Brava',text:invite});
        else { await navigator.clipboard.writeText(this.roomCode); this.onToast('Código copiado. ¡Pásalo a tus amigos!'); }
      }
      if(action==='start') {button.disabled=true;const {error}=await this.client.rpc('brava_start_room',{p_code:this.roomCode});if(error)throw error;await this.refreshState();}
      if(action==='answer') {button.disabled=true;this.root.querySelectorAll('[data-action="answer"]').forEach(item=>item.disabled=true);const {error}=await this.client.rpc('brava_submit_answer',{p_code:this.roomCode,p_article:button.dataset.article});if(error)throw error;await this.refreshState();}
      if(action==='leave') {if(confirm('¿Salir de la sala?')){await this.leaveRoom();this.renderHome();}}
      if(action==='home') {await this.leaveRoom();this.close();}
    } catch(error) {this.onToast(error.message);await this.refreshState();}
  }

  close() {
    clearInterval(this.timer);
    if(this.channel&&this.client)this.client.removeChannel(this.channel);
    this.channel=null;this.onClose();
  }

  async leaveRoom() {
    if(this.client&&this.roomCode) await this.client.rpc('brava_leave_room',{p_code:this.roomCode});
    clearInterval(this.timer);
    if(this.channel&&this.client)await this.client.removeChannel(this.channel);
    localStorage.removeItem('brava-online-room');this.room=null;this.roomId=null;this.roomCode=null;this.channel=null;
  }

  renderConnectionError(message) {
    if(!this.room)return this.renderHome(message);
    this.root.insertAdjacentHTML('afterbegin',`<div class="online-error" role="alert">Conexión interrumpida. Reconectando… ${escapeHtml(message)}</div>`);
  }
}

// --- CONFIGURAÇÃO PWA & WAKE LOCK ---
let wakeLock = null;
document.addEventListener('click', async () => {
	if (!wakeLock && navigator.wakeLock) {
		try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { }
	}
}, { once: true });

// --- AUDIO ENGINE PROFISSIONAL ---
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let audioBuffer = null;
let sourceNode = null;	   // O som que está tocando
let nextSourceNode = null;   // O som agendado (para troca perfeita)
let gainNode = audioCtx.createGain();
gainNode.connect(audioCtx.destination);

// --- ESTADO ---
let isPlaying = false;
let startTime = 0;	   // Momento zero do audioContext
let pausedAt = 0;		// Onde parou (segundos)
let loopEnabled = false;

let playlist = [], currentSong = null, sections = [];
let currentSectionIndex = -1, nextSectionIndex = -1;
let animId;
let isScheduled = false; // Trava de segurança para agendamento

const offcanvas = new bootstrap.Offcanvas('#menu');

// --- CARREGAMENTO ---
document.getElementById('folder-input').addEventListener('change', async (e) => {
	const files = Array.from(e.target.files);
	// Aceita mp3, wav, ogg e m4a
	const audioFiles = files.filter(f => f.name.toLowerCase().match(/\.(mp3|wav|ogg|m4a)$/));
	const jsonFiles = files.filter(f => f.name.toLowerCase().endsWith('.json'));
	playlist = [];

	for (let audio of audioFiles) {
		const baseName = audio.name.substring(0, audio.name.lastIndexOf('.'));
		const match = jsonFiles.find(j => j.name.substring(0, j.name.lastIndexOf('.')) === baseName);
		if (match) {
			try {
				const data = JSON.parse(await match.text());
				playlist.push({ 
					name: data.title || baseName, 
					audioFile: audio, 
					sections: data.sections.sort((a, b) => a.time - b.time) 
				});
			} catch (e) { console.error("Erro JSON:", e); }
		}
	}
	renderPlaylist();
	offcanvas.hide();
});

function renderPlaylist() {
	const list = document.getElementById('song-list');
	if (playlist.length === 0) { list.innerHTML = '<div class="p-4 text-center text-muted">Nenhum par (Audio + JSON) encontrado.</div>'; return; }
	document.getElementById('empty-state').classList.add('d-none');

	list.innerHTML = playlist.map((s, i) => `
		<button class="list-group-item list-group-item-action song-item py-3" onclick="loadSong(${i})">
			<div class="fw-bold">${s.name}</div>
		</button>
	`).join('');
}

async function loadSong(i) {
	stopAudio();
	currentSong = playlist[i];
	sections = currentSong.sections;
	
	// Feedback visual imediato
	document.getElementById('song-title').innerText = currentSong.name;
	document.getElementById('loader').classList.remove('d-none');
	document.getElementById('btn-play').disabled = true;
	document.getElementById('ready').classList.add('d-none');
	
	document.querySelectorAll('.song-item').forEach(el => el.classList.remove('active-song'));
	document.querySelectorAll('.song-item')[i].classList.add('active-song');

	try {
		const buffer = await currentSong.audioFile.arrayBuffer();
		// AQUI ESTAVA O ERRO GENÉRICO. Agora tratamos melhor.
		audioBuffer = await audioCtx.decodeAudioData(buffer);
		
		document.getElementById('loader').classList.add('d-none');
		document.getElementById('ready').classList.remove('d-none');
		document.getElementById('btn-play').disabled = false;
		
		renderGrid();
		
		// Prepara para tocar do início (sem dar play)
		currentSectionIndex = 0;
		pausedAt = sections[0].time;
		updateTimerVisual(pausedAt);
		updateButtonStyles();
		
		offcanvas.hide();

	} catch (e) { 
		// ALERTA DE ERRO MELHORADO
		document.getElementById('loader').classList.add('d-none');
		alert("ERRO CRÍTICO: Não foi possível ler o áudio.\n\nMotivo: " + e.message + "\n\nVerifique se o arquivo está corrompido.");
		console.error(e);
	}
}

function renderGrid() {
	document.getElementById('sections-grid').innerHTML = sections.map((s, i) => `
		<button class="section-btn" id="sec-btn-${i}" onclick="scheduleSection(${i})">${s.label}</button>
	`).join('');
}

// --- ENGINE DE PLAYBACK (ZERO ATRASO) ---

function playAudio(offset, when = 0) {
	// Se 'when' for 0, toca AGORA. Se for maior que 0, agenda para o futuro.
	const startTimeAbs = (when === 0) ? audioCtx.currentTime : when;

	const source = audioCtx.createBufferSource();
	source.buffer = audioBuffer;
	source.connect(gainNode);
	source.start(startTimeAbs, offset);
	
	if (when === 0) {
		// Play Imediato
		if (sourceNode) try { sourceNode.stop(); } catch(e){}
		sourceNode = source;
		startTime = audioCtx.currentTime - offset;
		isPlaying = true;
		isScheduled = false;
		updateUI(true);
		startLogic();
	} else {
		// Agendamento Futuro (Crossfade/Seamless)
		nextSourceNode = source;
	}
}

function stopAudio() {
	// Para tudo (atual e agendado)
	if (sourceNode) { try{ sourceNode.stop(); } catch(e){} sourceNode = null; }
	if (nextSourceNode) { try{ nextSourceNode.stop(); } catch(e){} nextSourceNode = null; }
	
	// Cancela Fades
	gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
	gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
	document.getElementById('btn-fade').classList.remove('fade-active');

	isPlaying = false;
	pausedAt = 0; 
	nextSectionIndex = -1;
	isScheduled = false;
	
	updateUI(false);
	updateButtonStyles();
	cancelAnimationFrame(animId);
	document.getElementById('timer').innerText = "00:00";
}

function triggerFadeOut() {
	if (!isPlaying) return;
	const fadeBtn = document.getElementById('btn-fade');
	fadeBtn.classList.add('fade-active');
	
	const now = audioCtx.currentTime;
	// Garante que o volume começa de onde está
	gainNode.gain.setValueAtTime(gainNode.gain.value, now);
	// Desce para 0 em 3 segundos
	gainNode.gain.linearRampToValueAtTime(0, now + 3);

	setTimeout(() => stopAudio(), 3000);
}

function togglePlay() {
	if (isPlaying) {
		pausedAt = audioCtx.currentTime - startTime;
		stopAudio();
	} else {
		if (audioCtx.state === 'suspended') audioCtx.resume();
		// Se a música parou, retoma. Se for nova, começa do inicio da sessão
		let startPoint = pausedAt > 0 ? pausedAt : (sections[0] ? sections[0].time : 0);
		playAudio(startPoint);
		updateButtonStyles();
	}
}

// --- LÓGICA INTELIGENTE (LOOKAHEAD) ---
function startLogic() {
	cancelAnimationFrame(animId);

	const check = () => {
		if (!isPlaying) return;

		const now = audioCtx.currentTime - startTime;
		updateTimerVisual(now);

		// Verifica a próxima sessão
		if (currentSectionIndex !== -1 && sections[currentSectionIndex + 1]) {
			const nextSec = sections[currentSectionIndex + 1];
			const timeRemaining = nextSec.time - now;

			// [MÁGICA DO ZERO DELAY]
			// Faltando 0.2s para acabar, nós já agendamos a troca na placa de som
			if (timeRemaining < 0.2 && timeRemaining > 0 && !isScheduled) {
				isScheduled = true; // Trava para não agendar 2 vezes
				
				const switchTimeAbs = audioCtx.currentTime + timeRemaining; // O momento exato no futuro

				if (loopEnabled) {
					// LOOP: Volta pro início da ATUAL
					const loopStart = sections[currentSectionIndex].time;
					performSeamlessSwitch(switchTimeAbs, loopStart, currentSectionIndex);
				
				} else if (nextSectionIndex !== -1) {
					// PRÓXIMA MARCADA: Vai para a escolhida
					const targetStart = sections[nextSectionIndex].time;
					const targetIdx = nextSectionIndex;
					nextSectionIndex = -1;
					performSeamlessSwitch(switchTimeAbs, targetStart, targetIdx);
				
				} else {
					// NATURAL: Segue o baile (não precisa fazer nada no áudio, só visual)
				}
			}
			
			// Atualização Visual (passou da linha)
			if (now >= nextSec.time + 0.05) {
				 if (!loopEnabled && nextSectionIndex === -1 && isScheduled === false) {
					 currentSectionIndex++;
					 updateButtonStyles();
				 }
				 // Destrava o agendamento se já passou tempo suficiente
				 if(now >= nextSec.time + 0.5) isScheduled = false; 
			}

		} else if (now >= audioBuffer.duration) {
			// Fim da música
			stopAudio();
		}

		animId = requestAnimationFrame(check);
	};
	check();
}

// Função Auxiliar para Troca Perfeita
function performSeamlessSwitch(whenAbs, offset, newIdx) {
	// 1. Toca o novo som no tempo exato futuro
	playAudio(offset, whenAbs);
	
	// 2. Para o som antigo nesse mesmo tempo
	if(sourceNode) sourceNode.stop(whenAbs);
	
	// 3. Atualiza as variáveis JS no momento certo
	const delayMs = (whenAbs - audioCtx.currentTime) * 1000;
	setTimeout(() => {
		// O "nextSource" vira o oficial
		sourceNode = nextSourceNode;
		nextSourceNode = null;
		startTime = audioCtx.currentTime - offset;
		currentSectionIndex = newIdx;
		isScheduled = false; // Libera
		updateButtonStyles();
	}, delayMs);
}

// --- CONTROLES UI ---
function scheduleSection(i) {
	if (!isPlaying) {
		jumpToSection(i, true);
		return;
	}
	if (i === currentSectionIndex) return;
	
	// Apenas marca visualmente para a próxima troca
	nextSectionIndex = i;
	updateButtonStyles();
	if (navigator.vibrate) navigator.vibrate(30);
}

function jumpToSection(i, auto) {
	currentSectionIndex = i;
	nextSectionIndex = -1;
	pausedAt = sections[i].time;
	updateButtonStyles();
	
	if (auto) {
		playAudio(pausedAt);
	} else {
		updateTimerVisual(pausedAt);
	}
}

function updateTimerVisual(seconds) {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	document.getElementById('timer').innerText = `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
}

function updateUI(playing) {
	const btn = document.getElementById('btn-play');
	btn.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill pl-1"></i>';
	if (playing) btn.classList.add('bg-light', 'text-dark');
	else btn.classList.remove('bg-light', 'text-dark');
}

function updateButtonStyles() {
	document.querySelectorAll('.section-btn').forEach((b, i) => {
		b.className = 'section-btn' + (i === currentSectionIndex ? ' active' : '') + (i === nextSectionIndex ? ' queued' : '');
	});
}

function toggleLoop() {
	loopEnabled = !loopEnabled;
	document.getElementById('btn-loop').classList.toggle('loop-active', loopEnabled);
	if (navigator.vibrate) navigator.vibrate(50);
}
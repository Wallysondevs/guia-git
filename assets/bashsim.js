/* =====================================================================
   Guia Bash — simulador de Bash (bashsim.js)
   ---------------------------------------------------------------------
   Um interpretador de Bash em JavaScript puro, com um sistema de
   arquivos fictício (a máquina "notebook" da usuária "ana").
   Roda no navegador (monta os componentes .try e .tryscript) e no
   Node (module.exports), onde é usado pelas ferramentas de tools/.

   Estrutura:
     1. utilidades, datas, ordenação pt_BR
     2. sistema de arquivos e estado inicial (igual ao laboratório)
     3. núcleo: processos (generators), escalonador, relógio virtual,
        descritores de arquivo, pipes e terminal
     4. parser: tokenizador + AST (listas, pipelines, compostos,
        redirecionamentos, here-docs, palavras com partes citadas)
     5. aritmética, padrões (glob/extglob), expansões na ordem do Bash
     6. executor
     7. comandos internos (builtins)
     8. programas externos simulados (coreutils, grep, sed, awk, find…)
     9. interface no navegador (.try e .tryscript)

   Pausas: o executor é feito de generators (function*). Quando um
   comando precisa de entrada do teclado, o processo "cede" ({t:'in'})
   e a interface mostra um campo; quando dorme, cede {t:'sleep'}.
   O escalonador alterna os processos de um pipeline (yes | head -1).

   LIMITAÇÕES CONHECIDAS (diferenças em relação ao Bash 5.3 real):
   - Não há rede, pacotes, editores, cron/systemd, man/info, tar/gzip,
     shellcheck, gawk; tput só com valores fixos; less/more mostram tudo
     de uma vez. Para eles, uma mensagem "(simulador) …" (nunca uma
     saída inventada).
   - Relógio fixo: 15/10/2026 10:30 (-03). sleep, timeout e wait avançam
     um relógio virtual; jobs em segundo plano andam nesse relógio (a
     saída de "(sleep 2; echo x) &" aparece quando o relógio avança).
   - PIDs ($$ = 3001; filhos 3100, 3101…), inodes e números do df/free/ps
     são fictícios. Sinais: TERM, INT, KILL, HUP, USR1, USR2 e PIPE;
     não há SIGCHLD/SIGWINCH nem Ctrl+Z (suspender).
   - A ordem de saída entre processos paralelos e de >( ) pode diferir da
     real (no Bash real ela também varia de uma execução para outra).
   - find, du e grep -r usam a ordem do disco do laboratório para os
     arquivos iniciais; arquivos novos saem na ordem de criação (ext4) ou
     na ordem inversa (/tmp, tmpfs).
   - awk é o mawk 1.3.4 sem as extensões raras (-W dump, srand
     reprodutível igual ao real); sed, grep, sort, date e find cobrem as
     opções usadas no guia; "sh" imita o dash só no básico (echo, [[,
     arrays, mensagens "x: not found" e "Syntax error").
   - Arquivos binários (fotos, .iso…) são cheios de zeros, como os do
     laboratório; "file" e "od" mostram o básico.
   - A ordem de nomes com pontuação (ls, curingas, sort) segue o Intl
     (ICU) em pt-BR, que quase sempre coincide com a glibc.
   - O "help NOME" vem de assets/bashsim-ajuda.js, carregado sob demanda.
   ===================================================================== */
(function (global) {
  "use strict";

  var USER = "ana", HOST = "notebook", HOME = "/home/ana", UID = 1000, GID = 1000;
  var GROUPS = [1000, 4, 24, 27, 30, 46, 100];
  var TZ_OFF = -3 * 3600 * 1000; // America/Sao_Paulo (sem horário de verão)
  var NOW0 = Date.UTC(2026, 9, 15, 13, 30, 0); // 15/10/2026 10:30 -03
  var OPCOES = { casaGuiaBash: false }; // BashSim.opcoes: a pasta da Ana do Guia Bash (testes antigos)
  var BASH_VERSION = "5.3.9(1)-release";
  var STEP_LIMIT = 300000;
  var MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  var MESES_LONGO = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  var DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  var DIAS_LONGO = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  var C0 = "\u0001", C1 = "\u0002"; // marcadores de cor na saída para o terminal
  function cor(letra, txt) { return C0 + letra + txt + C1; }
  function semCor(s) { return s.replace(/\u0001./g, "").replace(/\u0002/g, ""); }

  /* ------------------------------------------------------------------
     1. Utilidades
     ------------------------------------------------------------------ */
  function pad(s, n, esq) { s = String(s); var w = largura(s); while (w < n) { s = esq ? s + " " : " " + s; w++; } return s; }
  function largura(s) { var n = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c >= 0xdc00 && c < 0xe000) continue; if (c >= 0x300 && c < 0x370) continue; n++; } return n; }
  function dois(n) { return (n < 10 ? "0" : "") + n; }
  function utf8len(s) { var n = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += c < 128 ? 1 : c < 2048 ? 2 : (c >= 0xd800 && c < 0xdc00) ? (i++, 4) : 3; } return n; }
  function utf8bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function cmpBytes(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  // Ordem pt_BR.UTF-8 (strcoll da glibc): ignora pontuação no 1º nível, minúscula antes.
  var COLL = (typeof Intl !== "undefined" && Intl.Collator) ? new Intl.Collator("pt-BR", { ignorePunctuation: true, caseFirst: "lower", numeric: false }) : null;
  function collate(a, b) {
    if (!COLL) return cmpBytes(a, b);
    var r = COLL.compare(a, b);
    if (r === 0 && a !== b) {
      var r2 = COLL2.compare(a, b);
      return r2 !== 0 ? r2 : cmpBytes(a, b);
    }
    return r;
  }
  var COLL2 = (typeof Intl !== "undefined" && Intl.Collator) ? new Intl.Collator("pt-BR", { caseFirst: "lower" }) : null;
  function repete(s, n) { var r = ""; while (n-- > 0) r += s; return r; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function nomeValido(n) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n); }
  function isDigits(s) { return /^[0-9]+$/.test(s); }
  function ultimo(a) { return a[a.length - 1]; }

  // Datas no fuso -03 (independente do fuso do navegador)
  function tm(ms) {
    var d = new Date(ms + TZ_OFF);
    return { Y: d.getUTCFullYear(), M: d.getUTCMonth(), D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), w: d.getUTCDay(), ms: d.getUTCMilliseconds(), yday: Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) };
  }
  function epochDe(Y, M, D, h, m, s) { return Date.UTC(Y, M, D, h || 0, m || 0, s || 0) - TZ_OFF; }
  function dataLs(ms, agora) {
    var t = tm(ms), seis = 15778476000; // 365.2425*24*3600/2 s
    var s = (OPCOES.casaGuiaBash ? MESES : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])[t.M] + " " + pad(t.D, 2) + " "; // uutils ls: meses em inglês
    return s + ((agora - ms) < seis && (ms - agora) < 3600000 ? dois(t.h) + ":" + dois(t.m) : " " + t.Y);
  }
  function humano(b, si) {
    var base = si ? 1000 : 1024;
    if (b < base) return String(b);
    var u = ["K", "M", "G", "T", "P"], i = -1, v = b;
    do { v /= base; i++; } while (v >= base && i < u.length - 1);
    var uni = (si && i === 0) ? "k" : u[i];
    if (v < 10) { var r = Math.ceil(v * 10 - 1e-9) / 10; if (r < 10) return r.toFixed(1).replace(".", ",") + uni; return "10" + uni; }
    return Math.ceil(v - 1e-9) + uni;
  }

  // Erros que atravessam a pilha de generators
  function ExitSig(code) { this.code = code; }
  function ReturnSig(code) { this.code = code; }
  function BreakSig(n) { this.n = n; }
  function ContSig(n) { this.n = n; }
  function KillSig(sig) { this.sig = sig; }
  function AbortSig(msg) { this.msg = msg; }       // limite de passos / Ctrl+C
  function FatalSig(code) { this.code = code; }   // erro de expansão que encerra o shell não interativo
  function CmdErr(code) { this.code = code; }      // erro de expansão que aborta só o comando atual
  function SyntaxErr(msg, tok, line, semEco, x, extra) { this.msg = msg; this.tok = tok; this.line = line; this.semEco = !!semEco; this.extra = extra; }
  function Incomplete(what) { this.what = what; }
  function SigPipe() {}
  function isSig(e) { return e instanceof ExitSig || e instanceof ReturnSig || e instanceof BreakSig || e instanceof ContSig || e instanceof KillSig || e instanceof AbortSig || e instanceof FatalSig || e instanceof CmdErr || e instanceof SigPipe; }

  var SIGNAIS = ["EXIT", "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM", "STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS"];
  var SIG_DESC = { 1: "Interrupção", 2: "Interrupção", 3: "Sair", 6: "Abortado", 9: "Morto", 10: "Sinal definido pelo usuário 1", 12: "Sinal definido pelo usuário 2", 13: "Pipe quebrado", 14: "Alarme do relógio", 15: "Terminado" };
  SIG_DESC[1] = "Desconexão";
  function sinalNum(s) {
    s = String(s).toUpperCase();
    if (isDigits(s)) { var n = +s; return n >= 0 && n < 65 ? n : -1; }
    if (s.indexOf("SIG") === 0) s = s.slice(3);
    var i = SIGNAIS.indexOf(s);
    if (i >= 0) return i;
    if (s === "ERR") return 100; if (s === "DEBUG") return 101; if (s === "RETURN") return 102;
    return -1;
  }
  function sinalNome(n) { return n === 0 ? "EXIT" : n === 100 ? "ERR" : n === 101 ? "DEBUG" : n === 102 ? "RETURN" : "SIG" + SIGNAIS[n]; }

  /* ------------------------------------------------------------------
     2. Sistema de arquivos
     ------------------------------------------------------------------ */
  var proxIno = 27792800;
  function mkD(uid, modo, mt) { return { t: "d", c: Object.create(null), m: modo, u: uid, g: uid === 0 ? 0 : uid, mt: mt, ct: mt, at: mt, ino: proxIno++, nl: 1 }; }
  function mkF(uid, modo, dados, mt, zeros) { var n = { t: "f", d: dados, m: modo, u: uid, g: uid === 0 ? 0 : uid, mt: mt, ct: mt, at: mt, ino: proxIno++, nl: 1 }; if (zeros != null) { n.d = null; n.z = zeros; } return n; }
  function mkL(alvo, mt) { return { t: "l", alvo: alvo, m: 511, u: 0, g: 0, mt: mt, ct: mt, at: mt, ino: proxIno++, nl: 1 }; }
  function mkC(dev, mt) { return { t: "c", dev: dev, m: 438, u: 65534, g: 65534, mt: mt, ct: mt, at: mt, ino: proxIno++, nl: 1 }; }
  function dataT(Y, M, D, h, m) { return epochDe(Y, M - 1, D, h, m, 0); }
  function tamanho(no) {
    if (no.t === "d") return no.tam || 4096;
    if (no.t === "l") return utf8len(no.alvo);
    if (no.t === "c") return 0;
    if (no.d == null) return no.z || 0;
    return no.cacheTam != null && no.cacheD === no.d ? no.cacheTam : (no.cacheD = no.d, no.cacheTam = utf8len(no.d));
  }
  function blocos(no) { // blocos de 1K usados (como du/ls -s)
    if (no.t === "d") return no.tam != null && no.tam < 4096 ? 0 : 4;
    if (no.t !== "f") return 0;
    if (no.d == null) return 0; // esparso (como no laboratório)
    var t = tamanho(no); return Math.ceil(t / 4096) * 4;
  }
  function dadosDe(no) {
    if (no.d != null) return no.d;
    var z = no.z || 0; return z > 65536 ? repete("\0", 65536) : repete("\0", z);
  }

  var TXT = {
    bashrc: "# ~/.bashrc: executado pelo bash(1) para shells interativos.\n\n# Se não for interativo, não faz nada\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\nHISTCONTROL=ignoreboth\nHISTSIZE=1000\nHISTFILESIZE=2000\nshopt -s histappend\nshopt -s checkwinsize\n\nPS1='\\u@\\h:\\w\\$ '\n\nalias ls='ls --color=auto'\nalias grep='grep --color=auto'\nalias ll='ls -alF'\nalias la='ls -A'\nalias l='ls -CF'\n",
    profile: "# ~/.profile: executado pelo shell de login.\n\n# se estiver rodando bash, carrega o .bashrc\nif [ -n \"$BASH_VERSION\" ]; then\n    if [ -f \"$HOME/.bashrc\" ]; then\n        . \"$HOME/.bashrc\"\n    fi\nfi\n\n# inclui a pasta bin pessoal no PATH, se existir\nif [ -d \"$HOME/bin\" ] ; then\n    PATH=\"$HOME/bin:$PATH\"\nfi\nif [ -d \"$HOME/.local/bin\" ] ; then\n    PATH=\"$HOME/.local/bin:$PATH\"\nfi\n",
    frutas: "banana\nmaçã\nlaranja\nbanana\nuva\nmaçã\nbanana\n",
    notas: "Comprar café\nLigar para o João\nEstudar Bash\nFazer backup das fotos\n",
    alunos: "nome,idade,cidade,nota\nAna,29,Recife,9.5\nBruno,34,Curitiba,7.0\nCarla,22,Salvador,8.5\nDiego,41,Manaus,6.0\nElisa,27,Porto Alegre,10.0\n",
    acesso: "192.168.0.10 - - [15/Oct/2026:09:01:12] \"GET / HTTP/1.1\" 200\n192.168.0.23 - - [15/Oct/2026:09:01:40] \"GET /contato HTTP/1.1\" 200\n192.168.0.10 - - [15/Oct/2026:09:02:03] \"GET /admin HTTP/1.1\" 403\n192.168.0.57 - - [15/Oct/2026:09:05:19] \"GET /fotos HTTP/1.1\" 404\n192.168.0.10 - - [15/Oct/2026:09:06:44] \"POST /login HTTP/1.1\" 200\n192.168.0.23 - - [15/Oct/2026:09:07:02] \"GET / HTTP/1.1\" 200\n",
    backup: "#!/usr/bin/env bash\necho \"Fazendo backup...\"\n",
    passwd: "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\nana:x:1000:1000:Ana,,,:/home/ana:/bin/bash\n",
    group: "root:x:0:\nadm:x:4:ana\ncdrom:x:24:ana\nsudo:x:27:ana\ndip:x:30:ana\nplugdev:x:46:ana\nusers:x:100:ana\nnogroup:x:65534:\nana:x:1000:\n",
    shells: "# /etc/shells: valid login shells\n/bin/sh\n/usr/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/rbash\n/usr/bin/rbash\n/usr/bin/dash\n/usr/bin/screen\n",
    osrelease: "PRETTY_NAME=\"Ubuntu 26.04 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"26.04\"\nVERSION=\"26.04 LTS (Resolute Raccoon)\"\nVERSION_CODENAME=resolute\nID=ubuntu\nID_LIKE=debian\n"
  };
  var USUARIOS = { 0: "root", 1: "daemon", 33: "www-data", 65534: "nobody", 1000: "ana" };
  var GRUPOS = { 0: "root", 4: "adm", 24: "cdrom", 27: "sudo", 30: "dip", 46: "plugdev", 100: "users", 65534: "nogroup", 1000: "ana" };

  // Programas "instalados" em /usr/bin (os simulados e alguns que só existem para dar a mensagem certa)
  var BIN_EXTRA = ["github", "nano", "vim", "vi", "less", "more", "curl", "wget", "ssh", "scp", "apt", "apt-get", "dpkg", "sudo", "su", "python3", "perl", "man", "systemctl", "crontab", "top", "htop", "git", "make", "gcc", "zip", "unzip", "tar", "gzip", "gunzip", "ping", "ip", "ss", "shellcheck", "dash", "watch", "timeout", "nohup", "tput", "clear", "shuf", "fold", "comm", "join", "od", "md5sum", "sha256sum", "base64", "factor", "tac", "yes", "mktemp", "readlink", "groups", "logname", "tty", "nproc", "uptime", "free", "pkill", "killall", "pidof", "tree", "awk", "mawk", "gawk", "test", "[", "true", "false", "echo", "printf", "pwd", "sleep", "bc", "expr", "xxd", "hexdump", "iconv", "split", "csplit", "truncate", "install", "fmt", "pr", "expand", "unexpand", "numfmt", "seq", "sort", "uniq", "who", "w", "last", "lsblk", "mount", "umount", "chown", "chgrp", "sync", "dd", "cksum", "sum", "sha1sum", "b2sum", "tsort", "ptx", "stdbuf", "env", "printenv", "nice", "renice", "basenc", "base32", "link", "unlink", "dir", "vdir", "dircolors", "pathchk", "mkfifo", "mknod", "shred", "users", "hostid", "pinky", "arch", "uname", "hostname", "whoami", "id", "date", "cal", "column", "rev", "look", "diff", "cmp", "patch", "file", "stat", "du", "df", "which", "whereis", "type", "xargs", "find", "locate", "grep", "egrep", "fgrep", "sed", "cut", "tr", "tee", "wc", "head", "tail", "cat", "nl", "paste", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "touch", "ln", "chmod", "basename", "dirname", "realpath", "ps", "pgrep", "kill", "bash", "rbash", "sh", "lsof", "jq", "zcat", "openssl", "ssh-keygen", "rsync", "zsh", "fish", "code", "gedit", "xdg-open", "notify-send", "at", "batch", "flock", "getent", "logger", "lscpu", "sensors", "dmesg", "journalctl", "service", "ufw", "snap", "flatpak", "docker", "node", "npm", "pip", "pip3", "java", "ruby", "php", "lua", "tclsh", "xclip", "script", "strace", "ltrace", "gdb", "valgrind", "time", "env", "infocmp", "ldd"];

  function criarFS() {
    var T0 = dataT(2026, 3, 26, 9, 0), TB = dataT(2026, 2, 13, 4, 0);
    var raiz = mkD(0, 493, dataT(2026, 10, 13, 13, 7));
    function por(caminho, no) {
      var partes = caminho.split("/").filter(Boolean), atual = raiz;
      for (var i = 0; i < partes.length - 1; i++) atual = atual.c[partes[i]];
      atual.c[partes[partes.length - 1]] = no;
      return no;
    }
    ["boot", "dev", "etc", "home", "media", "mnt", "opt", "proc", "srv", "usr", "var", "snap", "sys", "run"].forEach(function (n) { por("/" + n, mkD(0, 493, dataT(2026, 2, 9, 8, 0))); });
    por("/bin", mkL("usr/bin", dataT(2024, 4, 22, 10, 0)));
    por("/sbin", mkL("usr/sbin", dataT(2024, 4, 22, 10, 0)));
    por("/lib", mkL("usr/lib", dataT(2024, 4, 22, 10, 0)));
    por("/root", mkD(0, 448, T0));
    var tmp = por("/tmp", mkD(UID, 493, NOW0 - 3600000)); tmp.tam = 40; tmp.tmpfs = true;
    por("/usr/bin", mkD(0, 493, TB));
    por("/usr/sbin", mkD(0, 493, TB));
    por("/usr/lib", mkD(0, 493, TB));
    por("/usr/local", mkD(0, 493, TB));
    por("/usr/local/bin", mkD(0, 493, TB));
    por("/usr/share", mkD(0, 493, TB));
    por("/usr/share/dict", mkD(0, 493, TB));
    por("/usr/share/dict/words", mkF(0, 420, "abacate\nbanana\ncaju\ndamasco\nfigo\ngoiaba\nkiwi\nlimão\nmanga\nuva\n", TB));
    var vistos = {};
    BIN_EXTRA.forEach(function (n) {
      if (vistos[n]) return; vistos[n] = 1;
      var tam = n === "bash" ? 1540520 : 35000 + (n.length * 7919) % 120000;
      por("/usr/bin/" + n, mkF(0, 493, null, TB, tam));
    });
    por("/usr/bin/sh", mkL("dash", dataT(2026, 2, 2, 10, 0)));
    por("/var/log", mkD(0, 509, NOW0 - 7200000));
    var sl = por("/var/log/syslog", mkF(104, 416, "Oct 15 08:00:01 notebook systemd[1]: Started cron.service.\n", NOW0 - 7200000)); sl.g = 4;
    por("/var/tmp", mkD(0, 1023, T0));
    por("/var/www", mkD(0, 493, T0));
    var E = dataT(2026, 10, 16, 9, 36);
    por("/etc/hostname", mkF(0, 420, "notebook\n", E));
    por("/etc/hosts", mkF(0, 420, "127.0.0.1\tlocalhost\n127.0.1.1\tnotebook\n", T0));
    por("/etc/passwd", mkF(0, 420, TXT.passwd, E));
    por("/etc/group", mkF(0, 420, TXT.group, E));
    por("/etc/shells", mkF(0, 420, TXT.shells, T0));
    por("/etc/os-release", mkF(0, 420, TXT.osrelease, T0));
    var sh = por("/etc/shadow", mkF(0, 416, "root:*:20500:0:99999:7:::\nana:$y$j9T$...:20500:0:99999:7:::\n", T0)); sh.g = 42;
    // /dev
    var DV = dataT(2026, 10, 16, 9, 26);
    ["null", "zero", "random", "urandom", "full", "tty"].forEach(function (n) { por("/dev/" + n, mkC(n, DV)); });
    por("/dev/stdin", mkL("/proc/self/fd/0", DV));
    por("/dev/stdout", mkL("/proc/self/fd/1", DV));
    por("/dev/stderr", mkL("/proc/self/fd/2", DV));
    por("/dev/fd", mkL("/proc/self/fd", DV));
    // /home/ana — igual a ~/guia-bash-lab/template
    var hm = por("/home", mkD(UID, 493, NOW0)); hm.tam = 60;
    if (OPCOES.casaGuiaBash) { // a pasta da Ana do Guia Bash (só para os testes antigos, tools/testes/0*.casos e 1*.casos)
    var h = por("/home/ana", mkD(UID, 488, dataT(2026, 10, 15, 8, 47)));
      var d12 = dataT(2026, 10, 12, 8, 3);
      // a ordem de criação imita a ordem do readdir no laboratório (find, du, grep -r)
      h.c["Documentos"] = mkD(UID, 509, dataT(2026, 10, 15, 9, 7));
      h.c["Música"] = mkD(UID, 509, d12);
      h.c["Área de trabalho"] = mkD(UID, 509, d12);
      h.c[".bashrc"] = mkF(UID, 420, TXT.bashrc, T0);
      h.c["frutas.txt"] = mkF(UID, 436, TXT.frutas, dataT(2026, 10, 14, 16, 5));
      h.c["Downloads"] = mkD(UID, 509, dataT(2026, 10, 15, 8, 47));
      h.c["Modelos"] = mkD(UID, 509, d12);
      h.c[".profile"] = mkF(UID, 420, TXT.profile, T0);
      h.c[".bash_history"] = mkF(UID, 384, "", dataT(2026, 10, 15, 8, 40));
      h.c[".gitconfig"] = mkF(UID, 420, "[user]\n\tname = Ana Souza\n\temail = ana@exemplo.com\n[init]\n\tdefaultBranch = main\n[core]\n\teditor = nano\n", dataT(2026, 10, 15, 8, 40)); // Git da Ana já configurado
      h.c["Público"] = mkD(UID, 509, d12);
      h.c["Vídeos"] = mkD(UID, 509, d12);
      h.c["Imagens"] = mkD(UID, 509, d12);
      var doc = h.c["Documentos"].c;
      doc["alunos.csv"] = mkF(UID, 436, TXT.alunos, dataT(2026, 10, 14, 18, 12));
      doc["notas.txt"] = mkF(UID, 436, TXT.notas, dataT(2026, 10, 14, 17, 40));
      doc["acesso.log"] = mkF(UID, 436, TXT.acesso, dataT(2026, 10, 15, 9, 7));
      doc["relatorio.odt"] = mkF(UID, 436, null, dataT(2026, 10, 14, 17, 40), 8394);
      doc["projetos"] = mkD(UID, 509, dataT(2026, 10, 15, 9, 15));
      doc["projetos"].c["site"] = mkD(UID, 509, d12);
      doc["projetos"].c["backup.sh"] = mkF(UID, 509, TXT.backup, dataT(2026, 10, 15, 9, 15));
      doc["projetos"].c["site"].c["index.html"] = mkF(UID, 436, "<h1>Olá</h1>\n", d12);
      doc["projetos"].c["site"].c["style.css"] = mkF(UID, 436, "h1 { color: orange; }\n", d12);
      var dl = h.c["Downloads"].c;
      dl["manual.pdf"] = mkF(UID, 436, null, dataT(2026, 10, 13, 11, 2), 2411520);
      dl["fotos-viagem.zip"] = mkF(UID, 436, null, dataT(2026, 10, 1, 19, 30), 104857600);
      dl["musica.mp3"] = mkF(UID, 436, null, dataT(2026, 10, 9, 20, 10), 5242880);
      dl["ubuntu-26.04-desktop-amd64.iso"] = mkF(UID, 436, null, dataT(2026, 10, 10, 21, 14), 6333579264);
      dl["foto.jpg"] = mkF(UID, 436, null, dataT(2026, 10, 15, 8, 47), 49152);
      var im = h.c["Imagens"].c;
      im["perfil.png"] = mkF(UID, 436, null, dataT(2026, 9, 20, 10, 0), 102400);
      im["ferias.jpg"] = mkF(UID, 436, null, dataT(2026, 8, 2, 14, 0), 2097152);
    } else {
    var h = por("/home/ana", mkD(UID, 488, dataT(2026, 10, 15, 9, 58)));
    // /home/ana — igual a ~/guia-git-lab/template (pastas padrão vazias, ~/.gitconfig da Ana)
    var dT = dataT(2026, 10, 14, 10, 11), dA = dataT(2026, 10, 14, 10, 26);
    h.c[".bash_history"] = mkF(UID, 384, "", dA);
    h.c["Modelos"] = mkD(UID, 509, dT);
    h.c[".bash_logout"] = mkF(UID, 420, "# ~/.bash_logout: executed by bash(1) when login shell exits.\n\n# when leaving the console clear the screen to increase privacy\n\nif [ \"$SHLVL\" = 1 ]; then\n    [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q\nfi\n", dA);
    h.c["Imagens"] = mkD(UID, 509, dT);
    h.c[".gitconfig"] = mkF(UID, 436, "[user]\n\tname = Ana Souza\n\temail = ana@exemplo.com\n[init]\n\tdefaultBranch = main\n[core]\n\teditor = nano\n", dataT(2026, 10, 15, 9, 58));
    h.c[".config"] = mkD(UID, 509, dT);
    h.c[".config"].c["user-dirs.dirs"] = mkF(UID, 436, "XDG_DESKTOP_DIR=\"$HOME/Área de trabalho\"\nXDG_DOWNLOAD_DIR=\"$HOME/Downloads\"\nXDG_TEMPLATES_DIR=\"$HOME/Modelos\"\nXDG_PUBLICSHARE_DIR=\"$HOME/Público\"\nXDG_DOCUMENTS_DIR=\"$HOME/Documentos\"\nXDG_MUSIC_DIR=\"$HOME/Música\"\nXDG_PICTURES_DIR=\"$HOME/Imagens\"\nXDG_VIDEOS_DIR=\"$HOME/Vídeos\"\n", dT);
    h.c["Documentos"] = mkD(UID, 509, dT);
    h.c[".bashrc"] = mkF(UID, 420, "# ~/.bashrc: executed by bash(1) for non-login shells.\n# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)\n# for examples\n\n# If not running interactively, don't do anything\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\n# don't put duplicate lines or lines starting with space in the history.\n# See bash(1) for more options\nHISTCONTROL=ignoreboth\n\n# append to the history file, don't overwrite it\nshopt -s histappend\n\n# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)\nHISTSIZE=1000\nHISTFILESIZE=2000\n\n# check the window size after each command and, if necessary,\n# update the values of LINES and COLUMNS.\nshopt -s checkwinsize\n\n# If set, the pattern \"**\" used in a pathname expansion context will\n# match all files and zero or more directories and subdirectories.\n#shopt -s globstar\n\n# make less more friendly for non-text input files, see lesspipe(1)\n[ -x /usr/bin/lesspipe ] && eval \"$(SHELL=/bin/sh lesspipe)\"\n\n# set variable identifying the chroot you work in (used in the prompt below)\nif [ -z \"${debian_chroot:-}\" ] && [ -r /etc/debian_chroot ]; then\n    debian_chroot=$(cat /etc/debian_chroot)\nfi\n\n# set a fancy prompt (non-color, unless we know we \"want\" color)\ncase \"$TERM\" in\n    xterm-color|*-256color) color_prompt=yes;;\nesac\n\n# uncomment for a colored prompt, if the terminal has the capability; turned\n# off by default to not distract the user: the focus in a terminal window\n# should be on the output of commands, not on the prompt\n#force_color_prompt=yes\n\nif [ -n \"$force_color_prompt\" ]; then\n    if [ -x /usr/bin/tput ] && tput setaf 1 >&/dev/null; then\n\t# We have color support; assume it's compliant with Ecma-48\n\t# (ISO/IEC-6429). (Lack of such support is extremely rare, and such\n\t# a case would tend to support setf rather than setaf.)\n\tcolor_prompt=yes\n    else\n\tcolor_prompt=\n    fi\nfi\n\nif [ \"$color_prompt\" = yes ]; then\n    PS1='${debian_chroot:+($debian_chroot)}\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '\nelse\n    PS1='${debian_chroot:+($debian_chroot)}\\u@\\h:\\w\\$ '\nfi\nunset color_prompt force_color_prompt\n\n# If this is an xterm set the title to user@host:dir\ncase \"$TERM\" in\nxterm*|rxvt*)\n    PS1=\"\\[\\e]0;${debian_chroot:+($debian_chroot)}\\u@\\h: \\w\\a\\]$PS1\"\n    ;;\n*)\n    ;;\nesac\n\n# enable color support of ls and also add handy aliases\nif [ -x /usr/bin/dircolors ]; then\n    test -r ~/.dircolors && eval \"$(dircolors -b ~/.dircolors)\" || eval \"$(dircolors -b)\"\n    alias ls='ls --color=auto'\n    #alias dir='dir --color=auto'\n    #alias vdir='vdir --color=auto'\n\n    alias grep='grep --color=auto'\n    alias fgrep='fgrep --color=auto'\n    alias egrep='egrep --color=auto'\nfi\n\n# colored GCC warnings and errors\n#export GCC_COLORS='error=01;31:warning=01;35:note=01;36:caret=01;32:locus=01:quote=01'\n\n# some more ls aliases\nalias ll='ls -alF'\nalias la='ls -A'\nalias l='ls -CF'\n\n# Add an \"alert\" alias for long running commands.  Use like so:\n#   sleep 10; alert\nalias alert='notify-send --urgency=low -i \"$([ $? = 0 ] && echo terminal || echo error)\" \"$(history|tail -n1|sed -e '\\''s/^\\s*[0-9]\\+\\s*//;s/[;&|]\\s*alert$//'\\'')\"'\n\n# Alias definitions.\n# You may want to put all your additions into a separate file like\n# ~/.bash_aliases, instead of adding them here directly.\n# See /usr/share/doc/bash-doc/examples in the bash-doc package.\n\nif [ -f ~/.bash_aliases ]; then\n    . ~/.bash_aliases\nfi\n\n# enable programmable completion features (you don't need to enable\n# this, if it's already enabled in /etc/bash.bashrc and /etc/profile\n# sources /etc/bash.bashrc).\nif ! shopt -oq posix; then\n  if [ -f /usr/share/bash-completion/bash_completion ]; then\n    . /usr/share/bash-completion/bash_completion\n  elif [ -f /etc/bash_completion ]; then\n    . /etc/bash_completion\n  fi\nfi\n", dA);
    h.c["Público"] = mkD(UID, 509, dT);
    h.c["Downloads"] = mkD(UID, 509, dT);
    h.c["Área de trabalho"] = mkD(UID, 509, dT);
    h.c["Vídeos"] = mkD(UID, 509, dT);
    h.c[".profile"] = mkF(UID, 420, "# ~/.profile: executed by the command interpreter for login shells.\n# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login\n# exists.\n# see /usr/share/doc/bash/examples/startup-files for examples.\n# the files are located in the bash-doc package.\n\n# the default umask is set in /etc/profile; for setting the umask\n# for ssh logins, install and configure the libpam-umask package.\n#umask 022\n\n# if running bash\nif [ -n \"$BASH_VERSION\" ]; then\n    # include .bashrc if it exists\n    if [ -f \"$HOME/.bashrc\" ]; then\n\t. \"$HOME/.bashrc\"\n    fi\nfi\n\n# set PATH so it includes user's private bin if it exists\nif [ -d \"$HOME/bin\" ] ; then\n    PATH=\"$HOME/bin:$PATH\"\nfi\n\n# set PATH so it includes user's private bin if it exists\nif [ -d \"$HOME/.local/bin\" ] ; then\n    PATH=\"$HOME/.local/bin:$PATH\"\nfi\n", dA);
    h.c["Música"] = mkD(UID, 509, dT);
    }
    return raiz;
  }
  // nomes de uma pasta na ordem do disco (readdir): ext4 = ordem de criação; tmpfs = inversa
  function listarDir(no) { var k = Object.keys(no.c); return no.tmpfs ? k.reverse() : k; }
  function contarLinks(no) { // nº de ligações de uma pasta = 2 + subpastas
    if (no.t !== "d") return no.nl || 1;
    var n = 2; for (var k in no.c) if (no.c[k].t === "d") n++; return n;
  }

  function precisaAspasLs(n) { return /[\s'"$`\\!*?&;|<>()\[=^]|^[#~]/.test(n) || n === "" || /[\x00-\x1f\x7f]/.test(n); }
  function aspasLs(n) { // estilo shell-escape do ls/stat do coreutils
    if (!/[\x00-\x1f\x7f]/.test(n)) return n.indexOf("'") === -1 ? "'" + n + "'" : '"' + n.replace(/(["\\$`])/g, "\\$1") + '"';
    return "'" + n.replace(/'/g, "'\\''").replace(/[\x00-\x1f\x7f]/g, function (c) { var m = { "\n": "n", "\t": "t" }[c]; return "'$'\\" + (m || ("0" + c.charCodeAt(0).toString(8)).slice(-3)) + "''"; }) + "'";
  }

  /* ------------------------------------------------------------------
     3. Núcleo: processos, escalonador, descritores, pipes, terminal
     ------------------------------------------------------------------ */
  function Pipe() { this.buf = ""; this.w = 0; this.r = 0; }
  function OFD(kind, props) { this.kind = kind; this.refs = 0; if (props) for (var k in props) this[k] = props[k]; }
  function ref(o) { if (!o) return o; if (o.refs++ === 0) { if (o.kind === "pipe-w") o.p.w++; else if (o.kind === "pipe-r") o.p.r++; } return o; }
  function unref(o) { if (!o) return; if (--o.refs === 0) { if (o.kind === "pipe-w") o.p.w--; else if (o.kind === "pipe-r") { o.p.r--; if (o.p.r === 0) o.p.buf = ""; } } }
  function novoPipe() { var p = new Pipe(); return [new OFD("pipe-r", { p: p, rd: true }), new OFD("pipe-w", { p: p, wr: true })]; }
  function podeLer(o) { return o && (o.kind === "tty-in" || o.kind === "pipe-r" || o.kind === "null" || o.kind === "zero" || o.kind === "random" || (o.kind === "file" && o.rd) || o.kind === "tty-out"); }
  function podeEscrever(o) { return o && (o.kind === "tty-out" || o.kind === "pipe-w" || o.kind === "null" || o.kind === "zero" || o.kind === "random" || (o.kind === "file" && o.wr)); }
  function isTTY(o) { return !!o && (o.kind === "tty-out" || o.kind === "tty-in"); }

  function Proc(k, pid, ppid) {
    this.k = k; this.pid = pid; this.ppid = ppid; this.state = "run"; this.resume = undefined; this.status = null;
    this.done = false; this.gen = null; this.sh = null; this.bg = false; this.nome = ""; this.cond = null; this.wake = 0; this.inReq = null;
  }

  function Kernel() {
    this.clock = NOW0;
    this.fs = criarFS();
    this.procs = [];
    this.nextPid = 3100;
    this.saidaBuf = [];
    this.onSaida = null;
    this.ttyBuf = ""; this.ttyEOF = false;
    this.steps = 0; this.limit = STEP_LIMIT;
    this.intPend = false;
    this.cur = null;
    this.main = null;
    this.bytesSaida = 0; this.limiteSaida = 4000000;
    this.sistema = [
      { pid: 1, ppid: 0, u: 0, tty: "?", cmd: "/sbin/init splash", comm: "systemd", stat: "Ss", start: "08:00" },
      { pid: 812, ppid: 1, u: 0, tty: "?", cmd: "/usr/sbin/NetworkManager --no-daemon", comm: "NetworkManager", stat: "Ssl", start: "08:00" },
      { pid: 1534, ppid: 1, u: UID, tty: "?", cmd: "/usr/bin/gnome-shell", comm: "gnome-shell", stat: "Ssl", start: "08:01" },
      { pid: 2210, ppid: 1534, u: UID, tty: "?", cmd: "/usr/lib/firefox/firefox", comm: "firefox", stat: "Sl", start: "08:05" },
      { pid: 2950, ppid: 1534, u: UID, tty: "?", cmd: "/usr/libexec/gnome-terminal-server", comm: "gnome-terminal-", stat: "Ssl", start: "08:10" }
    ];
  }
  var KP = Kernel.prototype;
  KP.saida = function (stream, s) {
    if (!s) return;
    this.bytesSaida += s.length;
    if (this.bytesSaida > this.limiteSaida) throw new AbortSig("saida");
    this.saidaBuf.push({ s: stream, t: s });
    if (this.onSaida) this.onSaida(stream, s);
  };
  KP.tirarSaida = function () { var b = this.saidaBuf; this.saidaBuf = []; return b; };
  KP.agora = function () { return this.clock; };
  KP.passo = function (n) {
    this.steps += n || 1;
    if (this.cur && !this.cur.bg && this.steps > this.limit) throw new AbortSig("passos");
  };
  KP.spawn = function (sh, fabrica, opt) {
    opt = opt || {};
    var k = this, pid = opt.pid || this.nextPid++;
    var p = new Proc(this, pid, opt.ppid || (sh.proc ? sh.proc.pid : 1));
    p.sh = sh; sh.proc = p; p.bg = !!opt.bg; p.nome = opt.nome || "bash";
    p.gen = (function* () {
      var st = 0;
      try {
        try { st = yield* fabrica(); }
        catch (e) {
          if (e instanceof ExitSig) st = e.code;
          else if (e instanceof FatalSig) st = e.code;
          else if (e instanceof KillSig) { p.porSinal = e.sig; st = 128 + e.sig; }
          else if (e instanceof SigPipe) st = 141;
          else if (e instanceof ReturnSig) st = e.code;
          else if (e instanceof BreakSig || e instanceof ContSig) st = 0;
          else throw e;
        }
        if (sh.trapSaida && !opt.semTrap) st = yield* sh.rodarTrapExit(st);
      } finally { if (!opt.manterFds) sh.fecharTudo(); }
      return st;
    })();
    this.procs.push(p);
    return p;
  };
  KP.acharProc = function (pid) { for (var i = 0; i < this.procs.length; i++) if (this.procs[i].pid === pid) return this.procs[i]; return null; };
  KP.finalizar = function (p, st) {
    if (p.done) return;
    p.done = true; p.state = "done"; p.status = st;
    var i = this.procs.indexOf(p); if (i >= 0) this.procs.splice(i, 1);
    if (p.onFim) p.onFim(p);
  };
  KP.terminar = function (p, sig) {
    if (p.done) return;
    p.porSinal = sig;
    if (p === this.cur) throw new KillSig(sig);
    try { p.gen.return(128 + sig); } catch (e) { if (!isSig(e)) throw e; }
    this.finalizar(p, 128 + sig);
  };
  // envia um sinal; devolve false se o processo não existe
  KP.sinal = function (pid, sig) {
    var p = this.acharProc(pid);
    if (!p) return false;
    if (sig === 0) return true;
    var tr = p.sh && p.sh.traps ? p.sh.traps[sig] : undefined;
    if (sig !== 9 && sig !== 19 && tr !== undefined) {
      if (tr !== "") { p.sh.pendSig.push(sig); if (p.state === "sleep") p.wake = this.clock; }
      return true;
    }
    if ([17, 18, 23, 28, 19, 20, 21, 22].indexOf(sig) >= 0) return true; // ignorados/parar (sem efeito aqui)
    if (p === this.main && p.sh && p.sh.interativo && !p.sh.subshell) return true; // o shell interativo ignora TERM/INT
    this.terminar(p, sig);
    return true;
  };
  KP.ctrlC = function () { this.intPend = true; };
  KP.entregarInt = function () {
    this.intPend = false;
    var k = this, alvos = this.procs.filter(function (p) { return !p.bg && !p.done; });
    alvos.forEach(function (p) {
      if (p.done || p === k.main) return;
      var tr = p.sh && p.sh.traps ? p.sh.traps[2] : undefined;
      if (tr !== undefined) { if (tr !== "") p.sh.pendSig.push(2); return; }
      k.terminar(p, 2);
    });
    var m = this.main;
    if (m && !m.done) {
      var trm = m.sh && !m.sh.interativo && m.sh.traps ? m.sh.traps[2] : undefined;
      if (trm !== undefined) { if (trm !== "") { m.sh.pendSig.push(2); if (m.state !== "run") { m.state = "run"; m.cond = null; } } return; }
      this.lancarEm(m, new AbortSig("int"));
    }
  };
  // lança uma exceção dentro de um processo parado (ex.: Ctrl+C / limite de passos)
  KP.lancarEm = function (p, erro) {
    if (p.done) return;
    var r;
    try { r = p.gen.throw(erro); }
    catch (e) {
      if (e instanceof AbortSig || isSig(e)) { this.finalizar(p, e instanceof AbortSig ? 130 : 1); return; }
      this.finalizar(p, 1); this.saida("err", "(simulador) erro interno: " + (e && e.message || e) + "\n"); return;
    }
    this.tratarYield(p, r);
  };
  KP.abortarFg = function (origem, motivo) {
    var k = this;
    this.procs.filter(function (p) { return !p.bg && !p.done && p !== origem && p !== k.main; }).forEach(function (p) {
      try { p.gen.return(130); } catch (e) { /* ignora */ }
      k.finalizar(p, 130);
    });
    if (this.main && !this.main.done && this.main !== origem) this.lancarEm(this.main, new AbortSig(motivo));
  };
  KP.tratarYield = function (p, r) {
    if (r.done) { this.finalizar(p, r.value); return; }
    var y = r.value || {};
    if (y.t === "block") { p.state = "block"; p.cond = y.cond; }
    else if (y.t === "sleep") { p.state = "sleep"; p.wake = this.clock + Math.max(0, y.ms); }
    else if (y.t === "in") {
      if (p.bg) { p.state = "run"; p.resume = null; }
      else { p.state = "in"; p.inReq = y; }
    }
    else { p.state = "run"; }
  };
  KP.passoProc = function (p) {
    var val = p.resume; p.resume = undefined;
    this.cur = p;
    var r;
    try { r = p.gen.next(val); }
    catch (e) {
      this.cur = null;
      if (e instanceof AbortSig) { this.finalizar(p, 130); this.abortarFg(p, e.msg); return; }
      if (e instanceof RangeError) {
        this.saida("err", "(simulador) execução interrompida: aninhamento profundo demais (recursão ou substituições demais umas dentro das outras).\n");
        this.finalizar(p, 1); this.abortarFg(p, "recursao"); return;
      }
      if (isSig(e)) { this.finalizar(p, e instanceof KillSig ? 128 + e.sig : 1); return; }
      this.finalizar(p, 1);
      this.saida("err", "(simulador) erro interno: " + (e && e.message || e) + "\n");
      if (typeof console !== "undefined" && this.debug) console.error(e);
      return;
    }
    this.cur = null;
    this.tratarYield(p, r);
  };
  KP.prontos = function (soBg) {
    var k = this, l = [];
    this.procs.forEach(function (p) {
      if (p.done) return;
      if (soBg && !p.bg) return;
      if (p.state === "block" && p.cond && p.cond()) { p.state = "run"; p.cond = null; }
      if (p.state === "sleep" && p.wake <= k.clock) p.state = "run";
      if (p.state === "run") l.push(p);
    });
    return l;
  };
  // Roda os processos. Devolve {t:'fim'} | {t:'in', req} | {t:'sleep', ms} | {t:'tick'}
  KP.pump = function (orcamento) {
    orcamento = orcamento || 5000;
    var k = this;
    while (true) {
      if (this.intPend) this.entregarInt();
      if (!this.main || this.main.done) {
        // deixa os jobs em segundo plano andarem um pouco (sem avançar o relógio)
        var n = 0, l;
        while (n < 3000 && (l = this.prontos(true)).length) { l.forEach(function (p) { if (!p.done) k.passoProc(p); }); n += l.length; }
        return { t: "fim" };
      }
      var lista = this.prontos(false);
      if (!lista.length) {
        var esperando = this.procs.filter(function (p) { return p.state === "in" && !p.done; });
        if (esperando.length) return { t: "in", req: esperando[0].inReq, proc: esperando[0] };
        var dorm = this.procs.filter(function (p) { return p.state === "sleep" && !p.done; });
        if (dorm.length) {
          var w = Math.min.apply(null, dorm.map(function (p) { return p.wake; }));
          return { t: "sleep", ms: w - this.clock, ate: w };
        }
        // impasse: ninguém pode andar (ex.: leitura de um pipe que ninguém escreve)
        this.saida("err", "(simulador) impasse: os processos ficaram esperando uns pelos outros.\n");
        this.abortarTudo();
        continue;
      }
      for (var i = 0; i < lista.length; i++) { if (!lista[i].done) this.passoProc(lista[i]); }
      orcamento -= lista.length;
      if (orcamento <= 0) return { t: "tick" };
    }
  };
  KP.abortarTudo = function () {
    var k = this;
    this.procs.filter(function (p) { return !p.bg && p !== k.main; }).forEach(function (p) { try { p.gen.return(1); } catch (e) { /* */ } k.finalizar(p, 1); });
    if (this.main && !this.main.done) this.lancarEm(this.main, new AbortSig("impasse"));
  };
  KP.darEntrada = function (proc, linha) { // linha sem \n; null = Ctrl+D
    if (linha === null) this.ttyEOF = true; else this.ttyBuf += linha + "\n";
    if (proc && proc.state === "in") { proc.state = "run"; proc.inReq = null; }
  };
  KP.avancar = function (ate) { if (ate > this.clock) this.clock = ate; };
  // Driver síncrono (Node/testes): entrada vem de uma função
  KP.rodarSync = function (entrada, maxIter) {
    var it = 0;
    while (it++ < (maxIter || 1e7)) {
      var r = this.pump(20000);
      if (r.t === "fim") return;
      if (r.t === "in") { var l = entrada ? entrada(r.req) : null; this.darEntrada(r.proc, l === undefined ? null : l); }
      else if (r.t === "sleep") this.avancar(r.ate);
    }
  };

  /* ---------- leitura e escrita em descritores ---------- */
  function escreverOFD(k, o, s) {
    if (!s) return;
    switch (o.kind) {
      case "tty-out": k.saida(o.stream, s); return;
      case "pipe-w":
        if (o.p.r === 0) throw new SigPipe();
        o.p.buf += s; return;
      case "file": {
        var no = o.no;
        if (no.d == null) { if (o.ap || o.pos >= (no.z || 0)) { no.z = (no.z || 0) + utf8len(s); no.mt = no.ct = k.clock; return; } no.d = repete("\0", Math.min(no.z, 65536)); }
        if (o.ap) o.pos = no.d.length;
        if (o.pos === no.d.length) no.d += s;
        else if (o.pos > no.d.length) no.d += repete("\0", o.pos - no.d.length) + s;
        else no.d = no.d.slice(0, o.pos) + s + no.d.slice(o.pos + s.length);
        o.pos += s.length; no.mt = no.ct = k.clock;
        return;
      }
      case "null": case "zero": case "random": return;
      default: throw new Error("EBADF");
    }
  }
  function fonteAvail(k, o) {
    switch (o.kind) {
      case "file": var d = dadosDe(o.no); return o.pos >= d.length ? "" : d.slice(o.pos);
      case "pipe-r": return o.p.buf;
      case "tty-in": case "tty-out": return k.ttyBuf;
      case "zero": return repete("\0", 4096);
      case "random": var r = ""; for (var i = 0; i < 256; i++) r += String.fromCharCode(Math.floor(Math.random() * 256)); return r;
      default: return "";
    }
  }
  function fonteTake(k, o, n) {
    switch (o.kind) {
      case "file": o.pos += n; return;
      case "pipe-r": o.p.buf = o.p.buf.slice(n); return;
      case "tty-in": case "tty-out": k.ttyBuf = k.ttyBuf.slice(n); return;
    }
  }
  function fonteEOF(k, o) {
    switch (o.kind) {
      case "file": return o.pos >= dadosDe(o.no).length;
      case "pipe-r": return o.p.buf === "" && o.p.w === 0;
      case "tty-in": case "tty-out": return k.ttyBuf === "" && k.ttyEOF;
      case "zero": case "random": return false;
      default: return true;
    }
  }
  function* fonteWait(k, o, req) {
    if (o.kind === "pipe-r") { var p = o.p; yield { t: "block", cond: function () { return p.buf !== "" || p.w === 0; } }; return; }
    if (o.kind === "tty-in" || o.kind === "tty-out") {
      var l = yield { t: "in", req: req || {} };
      if (l === null || l === undefined) { if (k.ttyBuf === "") k.ttyEOF = true; }
      return;
    }
  }
  // Lê até o delimitador (inclusive, consumido). Devolve {s, achou}
  function* lerAte(k, o, delim, max, req) {
    var acc = "";
    while (true) {
      var a = fonteAvail(k, o);
      if (a !== "") {
        var i = delim === null ? -1 : a.indexOf(delim);
        if (max != null && max >= 0) {
          var falta = max - acc.length;
          if (i < 0 || i >= falta) { if (a.length >= falta) { fonteTake(k, o, falta); return { s: acc + a.slice(0, falta), achou: true, max: true }; } }
        }
        if (i >= 0) { fonteTake(k, o, i + 1); return { s: acc + a.slice(0, i), achou: true }; }
        acc += a; fonteTake(k, o, a.length);
        continue;
      }
      if (fonteEOF(k, o)) { if (o.kind === "tty-in" || o.kind === "tty-out") k.ttyEOF = false; return { s: acc, achou: false }; }
      if (o.kind === "null" || o.kind === "pipe-w" || (o.kind === "file" && !o.rd)) return { s: acc, achou: false, erro: o.kind !== "null" };
      yield* fonteWait(k, o, req);
    }
  }
  function* lerTudo(k, o) {
    var acc = "";
    if (o.kind === "zero" || o.kind === "random") return fonteAvail(k, o);
    while (true) {
      var a = fonteAvail(k, o);
      if (a !== "") { acc += a; fonteTake(k, o, a.length); if (acc.length > 20000000) throw new AbortSig("saida"); continue; }
      if (fonteEOF(k, o)) { if (o.kind === "tty-in" || o.kind === "tty-out") k.ttyEOF = false; return acc; }
      if (o.kind === "null" || o.kind === "pipe-w" || (o.kind === "file" && !o.rd)) return acc;
      yield* fonteWait(k, o);
    }
  }

  /* ------------------------------------------------------------------
     4. Parser: tokenizador + AST
     ------------------------------------------------------------------
     Palavra = { p: [partes], raw: "texto original" }
     Partes: L (literal sem aspas), Q (literal citado), D (aspas duplas,
     com partes dentro), V (${…}/$x), C ($( )), B (crases), A ($(( ))),
     P (<( ) / >( )), ARR (lista de um array: a=( … )).
     ------------------------------------------------------------------ */
  var RESERVADAS = { "if": 1, "then": 1, "else": 1, "elif": 1, "fi": 1, "do": 1, "done": 1, "case": 1, "esac": 1, "while": 1, "until": 1, "for": 1, "select": 1, "function": 1, "time": 1, "{": 1, "}": 1, "!": 1, "[[": 1, "]]": 1, "coproc": 1 };
  var TERMINADORES = { "then": 1, "else": 1, "elif": 1, "fi": 1, "do": 1, "done": 1, "esac": 1, "}": 1 };
  var DECLARADORES = { declare: 1, typeset: 1, local: 1, export: 1, readonly: 1 };
  var CMD = { cmd: true, assign: true };

  function Parser(src, o) {
    o = o || {};
    this.s = src; this.i = 0; this.ln = o.linha || 1;
    this.inter = !!o.interativo;
    this.aliases = o.aliases || null;
    this.extglob = !!o.extglob;
    this.hd = [];
    this.la = null;
    this.aliasAtivos = [];
    this.aliasProx = false;
    this.pilha = [];
    this.avisos = [];
    this.nome = o.nome || "";
    this.dash = !!o.dash;
  }
  var PP = Parser.prototype;

  PP.fimInesperado = function (ch, linha) {
    if (this.inter) throw new Incomplete(ch);
    if (this.dash) { var ed = new SyntaxErr(ch === "'" || ch === '"' ? "Syntax error: Unterminated quoted string" : "Syntax error: end of file unexpected (expecting \")\")", null, this.ln, true); ed.dash = true; throw ed; }
    throw new SyntaxErr("encontrado EOF inesperado enquanto procurava por `" + ch + "' correspondente", null, linha || this.ln, true);
  };
  PP.eofEm = function () {
    if (this.inter) throw new Incomplete("eof");
    var topo = this.pilha.length ? this.pilha[this.pilha.length - 1] : null;
    if (topo && topo.subst && !this.dash) throw new SyntaxErr("encontrado EOF inesperado enquanto procurava por `)' correspondente", null, this.ln, true);
    if (this.dash) { var esp = topo ? ({ "if": "fi", "while": "done", "until": "done", "for": "done", "case": "esac", "{": "}", "(": ")", "function": "}" })[topo.kw] : null; var ed = new SyntaxErr("Syntax error: end of file unexpected" + (esp ? " (expecting \"" + esp + "\")" : ""), null, this.ln, true); ed.dash = true; throw ed; }
    if (topo) throw new SyntaxErr("erro de sintaxe: fim inesperado do arquivo do comando `" + topo.kw + "' na linha " + topo.ln, null, this.ln, true);
    throw new SyntaxErr("erro de sintaxe: fim prematuro do arquivo", null, this.ln, true);
  };
  PP.erroTok = function (t) {
    if (t.t === "EOF") this.eofEm();
    var txt = t.t === "NL" ? "newline" : t.t === "W" ? t.w.raw : t.t === "R" ? t.op : t.t === "ARITH" ? "((" : t.v;
    if (this.dash) { var ed = new SyntaxErr("Syntax error: " + (t.t === "NL" ? "newline" : "\"" + txt + "\"") + " unexpected", txt, t.ln, true); ed.dash = true; return ed; }
    return new SyntaxErr("erro de sintaxe próximo ao token inesperado `" + txt + "'", txt, t.ln);
  };

  /* ---------- tokenizador ---------- */
  PP.peek = function (ctx) { if (!this.la) this.la = this.lex(ctx || {}); return this.la; };
  PP.tok = function (ctx) { if (this.la) { var t = this.la; this.la = null; return t; } return this.lex(ctx || {}); };
  PP.pularBrancos = function () {
    var s = this.s;
    while (this.i < s.length) {
      var c = s[this.i];
      if (c === " " || c === "\t") { this.i++; continue; }
      if (c === "\\" && s[this.i + 1] === "\n") { this.i += 2; this.ln++; if (this.i >= s.length && this.inter) throw new Incomplete("\\"); continue; }
      if (c === "#") { while (this.i < s.length && s[this.i] !== "\n") this.i++; continue; }
      break;
    }
  };
  PP.lex = function (ctx) {
    this.pularBrancos();
    var s = this.s, ini = this.i, ln = this.ln;
    if (this.i >= s.length) return { t: "EOF", ln: ln };
    var c = s[this.i], c2 = s.substr(this.i, 2), c3 = s.substr(this.i, 3);
    if (c === "\n") { this.i++; this.ln++; this.lerHereDocs(); return { t: "NL", ln: ln }; }
    // redirecionamento com número/variável de descritor
    var m = /^([0-9]+)(?=[<>])/.exec(s.slice(this.i, this.i + 12));
    var fd = null, fdvar = null;
    if (m) { fd = +m[1]; this.i += m[1].length; }
    else if ((m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}(?=[<>])/.exec(s.slice(this.i, this.i + 80)))) { fdvar = m[1]; this.i += m[0].length; }
    c = s[this.i]; c2 = s.substr(this.i, 2); c3 = s.substr(this.i, 3);
    if ((c === "<" || c === ">") && s[this.i + 1] === "(" && fd === null && fdvar === null) return this.palavra(ctx, ini, ln);
    if (c === "}" && this.fimChave && fd === null && fdvar === null) { this.i++; return { t: "W", w: { p: [{ t: "L", v: "}" }], raw: "}" }, ln: ln }; }
    var ops = this.dash ? ["<<-", "<<", "<&", "<>", ">>", ">&", ">|", "<", ">"] : ["<<<", "<<-", "&>>", "<<", "<&", "<>", ">>", ">&", ">|", "&>", "<", ">"];
    for (var k = 0; k < ops.length; k++) {
      if (s.substr(this.i, ops[k].length) === ops[k]) {
        if ((ops[k] === "&>" || ops[k] === "&>>") && (fd !== null || fdvar !== null)) break;
        this.i += ops[k].length;
        return { t: "R", op: ops[k], fd: fd, fdvar: fdvar, ln: ln };
      }
    }
    if (fd !== null || fdvar !== null) { this.i = ini; }
    var ctl = this.dash ? [";;", ";", "&&", "&", "||", "|", "(", ")"] : [";;&", ";;", ";&", ";", "&&", "&", "||", "|&", "|", "(", ")"];
    for (k = 0; k < ctl.length; k++) {
      if (s.substr(this.i, ctl[k].length) === ctl[k]) {
        if (ctl[k] === "(" && ctx.cmd && s[this.i + 1] === "(" && !this.dash) {
          var ar = this.tentarAritmetica(this.i + 2);
          if (ar) { this.i = ar.fim; return { t: "ARITH", expr: ar.expr, ln: ln }; }
        }
        this.i += ctl[k].length;
        return { t: "O", v: ctl[k], ln: ln };
      }
    }
    return this.palavra(ctx, ini, ln);
  };
  // procura o "))" que fecha uma expressão aritmética começando em i
  PP.tentarAritmetica = function (i) {
    var s = this.s, d = 0, q = null;
    for (var j = i; j < s.length; j++) {
      var c = s[j];
      if (q) { if (c === "\\" && q === '"') { j++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === "\\") { j++; continue; }
      if (c === "(") d++;
      else if (c === ")") {
        if (d === 0) { if (s[j + 1] === ")") return { expr: s.slice(i, j), fim: j + 2 }; return null; }
        d--;
      }
    }
    if (this.inter) throw new Incomplete("((");
    if (this.emDolarArit) this.fimInesperado(")");
    return null;
  };
  PP.palavra = function (ctx, ini, ln) {
    var w = this.lerPalavra(ctx);
    var t = { t: "W", w: w, ln: ln };
    // apelidos (aliases)
    if (this.aliases && (ctx.cmd || this.aliasProx)) {
      this.aliasProx = false;
      var plain = w.p.length === 1 && w.p[0].t === "L" ? w.p[0].v : null;
      var self = this;
      this.aliasAtivos = this.aliasAtivos.filter(function (a) { return a.fim > ini; });
      if (plain !== null && hasOwn(this.aliases, plain) && !this.aliasAtivos.some(function (a) { return a.nome === plain; })) {
        var val = this.aliases[plain], fim = this.i;
        this.s = this.s.slice(0, ini) + val + this.s.slice(fim);
        var delta = val.length - (fim - ini);
        this.aliasAtivos.forEach(function (a) { a.fim += delta; });
        this.aliasAtivos.push({ nome: plain, fim: ini + val.length });
        this.i = ini;
        if (/[ \t]$/.test(val)) this.aliasProx2 = true;
        var r = this.lex(ctx);
        if (self.aliasProx2) { self.aliasProx2 = false; self.aliasProx = true; }
        return r;
      }
    } else this.aliasProx = false;
    return t;
  };

  PP.lerPalavra = function (ctx) {
    var s = this.s, ini = this.i, partes = [], lit = "";
    function flush() { if (lit) { partes.push({ t: "L", v: lit }); lit = ""; } }
    while (this.i < s.length) {
      var c = s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "<" || c === ">" || c === "(" || c === ")") {
        if ((c === "<" || c === ">") && s[this.i + 1] === "(" && this.i === ini) {
          var dir = c; this.i += 2;
          var ast = this.parseSubst(), raw = s.slice(ini, this.i);
          partes.push({ t: "P", dir: dir, ast: ast, raw: raw });
          continue;
        }
        if (c === "(") {
          if ((this.extglob || ctx.extglob) && /[?*+@!]$/.test(lit)) { lit += this.lerBalanceado(); continue; }
          if (ctx.assign && !this.dash && partes.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(lit)) {
            flush(); this.i++;
            partes.push({ t: "ARR", itens: this.lerArray() });
            continue;
          }
          if (ctx.assign && !this.dash && partes.length && /\+?=$/.test(lit) && /^[A-Za-z_][A-Za-z0-9_]*\[/.test(s.slice(ini, this.i))) {
            flush(); this.i++;
            partes.push({ t: "ARR", itens: this.lerArray() });
            continue;
          }
        }
        break;
      }
      if (c === "\\") {
        if (s[this.i + 1] === "\n") { this.i += 2; this.ln++; if (this.i >= s.length && this.inter) throw new Incomplete("\\"); continue; }
        if (this.i + 1 >= s.length) { lit += "\\"; this.i++; continue; }
        flush(); partes.push({ t: "Q", v: s[this.i + 1], esc: true }); this.i += 2; continue;
      }
      if (c === "'") { flush(); partes.push({ t: "Q", v: this.lerSimples(), sq: true }); continue; }
      if (c === '"') { flush(); partes.push({ t: "D", p: this.lerDQ() }); continue; }
      if (c === "$") { var r = this.lerDolar(false); if (r) { flush(); partes.push(r); } else { lit += "$"; this.i++; } continue; }
      if (c === "`") { flush(); partes.push(this.lerCrase()); continue; }
      if (c === "[" && ctx.assign && !this.dash && partes.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(lit)) {
        // subscrito de atribuição: a[i + 1]=x  (espaços permitidos dentro dos colchetes)
        var j = this.fimColchete(this.i);
        if (j > 0 && (s[j + 1] === "=" || (s[j + 1] === "+" && s[j + 2] === "="))) {
          var sub = s.slice(this.i, j + 1);
          var sp = new Parser(sub.slice(1, -1), { linha: this.ln });
          flush();
          partes.push({ t: "SUB", w: sp.lerAte(null, "pa"), raw: sub });
          this.i = j + 1;
          continue;
        }
      }
      if (c === "\n") this.ln++;
      lit += c; this.i++;
    }
    flush();
    return { p: partes, raw: s.slice(ini, this.i) };
  };
  PP.fimColchete = function (i) { // i aponta para "["; devolve índice do "]" correspondente ou -1
    var s = this.s, d = 0, q = null;
    for (var j = i; j < s.length; j++) {
      var c = s[j];
      if (q) { if (c === "\\" && q === '"') { j++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === "\\") { j++; continue; }
      if (c === "\n") return -1;
      if (c === "[") d++;
      else if (c === "]") { d--; if (d === 0) return j; }
    }
    return -1;
  };
  PP.lerBalanceado = function () { // a partir de "(" (extglob), devolve texto até o ")" correspondente
    var s = this.s, ini = this.i, d = 0;
    while (this.i < s.length) {
      var c = s[this.i];
      if (c === "\\") { this.i += 2; continue; }
      if (c === "(") d++;
      else if (c === ")") { d--; if (d === 0) { this.i++; return s.slice(ini, this.i); } }
      else if (c === "\n") this.ln++;
      this.i++;
    }
    this.fimInesperado(")");
  };
  PP.lerArray = function () {
    var itens = [], s = this.s;
    while (true) {
      // brancos, novas linhas e comentários
      while (this.i < s.length) {
        var c = s[this.i];
        if (c === " " || c === "\t") { this.i++; continue; }
        if (c === "\n") { this.i++; this.ln++; continue; }
        if (c === "\\" && s[this.i + 1] === "\n") { this.i += 2; this.ln++; continue; }
        if (c === "#") { while (this.i < s.length && s[this.i] !== "\n") this.i++; continue; }
        break;
      }
      if (this.i >= s.length) this.fimInesperado(")");
      if (s[this.i] === ")") { this.i++; return itens; }
      var item = { chave: null, add: false, w: null };
      if (s[this.i] === "[") {
        var j = this.fimColchete(this.i);
        if (j > 0 && (s[j + 1] === "=" || (s[j + 1] === "+" && s[j + 2] === "="))) {
          var sp = new Parser(s.slice(this.i + 1, j), { linha: this.ln });
          item.chave = sp.lerAte(null, "pa");
          item.chaveRaw = s.slice(this.i + 1, j);
          if (s[j + 1] === "+") { item.add = true; this.i = j + 3; } else this.i = j + 2;
        }
      }
      if (";&|<>(".indexOf(s[this.i]) >= 0 && s[this.i] !== "(") throw new SyntaxErr("erro de sintaxe próximo ao token inesperado `" + s[this.i] + "'", s[this.i], this.ln);
      item.w = this.lerPalavra({});
      itens.push(item);
    }
  };
  PP.lerSimples = function () {
    var s = this.s, ini = ++this.i, ln = this.ln;
    while (this.i < s.length && s[this.i] !== "'") { if (s[this.i] === "\n") this.ln++; this.i++; }
    if (this.i >= s.length) this.fimInesperado("'", ln);
    return s.slice(ini, this.i++);
  };
  PP.lerDQ = function () {
    var s = this.s, partes = [], lit = "", ln = this.ln;
    this.i++;
    function flush() { if (lit) { partes.push({ t: "L", v: lit }); lit = ""; } }
    while (true) {
      if (this.i >= s.length) this.fimInesperado('"', ln);
      var c = s[this.i];
      if (c === '"') { this.i++; break; }
      if (c === "\\") {
        var n = s[this.i + 1];
        if (n === "\n") { this.i += 2; this.ln++; continue; }
        if (n === "$" || n === "`" || n === '"' || n === "\\") { lit += n; this.i += 2; continue; }
        lit += "\\"; this.i++; continue;
      }
      if (c === "$") { var r = this.lerDolar(true); if (r) { flush(); partes.push(r); } else { lit += "$"; this.i++; } continue; }
      if (c === "`") { flush(); partes.push(this.lerCrase()); continue; }
      if (c === "\n") this.ln++;
      lit += c; this.i++;
    }
    flush();
    return partes;
  };
  PP.lerCrase = function () {
    var s = this.s, src = "", ln = this.ln;
    this.i++;
    while (true) {
      if (this.i >= s.length) this.fimInesperado("`", ln);
      var c = s[this.i];
      if (c === "`") { this.i++; break; }
      if (c === "\\" && "$`\\".indexOf(s[this.i + 1]) >= 0) { src += s[this.i + 1]; this.i += 2; continue; }
      if (c === "\n") this.ln++;
      src += c; this.i++;
    }
    return { t: "B", src: src, ln: ln };
  };
  PP.parseSubst = function () { // depois de "$(" ou "<(": lê uma lista até ")"
    var ln = this.ln;
    var la = this.la; this.la = null;
    this.pilha.push({ kw: "(", ln: ln, subst: true });
    var lista;
    try {
      lista = this.parseLista(false, { ")": 1 }, true);
      var t = this.tok(CMD);
      if (t.t === "EOF") this.fimInesperado(")", ln);
      if (!(t.t === "O" && t.v === ")")) throw this.erroTok(t);
    } finally { this.pilha.pop(); }
    this.la = la;
    return lista;
  };
  var ANSI_ESC = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  function decodificarAnsi(s, modoEcho) {
    var r = "";
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c !== "\\" || i + 1 >= s.length) { r += c; continue; }
      var n = s[++i], m;
      if (hasOwn(ANSI_ESC, n) && !(modoEcho && (n === "'" || n === '"' || n === "?"))) { r += ANSI_ESC[n]; continue; }
      if (modoEcho && n === "c") return { s: r, parar: true };
      if (n === "x" && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)))) { r += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; continue; }
      if ((n === "u" || n === "U") && (m = (n === "u" ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i + 1)))) { r += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; continue; }
      if (modoEcho && n === "0") { m = /^[0-7]{0,3}/.exec(s.slice(i + 1)); r += String.fromCharCode(parseInt(m[0] || "0", 8) & 255); i += m[0].length; continue; }
      if (modoEcho === "b" && /[1-7]/.test(n)) { m = /^[0-7]{1,3}/.exec(s.slice(i)); r += String.fromCharCode(parseInt(m[0], 8) & 255); i += m[0].length - 1; continue; }
      if (!modoEcho && /[0-7]/.test(n)) { m = /^[0-7]{1,3}/.exec(s.slice(i)); r += String.fromCharCode(parseInt(m[0], 8) & 255); i += m[0].length - 1; continue; }
      if (n === "c" && !modoEcho && i + 1 < s.length) { r += String.fromCharCode(s.charCodeAt(++i) & 31); continue; }
      r += "\\" + n;
    }
    return modoEcho ? { s: r, parar: false } : r;
  }
  PP.lerDolar = function (emDQ) {
    var s = this.s, i = this.i, n = s[i + 1], ini = i;
    if (n === "(" && s[i + 2] === "(") {
      this.emDolarArit = true;
      var ar;
      try { ar = this.tentarAritmetica(i + 3); } finally { this.emDolarArit = false; }
      if (ar) {
        var lnA = this.ln;
        this.i = ar.fim;
        for (var q = ini; q < ar.fim; q++) if (s[q] === "\n") this.ln++;
        var sp = new Parser(ar.expr, { linha: lnA });
        return { t: "A", w: sp.lerAte(null, "arith"), raw: ar.expr };
      }
    }
    if (n === "(") {
      this.i += 2;
      var ast = this.parseSubst();
      return { t: "C", ast: ast, raw: s.slice(ini + 2, this.i - 1) };
    }
    if (n === "{") return this.lerChaves(emDQ);
    if (n === "[" && !this.dash) {
      var d = 0, j = i + 1;
      for (; j < s.length; j++) { if (s[j] === "[") d++; else if (s[j] === "]") { d--; if (d === 0) break; } }
      if (j < s.length) {
        var exprB = s.slice(i + 2, j), lnB = this.ln;
        this.i = j + 1;
        return { t: "A", w: new Parser(exprB, { linha: lnB }).lerAte(null, "arith"), raw: exprB };
      }
    }
    if (n === "'" && !emDQ && !this.dash) {
      this.i++;
      var j = this.i + 1, txt = "";
      while (j < s.length && s[j] !== "'") { if (s[j] === "\\" && j + 1 < s.length) { txt += s[j] + s[j + 1]; j += 2; continue; } if (s[j] === "\n") this.ln++; txt += s[j]; j++; }
      if (j >= s.length) { this.i = j; this.fimInesperado("'"); }
      this.i = j + 1;
      return { t: "Q", v: decodificarAnsi(txt), ansi: true };
    }
    if (n === '"' && !emDQ && !this.dash) { this.i++; return { t: "D", p: this.lerDQ() }; }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      var m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i + 1, i + 200));
      this.i = i + 1 + m[0].length;
      return { t: "V", name: m[0] };
    }
    if (n !== undefined && /[0-9@*#?\-$!]/.test(n)) { this.i = i + 2; return { t: "V", name: n }; }
    return null;
  };
  // ${ … }
  PP.lerChaves = function (emDQ) {
    var s = this.s, ini = this.i, ln = this.ln;
    this.i += 2;
    // ${ comandos; } e ${| comandos; } (Bash 5.3): substituição de comando no shell atual
    if (/[ \t\n|]/.test(s[this.i] || "") && !this.dash) {
      var reply = s[this.i] === "|"; if (reply) this.i++;
      var la0 = this.la, fc0 = this.fimChave; this.la = null; this.fimChave = true;
      this.pilha.push({ kw: "${", ln: ln });
      try {
        var lista = this.parseLista(false, null, false);
        this.esperar("}");
      } finally { this.fimChave = fc0; }
      this.pilha.pop(); this.la = la0;
      return { t: "F", ast: lista, reply: reply, raw: s.slice(ini, this.i) };
    }
    var v = { t: "V", name: null, ln: ln };
    function fimRaw(self) { var d = 1, q = null, j = self.i; for (; j < s.length; j++) { var c = s[j]; if (q) { if (c === "\\" && q === '"') { j++; continue; } if (c === q) q = null; continue; } if (c === "\\") { j++; continue; } if (c === "'" && !emDQ) { q = c; continue; } if (c === '"') { q = c; continue; } if (c === "{") d++; else if (c === "}") { d--; if (d === 0) return j; } } return -1; }
    var c = s[this.i];
    if (c === "#" && s[this.i + 1] !== "}" && /[A-Za-z_0-9@*#?\-$!]/.test(s[this.i + 1] || "") && !(s[this.i + 1] === "#" && s[this.i + 2] !== "}") && !(/[\-?=+:%]/.test(s[this.i + 1]) && s[this.i + 2] !== "}" && !/[A-Za-z_0-9]/.test(s[this.i + 1]))) { v.len = true; this.i++; }
    else if (c === "!" && s[this.i + 1] !== "}" && /[A-Za-z_0-9@*#?\-$!]/.test(s[this.i + 1] || "")) { v.ind = true; this.i++; }
    var m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?\-$!])/.exec(s.slice(this.i, this.i + 200));
    if (!m) {
      var f = fimRaw(this);
      if (f < 0) { this.i = s.length; this.fimInesperado("}", ln); }
      v.bad = true; v.raw = s.slice(ini, f + 1); this.i = f + 1; return v;
    }
    v.name = m[1]; this.i += m[1].length;
    if (s[this.i] === "[" && /^[A-Za-z_]/.test(v.name)) {
      var jf = this.fimColchete(this.i);
      if (jf < 0) { var f2 = fimRaw(this); if (f2 < 0) { this.i = s.length; this.fimInesperado("}", ln); } v.bad = true; v.raw = s.slice(ini, f2 + 1); this.i = f2 + 1; return v; }
      var sub = s.slice(this.i + 1, jf);
      v.idxRaw = sub;
      if (sub === "@" || sub === "*") v.idx = sub;
      else v.idx = new Parser(sub, { linha: this.ln }).lerAte(null, "pa");
      this.i = jf + 1;
    }
    c = s[this.i];
    if (c === "}") { this.i++; v.raw = s.slice(ini, this.i); return v; }
    if (v.ind && (v.name === "@" || v.name === "*") === false && (c === "*" || c === "@") && s[this.i + 1] === "}") { v.prefixo = c; this.i += 2; v.raw = s.slice(ini, this.i); return v; }
    var ops = [":-", ":=", ":?", ":+", "-", "=", "?", "+", "##", "#", "%%", "%", "//", "/#", "/%", "/", "^^", "^", ",,", ",", "~~", "~", "@", ":"];
    var op = null;
    for (var k = 0; k < ops.length; k++) if (s.substr(this.i, ops[k].length) === ops[k]) { op = ops[k]; break; }
    if (!op || (v.len && op !== null)) {
      var f3 = fimRaw(this);
      if (f3 < 0) { this.i = s.length; this.fimInesperado("}", ln); }
      v.bad = true; v.raw = s.slice(ini, f3 + 1); this.i = f3 + 1; return v;
    }
    this.i += op.length;
    v.op = op;
    if (op === "@") {
      v.arg = s[this.i]; this.i++;
      if (s[this.i] !== "}") { var f4 = fimRaw(this); if (f4 < 0) { this.i = s.length; this.fimInesperado("}", ln); } v.bad = true; v.raw = s.slice(ini, f4 + 1); this.i = f4 + 1; return v; }
      this.i++; v.raw = s.slice(ini, this.i); return v;
    }
    if (op === ":") {
      // ${x:inicio:tamanho}
      var a1 = this.lerAte({ ":": 1, "}": 1 }, "arithpa", emDQ);
      v.off = a1;
      if (s[this.i] === ":") { this.i++; v.lenw = this.lerAte({ "}": 1 }, "arithpa", emDQ); }
      if (s[this.i] !== "}") this.fimInesperado("}", ln);
      this.i++; v.raw = s.slice(ini, this.i); return v;
    }
    if (op === "/" || op === "//" || op === "/#" || op === "/%") {
      v.arg = this.lerAte({ "/": 1, "}": 1 }, "pa", emDQ, true);
      if (s[this.i] === "/") { this.i++; v.rep = this.lerAte({ "}": 1 }, "pa", emDQ); }
      if (s[this.i] !== "}") this.fimInesperado("}", ln);
      this.i++; v.raw = s.slice(ini, this.i); return v;
    }
    v.arg = this.lerAte({ "}": 1 }, "pa", emDQ, /[#%^,]/.test(op[0]));
    if (s[this.i] !== "}") this.fimInesperado("}", ln);
    this.i++; v.raw = s.slice(ini, this.i);
    return v;
  };
  // Lê partes até um dos caracteres de parada (no nível 0). Modos:
  //  "pa"     operando de ${…}: aspas valem; espaços são literais
  //  "arith"  conteúdo de $(( )) e (( )): aspas duplas valem, o resto é literal
  //  "arithpa" operando aritmético dentro de ${x:…}
  //  "hd"     corpo de here-doc: só \ $ ` são especiais
  PP.lerAte = function (paradas, modo, emDQ, padrao) {
    var s = this.s, partes = [], lit = "", ini = this.i, prof = 0;
    function flush() { if (lit) { partes.push({ t: "L", v: lit }); lit = ""; } }
    while (this.i < s.length) {
      var c = s[this.i];
      if (paradas && prof === 0 && paradas[c]) break;
      if (modo === "arithpa" && c === "(") prof++;
      if (modo === "arithpa" && c === ")") prof--;
      if (c === "\\") {
        var n = s[this.i + 1];
        if (n === "\n") { this.i += 2; this.ln++; continue; }
        if (n === undefined) { lit += "\\"; this.i++; continue; }
        if (modo === "hd" || modo === "arith") {
          if (n === "$" || n === "`" || n === "\\") { flush(); partes.push({ t: "Q", v: n, esc: true }); this.i += 2; continue; }
          lit += "\\"; this.i++; continue;
        }
        if (emDQ && !(n === "$" || n === "`" || n === '"' || n === "\\" || n === "}")) { lit += "\\"; this.i++; continue; }
        flush(); partes.push({ t: "Q", v: n, esc: true }); this.i += 2; continue;
      }
      if (c === "$") { var r = this.lerDolar(emDQ || modo === "hd"); if (r) { flush(); partes.push(r); } else { lit += "$"; this.i++; } continue; }
      if (c === "`") { flush(); partes.push(this.lerCrase()); continue; }
      if (modo !== "hd") {
        if (c === '"' && !(modo === "pa" && emDQ && false)) {
          if (emDQ && modo === "pa") { flush(); partes.push({ t: "D", p: this.lerDQ(), emDQ: true }); continue; }
          flush(); partes.push({ t: "D", p: this.lerDQ() }); continue;
        }
        if (c === "'" && (modo === "pa" || modo === "arithpa") && (!emDQ || padrao)) { flush(); partes.push({ t: "Q", v: this.lerSimples(), sq: true }); continue; }
        if (c === "'" && modo === "arith" && false) { flush(); partes.push({ t: "Q", v: this.lerSimples(), sq: true }); continue; }
        if (modo === "pa" && c === "{" ) { prof++; }
        if (modo === "pa" && c === "}" && prof > 0) { prof--; }
      }
      if (c === "\n") this.ln++;
      lit += c; this.i++;
    }
    flush();
    return { p: partes, raw: s.slice(ini, this.i) };
  };

  /* ---------- here-docs ---------- */
  PP.lerHereDocs = function () {
    var s = this.s;
    while (this.hd.length) {
      var h = this.hd.shift(), corpo = "", achou = false, lnIni = this.ln;
      while (this.i < s.length) {
        var j = s.indexOf("\n", this.i), fimLinha = j < 0 ? s.length : j;
        var linha = s.slice(this.i, fimLinha);
        this.i = j < 0 ? s.length : j + 1; this.ln++;
        if (h.strip) linha = linha.replace(/^\t+/, "");
        if (linha === h.delim) { achou = true; break; }
        corpo += linha + "\n";
      }
      if (!achou) {
        if (this.inter) throw new Incomplete("heredoc");
        this.avisos.push({ ln: s[s.length - 1] === "\n" ? this.ln - 1 : this.ln, msg: "aviso: here-document na linha " + h.ln + " delimitado pelo fim do arquivo (desejava `" + h.delim + "')" });
      }
      if (h.quoted) h.r.hd = { texto: corpo };
      else h.r.hd = { w: new Parser(corpo, { linha: lnIni }).lerAte(null, "hd") };
    }
  };

  /* ---------- gramática ---------- */
  function plainWord(t) { return t && t.t === "W" && t.w.p.length === 1 && t.w.p[0].t === "L" ? t.w.p[0].v : null; }
  function ehRes(t, nome) { return plainWord(t) === nome; }
  PP.pularNL = function () {
    while (true) { var t = this.peek(CMD); if (t.t === "NL") { this.tok(); continue; } return t; }
  };
  // Lê uma linha de comando completa (até \n). Devolve null para linha vazia e undefined no fim.
  PP.parseLinha = function () {
    var t = this.peek(CMD);
    if (t.t === "EOF") { this.tok(); return undefined; }
    if (t.t === "NL") { this.tok(); return null; }
    var lista = this.parseLista(true);
    t = this.tok(CMD);
    if (t.t !== "NL" && t.t !== "EOF") throw this.erroTok(t);
    return lista;
  };
  PP.parseTudo = function () {
    var itens = [];
    while (true) {
      var l = this.parseLinha();
      if (l === undefined) break;
      if (l) itens = itens.concat(l.items);
    }
    return { k: "list", items: itens };
  };
  function ehTerminador(t, extra) {
    if (t.t === "O" && (t.v === ")" || t.v === ";;" || t.v === ";&" || t.v === ";;&")) return true;
    var p = plainWord(t);
    if (p !== null && (TERMINADORES[p] || (extra && extra[p]))) return true;
    return false;
  }
  PP.parseLista = function (topo, extra, vazioOk) {
    var itens = [];
    while (true) {
      var t = topo ? this.peek(CMD) : this.pularNL();
      if (t.t === "EOF") { if (topo) break; if (!itens.length && vazioOk) break; this.eofEm(); }
      if (t.t === "NL") break;
      if (ehTerminador(t, extra)) { if (!itens.length && !vazioOk) throw this.erroTok(t); break; }
      var ao = this.parseAndOr();
      t = this.peek();
      if (t.t === "O" && (t.v === ";" || t.v === "&")) {
        this.tok(); itens.push({ c: ao, bg: t.v === "&" });
        continue;
      }
      itens.push({ c: ao, bg: false });
      if (t.t === "NL") { if (topo) break; continue; }
      break;
    }
    return { k: "list", items: itens };
  };
  PP.parseAndOr = function () {
    var r = { k: "andor", p: [this.parsePipeline()], ops: [] };
    while (true) {
      var t = this.peek();
      if (t.t === "O" && (t.v === "&&" || t.v === "||")) {
        this.tok();
        var n = this.pularNL();
        if (n.t === "EOF") this.eofEm();
        r.ops.push(t.v); r.p.push(this.parsePipeline());
        continue;
      }
      return r;
    }
  };
  PP.parsePipeline = function () {
    var t = this.peek(CMD), tempo = false, tempoP = false, neg = false;
    if (ehRes(t, "time")) { this.tok(); tempo = true; t = this.peek(CMD); if (plainWord(t) === "-p") { this.tok(); tempoP = true; t = this.peek(CMD); } }
    while (ehRes(t, "!")) { this.tok(); neg = !neg; t = this.peek(CMD); }
    if ((tempo || neg) && (t.t === "NL" || t.t === "EOF" || (t.t === "O" && (t.v === ";" || t.v === "&")))) return { k: "pipe", cmds: [], neg: neg, tempo: tempo, tempoP: tempoP, amp: [] };
    var cmds = [this.parseComando()], amp = [];
    while (true) {
      t = this.peek();
      if (t.t === "O" && (t.v === "|" || t.v === "|&")) {
        this.tok();
        var n = this.pularNL();
        if (n.t === "EOF") this.eofEm();
        amp.push(t.v === "|&");
        cmds.push(this.parseComando());
        continue;
      }
      break;
    }
    return { k: "pipe", cmds: cmds, neg: neg, tempo: tempo, tempoP: tempoP, amp: amp };
  };
  PP.esperar = function (palavra) {
    var t = this.tok(CMD);
    if (ehRes(t, palavra)) return t;
    if (t.t === "EOF") this.eofEm();
    throw this.erroTok(t);
  };
  PP.parseComando = function () {
    var t = this.peek(CMD), cmd, ln = t.ln;
    var p = plainWord(t);
    if (t.t === "ARITH") {
      this.tok();
      cmd = { k: "arith", w: new Parser(t.expr, { linha: ln }).lerAte(null, "arith"), raw: t.expr, ln: ln };
    } else if (t.t === "O" && t.v === "(") {
      this.tok();
      this.pilha.push({ kw: "(", ln: ln });
      var corpo = this.parseLista(false, null, false);
      var f = this.tok(CMD);
      if (f.t === "EOF") this.eofEm();
      if (!(f.t === "O" && f.v === ")")) throw this.erroTok(f);
      this.pilha.pop();
      cmd = { k: "sub", body: corpo, ln: ln };
    } else if (p !== null && RESERVADAS[p] && t.w.raw === p && !(this.dash && /^(\[\[|\]\]|function|select|time|coproc)$/.test(p))) {
      switch (p) {
        case "if": cmd = this.parseIf(); break;
        case "while": case "until": cmd = this.parseWhile(p); break;
        case "for": cmd = this.parseFor(); break;
        case "select": cmd = this.parseFor(true); break;
        case "case": cmd = this.parseCase(); break;
        case "{": cmd = this.parseGrupo(); break;
        case "[[": cmd = this.parseCond(); break;
        case "function": return this.parseFuncao(true);
        default: this.tok(); throw this.erroTok(t);
      }
    } else if (t.t === "W" || t.t === "R") {
      return this.parseSimples();
    } else {
      this.tok();
      throw this.erroTok(t);
    }
    cmd.ln = cmd.ln || ln;
    cmd.r = this.parseRedirs();
    return cmd;
  };
  PP.parseRedirs = function () {
    var r = [];
    while (true) {
      var t = this.peek();
      if (t.t !== "R") break;
      this.tok();
      r.push(this.parseRedir(t));
    }
    return r;
  };
  PP.parseRedir = function (t) {
    var alvo = this.tok({});
    if (alvo.t !== "W") { if (alvo.t === "EOF" && !this.inter) throw new SyntaxErr("erro de sintaxe próximo ao token inesperado `newline'", "newline", alvo.ln); throw this.erroTok(alvo); }
    var r = { op: t.op, fd: t.fd, fdvar: t.fdvar, w: alvo.w, ln: t.ln };
    if (t.op === "<<" || t.op === "<<-") {
      var quoted = /['"\\]/.test(alvo.w.raw);
      var delim = alvo.w.p.map(function (x) { return x.t === "L" || x.t === "Q" ? x.v : x.t === "D" ? x.p.map(function (y) { return y.t === "L" ? y.v : y.raw ? "$" + y.raw : ""; }).join("") : x.t === "V" ? (x.raw || "$" + x.name) : ""; }).join("");
      this.hd.push({ r: r, delim: delim, strip: t.op === "<<-", quoted: quoted, ln: t.ln });
    }
    return r;
  };
  PP.parseSimples = function () {
    var cmd = { k: "simple", as: [], w: [], r: [], ln: this.peek(CMD).ln };
    while (true) {
      var semCmd = cmd.w.length === 0;
      var decl = !semCmd && plainWord({ t: "W", w: cmd.w[0] }) && DECLARADORES[cmd.w[0].p[0].v];
      var t = this.peek(semCmd ? { cmd: true, assign: true } : { assign: !!decl });
      if (t.t === "R") { this.tok(); cmd.r.push(this.parseRedir(t)); continue; }
      if (t.t === "W") {
        this.tok();
        if (semCmd) {
          var a = atribuicao(t.w);
          if (a) { cmd.as.push(a); continue; }
        }
        cmd.w.push(t.w);
        // definição de função: nome ( )
        if (cmd.w.length === 1 && cmd.as.length === 0) {
          var n = this.peek({ assign: !!(t.w.p.length === 1 && t.w.p[0].t === "L" && DECLARADORES[t.w.p[0].v]) });
          if (n.t === "O" && n.v === "(") {
            this.tok();
            var f = this.tok();
            if (!(f.t === "O" && f.v === ")")) throw this.erroTok(f);
            return this.corpoFuncao(t.w.raw, cmd.ln);
          }
        }
        continue;
      }
      if (t.t === "ARR") { this.tok(); throw this.erroTok(t); }
      if (t.t === "O" && t.v === "(" && cmd.w.length) { this.tok(); throw this.erroTok(t); }
      break;
    }
    if (!cmd.w.length && !cmd.as.length && !cmd.r.length) { var e = this.tok(); throw this.erroTok(e); }
    return cmd;
  };
  // "nome=valor", "nome+=valor", "nome[i]=valor", "nome=(…)"
  function atribuicao(w) {
    var p = w.p;
    if (!p.length || p[0].t !== "L") return null;
    var m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(p[0].v);
    var a;
    if (m) {
      var resto = p[0].v.slice(m[0].length);
      var vp = (resto ? [{ t: "L", v: resto }] : []).concat(p.slice(1));
      a = { name: m[1], add: m[2] === "+", idx: null };
      if (vp.length === 1 && vp[0].t === "ARR") { a.arr = vp[0].itens; a.val = null; }
      else a.val = { p: vp, raw: w.raw.slice(m[0].length) };
      return a;
    }
    // nome[sub]=valor
    if (p.length >= 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p[0].v) && p[1].t === "SUB") {
      var resto2 = p.slice(2);
      if (!resto2.length || resto2[0].t !== "L") return null;
      var m2 = /^(\+?)=/.exec(resto2[0].v);
      if (!m2) return null;
      var r0 = resto2[0].v.slice(m2[0].length);
      var vp2 = (r0 ? [{ t: "L", v: r0 }] : []).concat(resto2.slice(1));
      a = { name: p[0].v, add: m2[1] === "+", idx: p[1].w, idxRaw: p[1].raw.slice(1, -1) };
      if (vp2.length === 1 && vp2[0].t === "ARR") { a.arr = vp2[0].itens; a.val = null; }
      else a.val = { p: vp2, raw: "" };
      return a;
    }
    return null;
  }
  PP.corpoFuncao = function (nome, ln) {
    this.pularNL();
    var t = this.peek(CMD), p = plainWord(t);
    var composto = t.t === "ARITH" || (t.t === "O" && t.v === "(") || (p !== null && /^(if|while|until|for|select|case|\{|\[\[)$/.test(p));
    if (!composto) { if (t.t === "EOF") this.eofEm(); this.tok(); throw this.erroTok(t); }
    this.pilha.push({ kw: "function", ln: ln, fn: true });
    var corpo = this.parseComando();
    this.pilha.pop();
    return { k: "func", name: nome, body: corpo, ln: ln };
  };
  PP.parseFuncao = function () {
    var ln = this.tok(CMD).ln;
    var n = this.tok({});
    if (n.t !== "W") { if (n.t === "EOF") this.eofEm(); throw this.erroTok(n); }
    var t = this.peek();
    if (t.t === "O" && t.v === "(") {
      this.tok(); var f = this.tok();
      if (!(f.t === "O" && f.v === ")")) throw this.erroTok(f);
    }
    var fn = this.corpoFuncao(n.w.raw, ln);
    fn.kw = true;
    return fn;
  };
  PP.parseIf = function () {
    var ln = this.tok(CMD).ln;
    this.pilha.push({ kw: "if", ln: ln });
    var r = { k: "if", conds: [], bodies: [], els: null, ln: ln };
    r.conds.push(this.parseLista(false));
    this.esperar("then");
    r.bodies.push(this.parseLista(false));
    while (true) {
      var t = this.tok(CMD), p = plainWord(t);
      if (p === "elif") { r.conds.push(this.parseLista(false)); this.esperar("then"); r.bodies.push(this.parseLista(false)); continue; }
      if (p === "else") { r.els = this.parseLista(false); this.esperar("fi"); break; }
      if (p === "fi") break;
      if (t.t === "EOF") this.eofEm();
      throw this.erroTok(t);
    }
    this.pilha.pop();
    return r;
  };
  PP.parseWhile = function (kw) {
    var ln = this.tok(CMD).ln;
    this.pilha.push({ kw: kw, ln: ln });
    var cond = this.parseLista(false);
    this.esperar("do");
    var body = this.parseLista(false);
    this.esperar("done");
    this.pilha.pop();
    return { k: "while", until: kw === "until", cond: cond, body: body, ln: ln };
  };
  PP.parseFor = function (select) {
    var ln = this.tok(CMD).ln, kw = select ? "select" : "for";
    this.pilha.push({ kw: kw, ln: ln });
    var s = this.s;
    this.pularBrancos();
    if (!select && s.substr(this.i, 2) === "((") {
      var ar = this.tentarAritmetica(this.i + 2);
      if (!ar) this.fimInesperado(")");
      this.i = ar.fim;
      var partes = dividirFor(ar.expr);
      if (partes.length !== 3) throw new SyntaxErr("erro de sintaxe: requer expressão aritmética", null, ln);
      var r = { k: "arfor", ex: partes.map(function (e) { return new Parser(e, { linha: ln }).lerAte(null, "arith"); }), raws: partes, ln: ln };
      var t = this.peek(CMD);
      if (t.t === "O" && t.v === ";") this.tok();
      t = this.pularNL();
      if (ehRes(t, "{")) { this.tok(); r.body = this.parseLista(false); this.esperar("}"); }
      else { this.esperar("do"); r.body = this.parseLista(false); this.esperar("done"); }
      this.pilha.pop();
      return r;
    }
    var nt = this.tok({});
    if (nt.t !== "W") { if (nt.t === "EOF") this.eofEm(); throw this.erroTok(nt); }
    var nome = nt.w.raw;
    if (!nomeValido(nome) && select) throw new SyntaxErr("`" + nome + "': não é um identificador válido", null, nt.ln, false, true);
    var res = { k: select ? "select" : "for", name: nome, words: null, ln: ln };
    var t2 = this.peek(CMD);
    if (t2.t === "O" && t2.v === ";") { this.tok(); t2 = this.pularNL(); }
    else if (t2.t === "NL") t2 = this.pularNL();
    if (ehRes(t2, "in")) {
      this.tok();
      res.words = [];
      while (true) {
        var w = this.peek({});
        if (w.t === "W") { this.tok(); res.words.push(w.w); continue; }
        if (w.t === "O" && w.v === ";") { this.tok(); break; }
        if (w.t === "NL") { this.tok(); break; }
        if (w.t === "EOF") this.eofEm();
        this.tok(); throw this.erroTok(w);
      }
      this.pularNL();
    }
    var t3 = this.peek(CMD);
    if (ehRes(t3, "{")) { this.tok(); res.body = this.parseLista(false); this.esperar("}"); }
    else { this.esperar("do"); res.body = this.parseLista(false); this.esperar("done"); }
    this.pilha.pop();
    return res;
  };
  function dividirFor(e) {
    var r = [], d = 0, cur = "";
    for (var i = 0; i < e.length; i++) {
      var c = e[i];
      if (c === "(") d++; else if (c === ")") d--;
      if (c === ";" && d === 0) { r.push(cur); cur = ""; continue; }
      cur += c;
    }
    r.push(cur);
    return r;
  }
  PP.parseCase = function () {
    var ln = this.tok(CMD).ln;
    this.pilha.push({ kw: "case", ln: ln });
    var wt = this.tok({});
    if (wt.t !== "W") { if (wt.t === "EOF") this.eofEm(); throw this.erroTok(wt); }
    var r = { k: "case", w: wt.w, items: [], ln: ln };
    this.pularNL();
    this.esperar("in");
    while (true) {
      var t = this.pularNL();
      if (ehRes(t, "esac")) { this.tok(); break; }
      if (t.t === "EOF") this.eofEm();
      if (t.t === "O" && t.v === "(") { this.tok(); t = this.peek({}); }
      var pats = [];
      while (true) {
        var pt = this.tok({ extglob: true });
        if (pt.t !== "W") { if (pt.t === "EOF") this.eofEm(); throw this.erroTok(pt); }
        pats.push(pt.w);
        var sep = this.tok({});
        if (sep.t === "O" && sep.v === "|") continue;
        if (sep.t === "O" && sep.v === ")") break;
        if (sep.t === "EOF") this.eofEm();
        throw this.erroTok(sep);
      }
      var body = this.parseLista(false, { esac: 1 }, true);
      var item = { pats: pats, body: body, term: ";;" };
      r.items.push(item);
      var tt = this.peek(CMD);
      if (tt.t === "O" && (tt.v === ";;" || tt.v === ";&" || tt.v === ";;&")) { this.tok(); item.term = tt.v; continue; }
      if (ehRes(tt, "esac")) { this.tok(); break; }
      if (tt.t === "EOF") this.eofEm();
      this.tok(); throw this.erroTok(tt);
    }
    this.pilha.pop();
    return r;
  };
  PP.parseGrupo = function () {
    var ln = this.tok(CMD).ln;
    this.pilha.push({ kw: "{", ln: ln });
    var body = this.parseLista(false);
    this.esperar("}");
    this.pilha.pop();
    return { k: "group", body: body, ln: ln };
  };

  /* ---------- [[ expressão ]] ---------- */
  var COND_UN = { "-a": 1, "-b": 1, "-c": 1, "-d": 1, "-e": 1, "-f": 1, "-g": 1, "-h": 1, "-k": 1, "-p": 1, "-r": 1, "-s": 1, "-t": 1, "-u": 1, "-w": 1, "-x": 1, "-O": 1, "-G": 1, "-L": 1, "-S": 1, "-N": 1, "-z": 1, "-n": 1, "-o": 1, "-v": 1, "-R": 1 };
  var COND_BIN = { "==": 1, "=": 1, "!=": 1, "<": 1, ">": 1, "=~": 1, "-eq": 1, "-ne": 1, "-lt": 1, "-le": 1, "-gt": 1, "-ge": 1, "-nt": 1, "-ot": 1, "-ef": 1 };
  PP.condTok = function (regex) {
    var s = this.s;
    while (this.i < s.length && (s[this.i] === " " || s[this.i] === "\t" || (s[this.i] === "\\" && s[this.i + 1] === "\n") || s[this.i] === "\n")) {
      if (s[this.i] === "\\") { this.i++; this.ln++; } else if (s[this.i] === "\n") this.ln++;
      this.i++;
    }
    var ln = this.ln;
    if (this.i >= s.length) { if (this.inter) throw new Incomplete("[["); var eE = new SyntaxErr("encontrado EOF inesperado enquanto procurava por `]]'", null, ln, true); eE.extra = "erro de sintaxe: fim inesperado do arquivo do comando `[[' na linha " + (this.lnCond || ln); throw eE; }
    if (regex) { this.lnRegex = ln; return { t: "W", w: this.lerRegex(), ln: ln }; }
    var c2 = s.substr(this.i, 2), c = s[this.i];
    if (c2 === "&&" || c2 === "||") { this.i += 2; return { t: "O", v: c2, ln: ln }; }
    if (c === "(" || c === ")") { this.i++; return { t: "O", v: c, ln: ln }; }
    if (c === "<" || c === ">") { this.i++; return { t: "W", w: { p: [{ t: "L", v: c }], raw: c }, op: c, ln: ln }; }
    if (c === ";" || c === "|" || c === "&") { this.i++; return { t: "O", v: c, ln: ln }; }
    var w = this.lerPalavra({ extglob: true });
    return { t: "W", w: w, ln: ln };
  };
  PP.lerRegex = function () {
    var s = this.s, ini = this.i, partes = [], lit = "", d = 0;
    function flush() { if (lit) { partes.push({ t: "L", v: lit }); lit = ""; } }
    while (this.i < s.length) {
      var c = s[this.i];
      if (d === 0 && (c === " " || c === "\t" || c === "\n")) break;
      if (d === 0 && (s.substr(this.i, 2) === "&&" || s.substr(this.i, 2) === "||")) break;
      if (d === 0 && c === ")" ) break;
      if (c === "(") d++;
      if (c === ")") d--;
      if (c === "\\") { flush(); partes.push({ t: "Q", v: s[this.i + 1] || "\\", esc: true }); this.i += 2; continue; }
      if (c === "'") { flush(); partes.push({ t: "Q", v: this.lerSimples(), sq: true }); continue; }
      if (c === '"') { flush(); partes.push({ t: "D", p: this.lerDQ() }); continue; }
      if (c === "$") { var r = this.lerDolar(false); if (r) { flush(); partes.push(r); } else { lit += "$"; this.i++; } continue; }
      if (c === "\n") this.ln++;
      lit += c; this.i++;
    }
    flush();
    if (d > 0 && this.i >= s.length) {
      if (this.inter) throw new Incomplete(")");
      var e = new SyntaxErr("encontrado EOF inesperado enquanto procurava por `)' correspondente", null, this.lnRegex || this.ln, true);
      e.extra = "argumento inesperado para operador binário condicional"; e.extraLinha = this.ln;
      throw e;
    }
    return { p: partes, raw: s.slice(ini, this.i) };
  };
  PP.parseCond = function () {
    var ln = this.tok(CMD).ln, self = this;
    this.lnCond = ln;
    this.la = null;
    var look = null;
    function peekc(rx) { if (!look) look = self.condTok(rx); return look; }
    function nextc(rx) { var t = peekc(rx); look = null; return t; }
    function erro(t) {
      var txt = t.t === "W" ? t.w.raw : t.v;
      if (txt === "]]" || txt === undefined) return new SyntaxErr("erro de sintaxe na expressão condicional", null, t.ln);
      return new SyntaxErr("erro de sintaxe na expressão condicional: token inesperado `" + txt + "'", txt, t.ln, false, false, "erro de sintaxe próximo a `" + txt + "'");
    }
    function fim(t) { return t.t === "W" && t.w.raw === "]]"; }
    function ou() {
      var e = e_();
      while (true) { var t = peekc(); if (t.t === "O" && t.v === "||") { nextc(); e = { op: "or", a: e, b: e_() }; } else return e; }
    }
    function e_() {
      var e = nao();
      while (true) { var t = peekc(); if (t.t === "O" && t.v === "&&") { nextc(); e = { op: "and", a: e, b: nao() }; } else return e; }
    }
    function nao() {
      var t = peekc();
      if (t.t === "W" && t.w.raw === "!") { nextc(); return { op: "not", a: nao() }; }
      return prim();
    }
    function prim() {
      var t = nextc();
      if (t.t === "O" && t.v === "(") {
        var e = ou();
        var f = nextc();
        if (!(f.t === "O" && f.v === ")")) throw erro(f);
        return { op: "paren", a: e };
      }
      if (t.t !== "W" || fim(t)) throw erro(t);
      var raw = t.w.raw;
      if (COND_UN[raw] && !t.op) {
        var n = peekc();
        if (n.t === "W" && !fim(n)) { nextc(); return { op: "un", o: raw, a: n.w }; }
        if (fim(n)) throw new SyntaxErr("argumento inesperado `]]' para operador unário condicional", "]]", n.ln, false, false, "erro de sintaxe próximo a `]]'");
        if (n.t === "O" && (n.v === "&&" || n.v === "||" || n.v === ")")) return { op: "word", a: t.w };
        throw erro(n);
      }
      var b = peekc();
      if (b.t === "W" && !fim(b) && (COND_BIN[b.w.raw] || b.op)) {
        nextc();
        var op = b.w.raw;
        var dir = nextc(op === "=~");
        if (dir.t !== "W" || (fim(dir) && op !== "=~")) throw erro(dir);
        return { op: "bin", o: op, a: t.w, b: dir.w };
      }
      if (b.t === "W" && !fim(b)) throw new SyntaxErr("token inesperado `" + b.w.raw + "', esperava operador binário condicional", b.w.raw, b.ln, false, false, "erro de sintaxe próximo a `" + b.w.raw + "'");
      return { op: "word", a: t.w };
    }
    var t0 = peekc();
    if (fim(t0)) { nextc(); throw new SyntaxErr("erro de sintaxe próximo a `]]'", "]]", ln); }
    var expr = ou();
    var tf = nextc();
    if (!fim(tf)) throw erro(tf);
    return { k: "cond", e: expr, ln: ln };
  };

  /* ------------------------------------------------------------------
     5a. Aritmética (inteiros de 64 bits, como o Bash; mesmas mensagens)
     ------------------------------------------------------------------ */
  var HAS_BIG = typeof BigInt !== "undefined";
  var MAXS = 9007199254740991;
  function big(x) { return typeof x === "bigint" ? x : BigInt(x); }
  function norm(b) { // BigInt → número (se couber) depois de truncar para 64 bits
    if (typeof b !== "bigint") return b;
    b = BigInt.asIntN(64, b);
    if (b <= BigInt(MAXS) && b >= BigInt(-MAXS)) return Number(b);
    return b;
  }
  function seguro(n) { return typeof n === "number" && n <= MAXS && n >= -MAXS; }
  function aop(op, a, b) {
    if (typeof a === "number" && typeof b === "number") {
      var r;
      switch (op) {
        case "+": r = a + b; if (seguro(r)) return r; break;
        case "-": r = a - b; if (seguro(r)) return r; break;
        case "*": r = a * b; if (seguro(r)) return r; break;
        case "/": r = a / b; r = r < 0 ? Math.ceil(r) : Math.floor(r); return r === 0 ? 0 : r;
        case "%": r = a % b; return r === 0 ? 0 : r;
        case "<": return a < b ? 1 : 0; case ">": return a > b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0; case ">=": return a >= b ? 1 : 0;
        case "==": return a === b ? 1 : 0; case "!=": return a !== b ? 1 : 0;
        case "&": if (Math.abs(a) < 2147483648 && Math.abs(b) < 2147483648) return a & b; break;
        case "|": if (Math.abs(a) < 2147483648 && Math.abs(b) < 2147483648) return a | b; break;
        case "^": if (Math.abs(a) < 2147483648 && Math.abs(b) < 2147483648) return a ^ b; break;
      }
    }
    if (!HAS_BIG) return 0;
    var x = big(a), y = big(b);
    switch (op) {
      case "+": return norm(x + y); case "-": return norm(x - y); case "*": return norm(x * y);
      case "/": return norm(x / y); case "%": return norm(x % y);
      case "<": return x < y ? 1 : 0; case ">": return x > y ? 1 : 0;
      case "<=": return x <= y ? 1 : 0; case ">=": return x >= y ? 1 : 0;
      case "==": return x === y ? 1 : 0; case "!=": return x !== y ? 1 : 0;
      case "&": return norm(x & y); case "|": return norm(x | y); case "^": return norm(x ^ y);
      case "<<": return norm(x << (y & BigInt(63)));
      case ">>": return norm(x >> (y & BigInt(63)));
      case "**": { var r2 = BigInt(1), base = x, e = y; while (e > BigInt(0)) { if (e & BigInt(1)) r2 = BigInt.asIntN(64, r2 * base); base = BigInt.asIntN(64, base * base); e >>= BigInt(1); } return norm(r2); }
    }
    return 0;
  }
  function verdade(v) { return typeof v === "bigint" ? v !== BigInt(0) : v !== 0; }
  function numStr(v) { return String(v); }

  function ArithErr(msg, tok) { this.msg = msg; this.tok = tok; }

  // ctx: { get(nome, idx) → string, set(nome, idx, valor) , idx(nomeArray, exprIdx) }
  function Arith(expr, ctx, nivel) {
    this.e = expr; this.ctx = ctx; this.p = 0; this.lasttp = 0; this.tok = null; this.tv = null; this.nivel = nivel || 0;
  }
  var AP = Arith.prototype;
  AP.erro = function (msg, tok) {
    var e = new ArithErr(msg, tok !== undefined ? tok : this.e.slice(this.lasttp));
    // a expressão mostrada: sem os brancos do começo (e também do fim, nos erros de número)
    e.expr = tok !== undefined ? this.e.replace(/^[ \t\n]+|[ \t\n]+$/g, "") : this.e.replace(/^[ \t\n]+/, "");
    throw e;
  };
  AP.ler = function () {
    var e = this.e, p = this.p;
    while (p < e.length && /[ \t\n]/.test(e[p])) p++;
    if (p >= e.length) { this.p = p; this.tok = "EOF"; return; }
    this.lasttp = p;
    var c = e[p], m;
    if (/[0-9]/.test(c)) {
      m = /^[0-9]+(#[0-9A-Za-z@_]*)?|^0[xX][0-9A-Za-z]*/.exec(e.slice(p));
      var txt = /^0[xX]/.test(e.slice(p)) ? /^0[xX][0-9A-Za-z@_]*/.exec(e.slice(p))[0] : /^[0-9]+(#[0-9A-Za-z@_]*)?[0-9A-Za-z@_]*/.exec(e.slice(p))[0];
      this.p = p + txt.length;
      this.tok = "NUM"; this.tv = this.numero(txt);
      return;
    }
    if (/[A-Za-z_]/.test(c)) {
      m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(e.slice(p));
      this.p = p + m[0].length;
      this.tok = "VAR"; this.tv = { nome: m[0], idx: null };
      // subscrito
      var q = this.p; while (q < e.length && /[ \t]/.test(e[q])) q++;
      if (e[this.p] === "[") {
        var d = 0, j = this.p;
        for (; j < e.length; j++) { if (e[j] === "[") d++; else if (e[j] === "]") { d--; if (d === 0) break; } }
        if (j >= e.length) { this.erro("subscrito de array incorreto"); }
        this.tv.idx = e.slice(this.p + 1, j);
        this.p = j + 1;
      }
      return;
    }
    var ops = ["<<=", ">>=", "**", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "*=", "/=", "%=", "+=", "-=", "&=", "^=", "|=", "+", "-", "*", "/", "%", "<", ">", "=", "!", "~", "&", "^", "|", "?", ":", "(", ")", ","];
    for (var i = 0; i < ops.length; i++) if (e.substr(p, ops[i].length) === ops[i]) { this.p = p + ops[i].length; this.tok = ops[i]; return; }
    this.p = p + 1; this.tok = "BAD"; this.tv = c;
  };
  AP.numero = function (txt) {
    var base = 10, dig = txt, m;
    if ((m = /^([0-9]+)#(.*)$/.exec(txt))) {
      base = parseInt(m[1], 10); dig = m[2];
      if (base < 2 || base > 64) this.erro("base aritmética inválida", txt);
      if (dig === "") this.erro("número inválido", txt);
    } else if (/^0[xX]/.test(txt)) { base = 16; dig = txt.slice(2); if (dig === "") this.erro("número inválido", txt); }
    else if (txt.length > 1 && txt[0] === "0") { base = 8; dig = txt.slice(1); }
    var v = 0, vb = null;
    for (var i = 0; i < dig.length; i++) {
      var c = dig[i], d;
      if (/[0-9]/.test(c)) d = c.charCodeAt(0) - 48;
      else if (/[a-z]/.test(c)) d = c.charCodeAt(0) - 97 + 10;
      else if (/[A-Z]/.test(c)) d = base <= 36 ? c.charCodeAt(0) - 65 + 10 : c.charCodeAt(0) - 65 + 36;
      else if (c === "@") d = 62; else if (c === "_") d = 63; else d = 99;
      if (d >= base) this.erro("valor muito grande para esta base de numeração", txt);
      if (vb === null) { v = v * base + d; if (v > MAXS) { vb = BigInt(Math.floor(v / base)) * BigInt(base) + BigInt(d); } }
      else vb = BigInt.asIntN(64, vb * BigInt(base) + BigInt(d));
    }
    return vb !== null ? norm(vb) : v;
  };
  AP.valorVar = function (t) {
    var s = this.ctx.get(t.nome, t.idx);
    if (s === null || s === undefined || s === "") return 0;
    if (/^\s*-?[0-9]+\s*$/.test(s) && !/^\s*-?0[0-9]/.test(s)) { var n = parseInt(s, 10); if (seguro(n)) return n; }
    if (this.nivel > 60) { var e = new ArithErr("excedido o nível de recursividade da expressão", t.nome); e.expr = t.nome; throw e; }
    var sub = new Arith(s, this.ctx, this.nivel + 1);
    return sub.avaliar();
  };
  AP.avaliar = function () {
    this.ler();
    if (this.tok === "EOF") return 0;
    var v = this.virgula(true);
    if (this.tok === "BAD") this.erro("erro de sintaxe aritmética: operador aritmético inválido");
    if (this.tok !== "EOF") this.erro("erro de sintaxe aritmética na expressão");
    return v;
  };
  AP.virgula = function (ev) {
    var v = this.atrib(ev);
    while (this.tok === ",") { this.ler(); v = this.atrib(ev); }
    return v;
  };
  var ATRIB = { "=": 1, "*=": 1, "/=": 1, "%=": 1, "+=": 1, "-=": 1, "<<=": 1, ">>=": 1, "&=": 1, "^=": 1, "|=": 1 };
  AP.atrib = function (ev) {
    var ini = this.lasttp, salvo = { p: this.p, tok: this.tok, tv: this.tv, lasttp: this.lasttp };
    if (this.tok === "VAR") {
      var alvo = this.tv;
      this.ler();
      if (ATRIB[this.tok]) {
        var op = this.tok;
        this.ler();
        var rhs = this.atrib(ev);
        if (!ev) return 0;
        var novo = rhs;
        if (op !== "=") {
          var atual = this.valorVar(alvo), o = op.slice(0, -1);
          if ((o === "/" || o === "%") && !verdade(rhs)) this.erro("divisão por 0");
          novo = this.bin(o, atual, rhs);
        }
        this.ctx.set(alvo.nome, alvo.idx, numStr(novo));
        return novo;
      }
      this.p = salvo.p; this.tok = salvo.tok; this.tv = salvo.tv; this.lasttp = salvo.lasttp;
    }
    var v = this.cond(ev);
    if (ATRIB[this.tok]) this.erro("tentativa de atribuição para algo que não é uma variável");
    return v;
  };
  AP.bin = function (o, a, b) {
    if (o === "<<" || o === ">>") {
      if (typeof a === "number" && typeof b === "number" && b >= 0 && b < 31 && Math.abs(a) < 1073741824 && o === ">>") return a >> b;
      return HAS_BIG ? aop(o, a, b) : 0;
    }
    if (o === "**") {
      if ((typeof b === "number" ? b : Number(b)) < 0) this.erro("exponente menor que 0");
      if (typeof a === "number" && typeof b === "number") { var r = Math.pow(a, b); if (seguro(r)) return r; }
      return aop("**", a, b);
    }
    return aop(o, a, b);
  };
  AP.cond = function (ev) {
    var c = this.lor(ev);
    if (this.tok === "?") {
      this.ler();
      var t = verdade(c);
      if (this.tok === ":") this.erro("erro de sintaxe aritmética: esperava operando");
      var a = this.virgula(ev && t);
      if (this.tok !== ":") this.erro("esperava `:' para expressão condicional");
      this.ler();
      var b = this.cond(ev && !t);
      return t ? a : b;
    }
    return c;
  };
  AP.lor = function (ev) {
    var v = this.land(ev);
    while (this.tok === "||") { this.ler(); var t = verdade(v); var w = this.land(ev && !t); v = t || verdade(w) ? 1 : 0; }
    return v;
  };
  AP.land = function (ev) {
    var v = this.bor(ev);
    while (this.tok === "&&") { this.ler(); var t = verdade(v); var w = this.bor(ev && t); v = t && verdade(w) ? 1 : 0; }
    return v;
  };
  AP.nivelBin = function (ops, prox) {
    var self = this;
    return function (ev) {
      var v = prox.call(self, ev);
      while (ops.indexOf(self.tok) >= 0) {
        var o = self.tok; self.ler();
        var w = prox.call(self, ev);
        if (ev) {
          if ((o === "/" || o === "%") && !verdade(w)) self.erro("divisão por 0");
          v = self.bin(o, v, w);
        }
      }
      return v;
    };
  };
  AP.bor = function (ev) { return this.nivelBin(["|"], this.bxor)(ev); };
  AP.bxor = function (ev) { return this.nivelBin(["^"], this.band)(ev); };
  AP.band = function (ev) { return this.nivelBin(["&"], this.igual)(ev); };
  AP.igual = function (ev) { return this.nivelBin(["==", "!="], this.compara)(ev); };
  AP.compara = function (ev) { return this.nivelBin(["<", ">", "<=", ">="], this.desloca)(ev); };
  AP.desloca = function (ev) { return this.nivelBin(["<<", ">>"], this.soma)(ev); };
  AP.soma = function (ev) { return this.nivelBin(["+", "-"], this.mult)(ev); };
  AP.mult = function (ev) { return this.nivelBin(["*", "/", "%"], this.pot)(ev); };
  AP.pot = function (ev) {
    var v = this.unario(ev);
    if (this.tok === "**") {
      this.ler();
      var w = this.pot(ev);
      if (ev) v = this.bin("**", v, w);
    }
    return v;
  };
  AP.unario = function (ev) {
    var t = this.tok;
    if (t === "!") { this.ler(); var v = this.unario(ev); return verdade(v) ? 0 : 1; }
    if (t === "~") { this.ler(); var v2 = this.unario(ev); return typeof v2 === "number" && Math.abs(v2) < 2147483648 ? ~v2 : norm(~big(v2)); }
    if (t === "-") { this.ler(); var v3 = this.unario(ev); return typeof v3 === "number" ? (v3 === 0 ? 0 : -v3) : norm(-v3); }
    if (t === "+") { this.ler(); return this.unario(ev); }
    if (t === "++" || t === "--") {
      this.ler();
      if (this.tok !== "VAR") this.erro("esperava identificador após pré-acréscimo ou pré-decréscimo");
      var alvo = this.tv; this.ler();
      if (!ev) return 0;
      var n = aop(t === "++" ? "+" : "-", this.valorVar(alvo), 1);
      this.ctx.set(alvo.nome, alvo.idx, numStr(n));
      return n;
    }
    return this.prim(ev);
  };
  AP.prim = function (ev) {
    var t = this.tok;
    if (t === "(") {
      this.ler();
      var v = this.virgula(ev);
      if (this.tok !== ")") this.erro("esperava `)'");
      this.ler();
      return v;
    }
    if (t === "NUM") { var n = this.tv; this.ler(); return n; }
    if (t === "VAR") {
      var alvo = this.tv;
      this.ler();
      if (this.tok === "++" || this.tok === "--") {
        var op = this.tok; this.ler();
        if (!ev) return 0;
        var atual = this.valorVar(alvo);
        this.ctx.set(alvo.nome, alvo.idx, numStr(aop(op === "++" ? "+" : "-", atual, 1)));
        return atual;
      }
      return ev ? this.valorVar(alvo) : 0;
    }
    if (t === "EOF" || t === ")" ) this.erro("erro de sintaxe aritmética: esperava operando");
    if (t === "BAD") this.erro("erro de sintaxe aritmética: operador aritmético inválido");
    this.erro("erro de sintaxe aritmética: esperava operando");
  };

  /* ------------------------------------------------------------------
     5b. Padrões (curingas e extglob). O padrão é uma string em que
     caracteres citados vêm escapados com "\".
     ------------------------------------------------------------------ */
  // classes Unicode criadas em tempo de execução (navegadores antigos não entendem \p{…} literal)
  function reU(src) { try { return new RegExp(src, "u"); } catch (e) { return new RegExp(src.replace(/\\p\{Lu\}/g, "A-ZÀ-ÖØ-Þ").replace(/\\p\{Ll\}/g, "a-zß-öø-ÿ").replace(/\\p\{L\}/g, "A-Za-zÀ-ÖØ-öø-ÿ").replace(/\\p\{N\}/g, "0-9")); } }
  var RE_L = reU("^\\p{L}$"), RE_LN = reU("^[\\p{L}0-9]$"), RE_LU = reU("^\\p{Lu}$"), RE_LL = reU("^\\p{Ll}$"), RE_W = reU("^[\\p{L}0-9_]$");
  var CLASSES = {
    alpha: function (c) { return RE_L.test(c); }, digit: function (c) { return /[0-9]/.test(c); },
    alnum: function (c) { return RE_LN.test(c); }, upper: function (c) { return RE_LU.test(c); },
    lower: function (c) { return RE_LL.test(c); }, space: function (c) { return /[ \t\n\r\f\v]/.test(c); },
    blank: function (c) { return c === " " || c === "\t"; }, punct: function (c) { return /[!-\/:-@\[-`{-~]/.test(c); },
    xdigit: function (c) { return /[0-9A-Fa-f]/.test(c); }, cntrl: function (c) { return /[\x00-\x1f\x7f]/.test(c); },
    print: function (c) { return !/[\x00-\x1f\x7f]/.test(c); }, graph: function (c) { return !/[\x00-\x20\x7f]/.test(c); },
    word: function (c) { return RE_W.test(c); }
  };
  function compilarPadrao(p, ext) {
    var toks = [], i = 0;
    function lerColchete(j) { // j aponta para "[" ; devolve {tok, fim} ou null
      var k = j + 1, neg = false, itens = [];
      if (p[k] === "!" || p[k] === "^") { neg = true; k++; }
      var primeiro = true;
      while (k < p.length) {
        var c = p[k];
        if (c === "]" && !primeiro) return { tok: { t: "cls", neg: neg, itens: itens }, fim: k + 1 };
        primeiro = false;
        if (c === "[" && p[k + 1] === ":") {
          var f = p.indexOf(":]", k + 2);
          if (f > 0) { var nome = p.slice(k + 2, f); itens.push({ cls: CLASSES[nome] || function () { return false; } }); k = f + 2; continue; }
        }
        if (c === "\\" && k + 1 < p.length) { c = p[k + 1]; k++; }
        if (p[k + 1] === "-" && p[k + 2] !== undefined && p[k + 2] !== "]") {
          var fimC = p[k + 2]; var adv = 3;
          if (fimC === "\\" && k + 3 < p.length) { fimC = p[k + 3]; adv = 4; }
          itens.push({ de: c, ate: fimC }); k += adv; continue;
        }
        itens.push({ c: c }); k++;
      }
      return null;
    }
    while (i < p.length) {
      var c = p[i];
      if (c === "\\") { if (i + 1 < p.length) { toks.push({ t: "lit", c: p[i + 1] }); i += 2; } else { toks.push({ t: "lit", c: "\\" }); i++; } continue; }
      if (ext && "?*+@!".indexOf(c) >= 0 && p[i + 1] === "(") {
        // extglob: acha o ")" correspondente e as alternativas
        var d = 0, k = i + 1, alts = [], ini = i + 2;
        for (; k < p.length; k++) {
          if (p[k] === "\\") { k++; continue; }
          if (p[k] === "(") d++;
          else if (p[k] === ")") { d--; if (d === 0) break; }
          else if (p[k] === "|" && d === 1) { alts.push(p.slice(ini, k)); ini = k + 1; }
        }
        if (k < p.length) {
          alts.push(p.slice(ini, k));
          toks.push({ t: "ext", op: c, alts: alts.map(function (a) { return compilarPadrao(a, ext); }) });
          i = k + 1; continue;
        }
      }
      if (c === "*") { if (!(toks.length && toks[toks.length - 1].t === "star")) toks.push({ t: "star" }); i++; continue; }
      if (c === "?") { toks.push({ t: "any" }); i++; continue; }
      if (c === "[") { var r = lerColchete(i); if (r) { toks.push(r.tok); i = r.fim; continue; } }
      toks.push({ t: "lit", c: c }); i++;
    }
    return toks;
  }
  function casaCls(tok, ch, nc) {
    var ok = false;
    for (var i = 0; i < tok.itens.length && !ok; i++) {
      var it = tok.itens[i];
      if (it.cls) ok = it.cls(ch);
      else if (it.de !== undefined) { var cp = ch.codePointAt(0); ok = cp >= it.de.codePointAt(0) && cp <= it.ate.codePointAt(0); if (!ok && nc) { var o = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(); cp = o.codePointAt(0); ok = cp >= it.de.codePointAt(0) && cp <= it.ate.codePointAt(0); } }
      else ok = nc ? it.c.toLowerCase() === ch.toLowerCase() : it.c === ch;
    }
    return tok.neg ? !ok : ok;
  }
  // casa toks[ti..] com s[si..] inteiro
  function casarToks(toks, ti, s, si, nc, memo) {
    var chave = ti * (s.length + 1) + si;
    if (memo[chave] !== undefined) return memo[chave];
    var r = casarToks2(toks, ti, s, si, nc, memo);
    memo[chave] = r;
    return r;
  }
  function casarToks2(toks, ti, s, si, nc, memo) {
    while (ti < toks.length) {
      var t = toks[ti];
      if (t.t === "lit") { if (si < s.length && (nc ? s[si].toLowerCase() === t.c.toLowerCase() : s[si] === t.c)) { ti++; si++; continue; } return false; }
      if (t.t === "any") { if (si < s.length) { ti++; si++; continue; } return false; }
      if (t.t === "cls") { if (si < s.length && casaCls(t, s[si], nc)) { ti++; si++; continue; } return false; }
      if (t.t === "star") {
        if (ti === toks.length - 1) return true;
        for (var k = si; k <= s.length; k++) if (casarToks(toks, ti + 1, s, k, nc, memo)) return true;
        return false;
      }
      if (t.t === "ext") {
        for (var fim = si; fim <= s.length; fim++) {
          if (casaExt(t, s.slice(si, fim), nc) && casarToks(toks, ti + 1, s, fim, nc, memo)) return true;
        }
        return false;
      }
    }
    return si === s.length;
  }
  function casaAlguma(alts, s, nc) { for (var i = 0; i < alts.length; i++) if (casarToks(alts[i], 0, s, 0, nc, {})) return true; return false; }
  function casaExt(t, sub, nc) {
    switch (t.op) {
      case "@": return casaAlguma(t.alts, sub, nc);
      case "?": return sub === "" || casaAlguma(t.alts, sub, nc);
      case "!": return !casaAlguma(t.alts, sub, nc);
      case "*": case "+":
        if (sub === "") return t.op === "*";
        for (var k = 1; k <= sub.length; k++) {
          if (casaAlguma(t.alts, sub.slice(0, k), nc) && (k === sub.length || casaExt({ op: "*", alts: t.alts }, sub.slice(k), nc))) return true;
        }
        return false;
    }
    return false;
  }
  var cachePadrao = {};
  function casaPadrao(pat, s, opts) {
    opts = opts || {};
    var chave = (opts.ext ? "1" : "0") + pat, toks = cachePadrao[chave];
    if (!toks) { toks = compilarPadrao(pat, opts.ext); if (Object.keys(cachePadrao).length > 2000) cachePadrao = {}; cachePadrao[chave] = toks; }
    return casarToks(toks, 0, s, 0, !!opts.nc, {});
  }
  function temCuringa(pat, ext) {
    for (var i = 0; i < pat.length; i++) {
      var c = pat[i];
      if (c === "\\") { i++; continue; }
      if (c === "*" || c === "?") return true;
      if (c === "[" && pat.indexOf("]", i + 2) > 0) return true;
      if (ext && "+@!".indexOf(c) >= 0 && pat[i + 1] === "(") return true;
    }
    return false;
  }
  function tirarBarras(pat) { return pat.replace(/\\(.)/g, "$1"); }
  function escaparPadrao(s) { return s.replace(/[\\*?\[\]+@!()|]/g, "\\$&"); }

  /* ERE (POSIX) → RegExp do JavaScript */
  function ereParaJs(re, opts) {
    opts = opts || {};
    var out = "", i = 0, bre = !!opts.bre;
    while (i < re.length) {
      var c = re[i];
      if (c === "\\") {
        var n = re[i + 1];
        if (n === undefined) { out += "\\\\"; i++; continue; }
        if (bre) {
          if (n === "(" || n === ")" || n === "|" || n === "{" || n === "}") { out += n; i += 2; continue; }
          if (n === "+" || n === "?") { out += n; i += 2; continue; }
        }
        if (n === "<") { out += "\\b(?=\\w)"; i += 2; continue; }
        if (n === ">") { out += "\\b(?<=\\w)"; i += 2; continue; }
        if (n === "w" || n === "W" || n === "s" || n === "S" || n === "b" || n === "B") { out += "\\" + n; i += 2; continue; }
        if (/[1-9]/.test(n)) { out += "\\" + n; i += 2; continue; }
        if (n === "n") { out += "\\n"; i += 2; continue; }
        if (n === "t") { out += "\\t"; i += 2; continue; }
        out += /[A-Za-z0-9]/.test(n) ? n : "\\" + n; i += 2; continue;
      }
      if (c === "[") {
        var k = i + 1, cls = "[";
        if (re[k] === "^") { cls += "^"; k++; }
        if (re[k] === "]") { cls += "\\]"; k++; }
        while (k < re.length && re[k] !== "]") {
          if (re[k] === "[" && re[k + 1] === ":") {
            var f = re.indexOf(":]", k);
            if (f > 0) {
              var nome = re.slice(k + 2, f);
              cls += ((opts.ascii ? { alpha: "A-Za-z", digit: "0-9", alnum: "A-Za-z0-9", upper: "A-Z", lower: "a-z", space: " \\t\\n\\r\\f\\v", blank: " \\t", punct: "!-\\/:-@\\[-`{-~", xdigit: "0-9A-Fa-f", cntrl: "\\x00-\\x1f\\x7f", print: "\\x20-\\x7e", graph: "\\x21-\\x7e" } : { alpha: "\\p{L}", digit: "0-9", alnum: "\\p{L}0-9", upper: "\\p{Lu}", lower: "\\p{Ll}", space: "\\s", blank: " \\t", punct: "!-\\/:-@\\[-`{-~", xdigit: "0-9A-Fa-f", cntrl: "\\x00-\\x1f", print: "\\x20-\\x7e\\u00a0-\\uffff", graph: "\\x21-\\x7e\\u00a1-\\uffff" }))[nome] || "";
              k = f + 2; continue;
            }
          }
          if (re[k] === "\\" || re[k] === "[" || (re[k] === "]")) { cls += "\\" + re[k]; k++; continue; }
          cls += re[k]; k++;
        }
        if (k >= re.length) { if (opts.estrito !== false) return null; out += "\\["; i++; continue; }
        out += cls + "]"; i = k + 1; continue;
      }
      if (bre) {
        if (c === "(" || c === ")" || c === "|" || c === "{" || c === "}" || c === "+" || c === "?") { out += "\\" + c; i++; continue; }
        if (c === "*" && (out === "" || out === "^" || /\\\($/.test(out))) { out += "\\*"; i++; continue; }
      } else {
        if (c === "{" && !/^\{[0-9]*(,[0-9]*)?\}/.test(re.slice(i))) { out += "\\{"; i++; continue; }
        if ((c === "*" || c === "+" || c === "?") && (out === "" || out === "^" || out.slice(-1) === "(" || out.slice(-1) === "|")) { out += "\\" + c; i++; continue; }
      }
      if (c === "/" ) { out += "\\/"; i++; continue; }
      out += c; i++;
    }
    return out;
  }
  function criarRegex(src, flags) {
    if (src === null || src === undefined) return null;
    try { return new RegExp(src, (flags || "") + "u"); } catch (e) { try { return new RegExp(src, flags || ""); } catch (e2) { return null; } }
  }

  /* ------------------------------------------------------------------
     6. O shell: estado, variáveis, caminhos
     ------------------------------------------------------------------ */
  function Var(v, at) { this.v = v; this.at = at || {}; }
  function copiaVar(x) {
    var v = x.v;
    if (Array.isArray(v)) v = v.slice();
    else if (v instanceof Map) v = new Map(v);
    var at = {}; for (var k in x.at) at[k] = x.at[k];
    var n = new Var(v, at);
    if (x.local) n.local = x.local;
    return n;
  }
  var SHOPT_PADRAO = {
    autocd: 0, cdable_vars: 0, cdspell: 0, checkhash: 0, checkjobs: 0, checkwinsize: 1, cmdhist: 1, compat31: 0, compat32: 0, compat40: 0, compat41: 0, compat42: 0, compat43: 0, compat44: 0,
    complete_fullquote: 1, direxpand: 0, dirspell: 0, dotglob: 0, execfail: 0, expand_aliases: 0, extdebug: 0, extglob: 0, extquote: 1, failglob: 0, force_fignore: 1, globasciiranges: 1, globskipdots: 1, globstar: 0,
    gnu_errfmt: 0, histappend: 0, histreedit: 0, histverify: 0, hostcomplete: 1, huponexit: 0, inherit_errexit: 0, interactive_comments: 1, lastpipe: 0, lithist: 0, localvar_inherit: 0, localvar_unset: 0,
    login_shell: 0, mailwarn: 0, no_empty_cmd_completion: 0, nocaseglob: 0, nocasematch: 0, noexpand_translation: 0, nullglob: 0, patsub_replacement: 1, progcomp: 1, progcomp_alias: 0, promptvars: 1,
    restricted_shell: 0, shift_verbose: 0, sourcepath: 1, varredir_close: 0, xpg_echo: 0, array_expand_once: 0, bash_source_fullpath: 0
  };
  var SET_O = ["allexport", "braceexpand", "emacs", "errexit", "errtrace", "functrace", "hashall", "histexpand", "history", "ignoreeof", "interactive-comments", "keyword", "monitor", "noclobber", "noexec", "noglob", "nolog", "notify", "nounset", "onecmd", "physical", "pipefail", "posix", "privileged", "verbose", "vi", "xtrace"];
  var SET_LETRA = { a: "allexport", B: "braceexpand", e: "errexit", E: "errtrace", T: "functrace", h: "hashall", H: "histexpand", C: "noclobber", n: "noexec", f: "noglob", u: "nounset", v: "verbose", x: "xtrace", m: "monitor", b: "notify", k: "keyword", P: "physical", p: "privileged", t: "onecmd" };

  function Shell(k, o) {
    o = o || {};
    this.k = k; this.fs = k.fs;
    this.globais = Object.create(null);
    this.pilhaLocal = [];
    this.funcs = Object.create(null);
    this.aliases = Object.create(null);
    this.o = { braceexpand: 1, hashall: 1, "interactive-comments": 1 };
    this.shopt = {}; for (var s in SHOPT_PADRAO) this.shopt[s] = SHOPT_PADRAO[s];
    this.cwd = HOME; this.cwdLogico = HOME;
    this.pos = []; this.arg0 = "bash";
    this.fds = [];
    this.status = 0; this.pipestatus = [0];
    this.traps = Object.create(null);
    this.pendSig = [];
    this.jobs = []; this.proxJob = 1;
    this.interativo = !!o.interativo;
    this.subshell = 0;
    this.lineno = 1;
    this.funcStack = []; // {nome, fonte, linha}
    this.fonteStack = []; // nomes de arquivo (BASH_SOURCE)
    this.loopNivel = 0;
    this.dirStack = [];
    this.hist = []; this.histBase = 1;
    this.inicio = k.clock;
    this.ultimoBg = null;
    this.ultimoArg = "";
    this.umask = 2;
    this.hash = Object.create(null);
    this.semErrexit = 0;
    this.trapSaida = false;
    this.rnd = (Math.floor(k.clock / 1000) ^ 3001) & 0x7fffffff; this.ultimoRnd = -1;
    this.nome0 = "bash"; // nome usado nas mensagens de erro
    this.modoC = false;
    if (!o.semVars) this.varsIniciais();
  }
  var SP = Shell.prototype;
  SP.varsIniciais = function () {
    var self = this;
    function g(n, v, at) { self.globais[n] = new Var(v, at); }
    var exp = { x: true };
    g("HOME", HOME, exp); g("USER", USER, exp); g("LOGNAME", USER, exp); g("SHELL", "/bin/bash", exp);
    g("LANG", "pt_BR.UTF-8", exp); g("LANGUAGE", "pt_BR:pt:en", exp); g("TZ", "America/Sao_Paulo", exp); g("TERM", "xterm-256color", exp); g("EDITOR", "nano", exp);
    g("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", exp);
    g("PWD", HOME, exp); g("SHLVL", "1", exp);
    g("HOSTNAME", HOST); g("HOSTTYPE", "x86_64"); g("MACHTYPE", "x86_64-pc-linux-gnu"); g("OSTYPE", "linux-gnu");
    g("BASH", "/usr/bin/bash"); g("BASH_VERSION", BASH_VERSION);
    g("BASH_VERSINFO", ["5", "3", "9", "1", "release", "x86_64-pc-linux-gnu"], { a: true, r: true });
    g("IFS", " \t\n"); g("PS1", "\\u@\\h:\\w\\$ "); g("PS2", "> "); g("PS4", "+ ");
    g("OPTIND", "1"); g("OPTERR", "1");
    g("UID", "1000", { i: true, r: true }); g("EUID", "1000", { i: true, r: true }); g("PPID", "2950", { i: true, r: true });
    g("HISTFILE", HOME + "/.bash_history"); g("HISTSIZE", "500"); g("HISTFILESIZE", "500");
    g("COLUMNS", "80"); g("LINES", "24");
    g("BASH_ARGC", [], { a: true }); g("BASH_ARGV", [], { a: true }); g("BASH_LINENO", [], { a: true }); g("BASH_SOURCE", [], { a: true });
    g("DIRSTACK", [], { a: true }); g("GROUPS", ["1000"], { a: true }); g("PIPESTATUS", ["0"], { a: true });
  };
  // cópia para subshell / processo filho
  SP.fork = function (opt) {
    opt = opt || {};
    var n = Object.create(SP);
    Shell.call(n, this.k, { semVars: true });
    var self = this;
    function copiaEscopo(src) { var d = Object.create(null); for (var k in src) d[k] = copiaVar(src[k]); return d; }
    n.globais = copiaEscopo(this.globais);
    n.pilhaLocal = this.pilhaLocal.map(copiaEscopo);
    for (var f in this.funcs) n.funcs[f] = this.funcs[f];
    for (var a in this.aliases) n.aliases[a] = this.aliases[a];
    for (var o in this.o) n.o[o] = this.o[o];
    for (var s in this.shopt) n.shopt[s] = this.shopt[s];
    n.cwd = this.cwd; n.cwdLogico = this.cwdLogico;
    n.pos = this.pos.slice(); n.arg0 = this.arg0;
    n.fds = this.fds.map(function (x) { return ref(x); });
    n.status = this.status; n.pipestatus = this.pipestatus.slice();
    // subshell: armadilhas são restauradas (as ignoradas continuam)
    for (var t in this.traps) if (this.traps[t] === "") n.traps[t] = "";
    n.interativo = this.interativo;
    n.subshell = this.subshell + 1;
    n.lineno = this.lineno;
    n.funcStack = this.funcStack.slice(); n.fonteStack = this.fonteStack.slice();
    n.loopNivel = this.loopNivel;
    n.dirStack = this.dirStack.slice();
    n.jobs = this.jobs.slice(); n.jobCur = this.jobCur; n.jobAnt = this.jobAnt; n.proxJob = this.proxJob;
    n.hist = this.hist; n.histBase = this.histBase;
    n.inicio = this.inicio; n.ultimoBg = this.ultimoBg; n.ultimoArg = this.ultimoArg; n.umask = this.umask;
    n.nome0 = this.nome0; n.modoC = this.modoC; n.semErrexit = this.semErrexit;
    n.pai = this; n.rnd = this.rnd; n.ultimoRnd = this.ultimoRnd;
    n.raiz = this.raiz || this;
    n.ehSubshell = true;
    n.scriptNome = this.scriptNome;
    return n;
  };
  SP.fecharTudo = function () { this.fds.forEach(function (x) { unref(x); }); this.fds = []; };
  SP.prefixo = function () {
    if (this.ehSh) return this.nome0 + ": " + this.lineno + ": ";
    if (this.interativo) return "bash: ";
    return this.nome0 + ": linha " + this.lineno + ": ";
  };
  SP.erro = function (msg) { this.escrever(2, this.prefixo() + msg + "\n"); };
  // texto de pergunta (read -p, select): vai para a saída de erro, mas a interface não pinta de vermelho
  SP.escreverPrompt = function (s) {
    var o = this.fds[2];
    if (o && o.kind === "tty-out" && o.stream === "err") { this.k.saida("prompt", s); return true; }
    return this.escrever(2, s);
  };
  SP.escrever = function (fd, s) {
    var o = this.fds[fd];
    if (!o) return false;
    try { escreverOFD(this.k, o, s); }
    catch (e) { if (e instanceof SigPipe) throw e; if (e instanceof AbortSig) throw e; return false; }
    return true;
  };

  /* ---------- variáveis ---------- */
  SP.acharVar = function (nome) {
    for (var i = this.pilhaLocal.length - 1; i >= 0; i--) if (nome in this.pilhaLocal[i]) return this.pilhaLocal[i][nome];
    return nome in this.globais ? this.globais[nome] : null;
  };
  SP.escopoDe = function (nome) {
    for (var i = this.pilhaLocal.length - 1; i >= 0; i--) if (nome in this.pilhaLocal[i]) return this.pilhaLocal[i];
    return nome in this.globais ? this.globais : null;
  };
  SP.resolverRef = function (nome, n) { // segue namerefs
    n = n || 0;
    var v = this.acharVar(nome);
    if (v && v.at.n && typeof v.v === "string" && v.v !== "" && n < 10) {
      var alvo = v.v.replace(/\[.*$/, "");
      if (alvo === nome) return nome;
      return this.resolverRef(v.v, n + 1);
    }
    return nome;
  };
  SP.proxRandom = function () {
    var r;
    do {
      var ret = this.rnd === 0 ? 123459876 : this.rnd;
      var h = Math.floor(ret / 127773), l = ret - 127773 * h, t = 16807 * l - 2836 * h;
      this.rnd = t < 0 ? t + 0x7fffffff : t;
      r = ((this.rnd >>> 16) ^ (this.rnd & 65535)) & 32767;
    } while (r === this.ultimoRnd && this.ehSubshell);
    this.ultimoRnd = r;
    return r;
  };
  SP.especial = function (nome) {
    switch (nome) {
      case "RANDOM": return String(this.proxRandom());
      case "SRANDOM": return String(Math.floor(Math.random() * 4294967296));
      case "SECONDS": return String(Math.floor((this.k.clock - this.inicio) / 1000) + (this.secBase || 0));
      case "EPOCHSECONDS": return String(Math.floor(this.k.clock / 1000));
      case "EPOCHREALTIME": var ms = this.k.clock; return Math.floor(ms / 1000) + "," + ("00" + (ms % 1000)).slice(-3) + "000";
      case "LINENO": return String(this.lineno);
      case "BASHPID": return String(this.proc ? this.proc.pid : 3001);
      case "BASH_SUBSHELL": return String(this.subshell);
      case "SHELLOPTS": return this.shellopts();
      case "BASHOPTS": var self = this; return Object.keys(this.shopt).filter(function (k) { return self.shopt[k]; }).sort().join(":");
      case "BASH_ARGV0": return this.arg0;
      case "HISTCMD": return String(this.hist.length + 1);
      case "BASH_COMMAND": return this.bashCommand || "";
    }
    return undefined;
  };
  SP.shellopts = function () { var self = this; return SET_O.filter(function (k) { return self.o[k]; }).join(":"); };
  SP.arrayEspecial = function (nome) {
    switch (nome) {
      case "FUNCNAME": if (!this.funcStack.length) return null; return this.funcStack.map(function (f) { return f.nome; }).reverse().concat(this.fonteStack.length || !this.interativo ? ["main"] : []);
      case "BASH_SOURCE": var fs = this.funcStack.map(function (f) { return f.fonte; }).reverse(); return fs.concat(this.fonteStack.length ? [this.fonteStack[0]] : (this.scriptNome ? [this.scriptNome] : []));
      case "BASH_LINENO": var l = [this.lineno].concat(this.funcStack.map(function (f) { return f.linha; }).reverse()); return this.funcStack.map(function (f) { return String(f.linha); }).reverse().concat(this.funcStack.length ? ["0"] : []);
      case "PIPESTATUS": return this.pipestatus.map(String);
      case "DIRSTACK": return [this.curto(this.cwdLogico)].concat(this.dirStack.map(this.curto, this));
      case "GROUPS": return ["1000"];
      case "BASH_ARGV": return this.pos.slice().reverse();
    }
    return null;
  };
  // valor escalar de $nome (ou nome[idx]); null = não definida
  SP.valor = function (nome, idx) {
    var esp = idx == null ? this.especial(nome) : undefined;
    if (esp !== undefined) { var vv = this.acharVar(nome); if (!(vv && vv.removida)) return esp; }
    nome = this.resolverRef(nome);
    var ae = this.arrayEspecial(nome);
    if (ae) { var i0 = idx == null ? 0 : this.indiceNum(idx, ae.length); return i0 in ae ? ae[i0] : null; }
    var v = this.acharVar(nome);
    if (!v || v.v === undefined) return null;
    if (v.v instanceof Map) { var key = idx == null ? "0" : idx; return v.v.has(key) ? v.v.get(key) : null; }
    if (Array.isArray(v.v)) {
      var i = idx == null ? 0 : this.indiceNum(idx, v.v.length);
      if (i < 0) return null;
      return hasOwn(v.v, i) ? v.v[i] : null;
    }
    if (idx != null && this.indiceNum(idx, 1) !== 0) return null;
    return v.v;
  };
  SP.indiceNum = function (idx, len) {
    var n = typeof idx === "number" ? idx : Number(this.aritmetica(String(idx)));
    if (n < 0) n = len + n;
    return n;
  };
  // lista de valores de um array (ou escalar) na ordem dos índices
  SP.valoresArray = function (nome) {
    nome = this.resolverRef(nome);
    var ae = this.arrayEspecial(nome);
    if (ae) return ae.filter(function () { return true; });
    var v = this.acharVar(nome);
    if (!v || v.v === undefined) return [];
    if (v.v instanceof Map) return ordemAssoc(v.v).map(function (k) { return v.v.get(k); });
    if (Array.isArray(v.v)) { var r = []; Object.keys(v.v).forEach(function (k) { r.push(v.v[k]); }); return r; }
    return [v.v];
  };
  SP.chavesArray = function (nome) {
    nome = this.resolverRef(nome);
    var ae = this.arrayEspecial(nome);
    if (ae) return Object.keys(ae);
    var v = this.acharVar(nome);
    if (!v || v.v === undefined) return [];
    if (v.v instanceof Map) return ordemAssoc(v.v);
    if (Array.isArray(v.v)) return Object.keys(v.v);
    return ["0"];
  };
  // ordem de um array associativo igual à do Bash (tabela hash FNV-1 com 1024 baldes)
  function fnv(s) { var b = utf8bytes(s), h = 2166136261; for (var i = 0; i < b.length; i++) { h = Math.imul(h, 16777619) >>> 0; h = (h ^ b[i]) >>> 0; } return h; }
  function ordemAssoc(m) {
    var baldes = {}, ordem = [];
    m.forEach(function (v, k) { var b = fnv(k) & 1023; (baldes[b] = baldes[b] || []).unshift(k); });
    Object.keys(baldes).map(Number).sort(function (a, b) { return a - b; }).forEach(function (b) { ordem = ordem.concat(baldes[b]); });
    return ordem;
  }
  SP.ehReadonly = function (nome) { var v = this.acharVar(nome); return !!(v && v.at.r); };
  // atribui valor escalar (ou elemento). Devolve false se falhou (já imprime o erro)
  SP.atribuir = function (nome, valor, opt) {
    opt = opt || {};
    if (!opt.semRef) nome = this.resolverRef(nome);
    var m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(nome);
    if (m && opt.idx == null) { nome = m[1]; opt.idx = m[2]; opt.idxStr = true; }
    var esc = opt.local ? this.pilhaLocal[this.pilhaLocal.length - 1] : (opt.global ? this.globais : (this.escopoDe(nome) || this.globais));
    var v = esc[nome];
    if (v && v.at.r) { this.erro(nome + ": a variável permite somente leitura"); return false; }
    if (nome === "PATH" && opt.idx == null) this.hash = Object.create(null);
    if (nome === "RANDOM" && opt.idx == null) { this.rnd = (parseInt(valor, 10) || 0) >>> 0; this.ultimoRnd = -1; }
    if (nome === "SECONDS" && opt.idx == null) { this.inicio = this.k.clock; this.secBase = parseInt(valor, 10) || 0; }
    if (!v) { v = esc[nome] = new Var(undefined, {}); if (this.o.allexport) v.at.x = true; }
    var at = v.at;
    if (at.i && !opt.cru) {
      var base = opt.add ? (opt.idx == null ? this.valorDe(v, null) : this.valorDe(v, opt.idx)) : null;
      var expr = opt.add ? "(" + (base || "0") + ")+(" + valor + ")" : valor;
      var r = this.aritmeticaSegura(expr);
      if (r === null) return false;
      valor = r; opt = Object.assign({}, opt, { add: false });
    }
    if (at.u) valor = valor.toUpperCase(); else if (at.l) valor = valor.toLowerCase();
    if (opt.idx != null) {
      if (v.v instanceof Map) {
        var key = opt.idxStr ? String(opt.idx) : String(opt.idx);
        if (key === "" ) { this.erro(nome + "[" + (opt.idxRaw !== undefined ? opt.idxRaw : key) + "]: subscrito de array incorreto"); return false; }
        v.v.set(key, (opt.add && v.v.has(key) ? v.v.get(key) : "") + valor);
      } else {
        if (!Array.isArray(v.v)) v.v = v.v === undefined ? [] : [v.v];
        var len = v.v.length;
        var i = this.indiceNum(opt.idx, len);
        if (i < 0) { this.erro(nome + "[" + opt.idx + "]: subscrito de array incorreto"); return false; }
        v.v[i] = (opt.add && hasOwn(v.v, i) ? v.v[i] : "") + valor;
      }
    } else {
      if (v.v instanceof Map) v.v.set("0", (opt.add && v.v.has("0") ? v.v.get("0") : "") + valor);
      else if (Array.isArray(v.v)) v.v[0] = (opt.add && hasOwn(v.v, 0) ? v.v[0] : "") + valor;
      else v.v = (opt.add && v.v !== undefined ? v.v : "") + valor;
    }
    delete v.removida; delete v.semValor;
    if (nome === "PWD" && false) this.cwd = valor;
    return true;
  };
  SP.valorDe = function (v, idx) {
    if (v.v === undefined) return null;
    if (v.v instanceof Map) { var k = idx == null ? "0" : String(idx); return v.v.has(k) ? v.v.get(k) : null; }
    if (Array.isArray(v.v)) { var i = idx == null ? 0 : this.indiceNum(idx, v.v.length); return hasOwn(v.v, i) ? v.v[i] : null; }
    return idx == null || idx === 0 || idx === "0" ? v.v : null;
  };
  SP.definirSimples = function (nome, valor) { // sem checagens (uso interno)
    var esc = this.escopoDe(nome) || this.globais;
    var v = esc[nome];
    if (!v) v = esc[nome] = new Var(undefined, {});
    if (Array.isArray(v.v)) v.v[0] = valor; else if (v.v instanceof Map) v.v.set("0", valor); else v.v = valor;
  };
  SP.definirArray = function (nome, lista, opt) {
    opt = opt || {};
    var esc = opt.local ? this.pilhaLocal[this.pilhaLocal.length - 1] : (this.escopoDe(nome) || this.globais);
    var v = esc[nome];
    if (v && v.at.r) { this.erro(nome + ": a variável permite somente leitura"); return false; }
    if (!v) v = esc[nome] = new Var(undefined, {});
    v.v = lista; v.at.a = true;
    return true;
  };
  SP.removerVar = function (nome) {
    nome = this.resolverRef(nome);
    var esc = this.escopoDe(nome);
    if (!esc) return true;
    var v = esc[nome];
    if (v.at.r) { this.erro("unset: " + nome + ": impossível remover definição: variável somente-leitura"); return false; }
    if (esc !== this.globais && v.local) {
      // unset de uma local: no Bash a variável fica "invisível" neste escopo
      v.v = undefined; v.at = {}; v.removidaLocal = true;
      return true;
    }
    delete esc[nome];
    if (["RANDOM", "SECONDS", "LINENO", "SRANDOM", "EPOCHSECONDS", "EPOCHREALTIME", "BASHPID", "HISTCMD"].indexOf(nome) >= 0) { this.globais[nome] = new Var(undefined, {}); this.globais[nome].removida = true; }
    return true;
  };
  SP.varExiste = function (nome) { var v = this.acharVar(this.resolverRef(nome)); return !!(v && v.v !== undefined) || this.especial(nome) !== undefined && !(v && v.removida); };
  SP.exportadas = function () {
    var r = {}, self = this;
    function add(esc) { for (var k in esc) { var v = esc[k]; if (v.at.x && v.v !== undefined && !Array.isArray(v.v) && !(v.v instanceof Map)) r[k] = v.v; else if (k in r && !v.at.x) delete r[k]; } }
    add(this.globais);
    this.pilhaLocal.forEach(add);
    return r;
  };
  SP.aritmetica = function (expr) {
    var self = this;
    var ctx = {
      get: function (n, idx) {
        if (idx !== null && idx !== undefined) {
          var v = self.acharVar(self.resolverRef(n));
          if (v && v.v instanceof Map) { var key = self.expandirSubscritoAssoc(idx); return v.v.has(key) ? v.v.get(key) : ""; }
          var i = Number(self.aritmetica(idx));
          var r0 = self.valor(n, i); return r0 === null ? "" : r0;
        }
        var r = self.valor(n);
        if (r === null && self.o.nounset) { throw new ArithErr(n + ": variável não associada", null); }
        return r === null ? "" : r;
      },
      set: function (n, idx, val) {
        if (idx !== null && idx !== undefined) {
          var v = self.acharVar(self.resolverRef(n));
          if (v && v.v instanceof Map) { self.atribuir(n, val, { idx: self.expandirSubscritoAssoc(idx), cru: true }); return; }
          self.atribuir(n, val, { idx: Number(self.aritmetica(idx)), cru: true });
          return;
        }
        if (self.ehReadonly(n)) { self.erro(n + ": a variável permite somente leitura"); throw new CmdErr(1); }
        self.atribuir(n, val, { cru: true });
      }
    };
    var a = new Arith(expr, ctx);
    return a.avaliar();
  };
  SP.expandirSubscritoAssoc = function (idx) { return idx.replace(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/, function (m, n) { var v = this.valor(n); return v === null ? "" : v; }.bind(this)); };
  // avalia mostrando o erro como o Bash; devolve string ou null
  SP.aritmeticaSegura = function (expr, rot) {
    try { return String(this.aritmetica(expr)); }
    catch (e) {
      if (e instanceof ArithErr) { this.erroArit(expr, e, rot); return null; }
      throw e;
    }
  };
  SP.erroArit = function (expr, e, rot) {
    if (e.tok === null) { this.erro(e.msg); return; }
    this.erro((rot ? rot + ": " : "") + (e.expr !== undefined ? e.expr : expr.replace(/^[ \t\n]+/, "")) + ": " + e.msg + " (token de erro é \"" + e.tok + "\")");
  };

  /* ---------- caminhos e arquivos ---------- */
  function normalizar(p) {
    var partes = p.split("/"), out = [];
    partes.forEach(function (x) { if (!x || x === ".") return; if (x === "..") out.pop(); else out.push(x); });
    return "/" + out.join("/");
  }
  SP.abs = function (p) { if (p === "") return this.cwd; return normalizar(p[0] === "/" ? p : this.cwd + "/" + p); };
  SP.curto = function (p) { var h = this.valor("HOME") || HOME; return p === h ? "~" : (h !== "/" && p.indexOf(h + "/") === 0) ? "~" + p.slice(h.length) : p; };
  SP.pode = function (no, bit) { // 4 r, 2 w, 1 x
    var m = no.m;
    if (no.u === UID) return !!(m & (bit << 6));
    if (GROUPS.indexOf(no.g) >= 0) return !!(m & (bit << 3));
    return !!(m & bit);
  };
  // resolve um caminho. Devolve {no, pai, nome, caminho, err}
  SP.resolver = function (p, seguirFinal, prof) {
    prof = prof || 0;
    if (p === "") return { err: "ENOENT" };
    var abs = p[0] === "/" ? p : this.cwd + "/" + p;
    var partes = abs.split("/").filter(function (x) { return x !== "" && x !== "."; });
    var atual = this.fs, caminho = [], pilha = [this.fs];
    for (var i = 0; i < partes.length; i++) {
      var nome = partes[i], ultimoC = i === partes.length - 1;
      if (atual.t !== "d") return { err: "ENOTDIR", pai: null, nome: nome };
      if (!this.pode(atual, 1)) return { err: "EACCES", pai: atual, nome: nome };
      if (nome === "..") { if (pilha.length > 1) { pilha.pop(); caminho.pop(); } atual = pilha[pilha.length - 1]; if (ultimoC) return { no: atual, pai: pilha[pilha.length - 2] || atual, nome: caminho[caminho.length - 1] || "/", caminho: "/" + caminho.join("/") }; continue; }
      var filho = atual.c[nome];
      if (!filho) return { err: "ENOENT", pai: atual, nome: nome, caminho: "/" + caminho.concat([nome]).join("/"), ultimo: ultimoC };
      if (filho.t === "l" && (!ultimoC || seguirFinal)) {
        if (prof > 40) return { err: "ELOOP" };
        var alvo = filho.alvo[0] === "/" ? filho.alvo : "/" + caminho.join("/") + "/" + filho.alvo;
        var resto = partes.slice(i + 1).join("/");
        return this.resolver(alvo + (resto ? "/" + resto : ""), seguirFinal, prof + 1);
      }
      caminho.push(nome); pilha.push(filho);
      atual = filho;
      if (ultimoC) return { no: filho, pai: pilha[pilha.length - 2], nome: nome, caminho: "/" + caminho.join("/") };
    }
    return { no: this.fs, pai: this.fs, nome: "/", caminho: "/" };
  };
  SP.no = function (p, seguir) { var r = this.resolver(p, seguir !== false); return r.no || null; };
  var ERRNO = { ENOENT: "Arquivo ou diretório inexistente", EACCES: "Permissão negada", ENOTDIR: "Não é um diretório", EISDIR: "É um diretório", EEXIST: "Arquivo existe", ELOOP: "Número excessivo de níveis de links simbólicos", ENOTEMPTY: "Diretório não vazio", EPERM: "Operação não permitida", EINVAL: "Argumento inválido", EBADF: "Descritor de arquivo inválido", EXDEV: "Link inválido entre dispositivos", ENAMETOOLONG: "Nome de arquivo muito longo", ENOSPC: "Não há espaço disponível no dispositivo" };
  // descritor especial (/dev/stdin, /dev/fd/N…)
  SP.fdEspecial = function (p) {
    var m;
    if (p === "/dev/stdin") return 0; if (p === "/dev/stdout") return 1; if (p === "/dev/stderr") return 2;
    if ((m = /^\/(?:dev\/fd|proc\/self\/fd)\/([0-9]+)$/.exec(p))) return +m[1];
    return -1;
  };
  // abre um arquivo. modo: r w a rw. Devolve OFD ou {err}
  SP.abrir = function (p, modo, opt) {
    opt = opt || {};
    var esp = this.fdEspecial(p[0] === "/" ? normalizar(p) : p);
    if (esp >= 0) { var o = this.fds[esp]; if (!o) return { err: "ENOENT" }; return o; }
    if (p === "/dev/tty") return modo === "r" ? new OFD("tty-in") : new OFD("tty-out", { stream: "out" });
    var r = this.resolver(p, true);
    if (r.err && r.err !== "ENOENT") return { err: r.err };
    var no = r.no;
    if (no && no.t === "c") {
      if (no.dev === "null") return new OFD("null");
      if (no.dev === "zero") return new OFD("zero");
      if (no.dev === "random" || no.dev === "urandom") return new OFD("random");
      if (no.dev === "tty") return modo === "r" ? new OFD("tty-in") : new OFD("tty-out", { stream: "out" });
      if (no.dev === "full") return modo === "r" ? new OFD("zero") : { err: "ENOSPC" };
    }
    if (modo === "r") {
      if (!no) return { err: "ENOENT" };
      if (no.t === "d") return new OFD("file", { no: { t: "f", d: "", m: 0, u: 0, g: 0 }, pos: 0, rd: true, dir: true, path: r.caminho });
      if (!this.pode(no, 4)) return { err: "EACCES" };
      return new OFD("file", { no: no, pos: 0, rd: true, path: r.caminho });
    }
    if (no) {
      if (no.t === "d") return { err: "EISDIR" };
      if (!this.pode(no, 2)) return { err: "EACCES" };
      if (modo === "w" && opt.noclobber && no.t === "f") return { err: "NOCLOBBER" };
      if (modo === "w") { no.d = ""; delete no.z; no.mt = no.ct = this.k.clock; }
      return new OFD("file", { no: no, pos: 0, wr: true, rd: modo === "rw", ap: modo === "a", path: r.caminho });
    }
    if (!r.pai || r.pai.t !== "d") return { err: "ENOENT" };
    if (!r.ultimo) return { err: "ENOENT" };
    if (!this.pode(r.pai, 2) || !this.pode(r.pai, 1)) return { err: "EACCES" };
    var novo = mkF(UID, 438 & ~this.umask, "", this.k.clock);
    r.pai.c[r.nome] = novo; r.pai.mt = r.pai.ct = this.k.clock;
    return new OFD("file", { no: novo, pos: 0, wr: true, rd: modo === "rw", ap: modo === "a", path: r.caminho });
  };
  // lê arquivo inteiro (para comandos); devolve {txt} ou {err}
  SP.lerArquivo = function (p) {
    var esp = this.fdEspecial(p[0] === "/" ? normalizar(p) : p);
    if (esp >= 0 || p === "-") return { fd: esp >= 0 ? esp : 0 };
    var r = this.resolver(p, true);
    if (r.err) return { err: r.err };
    if (r.no.t === "d") return { err: "EISDIR" };
    if (r.no.t === "c") { if (r.no.dev === "null") return { txt: "" }; if (r.no.dev === "zero") return { txt: repete("\0", 1024) }; return { txt: "" }; }
    if (!this.pode(r.no, 4)) return { err: "EACCES" };
    return { txt: dadosDe(r.no), no: r.no };
  };

  /* ------------------------------------------------------------------
     7. Expansões, na ordem do Bash:
        chaves → til → parâmetros/aritmética/substituição de comando
        → separação de palavras (IFS) → curingas → remoção de aspas
     Segmentos: {s, q} citado · {s, lit} literal sem aspas · {s, sp}
     resultado de expansão sem aspas (sofre IFS) · {brk:'Q'|'U'} quebra.
     ------------------------------------------------------------------ */

  /* ---------- chaves ---------- */
  function partesParaSeq(partes) {
    var seq = [];
    partes.forEach(function (p) {
      if (p.t === "L") for (var i = 0; i < p.v.length; i++) seq.push(p.v[i]);
      else seq.push(p);
    });
    return seq;
  }
  function seqParaPartes(seq) {
    var r = [], lit = "";
    seq.forEach(function (x) { if (typeof x === "string") lit += x; else { if (lit) { r.push({ t: "L", v: lit }); lit = ""; } r.push(x); } });
    if (lit) r.push({ t: "L", v: lit });
    return r;
  }
  function expandirChaves(seq, prof) {
    prof = prof || 0;
    if (prof > 50) return [seq];
    for (var i = 0; i < seq.length; i++) {
      if (seq[i] !== "{") continue;
      if (i > 0 && seq[i - 1] === "$") continue;
      var d = 0, virg = [], j;
      for (j = i; j < seq.length; j++) {
        var c = seq[j];
        if (c === "{") d++;
        else if (c === "}") { d--; if (d === 0) break; }
        else if (c === "," && d === 1) virg.push(j);
      }
      if (j >= seq.length) return [seq];
      var pre = seq.slice(0, i), pos = seq.slice(j + 1), res = [];
      if (virg.length) {
        var ini = i + 1, alts = [];
        virg.concat([j]).forEach(function (k) { alts.push(seq.slice(ini, k)); ini = k + 1; });
        alts.forEach(function (a) { expandirChaves(pre.concat(a, pos), prof + 1).forEach(function (r) { res.push(r); }); });
        return res;
      }
      var meio = seq.slice(i + 1, j);
      if (meio.every(function (x) { return typeof x === "string"; })) {
        var txt = meio.join(""), m, lista = null;
        if ((m = /^([-+]?[0-9]+)\.\.([-+]?[0-9]+)(?:\.\.([-+]?[0-9]+))?$/.exec(txt))) {
          var a = parseInt(m[1], 10), b = parseInt(m[2], 10), passo = m[3] ? Math.abs(parseInt(m[3], 10)) || 1 : 1;
          var larg = (/^[-+]?0[0-9]/.test(m[1]) || /^[-+]?0[0-9]/.test(m[2])) ? Math.max(m[1].replace("+", "").length, m[2].replace("+", "").length) : 0;
          lista = [];
          for (var n = a; a <= b ? n <= b : n >= b; n += a <= b ? passo : -passo) {
            var sn = String(Math.abs(n)); while (sn.length < larg - (n < 0 ? 1 : 0)) sn = "0" + sn;
            lista.push((n < 0 ? "-" : "") + sn);
            if (lista.length > 100000) break;
          }
        } else if ((m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.([-+]?[0-9]+))?$/.exec(txt))) {
          var x = m[1].charCodeAt(0), y = m[2].charCodeAt(0), p2 = m[3] ? Math.abs(parseInt(m[3], 10)) || 1 : 1;
          lista = [];
          for (var cc = x; x <= y ? cc <= y : cc >= y; cc += x <= y ? p2 : -p2) lista.push(String.fromCharCode(cc));
        }
        if (lista) {
          lista.forEach(function (it) { expandirChaves(pre.concat(it.split(""), pos), prof + 1).forEach(function (r) { res.push(r); }); });
          return res;
        }
      }
      // não é uma expressão de chaves válida: continua procurando depois do "{"
      var resto = expandirChaves(seq.slice(i + 1), prof + 1);
      return resto.map(function (r) { return seq.slice(0, i + 1).concat(r); });
    }
    return [seq];
  }

  /* ---------- til ---------- */
  SP.til = function (pref) { // pref sem o "~"
    if (pref === "") { var h = this.valor("HOME"); return h === null ? HOME : h; }
    if (pref === "+") { var p = this.valor("PWD"); return p === null ? null : p; }
    if (pref === "-") { var o = this.valor("OLDPWD"); return o === null ? null : o; }
    var homes = { ana: HOME, root: "/root", daemon: "/usr/sbin", "www-data": "/var/www", nobody: "/nonexistent" };
    return hasOwn(homes, pref) ? homes[pref] : null;
  };
  // aplica til no início das partes (e depois de ":" em atribuições)
  SP.aplicarTil = function (partes, atrib) {
    if (!partes.length || (partes[0].t !== "L" && !atrib)) return partes;
    var self = this, v = partes[0].t === "L" ? partes[0].v : "";
    function troca(txt, inicioPalavra) {
      if (txt[0] !== "~") return null;
      var barra = txt.indexOf("/"), pref = barra < 0 ? txt.slice(1) : txt.slice(1, barra);
      if (barra < 0 && !inicioPalavra) return null;
      var r = self.til(pref);
      if (r === null) return null;
      return { home: r, resto: barra < 0 ? "" : txt.slice(barra) };
    }
    var unica = partes.length === 1 || (v.indexOf("/") >= 0);
    if (!atrib) {
      if (v[0] !== "~") return partes;
      if (!unica && v.indexOf("/") < 0) return partes;
      var t = troca(v, true);
      if (!t) return partes;
      return [{ t: "Q", v: t.home, til: true }].concat(t.resto ? [{ t: "L", v: t.resto }] : [], partes.slice(1));
    }
    // atribuição: til no início e depois de cada ":" (em qualquer parte literal)
    var saida = [];
    partes.forEach(function (p, idx) {
      if (p.t !== "L") { saida.push(p); return; }
      var inicioOk = idx === 0 || (partes[idx - 1].t === "L" && /:$/.test(partes[idx - 1].v));
      var pedacos = p.v.split(":");
      pedacos.forEach(function (pd, i) {
        if (i > 0) saida.push({ t: "L", v: ":" });
        var ultimoPd = i === pedacos.length - 1;
        if ((i > 0 || inicioOk) && pd[0] === "~") {
          var barra = pd.indexOf("/"), pref = barra < 0 ? pd.slice(1) : pd.slice(1, barra);
          if (barra >= 0 || !ultimoPd || idx === partes.length - 1) {
            var r = self.til(pref);
            if (r !== null) { saida.push({ t: "Q", v: r, til: true }); if (barra >= 0) saida.push({ t: "L", v: pd.slice(barra) }); return; }
          }
        }
        if (pd) saida.push({ t: "L", v: pd });
      });
    });
    return saida;
  };

  /* ---------- partes → segmentos ---------- */
  SP.expPartes = function* (partes, ctx) {
    var segs = [];
    for (var i = 0; i < partes.length; i++) {
      var p = partes[i];
      switch (p.t) {
        case "L": segs.push(ctx.dq ? { s: p.v, q: true } : { s: p.v, lit: true }); break;
        case "Q": case "SUB": segs.push({ s: p.v !== undefined ? p.v : "", q: true }); break;
        case "D": {
          var dentro = yield* this.expPartes(p.p, { dq: true });
          var soArroba = p.p.length > 0 && p.p.every(function (x) { return x.t === "V" && (x.name === "@" || (x.idx === "@" && !x.len && !x.ind)) && !x.op; });
          if (!soArroba) segs.push({ s: "", q: true });
          dentro.forEach(function (s) { segs.push(s); });
          break;
        }
        case "V": { var r = yield* this.expParam(p, !!ctx.dq, ctx); r.forEach(function (s) { segs.push(s); }); break; }
        case "C": case "B": {
          var out = yield* this.substComando(p);
          segs.push(ctx.dq ? { s: out, q: true } : { s: out, sp: true });
          break;
        }
        case "A": {
          var expr = yield* this.expandirStr(p.w, { arith: true });
          var val = this.aritmeticaSegura(expr);
          if (val === null) throw new CmdErr(1);
          segs.push(ctx.dq ? { s: val, q: true } : { s: val, sp: true });
          break;
        }
        case "P": { var cam = yield* this.substProcesso(p); segs.push({ s: cam, q: true }); break; }
        case "F": { var fo = yield* this.funsub(p); segs.push(ctx.dq ? { s: fo, q: true } : { s: fo, sp: true }); break; }
        case "ARR": segs.push({ s: "(" + "…" + ")", q: true }); break;
      }
    }
    return segs;
  };

  /* ---------- ${…} ---------- */
  SP.listaPos = function () { return this.pos.slice(); };
  SP.valorSimples = function (nome) {
    switch (nome) {
      case "?": return String(this.status);
      case "#": return String(this.pos.length);
      case "$": return String(this.raiz ? (this.raiz.pidShell || 3001) : (this.pidShell || 3001));
      case "!": return this.ultimoBg === null ? null : String(this.ultimoBg);
      case "-": return this.flags();
      case "0": return this.arg0;
      case "_": return this.ultimoArg;
    }
    if (isDigits(nome)) { var n = parseInt(nome, 10); if (n === 0) return this.arg0; return n <= this.pos.length ? this.pos[n - 1] : null; }
    return this.valor(nome);
  };
  SP.flags = function () {
    var self = this, r = "";
    "abefhikmnptuvxBCEHPT".split("").forEach(function (l) {
      if (l === "i") { if (self.interativo) r += "i"; return; }
      if (l === "m") { if (self.interativo && self.o.monitor) r += "m"; return; }
      var nome = SET_LETRA[l]; if (nome && self.o[nome]) r += l;
    });
    if (this.modoC) r += "c"; else if (this.interativo) r += "s";
    return r;
  };
  function ifsDe(sh) { var v = sh.valor("IFS"); return v === null ? " \t\n" : v; }
  SP.expParam = function* (v, dq, ctx) {
    if (v.bad) { this.erro(v.raw + ": substituição incorreta"); throw new CmdErr(1); }
    if (this.ehSh && (v.idx != null || v.ind || (v.op && !/^(:?[-=?+]|##?|%%?)$/.test(v.op)))) { this.erro("Bad substitution"); throw new FatalSig(2); }
    var nome = v.name, idx = v.idx, self = this;
    var lista = null, val = null, estrela = false, definida = true, ehArray = false;
    // ${!prefixo*} ${!prefixo@}
    if (v.ind && v.prefixo) {
      var nomes = this.nomesVars().filter(function (n) { return n.indexOf(nome) === 0; });
      lista = nomes; estrela = v.prefixo === "*";
      return this.segsLista(lista, estrela, dq);
    }
    // ${!array[@]} — chaves
    if (v.ind && (idx === "@" || idx === "*")) {
      lista = this.chavesArray(nome); estrela = idx === "*";
      return this.segsLista(lista, estrela, dq);
    }
    if (v.ind) {
      // indireção
      var vv = this.acharVar(nome);
      if (vv && vv.at.n && !idx) { val = vv.v === undefined ? null : vv.v; return this.segsVal(val, dq); }
      var ref = idx != null ? null : this.valorSimples(nome);
      if (idx != null) { var ix = yield* this.indiceDe(nome, idx); ref = ix.lista ? ix.lista.join(" ") : this.valor(nome, ix.i); }
      if (ref === null) { if (this.o.nounset) { this.erro(nome + ": variável não associada"); throw this.interativo ? new CmdErr(1) : new FatalSig(1); } ref = ""; }
      var m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?\-$!])(?:\[(.*)\])?$/.exec(ref);
      if (!m) { this.erro(ref + ": expansão indireta inválida"); throw new CmdErr(1); }
      nome = m[1];
      if (m[2] !== undefined) idx = (m[2] === "@" || m[2] === "*") ? m[2] : { p: [{ t: "L", v: m[2] }], raw: m[2] };
      else idx = null;
      v = Object.assign({}, v, { ind: false });
    }
    // valor base
    if (nome === "@" || nome === "*") { lista = this.listaPos(); estrela = nome === "*"; }
    else if (idx === "@" || idx === "*") {
      var vr = this.acharVar(this.resolverRef(nome));
      lista = this.valoresArray(nome); estrela = idx === "*"; ehArray = true;
      if (!vr && !this.arrayEspecial(nome)) definida = false;
    } else if (idx != null) {
      var ix2 = yield* this.indiceDe(nome, idx);
      val = ix2.erro ? null : this.valor(nome, ix2.i);
      if (val === null) definida = false;
    } else {
      val = this.valorSimples(nome);
      if (val === null) definida = false;
    }
    // ${#…}
    if (v.len) {
      if (lista) return this.segsVal(String(lista.length), dq);
      if (!definida && this.o.nounset && !/^[@*#?\-$!0]$/.test(nome)) { this.erro(nome + ": variável não associada"); throw this.interativo ? new CmdErr(1) : new FatalSig(1); }
      return this.segsVal(String(val === null ? 0 : Array.from(val).length), dq);
    }
    var op = v.op;
    var vazio = lista ? lista.length === 0 || (lista.length === 1 && lista[0] === "" && false) : (val === null || val === "");
    var naoDef = lista ? lista.length === 0 : val === null;
    if (!op || op === "@" || op === ":" || /^[#%\/^,]/.test(op)) {
      if (naoDef && this.o.nounset && nome !== "@" && nome !== "*" && !(lista && ehArray && definida)) {
        var rot = nome + (idx && idx !== "@" && idx !== "*" ? "[" + (v.idxRaw || "") + "]" : (idx ? "[" + idx + "]" : ""));
        if (isDigits(nome)) { this.erro("$" + nome + ": variável não associada"); throw this.interativo ? new CmdErr(1) : new FatalSig(127); }
        this.erro(rot + ": variável não associada");
        throw this.interativo ? new CmdErr(1) : new FatalSig(1);
      }
    }
    if (!op) return lista ? this.segsLista(lista, estrela, dq) : this.segsVal(val === null ? "" : val, dq);
    var colon = op[0] === ":" && op.length === 2;
    var teste = colon ? (lista ? (estrela ? lista.join(ifsDe(this).slice(0, 1)) === "" : lista.length === 0 || lista.every(function (x) { return x === ""; }) && lista.length <= 1) : vazio) : naoDef;
    if (lista && colon && !estrela) teste = lista.length === 0 || (lista.length === 1 && lista[0] === "");
    switch (op) {
      case "-": case ":-":
        if (teste) return yield* this.expPartes(dq ? v.arg.p : this.aplicarTil(v.arg.p, false), { dq: dq });
        return lista ? this.segsLista(lista, estrela, dq) : this.segsVal(val, dq);
      case "+": case ":+":
        if (!teste) return yield* this.expPartes(dq ? v.arg.p : this.aplicarTil(v.arg.p, false), { dq: dq });
        return dq ? [] : [];
      case "=": case ":=": {
        if (!teste) return lista ? this.segsLista(lista, estrela, dq) : this.segsVal(val, dq);
        if (lista || !nomeValido(nome)) { this.erro("$" + nome + ": impossível atribuir desta maneira"); throw new CmdErr(1); }
        var novo = yield* this.expandirStr(v.arg, { dq: dq, til: !dq });
        if (idx != null) { var ix3 = yield* this.indiceDe(nome, idx); if (!this.atribuir(nome, novo, { idx: ix3.i })) throw new CmdErr(1); }
        else if (!this.atribuir(nome, novo)) throw new CmdErr(1);
        return this.segsVal(this.valorSimples(nome) || (idx != null ? novo : ""), dq);
      }
      case "?": case ":?": {
        if (!teste) return lista ? this.segsLista(lista, estrela, dq) : this.segsVal(val, dq);
        var msg = v.arg.p.length ? yield* this.expandirStr(v.arg, { dq: dq }) : (colon || true ? "parâmetro nulo ou não inicializado" : "parâmetro não inicializado");
        this.erro(nome + (idx && idx.raw !== undefined ? "[" + idx.raw + "]" : "") + ": " + msg);
        if (!this.interativo) throw new FatalSig(1);
        throw new CmdErr(1);
      }
    }
    // operações aplicadas a cada elemento
    var itens = lista ? lista : [val === null ? "" : val];
    if (op === ":") {
      var offS = yield* this.expandirStr(v.off, { arith: true });
      var off = this.aritmeticaSegura(offS === "" ? "0" : offS);
      if (off === null) throw new CmdErr(1);
      off = Number(off);
      var len = null;
      if (v.lenw) { var lS = yield* this.expandirStr(v.lenw, { arith: true }); len = this.aritmeticaSegura(lS === "" ? "0" : lS); if (len === null) throw new CmdErr(1); len = Number(len); }
      if (lista) {
        var base = lista;
        if (nome === "@" || nome === "*") { base = [this.arg0].concat(lista); }
        var chaves = null;
        if (ehArray) {
          var vr2 = this.acharVar(this.resolverRef(nome));
          if (vr2 && Array.isArray(vr2.v)) {
            // fatias de arrays esparsos usam os índices
            var ks = Object.keys(vr2.v).map(Number);
            var maxI = ks.length ? ks[ks.length - 1] + 1 : 0;
            var ini = off < 0 ? maxI + off : off;
            if (off < 0 && ini < 0) return [];
            var sel = ks.filter(function (k) { return k >= ini; }).map(function (k) { return vr2.v[k]; });
            if (len !== null) { if (len < 0) { this.erro(nome + "[@]: " + len + ": expressão de substring < 0"); throw new CmdErr(1); } sel = sel.slice(0, len); }
            return this.segsLista(sel, estrela, dq);
          }
        }
        var n0 = base.length, i0 = off < 0 ? n0 + off : off;
        if (i0 < 0) return [];
        if (nome === "@" || nome === "*") { if (off < 0) i0 = n0 + off; }
        var fatia = base.slice(i0);
        if (len !== null) { if (len < 0) { this.erro((nome === "@" || nome === "*" ? "" : nome + "[@]: ") + len + ": expressão de substring < 0"); throw new CmdErr(1); } fatia = fatia.slice(0, len); }
        return this.segsLista(fatia, estrela, dq);
      }
      var chars = Array.from(itens[0]), L = chars.length;
      var a = off < 0 ? L + off : off;
      if (a < 0 || a > L) { return this.segsVal("", dq); }
      var b = len === null ? L : (len < 0 ? L + len : a + len);
      if (len !== null && len < 0 && b < a) { this.erro(nome + ": " + len + ": expressão de substring < 0"); throw new CmdErr(1); }
      return this.segsVal(chars.slice(a, Math.min(b, L)).join(""), dq);
    }
    var nc = this.shopt.nocasematch && false;
    var ext = true;
    if (op === "#" || op === "##" || op === "%" || op === "%%") {
      var pat = yield* this.padraoDe(v.arg);
      itens = itens.map(function (s) { return removerPadrao(s, pat, op, ext); });
      return lista ? this.segsLista(itens, estrela, dq) : this.segsVal(itens[0], dq);
    }
    if (op[0] === "/") {
      var pat2 = yield* this.padraoDe(v.arg);
      var repSegs = v.rep ? yield* this.expPartes(dq ? v.rep.p : this.aplicarTil(v.rep.p, false), { dq: false }) : [];
      var usaAmp = this.shopt.patsub_replacement;
      itens = itens.map(function (s) { return substituirPadrao(s, pat2, op, repSegs, usaAmp, ext); });
      return lista ? this.segsLista(itens, estrela, dq) : this.segsVal(itens[0], dq);
    }
    if (op === "^" || op === "^^" || op === "," || op === ",," || op === "~" || op === "~~") {
      var pat3 = v.arg && v.arg.p.length ? yield* this.padraoDe(v.arg) : "?";
      itens = itens.map(function (s) {
        var cs = Array.from(s);
        for (var k = 0; k < cs.length; k++) {
          if (casaPadrao(pat3, cs[k], { ext: ext })) cs[k] = op[0] === "^" ? cs[k].toUpperCase() : op[0] === "," ? cs[k].toLowerCase() : (cs[k] === cs[k].toUpperCase() ? cs[k].toLowerCase() : cs[k].toUpperCase());
          if (op.length === 1) break;
        }
        return cs.join("");
      });
      return lista ? this.segsLista(itens, estrela, dq) : this.segsVal(itens[0], dq);
    }
    if (op === "@") {
      var t = v.arg;
      if ("QEPAKaUuLk".indexOf(t) < 0) { this.erro(v.raw + ": substituição incorreta"); throw new CmdErr(1); }
      if (t === "a") { var va = this.acharVar(this.resolverRef(nome)); return this.segsVal(va ? atributosStr(va) : "", dq); }
      if (t === "A") {
        if (val === null && !lista) return [];
        if (lista && ehArray) return this.segsVal(this.declaracao(nome, true), dq);
        var va2 = this.acharVar(nome);
        var flags = va2 ? atributosStr(va2) : "";
        return this.segsVal((flags ? "declare -" + flags + " " : "") + nome + "=" + citarQ(val), dq);
      }
      if ((t === "K" || t === "k") && ehArray) {
        var ksA = this.chavesArray(nome), vsA = this.valoresArray(nome);
        var vrK = this.acharVar(this.resolverRef(nome)), assoc = vrK && vrK.v instanceof Map;
        if (t === "K") return this.segsVal(ksA.map(function (k, i) { return (assoc ? citarQ(k) : k) + " " + citarQ(vsA[i]); }).join(" "), dq);
        var pares = []; ksA.forEach(function (k, i) { pares.push(k, vsA[i]); });
        return this.segsLista(pares, estrela, dq);
      }
      itens = itens.map(function (s) {
        switch (t) {
          case "Q": case "K": case "k": return citarQ(s);
          case "E": return decodificarAnsi(s);
          case "P": return self.expandirPrompt(s);
          case "U": return s.toUpperCase();
          case "u": return s ? Array.from(s)[0].toUpperCase() + Array.from(s).slice(1).join("") : s;
          case "L": return s.toLowerCase();
        }
        return s;
      });
      if (!lista && val === null && (t === "Q" || t === "K")) return [];
      return lista ? this.segsLista(itens, estrela, dq) : this.segsVal(itens[0], dq);
    }
    return this.segsVal(val || "", dq);
  };
  function atributosStr(v) {
    var r = "";
    if (v.v instanceof Map || v.at.A) r += "A"; else if (Array.isArray(v.v) || v.at.a) r += "a";
    if (v.at.i) r += "i"; if (v.at.l) r += "l"; if (v.at.n) r += "n"; if (v.at.r) r += "r"; if (v.at.t) r += "t"; if (v.at.u) r += "u"; if (v.at.x) r += "x";
    return r;
  }
  // aspas do jeito do Bash (${x@Q}, set -x, declare -p…)
  function citarQ(s) {
    if (/[\x00-\x1f\x7f]/.test(s)) {
      return "$'" + s.replace(/[\\']/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, function (c) {
        var m = { "\n": "\\n", "\t": "\\t", "\r": "\\r", "\x1b": "\\E", "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\v": "\\v" }[c];
        return m || "\\" + ("00" + c.charCodeAt(0).toString(8)).slice(-3);
      }) + "'";
    }
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  // aspas do set -x / printf %q: só quando precisa
  function citarX(s) {
    if (s === "") return "''";
    if (/[\x00-\x1f\x7f]/.test(s)) return citarQ(s);
    if (/^[A-Za-z0-9_@%+=:,.\/\-]+$/.test(s) && !/^[=]/.test(s)) return s;
    if (/^[^'\s]*$/.test(s) || true) return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  function citarPrintfQ(s) {
    if (s === "") return "''";
    if (/[\x00-\x1f\x7f]/.test(s)) return citarQ(s);
    return s.replace(/[^A-Za-z0-9_@%+=:,.\/\-\u0080-\uffff]/g, "\\$&");
  }
  SP.segsVal = function (s, dq) { return dq ? [{ s: s, q: true }] : [{ s: s, sp: true }]; };
  SP.segsLista = function (lista, estrela, dq) {
    var r = [];
    if (estrela && dq) {
      var ifs = ifsDe(this);
      return [{ s: lista.join(ifs.slice(0, 1)), q: true }];
    }
    var sep = estrela ? ifsDe(this).slice(0, 1) : " ";
    lista.forEach(function (x, i) {
      if (i > 0) r.push({ brk: dq ? "Q" : "U", sep: sep });
      r.push(dq ? { s: x, q: true } : { s: x, sp: true });
    });
    if (!lista.length && dq) r.push({ vazio: true });
    return r;
  };
  SP.nomesVars = function () {
    var vistos = {}, r = [];
    function add(esc) { for (var k in esc) if (!vistos[k] && esc[k].v !== undefined) { vistos[k] = 1; r.push(k); } }
    for (var i = this.pilhaLocal.length - 1; i >= 0; i--) add(this.pilhaLocal[i]);
    add(this.globais);
    ["RANDOM", "SECONDS", "LINENO", "EPOCHSECONDS", "EPOCHREALTIME", "SRANDOM", "BASHPID", "BASH_SUBSHELL", "SHELLOPTS", "BASHOPTS", "FUNCNAME", "PIPESTATUS", "DIRSTACK", "BASH_ARGV0"].forEach(function (n) { if (!vistos[n]) r.push(n); });
    return r.sort(cmpBytes);
  };
  // índice de um elemento: devolve {i} (número ou chave)
  SP.indiceDe = function* (nome, idx) {
    var v = this.acharVar(this.resolverRef(nome));
    if (v && v.v instanceof Map) { var k = yield* this.expandirStr(idx, {}); return { i: k }; }
    var e = yield* this.expandirStr(idx, { arith: true });
    var r = this.aritmeticaSegura(e === "" ? "0" : e);
    if (r === null) throw new CmdErr(1);
    var n = Number(r);
    if (n < 0) {
      var len = v && Array.isArray(v.v) ? v.v.length : (v && v.v !== undefined ? 1 : 0);
      if (len + n < 0) { this.erro(nome + ": subscrito de array incorreto"); return { i: 1e15, erro: true }; }
      n = len + n;
    }
    return { i: n };
  };
  SP.padraoDe = function* (w) {
    if (!w) return "";
    var segs = yield* this.expPartes(w.p, { dq: false });
    return segsParaPadrao(segs);
  };
  function segsParaPadrao(segs) {
    var r = "";
    segs.forEach(function (s) { if (s.brk) r += s.sep || " "; else if (s.q) r += escaparPadrao(s.s); else if (s.s) r += s.s; });
    return r;
  }
  function removerPadrao(s, pat, op, ext) {
    var cs = Array.from(s), n = cs.length, i;
    if (op === "#") { for (i = 0; i <= n; i++) if (casaPadrao(pat, cs.slice(0, i).join(""), { ext: ext })) return cs.slice(i).join(""); return s; }
    if (op === "##") { for (i = n; i >= 0; i--) if (casaPadrao(pat, cs.slice(0, i).join(""), { ext: ext })) return cs.slice(i).join(""); return s; }
    if (op === "%") { for (i = n; i >= 0; i--) if (casaPadrao(pat, cs.slice(i).join(""), { ext: ext })) return cs.slice(0, i).join(""); return s; }
    if (op === "%%") { for (i = 0; i <= n; i++) if (casaPadrao(pat, cs.slice(i).join(""), { ext: ext })) return cs.slice(0, i).join(""); return s; }
    return s;
  }
  function substituirPadrao(s, pat, op, repSegs, usaAmp, ext) {
    function rep(m) {
      var r = "";
      repSegs.forEach(function (sg) {
        if (sg.brk) { r += " "; return; }
        if (sg.q || !usaAmp) r += sg.s;
        else {
          // "&" sem aspas vira o trecho casado; "\&" vira "&"
          for (var k = 0; k < sg.s.length; k++) {
            var c = sg.s[k];
            if (c === "\\" && sg.s[k + 1] === "&") { r += "&"; k++; continue; }
            if (c === "\\" && sg.s[k + 1] === "\\") { r += "\\"; k++; continue; }
            r += c === "&" ? m : c;
          }
        }
      });
      return r;
    }
    var cs = Array.from(s), n = cs.length, i, j;
    if (pat === "" && (op === "/" || op === "//")) return s;
    if (op === "/#") { for (j = n; j >= 0; j--) if (casaPadrao(pat, cs.slice(0, j).join(""), { ext: ext })) return rep(cs.slice(0, j).join("")) + cs.slice(j).join(""); return s; }
    if (op === "/%") { for (i = 0; i <= n; i++) if (casaPadrao(pat, cs.slice(i).join(""), { ext: ext })) return cs.slice(0, i).join("") + rep(cs.slice(i).join("")); return s; }
    var out = "", todas = op === "//";
    i = 0;
    while (i <= n) {
      var achou = -1;
      for (j = n; j >= i; j--) { if (casaPadrao(pat, cs.slice(i, j).join(""), { ext: ext })) { achou = j; break; } }
      if (achou >= 0 && !(achou === i && false)) {
        var m = cs.slice(i, achou).join("");
        out += rep(m);
        if (achou === i) { if (i < n) out += cs[i]; i++; }
        else i = achou;
        if (!todas) return out + cs.slice(i).join("");
        continue;
      }
      if (i < n) out += cs[i];
      i++;
    }
    return out;
  }

  /* ---------- substituição de comando e de processo ---------- */
  SP.substComando = function* (p) {
    var ast = p.ast;
    if (p.t === "B") {
      try { ast = new Parser(p.src, { aliases: this.shopt.expand_aliases ? this.aliases : null, extglob: this.shopt.extglob, linha: this.lineno }).parseTudo(); }
      catch (e) {
        if (e instanceof SyntaxErr) { this.erro("substituição de comando: linha " + (e.line || 1) + ": " + e.msg); this.status = 2; return ""; }
        if (e instanceof Incomplete) { this.erro("substituição de comando: linha 1: erro de sintaxe: fim prematuro do arquivo"); return ""; }
        throw e;
      }
    }
    // $(< arquivo)
    var it = ast.items;
    if (it.length === 1 && !it[0].bg && it[0].c.p.length === 1 && it[0].c.p[0].cmds.length === 1) {
      var c = it[0].c.p[0].cmds[0];
      if (c.k === "simple" && !c.w.length && !c.as.length && c.r.length === 1 && c.r[0].op === "<" && c.r[0].fd === null) {
        var nomeArq = yield* this.expandirStr(c.r[0].w, {});
        var r = this.lerArquivo(nomeArq);
        if (r.err) { this.erro(nomeArq + ": " + ERRNO[r.err]); this.ultimoSubst = 1; return ""; }
        this.ultimoSubst = 0;
        var txt0 = r.txt !== undefined ? r.txt : "";
        return txt0.replace(/\n+$/, "");
      }
    }
    var pp = novoPipe(), leitor = ref(pp[0]);
    pp[0].p.semLimite = true;
    var sub = this.fork();
    sub.emSubst = true;
    if (!this.shopt.inherit_errexit) sub.o.errexit = 0;
    unref(sub.fds[1]); sub.fds[1] = ref(pp[1]);
    var st = 0;
    try {
      st = yield* sub.rodarListaSub(ast);
    } finally {
      sub.fecharTudo();
    }
    this.ultimoSubst = st;
    this.status = st;
    var out = pp[0].p.buf;
    unref(leitor);
    if (out.indexOf("\0") >= 0) { this.erro("aviso: substituição de comando: byte nulo ignorado na entrada"); out = out.replace(/\0/g, ""); }
    return out.replace(/\n+$/, "");
  };
  SP.rodarListaSub = function* (ast) {
    var st = 0;
    try {
      try { st = yield* this.rodarLista(ast); }
      catch (e) {
        if (e instanceof ExitSig) st = e.code;
        else if (e instanceof FatalSig) st = e.code;
        else if (e instanceof ReturnSig) st = e.code;
        else if (e instanceof BreakSig || e instanceof ContSig) st = this.status;
        else if (e instanceof CmdErr) st = e.code;
        else throw e;
      }
      if (this.trapSaida) st = yield* this.rodarTrapExit(st);
    } catch (e2) { if (e2 instanceof SigPipe) st = 141; else throw e2; }
    return st;
  };
  SP.funsub = function* (p) {
    var pp = novoPipe(), leitor = ref(pp[0]);
    pp[0].p.semLimite = true;
    var salvo = this.fds[1];
    if (!p.reply) this.fds[1] = ref(pp[1]);
    var esc = null;
    if (p.reply) { esc = Object.create(null); esc.REPLY = new Var(undefined, {}); this.pilhaLocal.push(esc); }
    var out;
    try {
      try { yield* this.rodarLista(p.ast); } catch (e) { if (!(e instanceof ReturnSig)) throw e; }
      out = p.reply ? (this.valor("REPLY") || "") : pp[0].p.buf.replace(/\n+$/, "");
    } finally {
      if (!p.reply) { unref(this.fds[1]); this.fds[1] = salvo; }
      if (esc) { var i = this.pilhaLocal.lastIndexOf(esc); if (i >= 0) this.pilhaLocal.splice(i, 1); }
      unref(leitor);
    }
    return out;
  };
  SP.substProcesso = function* (p) {
    var pp = novoPipe(), fd = 63;
    while (this.fds[fd]) fd--;
    var sub = this.fork();
    if (p.dir === "<") { unref(sub.fds[1]); sub.fds[1] = ref(pp[1]); this.fds[fd] = ref(pp[0]); }
    else { unref(sub.fds[0]); sub.fds[0] = ref(pp[0]); this.fds[fd] = ref(pp[1]); }
    (this.psFds = this.psFds || []).push(fd);
    var proc = this.k.spawn(sub, function* () { return yield* sub.rodarListaSub(p.ast); }, { bg: this.proc ? this.proc.bg : false, nome: "bash" });
    proc.procSubst = true;
    this.ultimoBg = proc.pid;
    return "/dev/fd/" + fd;
  };
  SP.fecharProcSubst = function () {
    var self = this;
    if (!this.psFds) return;
    this.psFds.forEach(function (fd) { unref(self.fds[fd]); delete self.fds[fd]; });
    this.psFds = null;
  };

  /* ---------- separação de palavras ---------- */
  function separar(segs, ifs, quebrar) {
    var campos = [], cur = null, prev = "start";
    var ws = "", nws = "";
    for (var i = 0; i < ifs.length; i++) { var c = ifs[i]; if (c === " " || c === "\t" || c === "\n") ws += c; else nws += c; }
    function novo() { return { txt: "", pat: "", glob: false }; }
    function fecha() { campos.push(cur); cur = null; }
    segs.forEach(function (sg) {
      if (sg.vazio) return;
      if (sg.brk) {
        if (sg.brk === "Q") { if (!cur) cur = novo(); fecha(); cur = novo(); prev = "start"; }
        else { if (cur) fecha(); prev = "brk"; }
        return;
      }
      if (sg.q) { if (!cur) cur = novo(); cur.txt += sg.s; cur.pat += escaparPadrao(sg.s); return; }
      if (sg.lit || !quebrar || !ifs) {
        if (sg.s === "" && !sg.lit) { return; }
        if (!cur) cur = novo();
        cur.txt += sg.s; cur.pat += sg.s; cur.glob = true;
        return;
      }
      for (var k = 0; k < sg.s.length; k++) {
        var ch = sg.s[k];
        if (ws.indexOf(ch) >= 0) { if (cur) { fecha(); prev = "ws"; } continue; }
        if (nws.indexOf(ch) >= 0) {
          if (cur) { fecha(); prev = "nws"; }
          else if (prev === "ws") prev = "nws";
          else { campos.push(novo()); prev = "nws"; }
          continue;
        }
        if (!cur) cur = novo();
        cur.txt += ch; cur.pat += ch; cur.glob = true;
      }
    });
    if (cur) campos.push(cur);
    return campos;
  }

  /* ---------- curingas no sistema de arquivos ---------- */
  SP.glob = function (pat) {
    var self = this, ext = this.shopt.extglob, nc = this.shopt.nocaseglob, dot = this.shopt.dotglob, star2 = this.shopt.globstar;
    var segs = [], cur = "";
    for (var i = 0; i < pat.length; i++) {
      if (pat[i] === "\\" && i + 1 < pat.length) { cur += pat[i] + pat[i + 1]; i++; continue; }
      if (pat[i] === "/") { segs.push(cur); cur = ""; continue; }
      cur += pat[i];
    }
    segs.push(cur);
    var abs = pat[0] === "/";
    if (abs) segs.shift();
    var res = [];
    function seguir(no) { if (no && no.t === "l") { return null; } return no; }
    function anda(no, prefixo, k) {
      if (k === segs.length) { res.push(prefixo); return; }
      var seg = segs[k], ultimoS = k === segs.length - 1;
      if (seg === "") { // barra extra ou final
        if (ultimoS) { if (no.t === "d") res.push(prefixo + "/"); return; }
        anda(no, prefixo + "/", k + 1); return;
      }
      if (!temCuringa(seg, ext)) {
        var nome = tirarBarras(seg);
        var caminho = (prefixo === "" ? "" : prefixo + (prefixo === "/" ? "" : "/")) + nome;
        var r = self.resolver(abs || prefixo ? (abs ? caminho : caminho) : nome, true);
        if (nome === "." || nome === "..") r = self.resolver(caminho || nome, true);
        if (r.no) { if (ultimoS) res.push(caminho); else if (r.no.t === "d") anda(r.no, caminho, k + 1); }
        return;
      }
      if (no.t !== "d" || !self.pode(no, 4) || !self.pode(no, 1)) return;
      if (seg === "**" && star2 && ultimoS) {
        var tudo = function (dno, pref, prof) {
          Object.keys(dno.c).sort(collate).forEach(function (n) {
            if (n[0] === "." && !dot) return;
            var c = (pref === "" ? "" : pref + (pref === "/" ? "" : "/")) + n;
            res.push(c);
            if (dno.c[n].t === "d" && prof < 30) tudo(dno.c[n], c, prof + 1);
          });
        };
        tudo(no, prefixo, 0);
        return;
      }
      if (seg === "**" && star2) {
        var visit = function (dno, pref, prof) {
          anda(dno, pref, k + 1);
          if (prof > 30) return;
          Object.keys(dno.c).sort(collate).forEach(function (n) {
            if (n[0] === "." && !dot) return;
            var f = dno.c[n];
            if (f.t === "d") visit(f, (pref === "" ? "" : pref + (pref === "/" ? "" : "/")) + n, prof + 1);
          });
        };
        visit(no, prefixo, 0);
        return;
      }
      var lit0 = seg[0] === "." || (seg[0] === "\\" && seg[1] === ".");
      Object.keys(no.c).sort(collate).forEach(function (n) {
        if (n[0] === "." && !dot && !lit0) return;
        if (!casaPadrao(seg, n, { ext: ext, nc: nc })) return;
        var f = no.c[n];
        var caminho = (prefixo === "" ? "" : prefixo + (prefixo === "/" ? "" : "/")) + n;
        if (ultimoS) { res.push(caminho); return; }
        if (f.t === "l") { var rr = self.resolver(caminho, true); f = rr.no; }
        if (f && f.t === "d") anda(f, caminho, k + 1);
      });
    }
    var inicio = abs ? this.fs : this.no(this.cwd);
    if (!inicio) return [];
    anda(inicio, abs ? "/" : "", 0);
    // "**" pode repetir caminhos
    var vistos = {};
    res = res.filter(function (x) { if (vistos[x]) return false; vistos[x] = 1; return true; });
    if (abs) res = res.map(function (x) { return x.replace(/^\/\//, "/"); });
    if (segs.length > 1 || abs) res.sort(collate);
    return res;
  };

  /* ---------- entradas principais ---------- */
  // palavras de um comando → lista de argumentos
  SP.expandirArgs = function* (palavras) {
    var out = [];
    for (var i = 0; i < palavras.length; i++) {
      var r = yield* this.expandirPalavra(palavras[i]);
      for (var j = 0; j < r.length; j++) out.push(r[j]);
    }
    return out;
  };
  SP.expandirPalavra = function* (w, semGlob) {
    var variantes = [w.p];
    if (this.o.braceexpand && w.p.some(function (p) { return p.t === "L" && p.v.indexOf("{") >= 0; })) {
      variantes = expandirChaves(partesParaSeq(w.p)).map(seqParaPartes);
    }
    var out = [], ifs = ifsDe(this);
    for (var i = 0; i < variantes.length; i++) {
      var partes = this.aplicarTil(variantes[i], false);
      var segs = yield* this.expPartes(partes, { dq: false });
      var campos = separar(segs, ifs, true);
      for (var j = 0; j < campos.length; j++) {
        var c = campos[j];
        if (!semGlob && !this.o.noglob && c.glob && temCuringa(c.pat, this.shopt.extglob)) {
          var g = this.glob(c.pat);
          if (g.length) { g.forEach(function (x) { out.push(x); }); continue; }
          if (this.shopt.failglob) { this.erro("sem correspondência: " + c.txt); throw new CmdErr(1); }
          if (this.shopt.nullglob) continue;
          out.push(c.txt.replace(/\\(.)/g, function (m, x) { return c.pat.indexOf(m) >= 0 && false ? x : m; }));
          continue;
        }
        out.push(c.glob ? c.txt : c.txt);
      }
    }
    return out;
  };
  // expansão sem separação nem curingas (atribuições, case, here-string…)
  SP.expandirStr = function* (w, opt) {
    opt = opt || {};
    var partes = opt.atrib ? this.aplicarTil(w.p, true) : (opt.til ? this.aplicarTil(w.p, false) : w.p);
    var segs = yield* this.expPartes(partes, { dq: !!opt.dq });
    var r = "";
    segs.forEach(function (s) { if (s.brk) r += s.sep || " "; else if (s.s) r += s.s; });
    return r;
  };
  SP.expandirRegex = function* (w) {
    var segs = yield* this.expPartes(w.p, { dq: false });
    var r = "";
    segs.forEach(function (s) { if (s.brk) r += " "; else if (s.q) r += s.s.replace(/[\\^$.*+?()[\]{}|\/]/g, "\\$&"); else r += s.s; });
    return r;
  };

  /* ------------------------------------------------------------------
     8. Executor
     ------------------------------------------------------------------ */
  var BUILTINS = {}; // preenchido adiante: nome → function*(args, sh)
  var DASH_BUILTINS = {}; ". : [ alias bg break cd command continue echo eval exec exit export false fg getopts hash jobs kill local printf pwd read readonly return set shift test times trap true type ulimit umask unalias unset wait".split(" ").forEach(function (n) { DASH_BUILTINS[n] = 1; });
  var EXT = {};      // programas externos simulados

  SP.setLinha = function (ln) { if (!this.travarLinha) this.lineno = ln + (this.lnBase || 0); };
  SP.passo = function () {
    this.k.passo();
    if (this.pendSig.length) return true;
    return false;
  };
  SP.tratarSinais = function* () {
    while (this.pendSig.length) {
      var sig = this.pendSig.shift();
      var acao = this.traps[sig];
      if (acao === undefined) { if (sig === 2 || sig === 15 || sig === 1 || sig === 10 || sig === 12) throw new KillSig(sig); continue; }
      if (acao === "") continue;
      var st = this.status;
      yield* this.rodarTexto(acao, { trap: true });
      this.status = st;
    }
  };
  // pressão de pipe: se o stdout é um pipe cheio, espera o leitor
  SP.esperarPipe = function* () {
    var o = this.fds[1];
    if (o && o.kind === "pipe-w" && !o.p.semLimite && o.p.buf.length > 65536 && o.p.r > 0) {
      var p = o.p;
      yield { t: "block", cond: function () { return p.buf.length <= 16384 || p.r === 0; } };
    }
  };

  SP.rodarLista = function* (lista) {
    var st = this.status;
    for (var i = 0; i < lista.items.length; i++) {
      var it = lista.items[i];
      if (this.pendSig.length) yield* this.tratarSinais();
      if (it.bg) { st = yield* this.rodarBg(it.c); continue; }
      st = yield* this.rodarAndOr(it.c);
    }
    return st;
  };
  SP.rodarAndOr = function* (ao) {
    var st = 0;
    for (var i = 0; i < ao.p.length; i++) {
      if (i > 0) {
        var op = ao.ops[i - 1];
        if (op === "&&" && st !== 0) continue;
        if (op === "||" && st === 0) continue;
      }
      var ultimoP = i === ao.p.length - 1;
      if (!ultimoP) this.semErrexit++;
      try { st = yield* this.rodarPipeline(ao.p[i]); }
      finally { if (!ultimoP) this.semErrexit--; }
      if (ultimoP && st !== 0 && !ao.p[i].neg) yield* this.checarErro(st);
    }
    return st;
  };
  SP.checarErro = function* (st) {
    if (this.semErrexit > 0) return;
    if (this.traps[100] && !this.emTrapErr) {
      this.emTrapErr = true;
      try { yield* this.rodarTexto(this.traps[100], { trap: true }); } finally { this.emTrapErr = false; }
      this.status = st;
    }
    if (this.o.errexit) throw new ExitSig(st);
  };
  SP.rodarPipeline = function* (p) {
    var t0 = this.k.clock, st;
    if (p.neg) this.semErrexit++;
    try {
      if (!p.cmds.length) st = 0;
      else if (p.cmds.length === 1) { st = yield* this.rodarComando(p.cmds[0]); this.pipestatus = [st]; }
      else st = yield* this.rodarPipe(p);
    } finally { if (p.neg) this.semErrexit--; }
    if (p.tempo) {
      var dt = (this.k.clock - t0) / 1000;
      var fmt = function (x) { var m = Math.floor(x / 60), s = (x - m * 60).toFixed(3).replace(".", ","); return m + "m" + s + "s"; };
      if (p.tempoP) this.escrever(2, "real " + dt.toFixed(2) + "\nuser 0.00\nsys 0.00\n");
      else this.escrever(2, "\nreal\t" + fmt(dt) + "\nuser\t0m0,000s\nsys\t0m0,000s\n");
    }
    if (p.neg) st = st ? 0 : 1;
    this.status = st;
    return st;
  };
  SP.rodarPipe = function* (p) {
    var n = p.cmds.length, procs = [], self = this, pipes = [];
    var ultimoAqui = this.shopt.lastpipe && !(this.interativo && this.o.monitor);
    for (var i = 0; i < n - 1; i++) pipes.push(novoPipe());
    var salvo0 = null;
    for (var j = 0; j < n; j++) {
      if (j === n - 1 && ultimoAqui) break;
      var filho = this.fork();
      filho.emPipe = true;
      if (j > 0) { unref(filho.fds[0]); filho.fds[0] = ref(pipes[j - 1][0]); }
      if (j < n - 1) {
        unref(filho.fds[1]); filho.fds[1] = ref(pipes[j][1]);
        if (p.amp[j]) { unref(filho.fds[2]); filho.fds[2] = ref(pipes[j][1]); }
      }
      (function (f, cmd) {
        procs.push(self.k.spawn(f, function* () { return yield* f.rodarComandoSub(cmd); }, { bg: self.proc ? self.proc.bg : false, nome: nomeCmd(cmd) }));
      })(filho, p.cmds[j]);
    }
    var stUlt = null;
    if (ultimoAqui) {
      salvo0 = this.fds[0];
      this.fds[0] = ref(pipes[n - 2][0]);
      try { stUlt = yield* this.rodarComando(p.cmds[n - 1]); }
      finally { unref(this.fds[0]); this.fds[0] = salvo0; }
    }
    // o pai não fica com pontas dos pipes (só os filhos)
    yield { t: "block", cond: function () { return procs.every(function (x) { return x.done; }); } };
    var sts = procs.map(function (x) { return x.status; });
    if (stUlt !== null) sts.push(stUlt);
    this.pipestatus = sts;
    var st = sts[sts.length - 1];
    if (this.o.pipefail) { for (var k = sts.length - 1; k >= 0; k--) if (sts[k] !== 0) { st = sts[k]; break; } }
    procs.forEach(function (x) { if (x.porSinal === 13) { /* silencioso */ } });
    return st;
  };
  function nomeCmd(c) { if (c.k === "simple" && c.w.length && c.w[0].p.length === 1 && c.w[0].p[0].t === "L") return c.w[0].p[0].v; return "bash"; }
  // comando dentro de subshell/processo: "exit" encerra só ele
  SP.rodarComandoSub = function* (cmd) {
    var st;
    try { st = yield* this.rodarComando(cmd); }
    catch (e) {
      if (e instanceof ExitSig || e instanceof FatalSig) st = e.code;
      else if (e instanceof ReturnSig) st = e.code;
      else if (e instanceof BreakSig || e instanceof ContSig) st = this.status;
      else if (e instanceof CmdErr) st = e.code;
      else throw e;
    }
    if (this.trapSaida) st = yield* this.rodarTrapExit(st);
    return st;
  };
  SP.rodarBg = function* (ao) {
    var filho = this.fork(), self = this;
    filho.emBg = true;
    if (!this.interativo || !this.o.monitor) { unref(filho.fds[0]); filho.fds[0] = ref(new OFD("null")); }
    var txt = imprimirAndOr(ao);
    var proc = this.k.spawn(filho, function* () {
      var st;
      try { st = yield* filho.rodarAndOr(ao); }
      catch (e) {
        if (e instanceof ExitSig || e instanceof FatalSig || e instanceof ReturnSig || e instanceof CmdErr) st = e.code;
        else if (e instanceof BreakSig || e instanceof ContSig) st = 0;
        else throw e;
      }
      return st;
    }, { bg: true, nome: nomeCmd(ao.p[0].cmds[0] || {}) });
    this.ultimoBg = proc.pid;
    var selfB = this;
    proc.onFim = function (pr) { (selfB.bgStatus = selfB.bgStatus || {})[pr.pid] = pr.status; };
    var job = { n: this.proxJob++, procs: [proc], txt: txt, pgid: proc.pid, avisado: false };
    this.jobs.push(job);
    this.jobAtual(job);
    if (this.interativo && !this.subshell) this.escrever(2, "[" + job.n + "] " + proc.pid + "\n");
    this.status = 0;
    return 0;
  };
  SP.jobAtual = function (job) { this.jobAnt = this.jobCur; this.jobCur = job; };
  SP.limparJobs = function (avisar) {
    var self = this, linhas = [];
    this.jobs = this.jobs.filter(function (j) {
      var fim = j.procs.every(function (p) { return p.done; });
      if (!fim) return true;
      if (avisar && !j.avisado) linhas.push(self.linhaJob(j, true));
      if (self.jobCur === j) { self.jobCur = self.jobAnt; self.jobAnt = null; }
      return false;
    });
    if (!this.jobs.length) { this.proxJob = 1; this.jobCur = this.jobAnt = null; }
    else this.proxJob = Math.max.apply(null, this.jobs.map(function (j) { return j.n; })) + 1;
    if (!this.jobs.some(function (j) { return j === self.jobCur; })) this.jobCur = this.jobs.length ? this.jobs[this.jobs.length - 1] : null;
    return linhas;
  };
  SP.estadoJob = function (j) {
    var fim = j.procs.every(function (p) { return p.done; });
    if (!fim) return j.parado ? "Parado" : "Executando";
    var p = j.procs[j.procs.length - 1];
    if (p.porSinal) return ({ 15: "Terminado", 9: "Morto (Killed)", 2: "Interromper", 1: "Hangup", 13: "`Pipe' partido (escrita sem leitura)" })[p.porSinal] || ("Sinal " + p.porSinal);
    if (p.status === 0) return "Concluído";
    return "Fim da execução com status " + p.status;
  };
  SP.linhaJob = function (j, comL) {
    var marca = j === this.jobCur ? "+" : (j === this.jobAnt ? "-" : " ");
    var est = this.estadoJob(j), fim = est !== "Executando" && est !== "Parado";
    var txt = j.txt + (fim ? "" : " &");
    if (/^Fim da execução/.test(est)) est = "Fim da execução com status " + j.procs[j.procs.length - 1].status;
    return "[" + j.n + "]" + marca + "  " + est + repete(" ", Math.max(1, 27 - utf8len(est))) + txt;
  };

  /* ---------- redirecionamentos ---------- */
  SP.aplicarRedirs = function* (redirs, permanente) {
    var salvos = [], self = this;
    function troca(fd, novo) {
      if (!permanente) salvos.push({ fd: fd, velho: self.fds[fd] });
      else unref(self.fds[fd]);
      self.fds[fd] = novo ? ref(novo) : undefined;
      if (!novo) delete self.fds[fd];
    }
    for (var i = 0; i < redirs.length; i++) {
      var r = redirs[i], op = r.op;
      var fd = r.fd !== null && r.fd !== undefined ? r.fd : (op[0] === "<" && op !== "<>" ? 0 : (op === "<>" ? 0 : 1));
      if (op === "<<" || op === "<<-" || op === "<<<") fd = r.fd !== null && r.fd !== undefined ? r.fd : 0;
      var alvo, o;
      if (op === "<<" || op === "<<-") {
        var txt = r.hd ? (r.hd.texto !== undefined ? r.hd.texto : yield* this.expandirStr(r.hd.w, { dq: false })) : "";
        o = new OFD("file", { no: { t: "f", d: txt, m: 384, u: UID, g: GID }, pos: 0, rd: true, hd: true });
      } else if (op === "<<<") {
        var s = yield* this.expandirStr(r.w, { til: true });
        o = new OFD("file", { no: { t: "f", d: s + "\n", m: 384, u: UID, g: GID }, pos: 0, rd: true, hd: true });
      } else {
        var lista = yield* this.expandirPalavra(r.w);
        if (lista.length !== 1) { this.erro(r.w.raw + ": redirecionamento ambíguo"); this.desfazerRedirs(salvos); return null; }
        alvo = lista[0];
        if ((op === ">&" || op === "<&") && r.fdvar && alvo === "-") {
          var fdv = parseInt(this.valor(r.fdvar), 10);
          if (!isNaN(fdv)) troca(fdv, null);
          continue;
        }
        if (op === ">&" || op === "<&") {
          if (/^[0-9]+-?$/.test(alvo) || alvo === "-") {
            if (alvo === "-") { troca(fd, null); continue; }
            var origem = parseInt(alvo, 10), mover = /-$/.test(alvo);
            var od = this.fds[origem];
            if (!od) { this.erro(origem + ": Descritor de arquivo inválido"); this.desfazerRedirs(salvos); return null; }
            if (op === ">&" && !podeEscrever(od) && od.kind !== "tty-in") { /* o Bash deixa duplicar; o erro aparece na escrita */ }
            troca(fd, od);
            if (mover && origem !== fd) troca(origem, null);
            continue;
          }
          if (op === "<&") { this.erro(alvo + ": redirecionamento ambíguo"); this.desfazerRedirs(salvos); return null; }
          // >&arquivo = &>arquivo
          op = "&>";
        }
        if (alvo === "") { this.erro(": Arquivo ou diretório inexistente"); this.desfazerRedirs(salvos); return null; }
        var modo = op === "<" ? "r" : op === "<>" ? "rw" : (op === ">>" || op === "&>>") ? "a" : "w";
        o = this.abrir(alvo, modo, { noclobber: this.o.noclobber && op !== ">|" });
        if (o.err) {
          var msg = o.err === "NOCLOBBER" ? "impossível sobrescrever arquivo existente" : ERRNO[o.err];
          this.erro(alvo + ": " + msg); this.desfazerRedirs(salvos); return null;
        }
      }
      if (r.fdvar) {
        var nfd = 10; while (this.fds[nfd]) nfd++;
        this.fds[nfd] = ref(o);
        this.atribuir(r.fdvar, String(nfd));
        continue;
      }
      if (op === "&>" || op === "&>>") { troca(1, o); troca(2, o); continue; }
      troca(fd, o);
    }
    return salvos;
  };
  SP.desfazerRedirs = function (salvos) {
    if (!salvos) return;
    for (var i = salvos.length - 1; i >= 0; i--) {
      var s = salvos[i];
      unref(this.fds[s.fd]);
      if (s.velho) this.fds[s.fd] = s.velho; else delete this.fds[s.fd];
    }
  };

  /* ---------- comandos ---------- */
  SP.rodarComando = function* (c) {
    if (c.k === "simple") return yield* this.rodarSimples(c);
    if (c.k === "func") {
      this.funcs[c.name] = c;
      if (this.o.xtrace && false) this.xtrace(c.name);
      this.status = 0; return 0;
    }
    this.k.passo();
    if (c.ln) this.setLinha(c.ln);
    var salvos = null;
    if (c.r && c.r.length) {
      try { salvos = yield* this.aplicarRedirs(c.r, false); }
      catch (e) { if (e instanceof CmdErr) { this.status = 1; return 1; } throw e; }
      if (salvos === null) { this.status = 1; return 1; }
    }
    var st;
    try {
      st = yield* this.rodarComposto(c);
    } finally {
      this.desfazerRedirs(salvos);
    }
    this.status = st;
    return st;
  };
  SP.rodarComposto = function* (c) {
    var st = 0, self = this;
    switch (c.k) {
      case "group": return yield* this.rodarLista(c.body);
      case "sub": {
        var f = this.fork();
        try {
          st = yield* f.rodarListaSub(c.body);
        } finally { f.fecharTudo(); }
        if (f.rnd !== this.rnd) { /* subshell não afeta o pai */ }
        return st;
      }
      case "if": {
        for (var i = 0; i < c.conds.length; i++) {
          this.semErrexit++;
          var cs;
          try { cs = yield* this.rodarLista(c.conds[i]); } finally { this.semErrexit--; }
          if (cs === 0) return yield* this.rodarLista(c.bodies[i]);
        }
        if (c.els) return yield* this.rodarLista(c.els);
        this.status = 0;
        return 0;
      }
      case "while": {
        this.loopNivel++;
        try {
          while (true) {
            this.k.passo();
            if (this.pendSig.length) yield* this.tratarSinais();
            yield* this.esperarPipe();
            this.semErrexit++;
            var cst;
            try { cst = yield* this.rodarLista(c.cond); }
            catch (e) { this.semErrexit--; if (e instanceof BreakSig) { if (e.n > 1) throw new BreakSig(e.n - 1); break; } if (e instanceof ContSig) { if (e.n > 1) throw new ContSig(e.n - 1); continue; } throw e; }
            this.semErrexit--;
            if ((cst === 0) === c.until) break;
            try { st = yield* this.rodarLista(c.body); }
            catch (e2) {
              if (e2 instanceof BreakSig) { st = 0; if (e2.n > 1) throw new BreakSig(e2.n - 1); break; }
              if (e2 instanceof ContSig) { if (e2.n > 1) throw new ContSig(e2.n - 1); continue; }
              throw e2;
            }
          }
        } finally { this.loopNivel--; }
        return st;
      }
      case "for": case "select": {
        var itens;
        if (c.words) {
          this.setLinha(c.ln);
          itens = yield* this.expandirArgs(c.words);
        } else itens = this.pos.slice();
        if (c.k === "select") return yield* this.rodarSelect(c, itens);
        if (!nomeValido(c.name)) { this.erro("`" + c.name + "': não é um identificador válido"); return 1; }
        this.loopNivel++;
        try {
          for (var k = 0; k < itens.length; k++) {
            this.k.passo();
            if (this.pendSig.length) yield* this.tratarSinais();
            yield* this.esperarPipe();
            if (this.o.xtrace) this.xtraceTxt("for " + c.name + " in " + itens.map(citarX).join(" "));
            if (!this.atribuir(c.name, itens[k])) { st = 1; break; }
            try { st = yield* this.rodarLista(c.body); }
            catch (e3) {
              if (e3 instanceof BreakSig) { if (e3.n > 1) throw new BreakSig(e3.n - 1); break; }
              if (e3 instanceof ContSig) { if (e3.n > 1) throw new ContSig(e3.n - 1); continue; }
              throw e3;
            }
          }
        } finally { this.loopNivel--; }
        return st;
      }
      case "arfor": {
        this.loopNivel++;
        var ex = c.ex;
        var arit = function* (w, padrao) {
          var s = yield* self.expandirStr(w, { arith: true });
          if (/^\s*$/.test(s)) return padrao;
          if (self.o.xtrace) self.xtraceTxt("(( " + s.trim() + " ))");
          var r = self.aritmeticaSegura(s, "((");
          if (r === null) throw new CmdErr(1);
          return r;
        };
        try {
          yield* arit(ex[0], "1");
          while (true) {
            this.k.passo();
            if (this.pendSig.length) yield* this.tratarSinais();
            yield* this.esperarPipe();
            var t = yield* arit(ex[1], "1");
            if (t === "0") break;
            try { st = yield* this.rodarLista(c.body); }
            catch (e4) {
              if (e4 instanceof BreakSig) { if (e4.n > 1) throw new BreakSig(e4.n - 1); break; }
              if (e4 instanceof ContSig) { if (e4.n > 1) throw new ContSig(e4.n - 1); }
              else throw e4;
            }
            yield* arit(ex[2], "1");
          }
        } catch (e5) { if (e5 instanceof CmdErr) { this.loopNivel--; this.status = 1; return 1; } throw e5; }
        this.loopNivel--;
        return st;
      }
      case "case": {
        this.setLinha(c.ln);
        var palavra = yield* this.expandirStr(c.w, { til: true });
        if (this.o.xtrace) this.xtraceTxt("case " + citarX(palavra) + " in");
        var nc = this.shopt.nocasematch;
        for (var a = 0; a < c.items.length; a++) {
          var item = c.items[a], casou = false;
          for (var b = 0; b < item.pats.length && !casou; b++) {
            var pat = yield* this.padraoCase(item.pats[b]);
            if (casaPadrao(pat, palavra, { ext: true, nc: nc })) casou = true;
          }
          if (!casou) continue;
          st = yield* this.rodarLista(item.body);
          var term = item.term;
          while (term === ";&" && a + 1 < c.items.length) { a++; st = yield* this.rodarLista(c.items[a].body); term = c.items[a].term; }
          if (term === ";;&") continue;
          return st;
        }
        return st;
      }
      case "arith": {
        this.setLinha(c.ln);
        var e = yield* this.expandirStr(c.w, { arith: true });
        if (this.o.xtrace) this.xtraceTxt("(( " + e + " ))");
        var r = this.aritmeticaSegura(e, "((");
        if (r === null) { this.status = 1; return 1; }
        return r === "0" ? 1 : 0;
      }
      case "cond": {
        this.setLinha(c.ln);
        if (this.o.xtrace) this.xtraceTxt("[[ " + (yield* this.textoCond(c.e)) + " ]]");
        var rr = yield* this.avaliarCond(c.e);
        return rr;
      }
    }
    return 0;
  };
  SP.padraoCase = function* (w) {
    var partes = this.aplicarTil(w.p, false);
    var segs = yield* this.expPartes(partes, { dq: false });
    return segsParaPadrao(segs);
  };
  SP.rodarSelect = function* (c, itens) {
    var st = 0;
    this.loopNivel++;
    try {
      var mostrarMenu = true;
      while (true) {
        this.k.passo();
        if (itens.length && mostrarMenu) {
          var larg = String(itens.length).length;
          var linhas = itens.map(function (x, i) { return pad(i + 1, larg) + ") " + x; });
          this.escreverPrompt(linhas.join("\n") + "\n");
        }
        var ps3 = this.valor("PS3"); if (ps3 === null) ps3 = "#? ";
        this.escreverPrompt(ps3);
        var o = this.fds[0];
        if (!o) { st = 1; break; }
        var r = yield* lerAte(this.k, o, "\n", null, { prompt: ps3 });
        if (!r.achou && r.s === "") { this.escrever(2, "\n"); st = 1; break; }
        this.atribuir("REPLY", r.s);
        var n = /^\s*[0-9]+\s*$/.test(r.s) ? parseInt(r.s, 10) : 0;
        mostrarMenu = r.s === "";
        if (r.s === "") continue;
        this.atribuir(c.name, n >= 1 && n <= itens.length ? itens[n - 1] : "");
        try { st = yield* this.rodarLista(c.body); }
        catch (e) {
          if (e instanceof BreakSig) { if (e.n > 1) throw new BreakSig(e.n - 1); break; }
          if (e instanceof ContSig) { if (e.n > 1) throw new ContSig(e.n - 1); continue; }
          throw e;
        }
      }
    } finally { this.loopNivel--; }
    return st;
  };

  /* ---------- [[ ]] ---------- */
  SP.textoCond = function* (e) {
    switch (e.op) {
      case "and": return (yield* this.textoCond(e.a)) + " && " + (yield* this.textoCond(e.b));
      case "or": return (yield* this.textoCond(e.a)) + " || " + (yield* this.textoCond(e.b));
      case "not": return "! " + (yield* this.textoCond(e.a));
      case "paren": return "( " + (yield* this.textoCond(e.a)) + " )";
      case "un": return e.o + " " + (yield* this.expandirStr(e.a, { til: true }));
      case "bin": return (yield* this.expandirStr(e.a, { til: true })) + " " + e.o + " " + (e.o === "=~" ? yield* this.expandirStr(e.b, {}) : yield* this.padraoCase(e.b));
      case "word": return yield* this.expandirStr(e.a, { til: true });
    }
    return "";
  };
  SP.avaliarCond = function* (e) {
    switch (e.op) {
      case "and": { var a = yield* this.avaliarCond(e.a); if (a !== 0) return a; return yield* this.avaliarCond(e.b); }
      case "or": { var b = yield* this.avaliarCond(e.a); if (b === 0) return 0; return yield* this.avaliarCond(e.b); }
      case "not": { var c = yield* this.avaliarCond(e.a); return c === 0 ? 1 : (c === 1 ? 0 : c); }
      case "paren": return yield* this.avaliarCond(e.a);
      case "word": { var w = yield* this.expandirStr(e.a, { til: true }); return w !== "" ? 0 : 1; }
      case "un": {
        var x = yield* this.expandirStr(e.a, { til: true });
        return this.testeUnario(e.o, x, true) ? 0 : 1;
      }
      case "bin": {
        var l = yield* this.expandirStr(e.a, { til: true });
        var o = e.o;
        if (o === "=~") {
          var src = yield* this.expandirRegex(e.b);
          var re = criarRegex(ereParaJs(src), this.shopt.nocasematch ? "i" : "");
          if (!re) { this.erro("[[: expressão regular inválida `" + src + "': Expressão regular inválida"); return 2; }
          var m = re.exec(l);
          if (!m) { this.definirArray("BASH_REMATCH", []); return 1; }
          var arr = []; for (var i = 0; i < m.length; i++) arr[i] = m[i] === undefined ? "" : m[i];
          this.definirArray("BASH_REMATCH", arr);
          return 0;
        }
        if (o === "==" || o === "=" || o === "!=") {
          var pat = yield* this.padraoCase(e.b);
          var ok = casaPadrao(pat, l, { ext: true, nc: this.shopt.nocasematch });
          return (o === "!=" ? !ok : ok) ? 0 : 1;
        }
        var rr = yield* this.expandirStr(e.b, { til: true });
        if (o === "<") return collate(l, rr) < 0 ? 0 : 1;
        if (o === ">") return collate(l, rr) > 0 ? 0 : 1;
        if (/^-(eq|ne|lt|le|gt|ge)$/.test(o)) {
          var x1 = this.aritmeticaSegura(l === "" ? "0" : l), x2 = this.aritmeticaSegura(rr === "" ? "0" : rr);
          if (x1 === null || x2 === null) throw new CmdErr(1);
          return compararNum(o, Number(x1), Number(x2)) ? 0 : 1;
        }
        return this.testeBinArq(o, l, rr) ? 0 : 1;
      }
    }
    return 2;
  };
  function compararNum(o, a, b) {
    switch (o) { case "-eq": return a === b; case "-ne": return a !== b; case "-lt": return a < b; case "-le": return a <= b; case "-gt": return a > b; case "-ge": return a >= b; }
    return false;
  }
  SP.testeUnario = function (o, x, dentroCond) {
    var r;
    switch (o) {
      case "-z": return x === "";
      case "-n": return x !== "";
      case "-v": { var m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(x); if (!m) return false; if (m[2] !== undefined) { if (m[2] === "@" || m[2] === "*") return this.valoresArray(m[1]).length > 0; var vv = this.acharVar(m[1]); if (vv && vv.v instanceof Map) return vv.v.has(m[2]); return this.valor(m[1], Number(this.aritmetica(m[2]))) !== null; } return this.varExiste(m[1]); }
      case "-o": return !!this.o[x];
      case "-R": { var v = this.acharVar(x); return !!(v && v.at.n); }
      case "-t": { var fd = parseInt(x, 10); return isTTY(this.fds[fd]) && !this.semTTY; }
    }
    if (x === "") return false;
    var seguir = o !== "-h" && o !== "-L";
    if (this.fdEspecial(x) >= 0) { var od = this.fds[this.fdEspecial(x)]; if (o === "-e" || o === "-a" || o === "-r" || o === "-w") return !!od; if (o === "-p") return !!od && od.kind.indexOf("pipe") === 0; if (o === "-c") return !!od && isTTY(od); if (o === "-f") return !!od && od.kind === "file"; return false; }
    r = this.resolver(x, seguir);
    var no = r.no;
    if (!no) return false;
    switch (o) {
      case "-e": case "-a": return true;
      case "-f": return no.t === "f";
      case "-d": return no.t === "d";
      case "-h": case "-L": return no.t === "l";
      case "-s": return tamanho(no) > 0 && no.t !== "c";
      case "-r": return this.pode(no, 4);
      case "-w": return this.pode(no, 2);
      case "-x": return this.pode(no, 1);
      case "-c": return no.t === "c";
      case "-b": case "-p": case "-S": return false;
      case "-g": return !!(no.m & 1024); case "-u": return !!(no.m & 2048); case "-k": return !!(no.m & 512);
      case "-O": return no.u === UID; case "-G": return no.g === GID;
      case "-N": return no.mt > (no.at || 0);
    }
    return false;
  };
  SP.testeBinArq = function (o, a, b) {
    var na = this.no(a), nb = this.no(b);
    if (o === "-nt") return !!na && (!nb || na.mt > nb.mt);
    if (o === "-ot") return !!nb && (!na || na.mt < nb.mt);
    if (o === "-ef") return !!na && na === nb;
    return false;
  };

  /* ---------- xtrace ---------- */
  SP.ps4 = function () {
    var p = this.valor("PS4");
    if (p === null) p = "+ ";
    try { p = this.expandirPromptSimples(p); } catch (e) { /* */ }
    var nivel = (this.nivelX || 0) + (this.emSubst ? 1 : 0);
    var c0 = p.charAt(0);
    return repete(c0, nivel) + p;
  };
  SP.xtraceTxt = function (txt) { this.escrever(2, this.ps4() + txt + "\n"); };
  SP.expandirPromptSimples = function (p) {
    var self = this;
    return p.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9#?$!@*-])\}?/g, function (m, n) {
      var v = /^[A-Za-z_]/.test(n) ? self.valor(n) : self.valorSimples(n);
      if (n === "LINENO") v = String(self.lineno);
      if (n === "FUNCNAME") { v = self.funcStack.length ? self.funcStack[self.funcStack.length - 1].nome : null; }
      return v === null ? "" : v;
    });
  };

  /* ---------- comando simples ---------- */
  SP.rodarSimples = function* (c) {
    this.setLinha(c.ln);
    this.k.passo();
    if (this.pendSig.length) yield* this.tratarSinais();
    yield* this.esperarPipe();
    var args, decl = null, self = this;
    this.ultimoSubst = null;
    try {
      // palavras (comandos de declaração expandem atribuições sem separar)
      var w0 = c.w.length && c.w[0].p.length === 1 && c.w[0].p[0].t === "L" ? c.w[0].p[0].v : null;
      if (w0 && DECLARADORES[w0] && !this.funcs[w0]) {
        args = [w0]; decl = {};
        for (var i = 1; i < c.w.length; i++) {
          var at = atribuicao(c.w[i]);
          if (at) { var val = yield* this.valorAtrib(at); decl[args.length] = { a: at, v: val }; args.push(at.name + (at.idxRaw !== undefined ? "[" + at.idxRaw + "]" : "") + (at.add ? "+=" : "=") + (Array.isArray(val) ? "(" + val.map(function (x) { return x.k !== null && x.k !== undefined ? "[" + x.k + "]=" + x.v : x.v; }).join(" ") + ")" : val)); }
          else { var ex = yield* this.expandirPalavra(c.w[i]); ex.forEach(function (x) { args.push(x); }); }
        }
      } else args = yield* this.expandirArgs(c.w);
    } catch (e) {
      if (e instanceof CmdErr) { this.fecharProcSubst(); this.status = e.code; throw e; }
      throw e;
    }
    // só atribuições
    if (!args.length) {
      var stA = 0;
      this.bashCommand = imprimirSimples(c);
      if (this.traps[101] && !this.emTrapDebug) {
        this.emTrapDebug = true;
        try { yield* this.rodarTexto(this.traps[101], { trap: true }); } finally { this.emTrapDebug = false; }
      }
      try {
        for (var j = 0; j < c.as.length; j++) {
          var a = c.as[j];
          var v = yield* this.valorAtrib(a);
          if (this.o.xtrace) this.xtraceTxt(a.name + (a.idxRaw !== undefined ? "[" + a.idxRaw + "]" : "") + (a.add ? "+=" : "=") + (Array.isArray(v) ? "(" + v.map(function (x) { return citarX(x.v); }).join(" ") + ")" : citarX(v)));
          if (!this.fazerAtrib(a, v)) { stA = 1; if (this.ehReadonly(this.resolverRef(a.name))) throw new CmdErr(1); }
        }
      } catch (e2) {
        if (e2 instanceof CmdErr) { this.status = 1; throw e2; }
        throw e2;
      }
      if (c.r.length) {
        var sv = yield* this.aplicarRedirs(c.r, false);
        if (sv === null) { this.status = 1; return 1; }
        this.desfazerRedirs(sv);
      }
      var st0 = stA ? 1 : (this.ultimoSubst !== null ? this.ultimoSubst : 0);
      this.fecharProcSubst();
      this.status = st0;
      return st0;
    }
    // atribuições temporárias (ambiente do comando)
    var tempVals = [];
    for (var t = 0; t < c.as.length; t++) { var tv = yield* this.valorAtrib(c.as[t]); tempVals.push(tv); }
    if (this.o.xtrace) {
      c.as.forEach(function (a, ix) { self.xtraceTxt(a.name + "=" + citarX(Array.isArray(tempVals[ix]) ? "" : tempVals[ix])); });
      this.xtraceTxt(args.map(citarX).join(" "));
    }
    this.ultimoArg = args[args.length - 1];
    this.bashCommand = imprimirSimples(c);
    // DEBUG
    if (this.traps[101] && !this.emTrapDebug) {
      this.emTrapDebug = true;
      this.definirSimples("BASH_COMMAND", args.join(" "));
      try { yield* this.rodarTexto(this.traps[101], { trap: true }); } finally { this.emTrapDebug = false; }
    }
    var salvos = yield* this.aplicarRedirs(c.r, args[0] === "exec" && args.length === 1);
    if (salvos === null) { this.fecharProcSubst(); this.status = 1; return 1; }
    var temp = null;
    if (c.as.length) {
      temp = Object.create(null);
      c.as.forEach(function (a, ix) { var vv = new Var(Array.isArray(tempVals[ix]) ? "" : tempVals[ix], { x: true }); temp[a.name] = vv; });
      Object.defineProperty(temp, "__temp", { value: true, enumerable: false }); this.pilhaLocal.push(temp);
    }
    var st;
    try {
      st = yield* this.executar(args, { decl: decl, temp: temp });
    } finally {
      if (temp) { var ix2 = this.pilhaLocal.lastIndexOf(temp); if (ix2 >= 0) this.pilhaLocal.splice(ix2, 1); }
      this.desfazerRedirs(salvos);
      this.fecharProcSubst();
    }
    this.status = st;
    if (this.pendSig.length) { yield* this.tratarSinais(); this.status = st; }
    return st;
  };
  // valor de uma atribuição: string ou lista de {k, v}
  SP.valorAtrib = function* (a) {
    if (a.arr) {
      var r = [];
      for (var i = 0; i < a.arr.length; i++) {
        var it = a.arr[i];
        if (it.chave) {
          var k = yield* this.expandirStr(it.chave, {});
          var v = yield* this.expandirStr(it.w, { atrib: true });
          r.push({ k: k, v: v, add: it.add, kRaw: it.chaveRaw });
        } else {
          var vs = yield* this.expandirPalavra(it.w);
          vs.forEach(function (x) { r.push({ k: null, v: x }); });
        }
      }
      return r;
    }
    return yield* this.expandirStr(a.val, { atrib: true });
  };
  SP.fazerAtrib = function (a, v, opt) {
    opt = opt || {};
    var nome = a.name;
    if (Array.isArray(v)) return this.atribuirLista(nome, v, a.add, opt);
    if (a.idx) {
      var vr = this.acharVar(this.resolverRef(nome));
      var chave;
      if (vr && vr.v instanceof Map) { chave = this.expSync(a.idx); if (chave === "") { this.erro(nome + "[" + a.idxRaw + "]: subscrito de array incorreto"); return false; } }
      else { var e = this.expSync(a.idx); var r = this.aritmeticaSegura(e === "" ? "0" : e); if (r === null) return false; chave = Number(r); if (chave < 0) { var len = vr && Array.isArray(vr.v) ? vr.v.length : (vr && vr.v !== undefined ? 1 : 0); chave = len + chave; if (chave < 0) { this.erro(nome + "[" + a.idxRaw + "]: subscrito de array incorreto"); return false; } } }
      return this.atribuir(nome, v, { idx: chave, add: a.add, local: opt.local, global: opt.global });
    }
    return this.atribuir(nome, v, { add: a.add, local: opt.local, global: opt.global });
  };
  // expansão síncrona simples (para subscritos: sem substituição de comando)
  SP.expSync = function (w) {
    var g = this.expandirStr(w, {}), r = g.next();
    while (!r.done) r = g.next();
    return r.value;
  };
  SP.atribuirLista = function (nome, itens, add, opt) {
    opt = opt || {};
    nome = this.resolverRef(nome);
    var esc = opt.local ? this.pilhaLocal[this.pilhaLocal.length - 1] : (opt.global ? this.globais : (this.escopoDe(nome) || this.globais));
    var v = esc[nome];
    if (v && v.at.r) { this.erro(nome + ": a variável permite somente leitura"); return false; }
    if (!v) v = esc[nome] = new Var(undefined, {});
    var self = this;
    if (v.v instanceof Map || v.at.A) {
      var m = add && v.v instanceof Map ? v.v : new Map();
      var pend = null;
      itens.forEach(function (it) {
        if (it.k !== null && it.k !== undefined) { m.set(it.k, (it.add && m.has(it.k) ? m.get(it.k) : "") + it.v); }
        else {
          // a=(chave valor chave valor) (Bash 5.1+)
          if (pend === null) pend = it.v; else { m.set(pend, it.v); pend = null; }
        }
      });
      if (pend !== null) m.set(pend, "");
      v.v = m; delete v.semValor;
      return true;
    }
    var arr = add ? (Array.isArray(v.v) ? v.v : (v.v === undefined ? [] : [v.v])) : [];
    var prox = add ? arr.length : 0, ok = true;
    itens.forEach(function (it) {
      var val = it.v;
      if (v.at.i) { var rr = self.aritmeticaSegura(val || "0"); if (rr === null) { ok = false; return; } val = rr; }
      if (it.k !== null && it.k !== undefined) {
        var r = self.aritmeticaSegura(it.k === "" ? "0" : it.k);
        if (r === null) { ok = false; return; }
        var ix = Number(r);
        if (ix < 0) ix = arr.length + ix;
        if (ix < 0) { self.erro(nome + "[" + it.k + "]: subscrito de array incorreto"); ok = false; return; }
        arr[ix] = (it.add && hasOwn(arr, ix) ? arr[ix] : "") + val; prox = ix + 1;
      } else { arr[prox++] = val; }
    });
    if (v.at.u) arr = arr.map(function (x) { return x.toUpperCase(); });
    if (v.at.l) arr = arr.map(function (x) { return x.toLowerCase(); });
    v.v = arr; v.at.a = true; delete v.semValor;
    return ok;
  };

  // procura um comando no PATH; devolve caminho ou null
  SP.acharNoPath = function (nome, semExec) {
    var path = this.valor("PATH");
    if (path === null) path = "";
    var dirs = path.split(":");
    for (var i = 0; i < dirs.length; i++) {
      var d = dirs[i] === "" ? "." : dirs[i];
      var c = (d === "/" ? "" : d) + "/" + nome;
      var r = this.resolver(c, true);
      if (r.no && r.no.t === "f" && (semExec || this.pode(r.no, 1))) return c;
    }
    return null;
  };
  SP.tipoDe = function (nome, semFuncao) {
    if (!semFuncao && this.funcs[nome]) return { t: "function" };
    if (BUILTINS[nome] && !(this.desabilitados && this.desabilitados[nome])) return { t: "builtin" };
    if (nome.indexOf("/") >= 0) return { t: "file", path: nome };
    var p = this.hash[nome] && this.hash[nome].path || this.acharNoPath(nome);
    if (p) return { t: "file", path: p };
    return null;
  };
  // executa um comando já expandido
  SP.executar = function* (args, opt) {
    opt = opt || {};
    var nome = args[0];
    if (!opt.semFuncao && this.funcs[nome] && !opt.builtin) return yield* this.chamarFuncao(nome, this.funcs[nome], args.slice(1));
    if (BUILTINS[nome] && !(this.desabilitados && this.desabilitados[nome]) && !opt.externo && !(this.ehSh && !DASH_BUILTINS[nome])) {
      try { return yield* BUILTINS[nome].call(this, args, opt); }
      catch (e) { if (e instanceof SigPipe) throw e; throw e; }
    }
    if (opt.builtin) { this.erro("builtin: " + nome + ": não é um comando interno do shell"); return 1; }
    // externo
    var caminho;
    if (nome.indexOf("/") >= 0) caminho = nome;
    else {
      if (nome === "") { this.erro(": comando não encontrado"); return 127; }
      caminho = this.hash[nome] ? this.hash[nome].path : this.acharNoPath(nome);
      if (!caminho && this.valor("PATH") === null) { this.erro(nome + ": Arquivo ou diretório inexistente"); return 127; }
      if (!caminho) {
        var semX = this.acharNoPath(nome, true);
        if (semX) { this.erro(semX + ": Permissão negada"); return 126; }
        if (this.funcs.command_not_found_handle && !this.emCNF) {
          this.emCNF = true;
          try { return yield* this.chamarFuncao("command_not_found_handle", this.funcs.command_not_found_handle, args); } finally { this.emCNF = false; }
        }
        this.erro(nome + (this.ehSh ? ": not found" : ": comando não encontrado")); return 127;
      }
      if (!this.hash[nome]) this.hash[nome] = { path: caminho, hits: 0 };
      this.hash[nome].hits++;
    }
    return yield* this.executarArquivo(caminho, args, opt);
  };
  SP.executarArquivo = function* (caminho, args, opt) {
    var r = this.resolver(caminho, true);
    if (!r.no) {
      if (r.err === "EACCES") { this.erro(caminho + ": Permissão negada"); return 126; }
      if (r.err === "ENOTDIR") { this.erro(caminho + ": Não é um diretório"); return 126; }
      this.erro(caminho + ": Arquivo ou diretório inexistente"); return 127;
    }
    var no = r.no;
    if (no.t === "d") { this.erro(caminho + ": É um diretório"); return 126; }
    if (!this.pode(no, 1)) { this.erro(caminho + ": Permissão negada"); return 126; }
    var base = caminho.slice(caminho.lastIndexOf("/") + 1);
    var dir = r.caminho.slice(0, r.caminho.lastIndexOf("/"));
    // programas do sistema simulados
    if ((dir === "/usr/bin" || dir === "/bin" || dir === "/usr/local/bin" || dir === "/usr/sbin") && no.d === null) {
      if (EXT[base]) return yield* this.rodarExterno(base, args, EXT[base]);
      this.escrever(2, "(simulador) o programa \"" + base + "\" não existe neste simulador. Experimente no terminal de verdade.\n");
      return 127;
    }
    // script de texto
    var txt = dadosDe(no);
    var linha1 = txt.split("\n")[0];
    var inter = null;
    if (/^#!/.test(linha1)) {
      var m = /^#!\s*([^ \t]+)(?:[ \t]+([\s\S]*))?$/.exec(linha1);
      inter = m ? m[1] : "";
      var argI = m && m[2] ? m[2].replace(/^[ \t]+|[ \t]+$/g, "") : "";
      var b = inter.slice(inter.lastIndexOf("/") + 1);
      var rI = this.resolver(inter, true);
      if (!rI.no || rI.no.t !== "f") { this.erro(caminho + ": " + inter.replace(/\r/g, "^M") + ": interpretador incorreto: Arquivo ou diretório inexistente"); return 126; }
      if (b === "env") {
        var progEnv = argI;
        if (/[\s\r]/.test(progEnv) || !(this.acharNoPath(progEnv) || progEnv.indexOf("/") >= 0)) {
          this.escrever(2, "env: ‘" + progEnv.replace(/\r/g, "\\r").replace(/\t/g, "\\t") + "’: Arquivo ou diretório inexistente\n");
          if (/[\s\r]/.test(progEnv)) this.escrever(2, "env: usa -[v]S para passar opções em linhas shebang\n");
          return 127;
        }
        b = progEnv;
      }
      if (b === "bash" || b === "sh" || b === "dash") {
        return yield* this.rodarScriptNovo(caminho, txt, args.slice(1), { argv0: args[0], sh: b === "sh" || b === "dash" });
      }
      if (EXT[b]) {
        var nArgs = [b].concat(argI && inter.slice(-3) !== "env" ? [argI] : []).concat([caminho]).concat(args.slice(1));
        return yield* this.rodarExterno(b, nArgs, EXT[b]);
      }
      this.escrever(2, "(simulador) scripts em \"" + (b || inter) + "\" não rodam neste simulador. Experimente no terminal de verdade.\n");
      return 126;
    }
    if (/\0/.test(txt.slice(0, 200)) || no.d === null) { this.erro(caminho + ": impossível executar o arquivo binário: Formato de executável não reconhecido"); return 126; }
    // sem shebang: o Bash roda com ele mesmo
    return yield* this.rodarScriptNovo(caminho, txt, args.slice(1), { argv0: args[0] });
  };
  // ambiente para programas externos
  SP.ambiente = function () { return this.exportadas(); };
  SP.rodarExterno = function* (nome, args, fn) {
    var io = new IO(this, nome);
    var st;
    try { st = yield* fn.call(io, args, io); }
    catch (e) {
      if (e instanceof SigPipe) return 141;
      if (e instanceof ExitSig) return e.code;
      throw e;
    }
    return st === undefined ? 0 : st;
  };
  // novo shell (processo) para rodar um script: herda só o ambiente exportado
  SP.novoShell = function () {
    var n = new Shell(this.k, {});
    var env = this.exportadas();
    // variáveis exportadas do pai
    for (var k in env) n.globais[k] = new Var(env[k], { x: true });
    // SHLVL não muda em script
    for (var f in this.funcs) if (this.funcs[f].exportada) n.funcs[f] = this.funcs[f];
    n.cwd = this.cwd; n.cwdLogico = this.cwdLogico;
    n.globais.PWD = new Var(this.cwdLogico, { x: true });
    if (this.valor("OLDPWD") !== null && env.OLDPWD !== undefined) n.globais.OLDPWD = new Var(env.OLDPWD, { x: true });
    n.fds = this.fds.map(function (x) { return ref(x); });
    n.umask = this.umask;
    n.interativo = false;
    n.semTTY = this.semTTY;
    n.raiz = null;
    n.hist = [];
    return n;
  };
  SP.rodarScriptNovo = function* (caminho, txt, args, opt) {
    opt = opt || {};
    var n = this.novoShell();
    n.arg0 = opt.argv0 || caminho; n.nome0 = opt.nome0 || n.arg0; n.pos = args.slice();
    n.scriptNome = caminho;
    if (opt.opcoes) for (var o in opt.opcoes) n.o[o] = opt.opcoes[o];
    if (opt.modoC) n.modoC = true;
    n.ehSh = !!opt.sh;
    var self = this;
    var proc = this.k.spawn(n, function* () {
      n.pidShell = proc.pid;
      return yield* n.rodarFonte(txt, { script: true, nomeArq: caminho, modoC: opt.modoC, soChecar: opt.soChecar });
    }, { bg: this.proc ? this.proc.bg : false, nome: "bash" });
    yield { t: "block", cond: function () { return proc.done; } };
    return proc.status;
  };

  /* ---------- funções ---------- */
  SP.chamarFuncao = function* (nome, fn, args) {
    var fn_ = parseInt(this.valor("FUNCNEST") || "0", 10);
    if (fn_ > 0 && this.funcStack.length >= fn_) { this.erro(nome + ": excedido o nível máximo de aninhamento de avaliação (" + fn_ + ")"); throw new CmdErr(1); }
    if (this.funcStack.length >= 150) { this.escrever(2, "(simulador) recursão profunda demais (mais de 150 chamadas de função aninhadas). No Bash real, isso pode estourar a memória; confira a condição de parada.\n"); throw new AbortSig("recursao"); }
    var escopo = Object.create(null);
    this.pilhaLocal.push(escopo);
    var posVelho = this.pos, loopVelho = this.loopNivel;
    this.pos = args.slice();
    this.loopNivel = 0;
    this.funcStack.push({ nome: nome, fonte: fn.fonte || (this.fonteStack.length ? this.fonteStack[this.fonteStack.length - 1] : (this.scriptNome || "main")), linha: this.lineno });
    var st = 0, lnSalvo = this.lnBase;
    this.lnBase = fn.lnBase || 0;
    try {
      try { st = yield* this.rodarComando(fn.body); }
      catch (e) {
        if (e instanceof ReturnSig) st = e.code;
        else throw e;
      }
      var quadro = this.funcStack[this.funcStack.length - 1];
      if (this.traps[102] && !this.emTrapRet && (this.o.functrace || (quadro && quadro.trapRet))) { this.emTrapRet = true; try { yield* this.rodarTexto(this.traps[102], { trap: true }); } finally { this.emTrapRet = false; } }
    } finally {
      var i = this.pilhaLocal.lastIndexOf(escopo); if (i >= 0) this.pilhaLocal.splice(i, 1);
      this.pos = posVelho; this.loopNivel = loopVelho;
      var qf = this.funcStack.pop();
      if (qf && qf.opcoesSalvas) this.o = qf.opcoesSalvas;
      this.lnBase = lnSalvo;
    }
    this.status = st;
    return st;
  };

  /* ---------- rodar texto (script, source, eval, bash -c, trap) ---------- */
  SP.novoParser = function (txt, opt) {
    return new Parser(txt, { aliases: this.shopt.expand_aliases ? this.aliases : null, extglob: this.shopt.extglob, linha: (opt && opt.linha) || 1, interativo: false, dash: !!this.ehSh });
  };
  SP.mostrarErroSintaxe = function (e, opt, txt) {
    opt = opt || {};
    var pref;
    if (this.ehSh) { this.escrever(2, this.nome0 + ": " + e.line + ": " + e.msg + "\n"); return; }
    if (this.interativo && !opt.script && !opt.eval) { this.escrever(2, "bash: " + e.msg + "\n"); if (e.extra) this.escrever(2, "bash: " + e.extra + "\n"); return; }
    if (opt.eval) pref = (this.interativo ? "bash: " : this.nome0 + ": ") + "eval: linha " + e.line + ": ";
    else if (opt.modoC) pref = this.nome0 + ": -c: linha " + e.line + ": ";
    else pref = this.nome0 + ": linha " + e.line + ": ";
    this.escrever(2, pref + e.msg + "\n");
    if (e.extra) this.escrever(2, (e.extraLinha ? pref.replace(/linha \d+: $/, "linha " + e.extraLinha + ": ") : pref) + e.extra + "\n");
    if (!e.semEco && txt !== undefined) {
      var linhas = txt.split("\n"), l = linhas[(e.line || 1) - 1];
      if (l !== undefined) this.escrever(2, pref + "`" + l + "'\n");
    }
  };
  SP.prefixoBase = function () { return this.interativo ? "bash: " : this.nome0 + ": linha " + this.lineno + ": "; };
  SP.rodarFonte = function* (txt, opt) {
    opt = opt || {};
    var p = this.novoParser(txt, opt);
    if (opt.lnBase) p.ln = 1;
    var st = 0;
    while (true) {
      var ast;
      p.aliases = this.shopt.expand_aliases ? this.aliases : null;
      p.extglob = this.shopt.extglob;
      try { ast = p.parseLinha(); }
      catch (e) {
        if (e instanceof SyntaxErr) {
          if (opt.script && !opt.eval) this.lineno = e.line;
          this.mostrarErroSintaxe(e, opt, p.s);
          st = 2; this.status = 2;
          if (opt.eval || opt.trap) return 2;
          if (opt.source) return 2;
          throw new FatalSig(2);
        }
        throw e;
      }
      if (p.avisos.length) { var self = this; p.avisos.forEach(function (a) { self.lineno = a.ln; self.erro(a.msg); }); p.avisos = []; }
      if (ast === undefined) break;
      if (ast === null) continue;
      if (opt.soChecar || this.o.noexec) { continue; }
      if (this.o.verbose) { this.escrever(2, txt.split("\n").slice((ast.items[0] && ast.items[0].c.p[0].cmds[0] ? (ast.items[0].c.p[0].cmds[0].ln || 1) : 1) - 1, p.ln - 1).join("\n") + "\n"); }
      try {
        st = yield* this.rodarLista(ast);
      } catch (e2) {
        if (e2 instanceof CmdErr) { st = e2.code; this.status = st; if (!this.interativo && opt.script && false) throw new FatalSig(st); continue; }
        throw e2;
      }
    }
    return st;
  };
  // texto de trap / eval executado no shell atual
  SP.rodarTexto = function* (txt, opt) {
    opt = opt || {};
    var st;
    var lnSalvo = this.lineno, travaSalva = this.travarLinha;
    if (opt.trap) this.travarLinha = true;
    try {
      st = yield* this.rodarFonte(txt, { eval: !opt.trap, trap: opt.trap, linha: 1 });
    } finally { if (opt.trap) { this.lineno = lnSalvo; this.travarLinha = travaSalva; } }
    return st;
  };
  SP.rodarTrapExit = function* (st) {
    var acao = this.traps[0];
    this.trapSaida = false;
    if (!acao) return st;
    delete this.traps[0];
    this.status = st;
    try { yield* this.rodarTexto(acao, { trap: true }); }
    catch (e) { if (e instanceof ExitSig) return e.code; if (!(e instanceof CmdErr || e instanceof ReturnSig || e instanceof BreakSig || e instanceof ContSig)) throw e; }
    return st;
  };

  /* ------------------------------------------------------------------
     9. Comandos internos
     ------------------------------------------------------------------ */
  function B(nome, fn) { BUILTINS[nome] = fn; }
  // separa opções no estilo dos builtins (-abc, --). Devolve {o, args, erro}
  function opcoesB(sh, args, validas, comValor, nomeCmd) {
    var o = {}, i = 1;
    for (; i < args.length; i++) {
      var a = args[i];
      if (a === "--") { i++; break; }
      if (a.length < 2 || (a[0] !== "-" && !(a[0] === "+" && validas.indexOf("+") >= 0))) break;
      var sinal = a[0];
      for (var j = 1; j < a.length; j++) {
        var c = a[j];
        if (validas.indexOf(c) < 0 || c === "+") return { erro: sinal + c, i: i };
        if (comValor && comValor.indexOf(c) >= 0) {
          var v = a.slice(j + 1);
          if (v === "") { i++; v = args[i]; if (v === undefined) return { faltaArg: c, i: i }; }
          o[c] = v; break;
        }
        o[c] = sinal === "+" ? "+" : true;
      }
    }
    return { o: o, args: args.slice(i) };
  }
  SP.erroB = function (cmd, msg) { this.erro(cmd + ": " + msg); };
  SP.usoB = function (cmd, uso) { this.escrever(2, cmd + ": uso: " + uso + "\n"); };
  SP.opInvalida = function (cmd, op, uso) { this.erro(cmd + ": " + op + ": opção inválida"); if (uso) this.usoB(cmd, uso); return 2; };

  B(":", function* () { return 0; });
  B("true", function* () { return 0; });
  B("false", function* () { return 1; });

  /* ---------- echo ---------- */
  B("echo", function* (args) {
    if (this.ehSh) {
      var dn = args[1] === "-n", txt = args.slice(dn ? 2 : 1).join(" "), rd = decodificarAnsi(txt, true);
      this.escrever(1, rd.s + (dn || rd.parar ? "" : "\n"));
      return 0;
    }
    var n = false, e = this.shopt.xpg_echo, i = 1;
    for (; i < args.length; i++) {
      if (!/^-[neE]+$/.test(args[i])) break;
      for (var j = 1; j < args[i].length; j++) { var c = args[i][j]; if (c === "n") n = true; else if (c === "e") e = true; else e = false; }
    }
    var s = args.slice(i).join(" "), parar = false;
    if (e) { var r = decodificarAnsi(s, true); s = r.s; parar = r.parar; }
    if (!n && !parar) s += "\n";
    if (!this.escrever(1, s) && s !== "") { this.erro("echo: erro de escrita: Descritor de arquivo inválido"); return 1; }
    return 0;
  });

  /* ---------- printf ---------- */
  function localeNum(sh) { // separador decimal conforme LC_ALL > LC_NUMERIC > LANG
    var l = sh.valor("LC_ALL"); if (!l) l = sh.valor("LC_NUMERIC"); if (!l) l = sh.valor("LANG");
    return l && /^pt/.test(l) ? "," : ".";
  }
  SP.decimal = function () { return localeNum(this); };
  function formatarNum(conv, flags, larg, prec, v, dec) {
    var s, neg = false;
    if (conv === "d" || conv === "i") {
      neg = typeof v === "bigint" ? v < 0 : v < 0;
      s = String(typeof v === "bigint" ? (neg ? -v : v) : Math.abs(v));
      if (prec !== null) while (s.length < prec) s = "0" + s;
      if (prec === 0 && s === "0") s = "";
    } else if (conv === "u" || conv === "o" || conv === "x" || conv === "X") {
      var b = HAS_BIG ? BigInt.asUintN(64, big(v)) : Math.abs(v);
      s = b.toString(conv === "o" ? 8 : conv === "u" ? 10 : 16);
      if (conv === "X") s = s.toUpperCase();
      if (prec !== null) while (s.length < prec) s = "0" + s;
      if (flags.indexOf("#") >= 0 && s !== "0") { if (conv === "o") s = "0" + s; else if (conv === "x") s = "0x" + s; else if (conv === "X") s = "0X" + s; }
    } else {
      neg = v < 0 || (v === 0 && 1 / v < 0);
      var a = Math.abs(v), p = prec === null ? 6 : prec;
      if (!isFinite(a)) s = isNaN(a) ? "nan" : "inf";
      else if (conv === "f" || conv === "F") s = fixoExato(a, p);
      else if (conv === "e" || conv === "E") s = expC(a, p);
      else if (conv === "g" || conv === "G") {
        var P = p === 0 ? 1 : p;
        var ex = a === 0 ? 0 : expExato(a, P - 1).e;
        if (ex < -4 || ex >= P) { s = expC(a, P - 1); if (flags.indexOf("#") < 0) s = s.replace(/\.?0+e/, "e"); }
        else { s = fixoExato(a, Math.max(0, P - 1 - ex)); if (flags.indexOf("#") < 0 && s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, ""); }
      } else if (conv === "a" || conv === "A") s = a.toString(16);
      if (conv === "E" || conv === "G") s = s.toUpperCase();
      s = s.replace(".", dec);
    }
    var sinal = neg ? "-" : (flags.indexOf("+") >= 0 ? "+" : (flags.indexOf(" ") >= 0 ? " " : ""));
    var corpo = s;
    if (larg !== null && flags.indexOf("-") < 0 && flags.indexOf("0") >= 0 && (prec === null || "feEgG".indexOf(conv) >= 0)) {
      while ((sinal + corpo).length < larg) corpo = "0" + corpo;
    }
    s = sinal + corpo;
    if (larg !== null) { if (flags.indexOf("-") >= 0) while (s.length < larg) s += " "; else while (s.length < larg) s = " " + s; }
    return s;
  }
  function expC(a, p) { var r = expExato(a, p); return r.dig + "e" + (r.e < 0 ? "-" : "+") + (Math.abs(r.e) < 10 ? "0" : "") + Math.abs(r.e); }
  // valor exato de um double como fração m·2^e (BigInt)
  function decompor(x) {
    var dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x);
    var hi = dv.getUint32(0), lo = dv.getUint32(4), ex = (hi >>> 20) & 2047;
    var m = BigInt(hi & 1048575) * BigInt(4294967296) + BigInt(lo);
    if (ex === 0) ex = 1; else m += BigInt(1) << BigInt(52);
    return { m: m, e: ex - 1075 };
  }
  // arredonda x·10^p para inteiro (meio para o par), x >= 0
  function potBig(n) { var r = BigInt(1), dez = BigInt(10); for (var i = 0; i < n; i++) r *= dez; return r; }
  function escalaExata(x, p) {
    var d = decompor(x), num = d.m, den = BigInt(1);
    if (p >= 0) num *= potBig(p); else den *= potBig(-p);
    if (d.e >= 0) num <<= BigInt(d.e); else den <<= BigInt(-d.e);
    var q = num / den, r = num % den, dobro = r * BigInt(2);
    if (dobro > den || (dobro === den && (q & BigInt(1)))) q += BigInt(1);
    return q;
  }
  function fixoExato(x, p) {
    if (!HAS_BIG || x === 0) return x.toFixed(p);
    var s = escalaExata(x, p).toString();
    if (p > 0) { while (s.length <= p) s = "0" + s; s = s.slice(0, s.length - p) + "." + s.slice(s.length - p); }
    return s;
  }
  function expExato(x, p) {
    if (x === 0) return { dig: p > 0 ? "0." + repete("0", p) : "0", e: 0 };
    if (!HAS_BIG) { var t = x.toExponential(p).split("e"); return { dig: t[0], e: parseInt(t[1], 10) }; }
    var e = Math.floor(Math.log10(x));
    for (var tent = 0; tent < 3; tent++) {
      var q = escalaExata(x, p - e).toString();
      if (q.length > p + 1) { e++; continue; }
      if (q.length < p + 1) { e--; continue; }
      return { dig: p > 0 ? q[0] + "." + q.slice(1) : q, e: e };
    }
    var t2 = x.toExponential(p).split("e"); return { dig: t2[0], e: parseInt(t2[1], 10) };
  }
  function bytesLen(s) { return utf8len(s); }
  function cortarBytes(s, n) { var r = "", t = 0; for (var ch of s) { var l = utf8len(ch); if (t + l > n) break; r += ch; t += l; } return r; }
  function padBytes(s, larg, esq) { var n = utf8len(s); while (n < larg) { s = esq ? s + " " : " " + s; n++; } return s; }
  // número de argumento do printf: devolve {v, erro}
  function numPrintf(a, inteiro, dec) {
    if (a === undefined || a === "") return { v: 0 };
    if (/^['"]/.test(a)) return { v: a.length > 1 ? a.codePointAt(1) : 0 };
    var t = a.replace(/^\s+/, "");
    if (inteiro) {
      var m = /^[+-]?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(t);
      if (!m) return { v: 0, erro: true };
      if (/^[+-]?0[0-7]*[89]/.test(t)) return { v: 0, erro: "octal" };
      var txt = m[0], neg = txt[0] === "-", corpo = txt.replace(/^[+-]/, "");
      var v = /^0[xX]/.test(corpo) ? parseInt(corpo, 16) : (/^0[0-7]/.test(corpo) ? parseInt(corpo, 8) : parseInt(corpo, 10));
      if (!seguro(v) && HAS_BIG) { v = norm(BigInt(corpo.replace(/^0(?=[0-7])/, "0o"))); }
      if (neg) v = typeof v === "bigint" ? -v : -v;
      return { v: v, erro: txt.length !== t.length };
    }
    var re = dec === "," ? /^[+-]?([0-9]+(,[0-9]*)?|,[0-9]+)([eE][+-]?[0-9]+)?|^[+-]?(inf|infinity|nan)/i : /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?|^[+-]?(inf|infinity|nan)|^[+-]?0[xX][0-9a-fA-F]+/i;
    var m2 = re.exec(t);
    if (!m2) return { v: 0, erro: true };
    var num = parseFloat(m2[0].replace(",", "."));
    if (/^[+-]?0[xX]/.test(m2[0])) num = parseInt(m2[0], 16);
    return { v: num, erro: m2[0].length !== t.length };
  }
  SP.printfFormatar = function (fmt, args, cmd) {
    var self = this, out = "", ai = 0, st = 0, dec = localeNum(this), parar = false;
    function prox() { return ai < args.length ? args[ai++] : undefined; }
    var usouArg;
    do {
      usouArg = false;
      var i = 0;
      while (i < fmt.length && !parar) {
        var c = fmt[i];
        if (c === "\\") {
          var n = fmt[i + 1], m;
          if (n === undefined) { out += "\\"; i++; continue; }
          if (/[0-7]/.test(n)) { m = /^[0-7]{1,3}/.exec(fmt.slice(i + 1)); out += String.fromCharCode(parseInt(m[0], 8) & 255); i += 1 + m[0].length; continue; }
          if (n === "x") { m = /^[0-9a-fA-F]{1,2}/.exec(fmt.slice(i + 2)); if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; } this.erro(cmd + ": faltando dígito hexa para \\x"); out += "\\x"; i += 2; st = 1; continue; }
          if (n === "u" || n === "U") { m = (n === "u" ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(fmt.slice(i + 2)); if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += 2 + m[0].length; continue; } }
          var mapa = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'", "?": "?" };
          if (hasOwn(mapa, n)) { out += mapa[n]; i += 2; continue; }
          if (n === "c") { parar = true; break; }
          out += "\\" + n; i += 2; continue;
        }
        if (c !== "%") { out += c; i++; continue; }
        if (fmt[i + 1] === "%") { out += "%"; i += 2; continue; }
        var mm = /^%([-+ #0']*)(\*|[0-9]+)?(?:\.(\*|[0-9]*))?(hh|h|ll|l|L|j|z|t)?(\([^)]*\)T|.)?/.exec(fmt.slice(i));
        var flags = mm[1], larg = mm[2], prec = mm[3], conv = mm[5];
        i += mm[0].length;
        if (larg === "*") { usouArg = true; var la = numPrintf(prox(), true, dec); larg = Number(la.v); if (larg < 0) { flags += "-"; larg = -larg; } }
        else larg = larg ? parseInt(larg, 10) : null;
        if (prec === "*") { usouArg = true; prec = Number(numPrintf(prox(), true, dec).v); if (prec < 0) prec = null; }
        else prec = prec !== undefined ? (prec === "" ? 0 : parseInt(prec, 10)) : null;
        if (!conv) { this.erro(cmd + ": `%': faltando caractere de formato"); st = 1; parar = true; break; }
        var a;
        if (/\(.*\)T/.test(conv)) {
          usouArg = true; a = prox();
          var ts = a === undefined || a === "" || a === "-1" ? Math.floor(this.k.clock / 1000) : (a === "-2" ? Math.floor(this.inicio / 1000) : parseInt(a, 10));
          var s0 = formatarData(conv.slice(1, -2) || "%X", ts * 1000);
          if (larg !== null) s0 = padBytes(s0, larg, flags.indexOf("-") >= 0);
          out += s0; continue;
        }
        switch (conv) {
          case "s": case "b": case "q": case "Q": {
            usouArg = true; a = prox(); if (a === undefined) a = "";
            if (conv === "b") { var r = decodificarAnsi(a, "b"); a = r.s; if (r.parar) { parar = true; } }
            if (conv === "q") a = citarPrintfQ(a);
            if (conv === "Q") a = citarPrintfQ(prec !== null ? cortarBytes(a, prec) : a);
            if (prec !== null && conv !== "Q") a = cortarBytes(a, prec);
            if (larg !== null) a = padBytes(a, larg, flags.indexOf("-") >= 0);
            out += a; break;
          }
          case "c": {
            usouArg = true; a = prox(); if (a === undefined) a = "";
            a = a ? Array.from(a)[0] : "";
            if (larg !== null) a = padBytes(a, larg, flags.indexOf("-") >= 0);
            out += a; break;
          }
          case "d": case "i": case "o": case "u": case "x": case "X": {
            usouArg = true; a = prox();
            var nv = numPrintf(a, true, dec);
            if (nv.erro) { this.erro(cmd + ": " + a + ": número " + (nv.erro === "octal" ? "octal " : "") + "inválido"); st = 1; }
            out += formatarNum(conv, flags, larg, prec, nv.v, dec); break;
          }
          case "f": case "F": case "e": case "E": case "g": case "G": case "a": case "A": {
            usouArg = true; a = prox();
            var fv = numPrintf(a, false, dec);
            if (fv.erro) { this.erro(cmd + ": " + a + ": número inválido"); st = 1; }
            out += formatarNum(conv, flags, larg, prec, fv.v, dec); break;
          }
          default:
            this.erro(cmd + ": `" + conv + "': caractere de formato inválido"); st = 1; parar = true;
        }
      }
    } while (usouArg && ai < args.length && !parar);
    return { s: out, st: st };
  };
  B("printf", function* (args) {
    var i = 1, var_ = null;
    if (args[1] === "-v") { var_ = args[2]; i = 3; if (var_ === undefined) { this.erro("printf: -v: a opção requer um argumento"); this.usoB("printf", "printf [-v var] formato [argumentos]"); return 2; } }
    else if (args[1] === "--") i = 2;
    else if (args[1] && /^-./.test(args[1]) && args[1] !== "-") { this.erro("printf: " + args[1].slice(0, 2) + ": opção inválida"); this.usoB("printf", "printf [-v var] formato [argumentos]"); return 2; }
    if (args[i] === "--" && var_) i++;
    if (args[i] === undefined) { this.usoB("printf", "printf [-v var] formato [argumentos]"); return 2; }
    var r = this.printfFormatar(args[i], args.slice(i + 1), "printf");
    if (var_ !== null) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?$/.test(var_)) { this.erro("printf: `" + var_ + "': nome de variável inválido"); return 2; }
      if (!this.atribuir(var_, r.s)) return 1;
      return r.st;
    }
    if (!this.escrever(1, r.s) && r.s) { this.erro("printf: erro de escrita: Descritor de arquivo inválido"); return 1; }
    return r.st;
  });

  /* ---------- read ---------- */
  B("read", function* (args) {
    var o = {}, i = 1, nomes = [];
    for (; i < args.length; i++) {
      var a = args[i];
      if (a === "--") { i++; break; }
      if (a[0] !== "-" || a.length < 2) break;
      for (var j = 1; j < a.length; j++) {
        var c = a[j];
        if ("ers".indexOf(c) >= 0) { o[c] = true; continue; }
        if ("adinNptu".indexOf(c) >= 0) {
          var v = a.slice(j + 1);
          if (v === "") { i++; v = args[i]; }
          if (v === undefined) { this.erro("read: -" + c + ": a opção requer um argumento"); this.usoB("read", "read [-Eers] [-a array] [-d delim] [-i texto] [-n nchars] [-N nchars] [-p prompt] [-t tempo] [-u fd] [nome ...]"); return 2; }
          o[c] = v; break;
        }
        this.erro("read: -" + c + ": opção inválida"); this.usoB("read", "read [-Eers] [-a array] [-d delim] [-i texto] [-n nchars] [-N nchars] [-p prompt] [-t tempo] [-u fd] [nome ...]"); return 2;
      }
    }
    nomes = args.slice(i);
    for (var q = 0; q < nomes.length; q++) if (!/^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?$/.test(nomes[q])) { this.erro("read: `" + nomes[q] + "': não é um identificador válido"); return 1; }
    if (o.a && !nomeValido(o.a)) { this.erro("read: `" + o.a + "': não é um identificador válido"); return 1; }
    var fd = o.u !== undefined ? parseInt(o.u, 10) : 0;
    if (o.u !== undefined && (!/^[0-9]+$/.test(o.u) || !this.fds[fd])) { this.erro("read: " + o.u + ": descritor de arquivo inválido: Descritor de arquivo inválido"); return 1; }
    var fonte = this.fds[fd];
    if (!fonte) { this.erro("read: erro de leitura: 0: Descritor de arquivo inválido"); return 1; }
    var delim = o.d !== undefined ? (o.d === "" ? "\0" : o.d[0]) : "\n";
    var max = o.N !== undefined ? parseInt(o.N, 10) : (o.n !== undefined ? parseInt(o.n, 10) : null);
    if (o.N !== undefined) delim = null;
    var ehTty = isTTY(fonte);
    if (o.p !== undefined && ehTty) this.escreverPrompt(o.p);
    if (o.t !== undefined) {
      var tt = parseFloat(o.t);
      if (isNaN(tt)) { this.erro("read: " + o.t + ": especificação de tempo limite inválida"); return 1; }
      if (tt === 0) { var disp = fonteAvail(this.k, fonte) !== "" || fonte.kind === "file" || fonte.kind === "null" || fonteEOF(this.k, fonte); return disp ? 0 : 1; }
      if (ehTty && this.k.semTeclado) { this.k.clock += tt * 1000; return 142; }
    }
    var req = { prompt: o.p !== undefined ? o.p : "", silencioso: !!o.s, n: max, tempo: o.t };
    var linha = "", achou = false, crua = !!o.r;
    while (true) {
      var r = yield* lerAte(this.k, fonte, delim === null ? null : delim, max === null ? null : max - Array.from(linha).length, req);
      if (r.erro) { this.erro("read: erro de leitura: " + fd + ": Descritor de arquivo inválido"); return 1; }
      if (r.tempo) { return 142; }
      var s = r.s;
      achou = r.achou;
      if (!crua && achou && !r.max && /(^|[^\\])(\\\\)*\\$/.test(s) && delim === "\n") { linha += s.slice(0, -1); continue; }
      linha += s;
      break;
    }
    if (ehTty && o.s && this.k.ecoSilencioso) this.escrever(2, "\n");
    // barras invertidas (sem -r): \x vira x e protege da separação
    var chars = [], prot = [];
    for (var k = 0; k < linha.length; k++) {
      if (!crua && linha[k] === "\\" && k + 1 < linha.length) { chars.push(linha[k + 1]); prot.push(true); k++; continue; }
      if (!crua && linha[k] === "\\") { continue; }
      chars.push(linha[k]); prot.push(false);
    }
    var ifs = ifsDe(this), ws = ifs.replace(/[^ \t\n]/g, ""), nws = ifs.replace(/[ \t\n]/g, "");
    var self = this;
    function ehWs(ix) { return !prot[ix] && ws.indexOf(chars[ix]) >= 0; }
    function ehNws(ix) { return !prot[ix] && nws.indexOf(chars[ix]) >= 0; }
    function texto(a, b) { return chars.slice(a, b).join(""); }
    var stFinal = achou || r && r.max ? 0 : 1;
    if (!achou && linha === "" && !(r && r.max)) {
      // EOF sem dados: variáveis ficam vazias
      if (o.a) this.definirArray(o.a, []);
      else if (!nomes.length) this.atribuir("REPLY", "");
      else nomes.forEach(function (n) { self.atribuir(n, ""); });
      return 1;
    }
    if (!nomes.length && !o.a) { this.atribuir("REPLY", chars.join("")); return stFinal; }
    if (o.N !== undefined && nomes.length === 1) { return this.atribuir(nomes[0], chars.join("")) ? stFinal : 1; }
    // separa em campos
    var campos = [], p = 0, n = chars.length;
    while (p < n && ehWs(p)) p++;
    var nVars = o.a ? Infinity : nomes.length;
    while (p < n) {
      if (campos.length === nVars - 1) {
        // último nome: o resto da linha, sem os brancos de IFS do fim
        var fim = n;
        while (fim > p && ehWs(fim - 1)) fim--;
        // um delimitador não-branco solitário no fim é removido
        if (fim > p && ehNws(fim - 1)) {
          var t2 = fim - 1; while (t2 > p && ehWs(t2 - 1)) t2--;
          var resto = texto(p, t2), temOutro = false;
          for (var z = p; z < t2; z++) if (ehNws(z)) temOutro = true;
          if (!temOutro) fim = t2;
        }
        campos.push({ ini: p, fim: fim });
        p = n; break;
      }
      var ini = p;
      while (p < n && !ehWs(p) && !ehNws(p)) p++;
      campos.push({ ini: ini, fim: p });
      while (p < n && ehWs(p)) p++;
      if (p < n && ehNws(p)) { p++; while (p < n && ehWs(p)) p++; if (p >= n && o.a === undefined && campos.length < nVars - 1) { /* termina */ } }
    }
    var valores = campos.map(function (cp) { return texto(cp.ini, cp.fim); });
    if (o.a) { this.definirArray(o.a, valores); return stFinal; }
    for (var w = 0; w < nomes.length; w++) if (!this.atribuir(nomes[w], valores[w] !== undefined ? valores[w] : "")) return 1;
    return stFinal;
  });

  B("mapfile", function* (args) {
    var r = opcoesB(this, args, "tnOsdCcu", "nOsdCcu");
    if (r.erro) return this.opInvalida(args[0], r.erro, args[0] + " [-d delim] [-n número] [-O origem] [-s número] [-t] [-u fd] [-C chamada] [-c quantidade] [array]");
    var o = r.o, nome = r.args[0] || "MAPFILE";
    var fd = o.u !== undefined ? parseInt(o.u, 10) : 0, fonte = this.fds[fd];
    if (!fonte) { this.erro(args[0] + ": " + o.u + ": descritor de arquivo inválido"); return 1; }
    var delim = o.d !== undefined ? (o.d === "" ? "\0" : o.d[0]) : "\n";
    var lim = o.n !== undefined ? parseInt(o.n, 10) : 0, pular = o.s !== undefined ? parseInt(o.s, 10) : 0;
    var origem = o.O !== undefined ? parseInt(o.O, 10) : 0;
    var v = this.acharVar(nome);
    var arr = o.O !== undefined && v && Array.isArray(v.v) ? v.v.slice() : [];
    var k = origem, lidas = 0, quantum = o.c !== undefined ? parseInt(o.c, 10) : 5000;
    while (!lim || lidas < lim) {
      var l = yield* lerAte(this.k, fonte, delim, null, {});
      if (!l.achou && l.s === "") break;
      if (pular > 0) { pular--; continue; }
      var valor = o.t || !l.achou || delim === "\0" ? l.s : l.s + delim;
      if (o.C !== undefined && (lidas + 1) % quantum === 0) {
        this.definirArray(nome, arr);
        yield* this.rodarTexto(o.C + " " + k + " " + citarQ(valor), {});
        arr = (this.acharVar(nome) || { v: arr }).v || arr;
      }
      arr[k++] = valor;
      lidas++;
      if (!l.achou) break;
    }
    this.definirArray(nome, arr);
    return 0;
  });
  BUILTINS.readarray = BUILTINS.mapfile;

  /* ---------- diretórios ---------- */
  SP.mudarDir = function (destino, cmd, fisico) {
    var alvo = destino[0] === "/" ? destino : (this.cwdLogico === "/" ? "" : this.cwdLogico) + "/" + destino;
    var logico = normalizar(alvo);
    var r = this.resolver(fisico ? alvo : logico, true);
    if (!r.no) {
      var r2 = this.resolver(alvo, true);
      if (r2.no && r2.no.t === "d") r = r2; else { this.erro(cmd + ": " + destino + ": " + ERRNO[r.err === "ENOENT" || !r.err ? "ENOENT" : r.err]); return false; }
    }
    if (r.no.t !== "d") { this.erro(cmd + ": " + destino + ": Não é um diretório"); return false; }
    if (!this.pode(r.no, 1)) { this.erro(cmd + ": " + destino + ": Permissão negada"); return false; }
    var velho = this.cwdLogico;
    this.cwd = r.caminho;
    this.cwdLogico = fisico ? r.caminho : logico;
    var vo = this.acharVar("OLDPWD");
    this.atribuir("OLDPWD", velho); if (!vo) this.acharVar("OLDPWD").at.x = true;
    this.atribuir("PWD", this.cwdLogico);
    return true;
  };
  B("cd", function* (args) {
    var i = 1, fisico = this.o.physical;
    while (i < args.length && /^-[LPe@]+$/.test(args[i])) { if (args[i].indexOf("P") >= 0) fisico = true; if (args[i].indexOf("L") >= 0) fisico = false; i++; }
    if (args[i] === "--") i++;
    else if (args[i] && /^-./.test(args[i]) && args[i] !== "-") return this.opInvalida("cd", args[i].slice(0, 2), "cd [-L|[-P [-e]]] [-@] [dir]");
    var resto = args.slice(i);
    if (resto.length > 1) { this.erro("cd: número excessivo de argumentos"); return 2; }
    var d = resto[0], imprimir = false;
    if (d === undefined) { d = this.valor("HOME"); if (d === null) { this.erro("cd: HOME não definida"); return 1; } if (d === "") return 0; }
    else if (d === "") { this.erro("cd: diretório nulo"); return 1; }
    else if (d === "-") { d = this.valor("OLDPWD"); if (d === null) { this.erro("cd: OLDPWD não definida"); return 1; } imprimir = true; }
    else if (d[0] !== "/" && !/^\.\.?(\/|$)/.test(d)) {
      var cdp = this.valor("CDPATH");
      if (cdp) {
        var dirs = cdp.split(":");
        for (var k = 0; k < dirs.length; k++) {
          var base = dirs[k] || ".";
          var c = (base === "/" ? "" : base) + "/" + d;
          var rr = this.resolver(c[0] === "/" ? c : c, true);
          if (rr.no && rr.no.t === "d") {
            if (!this.mudarDir(c, "cd", fisico)) return 1;
            if (dirs[k] !== "") this.escrever(1, this.cwdLogico + "\n");
            return 0;
          }
        }
      }
    }
    if (!this.mudarDir(d, "cd", fisico)) return 1;
    if (imprimir) this.escrever(1, this.cwdLogico + "\n");
    return 0;
  });
  B("pwd", function* (args) {
    var r = opcoesB(this, args, "LP");
    if (r.erro) return this.opInvalida("pwd", r.erro, "pwd [-LP]");
    this.escrever(1, (r.o.P ? this.cwd : this.cwdLogico) + "\n");
    return 0;
  });
  SP.dirsLista = function (longo) { var self = this; return [this.cwdLogico].concat(this.dirStack).map(function (d) { return longo ? d : self.curto(d); }); };
  B("dirs", function* (args) {
    var r = opcoesB(this, args, "clpv");
    if (r.erro) return this.opInvalida("dirs", r.erro, "dirs [-clpv] [+N] [-N]");
    var o = r.o;
    if (o.c) { this.dirStack = []; return 0; }
    var l = this.dirsLista(o.l);
    if (r.args.length) {
      var m = /^([+-])([0-9]+)$/.exec(r.args[0]);
      if (!m) { this.erro("dirs: " + r.args[0] + ": opção inválida"); this.usoB("dirs", "dirs [-clpv] [+N] [-N]"); return 2; }
      var n = +m[2], ix = m[1] === "+" ? n : l.length - 1 - n;
      if (ix < 0 || ix >= l.length) { this.erro("dirs: " + r.args[0] + ": índice de pilha de diretórios inválido"); return 1; }
      this.escrever(1, l[ix] + "\n"); return 0;
    }
    if (o.v) this.escrever(1, l.map(function (d, i) { return pad(i, 2) + "  " + d; }).join("\n") + "\n");
    else if (o.p) this.escrever(1, l.join("\n") + "\n");
    else this.escrever(1, l.join(" ") + "\n");
    return 0;
  });
  B("pushd", function* (args) {
    var semCd = false, a = args.slice(1);
    if (a[0] === "-n") { semCd = true; a.shift(); }
    if (!a.length) {
      if (!this.dirStack.length) { this.erro("pushd: nenhum outro diretório"); return 1; }
      var topo = this.dirStack[0], atual = this.cwdLogico;
      if (!this.mudarDir(topo, "pushd")) return 1;
      this.dirStack[0] = atual;
    } else if (/^[+-][0-9]+$/.test(a[0])) {
      var l = [this.cwdLogico].concat(this.dirStack), n = +a[0].slice(1), ix = a[0][0] === "+" ? n : l.length - 1 - n;
      if (ix < 0 || ix >= l.length) { this.erro("pushd: " + a[0] + ": índice de pilha de diretórios inválido"); return 1; }
      var rot = l.slice(ix).concat(l.slice(0, ix));
      if (!this.mudarDir(rot[0], "pushd")) return 1;
      this.dirStack = rot.slice(1);
    } else {
      var velho = this.cwdLogico;
      if (!semCd) { if (!this.mudarDir(a[0], "pushd")) return 1; this.dirStack.unshift(velho); }
      else this.dirStack.unshift(this.abs(a[0]));
    }
    this.escrever(1, this.dirsLista().join(" ") + "\n");
    return 0;
  });
  B("popd", function* (args) {
    var a = args.slice(1), semCd = false;
    if (a[0] === "-n") { semCd = true; a.shift(); }
    if (!this.dirStack.length) { this.erro("popd: pilha de diretórios está vazia"); return 1; }
    if (a.length && /^[+-][0-9]+$/.test(a[0])) {
      var l = [this.cwdLogico].concat(this.dirStack), n = +a[0].slice(1), ix = a[0][0] === "+" ? n : l.length - 1 - n;
      if (ix < 0 || ix >= l.length) { this.erro("popd: " + a[0] + ": índice de pilha de diretórios inválido"); return 1; }
      if (ix === 0) { if (!this.mudarDir(this.dirStack[0], "popd")) return 1; this.dirStack.shift(); }
      else this.dirStack.splice(ix - 1, 1);
    } else if (a.length) { this.erro("popd: " + a[0] + ": opção inválida"); this.usoB("popd", "popd [-n] [+N | -N]"); return 2; }
    else {
      if (!semCd) { if (!this.mudarDir(this.dirStack[0], "popd")) return 1; }
      this.dirStack.shift();
    }
    this.escrever(1, this.dirsLista().join(" ") + "\n");
    return 0;
  });

  /* ---------- variáveis ---------- */
  function citarDeclare(s) { return '"' + s.replace(/(["\\$`])/g, "\\$1") + '"'; }
  SP.declaracao = function (nome, semDeclare) {
    var v = this.acharVar(nome);
    var ae = this.arrayEspecial(nome);
    if (!v && !ae) return null;
    var flags = v ? atributosStr(v) : "a";
    var s = (semDeclare ? "declare" : "declare") + " -" + (flags || "-") + " " + nome;
    if (ae && !v) return s + "=(" + ae.map(function (x, i) { return "[" + i + "]=" + citarDeclare(x); }).join(" ") + ")";
    if (v.v === undefined) return s;
    if (v.v instanceof Map) {
      var ks = ordemAssoc(v.v);
      if (!ks.length) return v.semValor ? s : s + "=()";
      return s + "=(" + ks.map(function (k) { return "[" + (/^[A-Za-z0-9_.\/-]+$/.test(k) ? k : citarDeclare(k)) + "]=" + citarDeclare(v.v.get(k)); }).join(" ") + " )";
    }
    if (Array.isArray(v.v) && !v.v.length && v.semValor) return s;
    if (Array.isArray(v.v)) return s + "=(" + Object.keys(v.v).map(function (i) { return "[" + i + "]=" + citarDeclare(v.v[i]); }).join(" ") + ")";
    return s + "=" + citarDeclare(v.v);
  };
  SP.mostrarFuncao = function (nome) {
    var f = this.funcs[nome];
    return nome + " () \n" + imprimirCmd(f.body, 0, true) + "\n";
  };
  SP.declarar = function (cmd, args, opt) {
    var self = this;
    var flags = {}, mais = {}, i = 1;
    for (; i < args.length; i++) {
      var a = args[i];
      if (opt.decl && opt.decl[i]) break;
      if (a === "--") { i++; break; }
      if (!/^[-+]/.test(a) || a.length < 2) break;
      for (var j = 1; j < a.length; j++) {
        var c = a[j];
        if ("aAfFgiIlnprtux".indexOf(c) < 0 || (cmd === "local" && "fFg".indexOf(c) >= 0 && false)) {
          this.erro(cmd + ": " + a[0] + c + ": opção inválida");
          this.usoB(cmd, cmd === "local" ? "local [opção] nome[=valor] ..." : cmd + " [-aAfFgiIlnrtux] nome[=valor] ... ou " + cmd + " -p [-aAfFilnrtux] [nome ...]");
          return 2;
        }
        if (a[0] === "-") flags[c] = true; else mais[c] = true;
      }
    }
    var nomes = [];
    for (; i < args.length; i++) {
      if (cmd === "local" && args[i] === "-" && this.funcStack.length) { var qd = this.funcStack[this.funcStack.length - 1]; if (!qd.opcoesSalvas) { qd.opcoesSalvas = {}; for (var ko in this.o) qd.opcoesSalvas[ko] = this.o[ko]; } continue; }
      nomes.push({ txt: args[i], d: opt.decl ? opt.decl[i] : null });
    }
    if (cmd === "local" && !nomes.length && args.indexOf("-") > 0) return 0;
    var local = cmd === "local" || (this.pilhaLocal.filter(function (e) { return !e.__temp; }).length > 0 && !flags.g && (cmd === "declare" || cmd === "typeset"));
    if (cmd === "local" && !this.funcStack.length) { this.erro("local: somente pode ser usado em uma função"); return 1; }
    // listar
    if (flags.f || flags.F) {
      var fns = nomes.length ? nomes.map(function (n) { return n.txt; }) : Object.keys(this.funcs).sort(cmpBytes);
      var st = 0;
      fns.forEach(function (n) {
        if (!self.funcs[n]) { st = 1; return; }
        if (flags.F) self.escrever(1, (nomes.length ? n : "declare -f " + n) + "\n");
        else self.escrever(1, self.mostrarFuncao(n));
      });
      if (flags.r || flags.x) { fns.forEach(function (n) { if (self.funcs[n] && flags.x) self.funcs[n].exportada = true; }); }
      return st;
    }
    if (!nomes.length && (flags.p || !Object.keys(flags).length || Object.keys(flags).every(function (k) { return k === "p"; }) || true)) {
      if (!nomes.length) {
        var lista = this.nomesVars().filter(function (n) {
          var v = self.acharVar(n); if (!v) return !flags.a && !flags.A && !flags.i && !flags.r && !flags.x && !flags.l && !flags.u && !flags.n && !!self.arrayEspecial(n) && false;
          if (flags.a && !(Array.isArray(v.v))) return false; if (flags.A && !(v.v instanceof Map)) return false;
          if (flags.i && !v.at.i) return false; if (flags.r && !v.at.r) return false; if (flags.x && !v.at.x) return false;
          return true;
        });
        if (!flags.p && !Object.keys(flags).length) {
          lista.forEach(function (n) { var v = self.acharVar(n); if (!v || v.v === undefined) return; var d = self.declaracao(n); self.escrever(1, (Array.isArray(v.v) || v.v instanceof Map ? n + "=" + d.slice(d.indexOf("=") + 1) : n + "=" + citarSet(v.v)) + "\n"); });
          return 0;
        }
        lista.forEach(function (n) { var d = self.declaracao(n); if (d) self.escrever(1, d + "\n"); });
        return 0;
      }
    }
    if (flags.p) {
      var st2 = 0;
      nomes.forEach(function (n) {
        var d = self.declaracao(n.txt);
        if (d === null) { self.erro(cmd + ": " + n.txt + ": não encontrado"); st2 = 1; return; }
        self.escrever(1, d + "\n");
      });
      return st2;
    }
    var stF = 0;
    nomes.forEach(function (n) {
      var nome, at = n.d ? n.d.a : null, val = n.d ? n.d.v : undefined;
      if (at) nome = at.name;
      else {
        var m = /^([^=]*?)(\+?=)([\s\S]*)$/.exec(n.txt);
        if (m) { nome = m[1]; val = m[3]; at = { name: nome, add: m[2] === "+=" }; var mi = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(nome); if (mi) { at.name = nome = mi[1]; at.idx = { p: [{ t: "L", v: mi[2] }], raw: mi[2] }; at.idxRaw = mi[2]; } }
        else nome = n.txt;
      }
      var nomeBase = nome.replace(/\[.*$/, "");
      if (!nomeValido(nomeBase)) { self.erro(cmd + ": `" + n.txt + "': não é um identificador válido"); stF = 1; return; }
      var esc = local ? self.pilhaLocal[self.pilhaLocal.length - 1] : (flags.g ? self.globais : (self.escopoDe(nomeBase) || self.globais));
      if (local && esc && esc.__temp) { var ix = self.pilhaLocal.length - 2; while (ix >= 0 && self.pilhaLocal[ix].__temp) ix--; esc = self.pilhaLocal[ix]; }
      var v = esc[nomeBase];
      if (v && v.at.r && (val !== undefined || Object.keys(flags).some(function (f) { return f !== "r" && f !== "x" && f !== "p"; }))) {
        self.erro(cmd + ": " + nomeBase + ": a variável permite somente leitura"); stF = 1; return;
      }
      if (!v) {
        v = esc[nomeBase] = new Var(undefined, {});
        if (local) v.local = true;
        // local herda o valor? (não, a menos de localvar_inherit)
        if (self.o.allexport) v.at.x = true;
      }
      if (flags.a && v.v instanceof Map) { self.erro(cmd + ": " + nomeBase + ": impossível converter array associativo para indexado"); stF = 1; return; }
      if (flags.A && Array.isArray(v.v) && v.v.length) { self.erro(cmd + ": " + nomeBase + ": impossível converter array indexado para associativo"); stF = 1; return; }
      if (flags.A && !(v.v instanceof Map)) { if (v.v === undefined) v.semValor = true; v.v = new Map(); v.at.A = true; }
      if (flags.a && !Array.isArray(v.v)) { if (v.v === undefined) v.semValor = true; v.v = v.v === undefined ? [] : [v.v]; v.at.a = true; }
      "ilunxt".split("").forEach(function (f) { if (flags[f]) v.at[f] = true; if (mais[f]) delete v.at[f]; });
      if (flags.l) delete v.at.u; if (flags.u) delete v.at.l;
      if (val !== undefined) {
        var ok;
        var opt2 = { local: false };
        var escSalvo = null;
        if (Array.isArray(val)) ok = self.atribuirListaEm(esc, nomeBase, val, at.add);
        else {
          if (v.at.n && !at.idx) { v.v = val; ok = true; }
          else {
            // atribui diretamente neste escopo
            var tmp = self.pilhaLocal;
            ok = self.atribuirEm(esc, nomeBase, val, at);
          }
        }
        if (!ok) stF = 1;
      } else if (cmd === "local" && v.v === undefined && false) { /* local sem valor: fica sem valor */ }
      if (flags.r) v.at.r = true;
      if (flags.x && v.v === undefined && false) { }
    });
    return stF;
  };
  SP.atribuirEm = function (esc, nome, val, at) {
    // escolhe o escopo certo temporariamente
    var salvo = this.pilhaLocal;
    if (esc === this.globais) { this.pilhaLocal = []; }
    else { var ix = salvo.indexOf(esc); this.pilhaLocal = salvo.slice(0, ix + 1); }
    try {
      if (at && at.idx) return this.fazerAtrib(at, val);
      return this.atribuir(nome, val, { add: at && at.add, semRef: false });
    } finally { this.pilhaLocal = salvo; }
  };
  SP.atribuirListaEm = function (esc, nome, itens, add) {
    var salvo = this.pilhaLocal;
    if (esc === this.globais) this.pilhaLocal = [];
    else { var ix = salvo.indexOf(esc); this.pilhaLocal = salvo.slice(0, ix + 1); }
    try { return this.atribuirLista(nome, itens, add); } finally { this.pilhaLocal = salvo; }
  };
  function citarSet(s) {
    if (s === "") return "''";
    if (/[\x00-\x1f\x7f]/.test(s)) return citarQ(s);
    if (/^[A-Za-z0-9_@%+=:,.\/\-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  B("declare", function* (args, opt) { return this.declarar(args[0], args, opt || {}); });
  BUILTINS.typeset = BUILTINS.declare;
  B("local", function* (args, opt) { return this.declarar("local", args, opt || {}); });
  B("export", function* (args, opt) {
    var self = this, i = 1, n = false, f = false, p = false;
    for (; i < args.length; i++) {
      if (opt && opt.decl && opt.decl[i]) break;
      if (args[i] === "--") { i++; break; }
      if (!/^-[nfp]+$/.test(args[i])) { if (/^-./.test(args[i])) { this.erro("export: " + args[i].slice(0, 2) + ": opção inválida"); this.usoB("export", "export [-fn] [nome[=valor] ...] ou export -p [-f]"); return 2; } break; }
      if (args[i].indexOf("n") >= 0) n = true; if (args[i].indexOf("f") >= 0) f = true; if (args[i].indexOf("p") >= 0) p = true;
    }
    var resto = [];
    for (var j = i; j < args.length; j++) resto.push({ txt: args[j], d: opt && opt.decl ? opt.decl[j] : null });
    if (!resto.length) {
      if (f) { Object.keys(this.funcs).sort().forEach(function (fn) { if (self.funcs[fn].exportada) self.escrever(1, self.mostrarFuncao(fn) + "declare -fx " + fn + "\n"); }); return 0; }
      var exp = this.nomesVars().filter(function (k) { var v = self.acharVar(k); return v && v.at.x; });
      exp.forEach(function (k) { var v = self.acharVar(k); var d = self.declaracao(k); self.escrever(1, (v.v === undefined ? "declare -" + atributosStr(v) + " " + k : d) + "\n"); });
      return 0;
    }
    var st = 0;
    resto.forEach(function (r) {
      var nome, val;
      if (r.d) { nome = r.d.a.name; val = r.d.v; }
      else { var m = /^([^=]*?)(\+?=)([\s\S]*)$/.exec(r.txt); if (m) { nome = m[1]; val = m[3]; } else nome = r.txt; }
      if (f) { if (!self.funcs[nome]) { self.erro("export: " + nome + ": não é uma função"); st = 1; return; } self.funcs[nome].exportada = !n; return; }
      if (!nomeValido(nome)) { self.erro("export: `" + r.txt + "': não é um identificador válido"); st = 1; return; }
      if (val !== undefined) {
        if (Array.isArray(val)) { if (!self.atribuirLista(nome, val, r.d.a.add)) { st = 1; return; } }
        else if (!self.atribuir(nome, val, { add: r.d ? r.d.a.add : false })) { st = 1; return; }
      }
      var v = self.acharVar(nome);
      if (!v) { v = self.globais[nome] = new Var(undefined, {}); }
      if (n) delete v.at.x; else v.at.x = true;
    });
    return st;
  });
  B("readonly", function* (args, opt) {
    var self = this, i = 1, fl = {};
    for (; i < args.length; i++) {
      if (opt && opt.decl && opt.decl[i]) break;
      if (args[i] === "--") { i++; break; }
      if (!/^-[aAfp]+$/.test(args[i])) { if (/^-./.test(args[i])) { this.erro("readonly: " + args[i].slice(0, 2) + ": opção inválida"); this.usoB("readonly", "readonly [-aAf] [nome[=valor] ...] ou readonly -p"); return 2; } break; }
      args[i].slice(1).split("").forEach(function (c) { fl[c] = true; });
    }
    if (i >= args.length) {
      this.nomesVars().forEach(function (k) { var v = self.acharVar(k); if (v && v.at.r) { var d = self.declaracao(k); self.escrever(1, (v.v === undefined ? "declare -" + atributosStr(v) + " " + k : d) + "\n"); } });
      return 0;
    }
    var st = 0;
    for (var j = i; j < args.length; j++) {
      var nome, val, d = opt && opt.decl ? opt.decl[j] : null;
      if (d) { nome = d.a.name; val = d.v; }
      else { var m = /^([^=]*?)=([\s\S]*)$/.exec(args[j]); if (m) { nome = m[1]; val = m[2]; } else nome = args[j]; }
      if (fl.f) { if (this.funcs[nome]) this.funcs[nome].ro = true; continue; }
      if (!nomeValido(nome)) { this.erro("readonly: `" + args[j] + "': não é um identificador válido"); st = 1; continue; }
      if (fl.A || fl.a) { var vv = this.acharVar(nome); if (!vv) { vv = this.globais[nome] = new Var(fl.A ? new Map() : [], {}); } }
      if (val !== undefined) {
        if (Array.isArray(val)) { if (!this.atribuirLista(nome, val, d && d.a.add)) { st = 1; continue; } }
        else if (!this.atribuir(nome, val)) { st = 1; continue; }
      }
      var v = this.acharVar(nome);
      if (!v) v = this.globais[nome] = new Var(undefined, {});
      v.at.r = true;
    }
    return st;
  });
  B("unset", function* (args) {
    var r = opcoesB(this, args, "fvn");
    if (r.erro) return this.opInvalida("unset", r.erro, "unset [-f] [-v] [-n] [nome ...]");
    var st = 0, self = this;
    r.args.forEach(function (n) {
      if (r.o.f) { if (self.funcs[n] && self.funcs[n].ro) { self.erro("unset: " + n + ": impossível remover definição: função somente-leitura"); st = 1; return; } delete self.funcs[n]; return; }
      var m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(n);
      if (m) {
        var v = self.acharVar(self.resolverRef(m[1]));
        if (!v) return;
        if (v.at.r) { self.erro("unset: " + m[1] + ": impossível remover definição: variable somente-leitura"); st = 1; return; }
        if (m[2] === "@" || m[2] === "*") { if (v.v instanceof Map) v.v = new Map(); else v.v = []; return; }
        if (v.v instanceof Map) { v.v.delete(m[2]); return; }
        if (Array.isArray(v.v)) {
          var ix = Number(self.aritmetica(m[2])); if (ix < 0) ix = v.v.length + ix;
          if (ix < 0) { self.erro("unset: [" + m[2] + "]: subscrito de array incorreto"); st = 1; return; }
          delete v.v[ix];
          while (v.v.length && !hasOwn(v.v, v.v.length - 1)) v.v.length--;
          return;
        }
        if (Number(self.aritmetica(m[2])) === 0) self.removerVar(m[1]);
        return;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { self.erro("unset: `" + n + "': não é um identificador válido"); st = 1; return; }
      var vv = r.o.n ? self.acharVar(n) : self.acharVar(self.resolverRef(n));
      if (vv && vv.at.r) { self.erro("unset: " + n + ": impossível remover definição: variable somente-leitura"); st = 1; return; }
      if (!vv && !r.o.v && self.funcs[n]) { delete self.funcs[n]; return; }
      if (r.o.n) { var esc = self.escopoDe(n); if (esc) delete esc[n]; return; }
      if (!self.removerVar(n)) st = 1;
    });
    return st;
  });
  B("let", function* (args) {
    if (args.length < 2) { this.erro("let: esperava uma expressão"); return 1; }
    var v = "0";
    for (var i = 1; i < args.length; i++) {
      v = this.aritmeticaSegura(args[i], "let");
      if (v === null) return 1;
    }
    return v === "0" ? 1 : 0;
  });
  B("shift", function* (args) {
    var n = 1;
    if (args.length > 2) { this.erro("shift: número excessivo de argumentos"); return 1; }
    if (args[1] !== undefined) {
      var r = this.aritmeticaSegura(args[1], "shift");
      if (r === null || !/^-?[0-9]+$/.test(args[1].trim())) { if (r !== null) { this.erro("shift: " + args[1] + ": requer argumento numérico"); } return 1; }
      n = Number(r);
    }
    if (n < 0) { this.erro("shift: " + args[1] + ": número de shift fora dos limites"); return 1; }
    if (n > this.pos.length) { if (this.shopt.shift_verbose) this.erro("shift: " + n + ": número de shift fora dos limites"); return 1; }
    this.pos = this.pos.slice(n);
    return 0;
  });
  B("getopts", function* (args) {
    if (args.length < 3) { this.usoB("getopts", "getopts optstring nome [arg ...]"); return 2; }
    var opts = args[1], nome = args[2], lista = args.length > 3 ? args.slice(3) : this.pos;
    var silencioso = opts[0] === ":";
    if (silencioso) opts = opts.slice(1);
    var optind = parseInt(this.valor("OPTIND") || "1", 10);
    if (optind < 1) optind = 1;
    if (this._goInd !== optind || this._goLista !== lista.join("\0")) { this._goPos = 1; this._goInd = optind; this._goLista = lista.join("\0"); }
    var pos = this._goPos || 1;
    var arg = lista[optind - 1];
    var self = this;
    function fim() { self.atribuir(nome, "?"); self.removerVar("OPTARG"); self._goPos = 1; return 1; }
    if (arg === undefined || arg[0] !== "-" || arg === "-") return fim();
    if (arg === "--") { this.atribuir("OPTIND", String(optind + 1)); this._goInd = optind + 1; return fim(); }
    var c = arg[pos];
    var ix = opts.indexOf(c);
    pos++;
    var proxArg = false;
    if (pos >= arg.length) { optind++; pos = 1; proxArg = true; }
    var prog = this.nome0;
    if (ix < 0 || c === ":") {
      if (silencioso) { this.atribuir("OPTARG", c); this.atribuir(nome, "?"); }
      else { if ((this.valor("OPTERR") || "1") !== "0") this.escrever(2, prog + ": opção ilegal -- " + c + "\n"); this.atribuir(nome, "?"); this.removerVar("OPTARG"); }
    } else if (opts[ix + 1] === ":") {
      if (!proxArg) { this.atribuir("OPTARG", arg.slice(pos)); optind++; pos = 1; this.atribuir(nome, c); }
      else if (lista[optind - 1] !== undefined) { this.atribuir("OPTARG", lista[optind - 1]); optind++; this.atribuir(nome, c); }
      else {
        if (silencioso) { this.atribuir(nome, ":"); this.atribuir("OPTARG", c); }
        else { if ((this.valor("OPTERR") || "1") !== "0") this.escrever(2, prog + ": a opção requer um argumento: -- " + c + "\n"); this.atribuir(nome, "?"); this.removerVar("OPTARG"); }
      }
    } else { this.atribuir(nome, c); this.removerVar("OPTARG"); }
    this.atribuir("OPTIND", String(optind));
    this._goInd = optind; this._goPos = pos;
    return 0;
  });

  /* ---------- execução ---------- */
  SP.acharFonte = function (nome) {
    if (nome.indexOf("/") >= 0) return nome;
    if (this.shopt.sourcepath) {
      var path = (this.valor("PATH") || "").split(":");
      for (var i = 0; i < path.length; i++) { var c = (path[i] || ".") + "/" + nome; var r = this.resolver(c, true); if (r.no && r.no.t === "f") return c; }
    }
    return nome;
  };
  B("source", function* (args) {
    var a = args.slice(1);
    if (a[0] === "--") a.shift();
    if (!a.length) { this.erro(args[0] + ": requer argumento arquivo"); this.usoB(args[0], args[0] + " [-p caminho] arquivo [argumentos]"); return 2; }
    var arq = this.acharFonte(a[0]);
    var r = this.lerArquivo(arq);
    if (r.err) { this.erro(a[0] + ": " + ERRNO[r.err]); return 1; }
    var txt = r.txt !== undefined ? r.txt : yield* lerTudo(this.k, this.fds[r.fd]);
    var posVelho = this.pos, nomeVelho = this.nome0, lnV = this.lineno, lnB = this.lnBase;
    if (a.length > 1) this.pos = a.slice(1);
    this.nome0 = a[0];
    this.fonteStack.push(a[0]);
    this.funcStack.push({ nome: "source", fonte: a[0], linha: this.lineno });
    this.lnBase = 0;
    var st;
    try {
      st = yield* this.rodarFonte(txt, { script: true, source: true });
    } catch (e) {
      if (e instanceof ReturnSig) st = e.code; else throw e;
    } finally {
      if (a.length > 1) this.pos = posVelho;
      this.nome0 = nomeVelho; this.fonteStack.pop(); this.funcStack.pop(); this.lineno = lnV; this.lnBase = lnB;
    }
    return st;
  });
  BUILTINS["."] = BUILTINS.source;
  B("eval", function* (args) {
    var txt = args.slice(1).join(" ");
    if (!txt.trim()) return 0;
    var lnV = this.lineno;
    var st = yield* this.rodarFonte(txt + "\n", { eval: true, linha: this.lineno });
    this.lineno = lnV;
    return st;
  });
  B("exec", function* (args) {
    var a = args.slice(1);
    while (a.length && /^-[cl]+$/.test(a[0])) a.shift();
    if (a[0] === "-a") a.splice(0, 2);
    if (a[0] === "--") a.shift();
    if (!a.length) return 0;
    var t = this.tipoDe(a[0], true);
    if (!t || (t.t !== "file" && t.t !== "builtin")) {
      this.erro("exec: " + a[0] + ": não encontrado");
      if (!this.interativo && !this.shopt.execfail) throw new ExitSig(127);
      return 127;
    }
    var st = yield* this.executar(a, { semFuncao: true });
    throw new ExitSig(st);
  });
  B("exit", function* (args) {
    var st = this.status;
    if (args.length > 2) { this.erro("exit: número excessivo de argumentos"); return 1; }
    if (args[1] !== undefined) {
      if (!/^\s*[+-]?[0-9]+\s*$/.test(args[1])) { if (this.interativo && !this.subshell) this.escrever(2, "exit\n"); this.erro("exit: " + args[1] + ": requer argumento numérico"); throw new ExitSig(2); }
      st = ((parseInt(args[1], 10) % 256) + 256) % 256;
    }
    if (this.interativo && !this.subshell && !this.emSubst) this.escrever(2, "exit\n");
    throw new ExitSig(st);
  });
  BUILTINS.logout = function* (args) { if (this.interativo) { this.erro("logout: não é um shell de login: use `exit'"); return 1; } this.erro("logout: não é um shell de login: use `exit'"); return 1; };
  B("return", function* (args) {
    if (!this.funcStack.length) { this.erro("return: possível retornar (`return') apenas de uma função ou script carregado (com `source')"); return 2; }
    var st = this.status;
    if (args[1] !== undefined) {
      if (!/^\s*[+-]?[0-9]+\s*$/.test(args[1])) { this.erro("return: " + args[1] + ": requer argumento numérico"); throw new ReturnSig(2); }
      st = ((parseInt(args[1], 10) % 256) + 256) % 256;
    }
    throw new ReturnSig(st);
  });
  function laco(tipo) {
    return function* (args) {
      var n = 1;
      if (!this.loopNivel) { this.erro(tipo + ": significativo apenas em um loop de `for', `while' ou `until'"); return 0; }
      if (args[1] !== undefined) {
        if (!/^\s*-?[0-9]+\s*$/.test(args[1])) { this.erro(tipo + ": " + args[1] + ": requer argumento numérico"); if (!this.loopNivel) return 1; n = 1; throw new BreakSig(1e9); }
        n = parseInt(args[1], 10);
        if (n < 1) { this.erro(tipo + ": " + args[1] + ": número de loops fora dos limites"); return 1; }
      }
      if (!this.loopNivel) { this.erro(tipo + ": significativo apenas em um loop de `for', `while' ou `until'"); return 0; }
      if (tipo === "break") throw new BreakSig(Math.min(n, this.loopNivel));
      throw new ContSig(Math.min(n, this.loopNivel));
    };
  }
  B("break", laco("break"));
  B("continue", laco("continue"));

  /* ---------- test / [ ---------- */
  SP.testeArgs = function (a, cmd) {
    var self = this;
    function erro(msg) { var e = new Error(msg); e.teste = true; throw e; }
    function un(op, x) { if (op === "-v" || op === "-R" || op === "-o") return self.testeUnario(op, x); return self.testeUnario(op, x); }
    function ehUn(op) { return COND_UN[op] && op !== "-a" || op === "-a" ; }
    function num(x) {
      var t = x.trim();
      if (!/^[+-]?[0-9]+$/.test(t)) erro(x + ": esperava número inteiro");
      return parseInt(t, 10);
    }
    function bin(x, op, y) {
      switch (op) {
        case "=": case "==": return x === y;
        case "!=": return x !== y;
        case "<": return collate(x, y) < 0;
        case ">": return collate(x, y) > 0;
        case "-eq": case "-ne": case "-lt": case "-le": case "-gt": case "-ge": return compararNum(op, num(x), num(y));
        case "-nt": case "-ot": case "-ef": return self.testeBinArq(op, x, y);
      }
      erro(op + ": esperava operador binário");
    }
    var BIN = { "=": 1, "==": 1, "!=": 1, "<": 1, ">": 1, "-eq": 1, "-ne": 1, "-lt": 1, "-le": 1, "-gt": 1, "-ge": 1, "-nt": 1, "-ot": 1, "-ef": 1 };
    var pos = 0;
    function expr() { var v = termo(); while (a[pos] === "-o") { pos++; var w = termo(); v = v || w; } return v; }
    function termo() { var v = fator(); while (a[pos] === "-a") { pos++; var w = fator(); v = v && w; } return v; }
    function fator() {
      if (pos >= a.length) erro("esperava argumento");
      var t = a[pos];
      if (t === "!") { pos++; return !fator(); }
      if (t === "(" ) { pos++; var v = expr(); if (a[pos] !== ")") erro("faltando `)'"); pos++; return v; }
      if (BIN[a[pos + 1]] && pos + 2 < a.length) { var r = bin(t, a[pos + 1], a[pos + 2]); pos += 3; return r; }
      if (COND_UN[t] && t !== "-a" && t !== "-o" && pos + 1 < a.length) { pos += 2; return un(t, a[pos - 1]); }
      if (COND_UN[t] && pos + 1 >= a.length && false) erro(t + ": esperava operador unário");
      pos++; return t !== "";
    }
    // regras POSIX por número de argumentos
    var n = a.length;
    if (n === 0) return false;
    if (n === 1) return a[0] !== "";
    if (n === 2) {
      if (a[0] === "!") return a[1] === "";
      if (COND_UN[a[0]]) return un(a[0], a[1]);
      erro(a[0] + ": esperava operador unário");
    }
    if (n === 3) {
      if (BIN[a[1]]) return bin(a[0], a[1], a[2]);
      if (a[1] === "-a") return a[0] !== "" && a[2] !== "";
      if (a[1] === "-o") return a[0] !== "" || a[2] !== "";
      if (a[0] === "!") { if (COND_UN[a[1]]) return !un(a[1], a[2]); erro(a[1] + ": esperava operador unário"); }
      if (a[0] === "(" && a[2] === ")") return a[1] !== "";
      erro(a[1] + ": esperava operador binário");
    }
    if (n === 4) {
      if (a[0] === "!") { var r3 = this.testeArgs(a.slice(1), cmd); return !r3; }
      if (a[0] === "(" && a[3] === ")") return this.testeArgs(a.slice(1, 3), cmd);
    }
    var v = expr();
    if (pos < a.length) erro(n > 4 || true ? "número excessivo de argumentos" : "");
    return v;
  };
  function testeB(nome) {
    return function* (args) {
      var a = args.slice(1);
      if (nome === "[") {
        if (a[a.length - 1] !== "]") { this.erro("[: faltando `]'"); return 2; }
        a.pop();
      }
      try { return this.testeArgs(a, nome) ? 0 : 1; }
      catch (e) { if (e.teste) { this.erro(nome + ": " + e.message); return 2; } if (e instanceof ArithErr) { this.erro(nome + ": " + e.msg); return 2; } throw e; }
    };
  }
  B("test", testeB("test"));
  B("[", testeB("["));

  /* ---------- type / command / builtin / hash ---------- */
  var PALAVRAS_CHAVE = ["if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done", "in", "function", "time", "{", "}", "!", "[[", "]]", "coproc"];
  var ESPECIAIS = { "break": 1, ":": 1, ".": 1, "continue": 1, "eval": 1, "exec": 1, "exit": 1, "export": 1, "readonly": 1, "return": 1, "set": 1, "shift": 1, "trap": 1, "unset": 1, "source": 1, "times": 1 };
  SP.descrever = function (nome, o) {
    var r = [], self = this;
    if (!o.P) {
      if (this.aliases[nome] !== undefined && this.shopt.expand_aliases) r.push({ t: "alias", s: nome + " está apelidada para `" + this.aliases[nome] + "'" });
      if (PALAVRAS_CHAVE.indexOf(nome) >= 0) r.push({ t: "keyword", s: nome + " é uma palavra-chave do shell" });
      if (this.funcs[nome] && !o.f) r.push({ t: "function", s: nome + " é uma função\n" + this.mostrarFuncao(nome).replace(/\n$/, "") });
      if (BUILTINS[nome] && !(this.desabilitados && this.desabilitados[nome])) r.push({ t: "builtin", s: nome + " é um comando interno " + (ESPECIAIS[nome] ? "especial " : "") + "do shell" });
    }
    if (o.a || !r.length || o.P) {
      if (nome.indexOf("/") >= 0) { var rr = this.resolver(nome, true); if (rr.no && rr.no.t === "f" && this.pode(rr.no, 1)) r.push({ t: "file", s: nome + " é " + nome, p: nome }); }
      else {
        if (this.hash[nome] && !o.a) r.push({ t: "file", s: nome + " está na tabela hash (" + this.hash[nome].path + ")", p: this.hash[nome].path });
        else {
          var path = (this.valor("PATH") || "").split(":");
          for (var i = 0; i < path.length; i++) {
            var c = (path[i] || ".") + "/" + nome, x = this.resolver(c, true);
            if (x.no && x.no.t === "f" && this.pode(x.no, 1)) { r.push({ t: "file", s: nome + " é " + c, p: c }); if (!o.a) break; }
          }
        }
      }
    }
    return r;
  };
  B("type", function* (args) {
    var r = opcoesB(this, args, "afptP");
    if (r.erro) return this.opInvalida("type", r.erro, "type [-afptP] nome [nome ...]");
    var st = 0, self = this, o = r.o;
    r.args.forEach(function (n) {
      var d = self.descrever(n, o);
      if (!d.length) { if (!o.t && !o.p && !o.P) self.erro("type: " + n + ": não encontrado"); st = 1; return; }
      if (!o.a) d = d.slice(0, 1);
      d.forEach(function (x) {
        if (o.t) self.escrever(1, x.t + "\n");
        else if (o.p || o.P) { if (x.t === "file") self.escrever(1, x.p + "\n"); }
        else self.escrever(1, x.s + "\n");
      });
    });
    return st;
  });
  B("command", function* (args) {
    var i = 1, o = {};
    while (i < args.length && /^-[pvV]+$/.test(args[i])) { args[i].slice(1).split("").forEach(function (c) { o[c] = true; }); i++; }
    if (args[i] === "--") i++;
    else if (args[i] && /^-./.test(args[i])) return this.opInvalida("command", args[i].slice(0, 2), "command [-pVv] comando [arg ...]");
    var a = args.slice(i), self = this;
    if (!a.length) return 0;
    if (o.v || o.V) {
      var st = 0, achouAlgum = false;
      a.forEach(function (n) {
        var d = self.descrever(n, {});
        if (!d.length) { if (o.V) self.erro("command: " + n + ": não encontrado"); if (st !== 0 || true) st = st === 0 && achouAlgum ? 0 : 1; return; }
        achouAlgum = true; st = 0;
        var x = d[0];
        if (o.V) self.escrever(1, x.s + "\n");
        else if (x.t === "alias") self.escrever(1, "alias " + n + "=" + citarSet(self.aliases[n]) + "\n");
        else if (x.t === "file") self.escrever(1, x.p + "\n");
        else self.escrever(1, n + "\n");
      });
      return st;
    }
    return yield* this.executar(a, { semFuncao: true });
  });
  B("builtin", function* (args) {
    if (args.length < 2) return 0;
    if (!BUILTINS[args[1]]) { this.erro("builtin: " + args[1] + ": não é um comando interno do shell"); return 1; }
    return yield* this.executar(args.slice(1), { semFuncao: true, builtin: true });
  });
  B("hash", function* (args) {
    var r = opcoesB(this, args, "rdltp", "p");
    if (r.erro) return this.opInvalida("hash", r.erro, "hash [-lr] [-p caminho] [-dt] [nome ...]");
    var self = this;
    if (r.o.r) { this.hash = Object.create(null); return 0; }
    if (!r.args.length) {
      var ks = Object.keys(this.hash);
      if (!ks.length) { this.escrever(1, "hash: tabela de hash está vazia\n"); return 0; }
      this.escrever(1, "número\tcomando\n" + ks.map(function (k) { return pad(self.hash[k].hits, 4) + "\t" + self.hash[k].path; }).join("\n") + "\n");
      return 0;
    }
    var st = 0;
    r.args.forEach(function (n) {
      if (r.o.d) { delete self.hash[n]; return; }
      if (r.o.t) { if (self.hash[n]) self.escrever(1, self.hash[n].path + "\n"); else { self.erro("hash: " + n + ": não encontrado"); st = 1; } return; }
      if (r.o.p) { self.hash[n] = { path: r.o.p, hits: 0 }; return; }
      if (BUILTINS[n] || self.funcs[n]) return;
      var p = self.acharNoPath(n);
      if (!p) { self.erro("hash: " + n + ": não encontrado"); st = 1; return; }
      self.hash[n] = { path: p, hits: 0 };
    });
    return st;
  });

  /* ---------- set / shopt ---------- */
  B("set", function* (args) {
    var self = this;
    if (args.length === 1) {
      var nomes = this.nomesVars();
      nomes.forEach(function (n) {
        var v = self.acharVar(n);
        if (!v) { var e = self.especial(n); if (e !== undefined) self.escrever(1, n + "=" + citarSet(e) + "\n"); return; }
        if (v.v === undefined) return;
        if (Array.isArray(v.v) || v.v instanceof Map) { var d = self.declaracao(n); self.escrever(1, n + "=" + d.slice(d.indexOf("=") + 1) + "\n"); }
        else self.escrever(1, n + "=" + citarSet(v.v) + "\n");
      });
      Object.keys(this.funcs).sort(cmpBytes).forEach(function (f) { self.escrever(1, self.mostrarFuncao(f)); });
      return 0;
    }
    for (var i = 1; i < args.length; i++) {
      var a = args[i];
      if (a === "--") { this.pos = args.slice(i + 1); return 0; }
      if (a === "-") { this.o.xtrace = 0; this.o.verbose = 0; if (i + 1 < args.length) this.pos = args.slice(i + 1); return 0; }
      if (a[0] !== "-" && a[0] !== "+") { this.pos = args.slice(i); return 0; }
      var liga = a[0] === "-";
      for (var j = 1; j < a.length; j++) {
        var c = a[j];
        if (c === "o") {
          var nome = args[i + 1];
          if (nome === undefined || nome[0] === "-" || nome[0] === "+") {
            if (liga) SET_O.forEach(function (k) { self.escrever(1, pad(k, 15, true) + "\t" + (self.o[k] ? "on" : "off") + "\n"); });
            else SET_O.forEach(function (k) { self.escrever(1, "set " + (self.o[k] ? "-o " : "+o ") + k + "\n"); });
            continue;
          }
          i++;
          if (SET_O.indexOf(nome) < 0) { this.erro("set: " + nome + ": nome de opção inválido"); return 2; }
          this.o[nome] = liga ? 1 : 0;
          if (nome === "vi" && liga) this.o.emacs = 0; if (nome === "emacs" && liga) this.o.vi = 0;
          continue;
        }
        if (!SET_LETRA[c]) { this.erro("set: " + a[0] + c + ": opção inválida"); this.usoB("set", "set [-abefhkmnptuvxBCEHPT] [-o opção-nome] [--] [-] [arg ...]"); return 2; }
        this.o[SET_LETRA[c]] = liga ? 1 : 0;
      }
    }
    return 0;
  });
  B("shopt", function* (args) {
    var r = opcoesB(this, args, "psuqo");
    if (r.erro) return this.opInvalida("shopt", r.erro, "shopt [-pqsu] [-o] [nome_opção ...]");
    var o = r.o, self = this, st = 0;
    if (o.s && o.u) { this.erro("shopt: impossível simultaneamente definir e remover definição de opções do shell"); return 1; }
    var tabela = o.o ? null : this.shopt;
    var nomes = o.o ? SET_O : Object.keys(this.shopt).sort(cmpBytes);
    function val(n) { return o.o ? !!self.o[n] : !!self.shopt[n]; }
    function mostra(n) {
      if (o.q) return;
      if (o.p) self.escrever(1, (o.o ? "set " + (val(n) ? "-o " : "+o ") : "shopt " + (val(n) ? "-s " : "-u ")) + n + "\n");
      else self.escrever(1, pad(n, o.o ? 15 : 20, true) + "\t" + (val(n) ? "on" : "off") + "\n");
    }
    if (!r.args.length) {
      nomes.forEach(function (n) { if (o.s && !val(n)) return; if (o.u && val(n)) return; mostra(n); });
      return 0;
    }
    r.args.forEach(function (n) {
      var existe = o.o ? SET_O.indexOf(n) >= 0 : hasOwn(self.shopt, n);
      if (!existe) { self.erro("shopt: " + n + ": nome de opção " + (o.o ? "" : "de shell ") + "inválido"); st = 1; return; }
      if (o.s || o.u) { if (o.o) self.o[n] = o.s ? 1 : 0; else self.shopt[n] = o.s ? 1 : 0; return; }
      if (!val(n)) st = 1;
      mostra(n);
    });
    return st;
  });

  /* ---------- alias ---------- */
  B("alias", function* (args) {
    var self = this, st = 0, a = args.slice(1);
    if (a[0] === "-p") a.shift();
    if (a[0] === "--") a.shift();
    if (!a.length) { Object.keys(this.aliases).sort(cmpBytes).forEach(function (k) { self.escrever(1, "alias " + k + "=" + citarSet(self.aliases[k]).replace(/^([^'].*)$/, "'$1'") + "\n"); }); return 0; }
    a.forEach(function (x) {
      var i = x.indexOf("=");
      if (i > 0) {
        var n = x.slice(0, i);
        if (/[\s\/$`=<>;|&()'"\\]/.test(n)) { self.erro("alias: `" + n + "': nome de apelido (alias) inválido"); st = 1; return; }
        self.aliases[n] = x.slice(i + 1); return;
      }
      if (self.aliases[x] !== undefined) self.escrever(1, "alias " + x + "=" + citarSet(self.aliases[x]).replace(/^([^'].*)$/, "'$1'") + "\n");
      else { self.erro("alias: " + x + ": não encontrado"); st = 1; }
    });
    return st;
  });
  B("unalias", function* (args) {
    var self = this, st = 0;
    if (args[1] === "-a") { this.aliases = Object.create(null); return 0; }
    if (args.length < 2) { this.usoB("unalias", "unalias [-a] nome [nome ...]"); return 2; }
    args.slice(1).forEach(function (n) { if (self.aliases[n] === undefined) { self.erro("unalias: " + n + ": não encontrado"); st = 1; } else delete self.aliases[n]; });
    return st;
  });

  /* ---------- histórico ---------- */
  B("history", function* (args) {
    var a = args.slice(1), self = this;
    var raiz = this.raiz || this;
    if (a[0] === "-c") { raiz.hist.length = 0; return 0; }
    if (a[0] === "-d") {
      var n = parseInt(a[1], 10);
      if (isNaN(n) || n < 1 || n > raiz.hist.length) { this.erro("history: " + a[1] + ": posição no histórico fora dos limites"); return 1; }
      raiz.hist.splice(n - 1, 1); return 0;
    }
    if (a[0] === "-w" || a[0] === "-a" || a[0] === "-r" || a[0] === "-n") return 0;
    if (a[0] === "-s") { raiz.hist.push(a.slice(1).join(" ")); return 0; }
    var lista = raiz.hist.map(function (h, i) { return { n: i + 1, h: h }; });
    if (a[0] !== undefined) {
      if (!/^[0-9]+$/.test(a[0])) { this.erro("history: " + a[0] + ": requer argumento numérico"); return 1; }
      lista = lista.slice(Math.max(0, lista.length - parseInt(a[0], 10)));
    }
    var fmt = this.valor("HISTTIMEFORMAT");
    lista.forEach(function (x) { self.escrever(1, pad(x.n, 5) + "  " + (fmt ? formatarData(fmt, self.k.clock) : "") + x.h + "\n"); });
    return 0;
  });
  B("fc", function* (args) {
    var raiz = this.raiz || this, self = this;
    if (args[1] === "-l") {
      var l = raiz.hist.slice(-16), base = raiz.hist.length - l.length;
      l.forEach(function (h, i) { self.escrever(1, (base + i + 1) + "\t " + h + "\n"); });
      return 0;
    }
    this.escrever(2, "(simulador) fc abre um editor; aqui ele não existe. Use history e !número.\n");
    return 1;
  });

  /* ---------- jobs ---------- */
  SP.acharJob = function (spec, cmd) {
    var raiz = this, j;
    if (spec === undefined || spec === "%%" || spec === "%+" || spec === "%") { j = this.jobCur; if (!j) { this.erro(cmd + ": atual: trabalho não existe"); return null; } return j; }
    if (spec === "%-") { j = this.jobAnt || this.jobCur; if (!j) { this.erro(cmd + ": " + spec + ": trabalho não existe"); return null; } return j; }
    var m = /^%([0-9]+)$/.exec(spec);
    if (m) { j = this.jobs.filter(function (x) { return x.n === +m[1]; })[0]; if (!j) { this.erro(cmd + ": " + spec + ": trabalho não existe"); return null; } return j; }
    if (/^%/.test(spec)) {
      var pref = spec.slice(1);
      j = this.jobs.filter(function (x) { return pref[0] === "?" ? x.txt.indexOf(pref.slice(1)) >= 0 : x.txt.indexOf(pref) === 0; });
      if (!j.length) { this.erro(cmd + ": " + spec + ": trabalho não existe"); return null; }
      return j[0];
    }
    if (/^[0-9]+$/.test(spec)) { j = this.jobs.filter(function (x) { return x.procs.some(function (p) { return p.pid === +spec; }); })[0]; if (!j) { this.erro(cmd + ": " + spec + ": trabalho não existe"); return null; } return j; }
    this.erro(cmd + ": " + spec + ": trabalho não existe"); return null;
  };
  B("jobs", function* (args) {
    var r = opcoesB(this, args, "lnprs");
    if (r.erro) return this.opInvalida("jobs", r.erro, "jobs [-lnprs] [espec_job ...] ou jobs -x comando [args]");
    var self = this, o = r.o;
    var lista = this.jobs;
    if (r.args.length) { lista = []; for (var i = 0; i < r.args.length; i++) { var j = this.acharJob(r.args[i], "jobs"); if (!j) return 1; lista.push(j); } }
    lista.forEach(function (j) {
      var fim = j.procs.every(function (p) { return p.done; });
      if (o.r && fim) return; if (o.s && !j.parado) return;
      if (o.p) { self.escrever(1, j.procs[0].pid + "\n"); return; }
      var linha = self.linhaJob(j);
      if (o.l) linha = linha.replace(/^(\[\d+\][+\- ])  /, "$1 " + j.procs[0].pid + " ");
      self.escrever(1, linha + "\n");
      if (fim) j.avisado = true;
    });
    this.limparJobsAvisados();
    return 0;
  });
  SP.limparJobsAvisados = function () {
    var self = this;
    this.jobs = this.jobs.filter(function (j) { return !(j.avisado && j.procs.every(function (p) { return p.done; })); });
    this.proxJob = this.jobs.length ? Math.max.apply(null, this.jobs.map(function (j) { return j.n; })) + 1 : 1;
    if (!this.jobs.some(function (j) { return j === self.jobCur; })) this.jobCur = this.jobs.length ? this.jobs[this.jobs.length - 1] : null;
    if (!this.jobs.some(function (j) { return j === self.jobAnt; })) this.jobAnt = null;
  };
  B("fg", function* (args) {
    if (!this.jobs.length && !this.interativo) { this.erro("fg: nenhum controle de trabalho"); return 1; }
    var j = this.acharJob(args[1], "fg");
    if (!j) return 1;
    this.escrever(1, j.txt + "\n");
    j.parado = false;
    j.procs.forEach(function (p) { p.bg = false; });
    yield { t: "block", cond: function () { return j.procs.every(function (p) { return p.done; }); } };
    var st = j.procs[j.procs.length - 1].status;
    this.jobs = this.jobs.filter(function (x) { return x !== j; });
    if (this.jobCur === j) this.jobCur = this.jobs.length ? this.jobs[this.jobs.length - 1] : null;
    return st;
  });
  B("bg", function* (args) {
    var j = this.acharJob(args[1], "bg");
    if (!j) return 1;
    if (!j.parado) { this.erro("bg: o trabalho " + j.n + " já está em plano de fundo"); return 0; }
    j.parado = false;
    this.escrever(1, "[" + j.n + "]+ " + j.txt + " &\n");
    return 0;
  });
  B("wait", function* (args) {
    var self = this, a = args.slice(1), alvos = [];
    var n = false;
    while (a.length && /^-/.test(a[0])) { if (a[0] === "-n") n = true; else if (a[0] === "-f") { /* ok */ } else if (a[0] === "-p") a.shift(); a.shift(); }
    if (!a.length) {
      var todos = [];
      this.jobs.forEach(function (j) { j.procs.forEach(function (p) { todos.push(p); }); });
      if (!todos.length) return 0;
      if (n) {
        yield { t: "block", cond: function () { return todos.some(function (p) { return p.done; }); } };
        var feito = todos.filter(function (p) { return p.done; })[0];
        this.marcarAvisados();
        return feito.status;
      }
      yield { t: "block", cond: function () { return todos.every(function (p) { return p.done; }) || self.pendSig.length > 0; } };
      if (this.pendSig.length && !todos.every(function (p) { return p.done; })) return 128 + this.pendSig[0];
      this.jobs.forEach(function (j) { j.avisado = true; });
      this.limparJobsAvisados();
      return 0;
    }
    var st = 0;
    for (var i = 0; i < a.length; i++) {
      var procs;
      if (a[i][0] === "%") { var j = this.acharJob(a[i], "wait"); if (!j) { st = 127; continue; } procs = j.procs; }
      else {
        if (!/^[0-9]+$/.test(a[i])) { this.erro("wait: `" + a[i] + "': não é um pid ou uma especificação de trabalho válida"); st = 2; continue; }
        var pid = +a[i], p = null;
        this.jobs.forEach(function (jj) { jj.procs.forEach(function (x) { if (x.pid === pid) p = x; }); });
        if (!p) { var pp = this.k.acharProc(pid); if (pp && pp.procSubst) p = pp; }
        if (!p && this.bgStatus && hasOwn(this.bgStatus, pid)) { st = this.bgStatus[pid]; continue; }
        if (!p) { this.erro("wait: o pid " + pid + " não é um processo filho deste shell"); st = 127; continue; }
        procs = [p];
      }
      yield { t: "block", cond: function () { return procs.every(function (x) { return x.done; }); } };
      st = procs[procs.length - 1].status;
      this.jobs.forEach(function (jj) { if (jj.procs.every(function (x) { return x.done; }) && jj.procs.some(function (x) { return procs.indexOf(x) >= 0; })) jj.avisado = true; });
    }
    this.limparJobsAvisados();
    return st;
  });
  SP.marcarAvisados = function () { this.jobs.forEach(function (j) { if (j.procs.every(function (p) { return p.done; })) j.avisado = true; }); this.limparJobsAvisados(); };
  B("disown", function* (args) {
    if (args[1] === "-a" || args.length < 2) { if (args[1] === "-a") this.jobs = []; else { var j0 = this.jobCur; this.jobs = this.jobs.filter(function (x) { return x !== j0; }); } this.limparJobsAvisados(); return 0; }
    for (var i = 1; i < args.length; i++) { var j = this.acharJob(args[i], "disown"); if (!j) return 1; this.jobs = this.jobs.filter(function (x) { return x !== j; }); }
    this.limparJobsAvisados();
    return 0;
  });
  var LISTA_SINAIS = " 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP\n 6) SIGABRT\t 7) SIGBUS\t 8) SIGFPE\t 9) SIGKILL\t10) SIGUSR1\n11) SIGSEGV\t12) SIGUSR2\t13) SIGPIPE\t14) SIGALRM\t15) SIGTERM\n16) SIGSTKFLT\t17) SIGCHLD\t18) SIGCONT\t19) SIGSTOP\t20) SIGTSTP\n21) SIGTTIN\t22) SIGTTOU\t23) SIGURG\t24) SIGXCPU\t25) SIGXFSZ\n26) SIGVTALRM\t27) SIGPROF\t28) SIGWINCH\t29) SIGIO\t30) SIGPWR\n31) SIGSYS\t34) SIGRTMIN\t35) SIGRTMIN+1\t36) SIGRTMIN+2\t37) SIGRTMIN+3\n38) SIGRTMIN+4\t39) SIGRTMIN+5\t40) SIGRTMIN+6\t41) SIGRTMIN+7\t42) SIGRTMIN+8\n43) SIGRTMIN+9\t44) SIGRTMIN+10\t45) SIGRTMIN+11\t46) SIGRTMIN+12\t47) SIGRTMIN+13\n48) SIGRTMIN+14\t49) SIGRTMIN+15\t50) SIGRTMAX-14\t51) SIGRTMAX-13\t52) SIGRTMAX-12\n53) SIGRTMAX-11\t54) SIGRTMAX-10\t55) SIGRTMAX-9\t56) SIGRTMAX-8\t57) SIGRTMAX-7\n58) SIGRTMAX-6\t59) SIGRTMAX-5\t60) SIGRTMAX-4\t61) SIGRTMAX-3\t62) SIGRTMAX-2\n63) SIGRTMAX-1\t64) SIGRTMAX\t\n";
  B("kill", function* (args) {
    var a = args.slice(1), sig = 15, self = this;
    if (!a.length) { this.usoB("kill", "kill [-s espec_sinal | -n num_sinal | -espec_sinal] pid | espec_job ... ou kill -l [espec_sinal]"); return 2; }
    if (a[0] === "-l" || a[0] === "-L") {
      if (a.length === 1) { this.escrever(1, LISTA_SINAIS); return 0; }
      var st0 = 0;
      a.slice(1).forEach(function (x) { if (/^[0-9]+$/.test(x)) { var n = +x; if (n > 128) n -= 128; if (n > 0 && n < SIGNAIS.length) self.escrever(1, SIGNAIS[n] + "\n"); else { self.erro("kill: " + x + ": especificação de sinal inválida"); st0 = 1; } } else { var nn = sinalNum(x); if (nn > 0 && nn < 64) self.escrever(1, nn + "\n"); else { self.erro("kill: " + x + ": especificação de sinal inválida"); st0 = 1; } } });
      return st0;
    }
    if (a[0] === "-s" || a[0] === "-n") { sig = sinalNum(a[1] || ""); if (sig < 0 || sig > 64) { this.erro("kill: " + a[1] + ": especificação de sinal inválida"); return 1; } a = a.slice(2); }
    else if (/^-./.test(a[0]) && a[0] !== "--") { sig = sinalNum(a[0].slice(1)); if (sig < 0 || sig > 64) { this.erro("kill: " + a[0].slice(1) + ": especificação de sinal inválida"); return 1; } a = a.slice(1); }
    if (a[0] === "--") a = a.slice(1);
    if (!a.length) { this.usoB("kill", "kill [-s espec_sinal | -n num_sinal | -espec_sinal] pid | espec_job ... ou kill -l [espec_sinal]"); return 2; }
    var st = 0;
    a.forEach(function (x) {
      var pids = [];
      if (x[0] === "%") { var j = self.acharJob(x, "kill"); if (!j) { st = 1; return; } pids = j.procs.filter(function (p) { return !p.done; }).map(function (p) { return p.pid; }); if (!pids.length) { self.erro("kill: " + x + ": trabalho não existe"); st = 1; return; } if (sig !== 0) j.mortoPor = sig; }
      else if (/^-?[0-9]+$/.test(x)) pids = [+x];
      else { self.erro("kill: " + x + ": argumentos devem ser IDs de processo ou de trabalho"); st = 1; return; }
      pids.forEach(function (pid) {
        var sis = self.k.sistema.filter(function (p) { return p.pid === pid; })[0];
        if (sis) {
          if (sis.u !== UID) { self.erro("kill: (" + pid + ") - Operação não permitida"); st = 1; return; }
          if (sig !== 0 && sig !== 18 && sig !== 19 && sig !== 20 && sig !== 28 && sig !== 17) self.k.sistema = self.k.sistema.filter(function (p) { return p !== sis; });
          return;
        }
        if (pid === 3001 && !self.k.acharProc(3001)) { return; }
        if (!self.k.sinal(pid, sig)) { self.erro("kill: (" + pid + ") - Processo inexistente"); st = 1; }
      });
    });
    return st;
  });

  /* ---------- trap ---------- */
  B("trap", function* (args) {
    var a = args.slice(1), self = this;
    if (a[0] === "--") a.shift();
    if (a[0] === "-l") { this.escrever(1, LISTA_SINAIS); return 0; }
    var listar = !a.length || a[0] === "-p" || a[0] === "-P";
    if (listar) {
      var filtro = a.slice(1).map(sinalNum);
      var lista = Object.keys(this.traps).map(Number).sort(function (x, y) { return x - y; });
      if (filtro.length) lista = filtro.filter(function (s) { return self.traps[s] !== undefined; });
      lista.forEach(function (s) { self.escrever(1, "trap -- " + citarQ(self.traps[s]) + " " + sinalNome(s) + "\n"); });
      return 0;
    }
    var acao, sinais;
    if (a.length === 1 || /^[0-9]+$/.test(a[0]) && a.length >= 1 && sinalNum(a[0]) >= 0 && false) { acao = "-"; sinais = a; }
    else if (a[0] === "-") { acao = "-"; sinais = a.slice(1); }
    else { acao = a[0]; sinais = a.slice(1); }
    if (a.length === 1) { sinais = a; acao = "-"; }
    var st = 0;
    sinais.forEach(function (s) {
      var n = sinalNum(s);
      if (n < 0 || (n > 64 && n < 100)) { self.erro("trap: " + s + ": especificação de sinal inválida"); st = 1; return; }
      if (acao === "-") delete self.traps[n];
      else self.traps[n] = acao;
      if (n === 0) self.trapSaida = acao !== "-";
      if (n === 102 && self.funcStack.length) self.funcStack[self.funcStack.length - 1].trapRet = acao !== "-";
    });
    return st;
  });
  B("times", function* () { this.escrever(1, "0m0,010s 0m0,005s\n0m0,000s 0m0,000s\n"); return 0; });
  B("umask", function* (args) {
    var a = args.slice(1), S = false, p = false;
    while (a.length && /^-[Sp]+$/.test(a[0])) { if (a[0].indexOf("S") >= 0) S = true; if (a[0].indexOf("p") >= 0) p = true; a.shift(); }
    if (!a.length) {
      if (S) { var m = 511 & ~this.umask; var f = function (b) { return (b & 4 ? "r" : "") + (b & 2 ? "w" : "") + (b & 1 ? "x" : ""); }; this.escrever(1, (p ? "umask -S " : "") + "u=" + f(m >> 6) + ",g=" + f((m >> 3) & 7) + ",o=" + f(m & 7) + "\n"); }
      else this.escrever(1, (p ? "umask " : "") + ("000" + this.umask.toString(8)).slice(-4) + "\n");
      return 0;
    }
    if (/^[0-7]{1,4}$/.test(a[0])) { this.umask = parseInt(a[0], 8); return 0; }
    var cur = 511 & ~this.umask, ok = true;
    a[0].split(",").forEach(function (part) {
      var mm = /^([ugoa]*)([=+-])([rwx]*)$/.exec(part);
      if (!mm) { ok = false; return; }
      var quem = mm[1] || "a", bits = 0;
      mm[3].split("").forEach(function (c) { bits |= c === "r" ? 4 : c === "w" ? 2 : 1; });
      var mask = 0, val = 0;
      if (/[ua]/.test(quem)) { mask |= 448; val |= bits << 6; }
      if (/[ga]/.test(quem)) { mask |= 56; val |= bits << 3; }
      if (/[oa]/.test(quem)) { mask |= 7; val |= bits; }
      if (mm[2] === "=") cur = (cur & ~mask) | val; else if (mm[2] === "+") cur |= val; else cur &= ~val;
    });
    if (!ok) { this.erro("umask: `" + a[0] + "': caractere de modo simbólico inválido"); return 1; }
    this.umask = 511 & ~cur;
    return 0;
  });
  B("caller", function* (args) {
    var n = args[1] !== undefined ? parseInt(args[1], 10) : null;
    var fs = this.funcStack;
    if (!fs.length) return 1;
    if (n === null) { var f = fs[fs.length - 1]; this.escrever(1, f.linha + " " + (fs.length > 1 ? fs[fs.length - 2].fonte : (this.scriptNome || "main")) + "\n"); return 0; }
    var ix = fs.length - 1 - n;
    if (ix < 0) return 1;
    var g = fs[ix];
    this.escrever(1, g.linha + " " + (ix > 0 ? fs[ix - 1].nome : "main") + " " + (ix > 0 ? fs[ix - 1].fonte : (this.scriptNome || "main")) + "\n");
    return 0;
  });
  B("enable", function* (args) {
    var self = this;
    if (args.length === 1 || args[1] === "-a" || args[1] === "-p") { Object.keys(BUILTINS).sort(cmpBytes).forEach(function (b) { self.escrever(1, "enable " + b + "\n"); }); return 0; }
    if (args[1] === "-n") { this.desabilitados = this.desabilitados || {}; args.slice(2).forEach(function (b) { self.desabilitados[b] = true; }); return 0; }
    if (this.desabilitados) args.slice(1).forEach(function (b) { delete self.desabilitados[b]; });
    return 0;
  });
  B("compgen", function* (args) {
    var self = this, a = args.slice(1), tipos = [], palavras = null, i = 0;
    for (; i < a.length; i++) {
      var x = a[i];
      if (x === "-W") { palavras = a[++i]; continue; }
      if (x === "-A") { tipos.push({ "function": "f", alias: "a", builtin: "b", command: "c", directory: "d", file: "fi", keyword: "k", variable: "v", "export": "e", user: "u" }[a[++i]] || ""); continue; }
      if (/^-[abcdefkuvj]+$/.test(x)) { x.slice(1).split("").forEach(function (c) { tipos.push(c === "f" ? "fi" : c); }); continue; }
      if (x === "--") { i++; break; }
      break;
    }
    var pref = a[i] || "", res = [];
    tipos.forEach(function (t) {
      if (t === "a") res = res.concat(Object.keys(self.aliases).sort(cmpBytes));
      if (t === "b") res = res.concat(Object.keys(BUILTINS).sort(cmpBytes));
      if (t === "k") res = res.concat(PALAVRAS_CHAVE);
      if (t === "f") res = res.concat(Object.keys(self.funcs));
      if (t === "v") res = res.concat(self.nomesVars());
      if (t === "e") res = res.concat(Object.keys(self.exportadas()));
      if (t === "u") res = res.concat(["ana", "daemon", "nobody", "root", "www-data"]);
      if (t === "c") { res = res.concat(Object.keys(self.aliases), PALAVRAS_CHAVE, Object.keys(self.funcs), Object.keys(BUILTINS)); var ub = self.no("/usr/bin"); if (ub) res = res.concat(Object.keys(ub.c)); }
      if (t === "fi" || t === "d") {
        var barra = pref.lastIndexOf("/"), dir = barra >= 0 ? pref.slice(0, barra + 1) : "", no = self.no(dir === "" ? "." : dir);
        if (no && no.t === "d") Object.keys(no.c).forEach(function (n) { if (t === "d" && no.c[n].t !== "d") return; res.push(dir + n); });
      }
    });
    if (palavras !== null) { var segs = palavras.split(/[ \t\n]+/).filter(Boolean); res = res.concat(segs); }
    var vistos = {};
    res = res.filter(function (x) { if (x.indexOf(pref) !== 0 || vistos[x]) return false; vistos[x] = 1; return true; });
    if (tipos.indexOf("fi") >= 0 || tipos.indexOf("d") >= 0) res.sort(collate);
    res.forEach(function (x) { self.escrever(1, x + "\n"); });
    return res.length ? 0 : 1;
  });
  B("complete", function* (args) {
    var raiz = this.raiz || this, self = this;
    raiz.completes = raiz.completes || {};
    if (args.length === 1 || args[1] === "-p") {
      var ks = args.length > 2 ? args.slice(2) : Object.keys(raiz.completes).sort();
      var stc = 0;
      ks.forEach(function (k) { if (raiz.completes[k]) self.escrever(1, "complete " + raiz.completes[k] + " " + k + "\n"); else { self.erro("complete: " + k + ": nenhuma especificação de completação"); stc = 1; } });
      return stc;
    }
    if (args[1] === "-r") { if (args.length > 2) args.slice(2).forEach(function (k) { delete raiz.completes[k]; }); else raiz.completes = {}; return 0; }
    var nome = args[args.length - 1];
    raiz.completes[nome] = args.slice(1, -1).map(citarSet).join(" ");
    return 0;
  });
  B("compopt", function* () { return 0; });
  ["ulimit", "suspend", "bind", "coproc"].forEach(function (n) {
    B(n, function* (args) {
      if (n === "ulimit") { if (args.length === 1 || args[1] === "-f") { this.escrever(1, "unlimited\n"); return 0; } if (args[1] === "-n") { this.escrever(1, "524288\n"); return 0; } if (args[1] === "-a") { this.escrever(1, "real-time non-blocking time  (microseconds, -R) unlimited\ncore file size              (blocks, -c) 0\ndata seg size               (kbytes, -d) unlimited\nfile size                   (blocks, -f) unlimited\nopen files                          (-n) 1024\nstack size                  (kbytes, -s) 8192\ncpu time                   (seconds, -t) unlimited\nmax user processes                  (-u) 63432\n"); return 0; } }
      this.escrever(2, "(simulador) " + n + " não funciona neste simulador. Experimente no terminal de verdade.\n");
      return 1;
    });
  });
  B("help", function* (args) {
    if (args.length > 1) return this.ajudaDe(args.slice(1));
    this.escrever(1, TEXTO_HELP + NOTA_SIM);
    return 0;
  });

  /* Textos do help do Bash 5.3.9 em pt_BR (capturados do laboratório).
     Os textos longos de "help NOME" ficam em assets/bashsim-ajuda.js, carregado sob demanda. */
  var TEXTO_HELP = "GNU bash, versão 5.3.9(1)-release (x86_64-pc-linux-gnu)\nEsses comandos shell são definidos internamente. Digite `help' para ver essa\nlista. Digite `help NOME' para descobrir mais sobre a função `NOME'.\nUse `info bash' para descobrir mais sobre o shell em geral.\nUse `man -k' ou `info' para descobrir mais sobre comandos que não estão nesta\nlista.\n\nUm asterisco (*) próximo ao nome significa que o comando está desabilitado.\n\n ! PIPELINE                              history [-c] [-d posição] [n] ou his>\n espec_job [&]                           if COMANDOS; then COMANDOS; [ elif C>\n (( expressão ))                         jobs [-lnprs] [espec_job ...] ou job>\n . [-p caminho] arquivo [argumentos]     kill [-s espec_sinal | -n num_sinal >\n :                                       let ARG [ARG ...]\n [ arg... ]                              local [opção] nome[=valor] ...\n [[ expressão ]]                         logout [n]\n alias [-p] [nome[=valor] ... ]          mapfile [-d delim] [-n número] [-O o>\n bg [espec_job ...]                      popd [-n] [+N | -N]\n bind [-lpsvPSVX] [-m mapa-teclas] [-f>  printf [-v var] formato [argumentos]\n break [n]                               pushd [-n] [+N | -N | dir]\n builtin [comando-interno-shell [arg .>  pwd [-LP]\n caller [expr]                           read [-ers] [-a array] [-d delim] [->\n case PALAVRA in [PADRÃO [| PADRÃO]...>  readarray [-d delim] [-n número] [-O>\n cd [-L|[-P [-e]]] [-@] [dir]            readonly [-aAf] [nome[=valor] ...] o>\n command [-pVv] comando [arg ...]        return [n]\n compgen [-V nome_var] [-abcdefgjksuv]>  select NOME [in PALAVRAS ... ;] do C>\n complete [-abcdefgjksuv] [-pr] [-DEI]>  set [-abefhkmnptuvxBCEHPT] [-o opção>\n compopt [-o|+o opção] [-DEI] [nome ..>  shift [n]\n continue [n]                            shopt [-pqsu] [-o] [nome_opção ...]\n coproc [NOME] comando [redirecionamen>  source [-p caminho] arquivo [argumen>\n declare [-aAfFgiIlnrtux] [nome[=valor>  suspend [-f]\n dirs [-clpv] [+N] [-N]                  test [expr]\n disown [-h] [-ar] [espec_job ... | pi>  time [-p] pipeline\n echo [-neE] [arg ...]                   times\n enable [-a] [-dnps] [-f arquivo] [nom>  trap [-Plp] [[ação] espec_sinal ...]\n eval [arg ...]                          true\n exec [-cl] [-a nome] [comando [argume>  type [-afptP] nome [nome ...]\n exit [n]                                typeset [-aAfFgiIlnrtux] nome[=valor>\n export [-fn] [nome[=valor] ...] ou ex>  ulimit [-SHabcdefiklmnpqrstuvxPRT] [>\n false                                   umask [-p] [-S] [modo]\n fc [-e editor] [-lnr] [primeiro] [últ>  unalias [-a] nome [nome ...]\n fg [espec_job]                          unset [-f] [-v] [-n] [nome ...]\n for NOME [in PALAVRAs ...] ; do COMAN>  until COMANDOS; do COMANDOS-2; done\n for (( exp1; exp2; exp3 )); do COMAND>  variables - Nomes e significados de >\n function NOME { COMANDOS ; } ou NOME >  wait [-fn] [-p var] [id ...]\n getopts optstring nome [arg ...]        while COMANDOS; do COMANDOS-2; done\n hash [-lr] [-p caminho] [-dt] [nome .>  { COMANDOS ; }\n help [-dms] [padrão ...]\n";
  var BASH_VERSAO_TXT = "GNU bash, versão 5.3.9(1)-release (x86_64-pc-linux-gnu)\nCopyright (C) 2025 Free Software Foundation, Inc.\nLicença GPLv3+: GNU GPL versão 3 ou posterior <http://gnu.org/licenses/gpl.html>\n\nEste é um software livre; você é livre para alterar e redistribuí-lo.\nHá NENHUMA GARANTIA, na extensão permitida pela lei.\n";
  var AJUDA = null, AJUDA_D = null;
  function carregarAjuda() {
    if (AJUDA) return true;
    var dados = global.BashSimAjuda;
    if (!dados && typeof require === "function" && typeof module !== "undefined") { try { dados = require("./bashsim-ajuda.js"); } catch (e) { dados = null; } }
    if (!dados) return false;
    AJUDA = dados.ajuda; AJUDA_D = dados.descricao;
    return true;
  }

  /* ------------------------------------------------------------------
     10. Impressão de comandos (type, declare -f, jobs) no formato do Bash
     ------------------------------------------------------------------ */
  function ind(n) { return repete("    ", n); }
  function imprimirRedir(r) {
    var fd = r.fdvar ? "{" + r.fdvar + "}" : (r.fd !== null && r.fd !== undefined ? String(r.fd) : "");
    var op = r.op;
    if (op === ">&" || op === "<&") return fd + op + r.w.raw;
    if (op === "<<" || op === "<<-") return fd + op + r.w.raw;
    if (op === "&>") return "> " + r.w.raw + " 2>&1";
    if (op === "&>>") return ">> " + r.w.raw + " 2>&1";
    return fd + op + " " + r.w.raw;
  }
  function imprimirSimples(c) {
    var partes = [];
    c.as.forEach(function (a) { partes.push(a.raw || (a.name + (a.idxRaw !== undefined ? "[" + a.idxRaw + "]" : "") + (a.add ? "+=" : "=") + (a.arr ? "(" + a.arr.map(function (it) { return (it.chaveRaw !== undefined ? "[" + it.chaveRaw + "]=" : "") + it.w.raw; }).join(" ") + ")" : (a.val ? a.val.raw : "")))); });
    c.w.forEach(function (w) { partes.push(w.raw); });
    c.r.forEach(function (r) { partes.push(imprimirRedir(r)); });
    return partes.join(" ");
  }
  function heredocsDe(c) {
    var r = [];
    (c.r || []).forEach(function (x) { if (x.hd) r.push(x); });
    return r;
  }
  function imprimirCond(e) {
    switch (e.op) {
      case "and": return imprimirCond(e.a) + " && " + imprimirCond(e.b);
      case "or": return imprimirCond(e.a) + " || " + imprimirCond(e.b);
      case "not": return "! " + imprimirCond(e.a);
      case "paren": return "( " + imprimirCond(e.a) + " )";
      case "un": return e.o + " " + e.a.raw;
      case "bin": return e.a.raw + " " + e.o + " " + e.b.raw;
      case "word": return e.a.raw;
    }
    return "";
  }
  function imprimirPipe(p, n) {
    var s = p.cmds.map(function (c) { return imprimirCmd(c, n); }).join(" | ");
    if (p.neg) s = "! " + s;
    if (p.tempo) s = "time " + (p.tempoP ? "-p " : "") + s;
    return s;
  }
  function imprimirAndOr(ao, n) {
    n = n || 0;
    var s = imprimirPipe(ao.p[0], n);
    for (var i = 1; i < ao.p.length; i++) s += " " + ao.ops[i - 1] + " " + imprimirPipe(ao.p[i], n);
    return s;
  }
  function temHeredoc(ao) { return ao.p.some(function (p) { return p.cmds.some(function (c) { return heredocsDe(c).length > 0; }); }); }
  function corpoHeredoc(ao) {
    var r = "";
    ao.p.forEach(function (p) { p.cmds.forEach(function (c) { heredocsDe(c).forEach(function (h) { r += "\n" + (h.hd.texto !== undefined ? h.hd.texto : h.hd.w.raw) + delimDe(h); }); }); });
    return r;
  }
  function delimDe(h) { return h.w.raw.replace(/['"\\]/g, ""); }
  // lista em várias linhas (corpo de bloco)
  function imprimirLista(l, n) {
    var s = ind(n), pularSep = false;
    l.items.forEach(function (it, i) {
      var ultimoI = i === l.items.length - 1;
      s += imprimirAndOr(it.c, n);
      if (temHeredoc(it.c)) { s += corpoHeredoc(it.c) + "\n"; if (!ultimoI) s += "\n" + ind(n); pularSep = true; return; }
      if (it.bg) { s += " &"; if (!ultimoI) s += " "; return; }
      if (!ultimoI) { s += pularSep ? "\n" + ind(n) : ";\n" + ind(n); pularSep = false; }
    });
    return s;
  }
  // lista numa linha só (condições)
  function imprimirListaLinha(l) {
    return l.items.map(function (it, i) { return imprimirAndOr(it.c, 0) + (it.bg ? " &" : (i < l.items.length - 1 ? ";" : "")); }).join(" ");
  }
  function imprimirCmd(c, n, comoCorpo) {
    n = n || 0;
    var s = "", red = c.r && c.r.length && c.k !== "simple" ? " " + c.r.map(imprimirRedir).join(" ") : "";
    switch (c.k) {
      case "simple": return imprimirSimples(c);
      case "group": s = "{ \n" + imprimirLista(c.body, n + 1) + "\n" + ind(n) + "}"; break;
      case "sub":
        if (comoCorpo) return "{ \n" + ind(n + 1) + "( " + imprimirListaLinha(c.body) + " )" + red + "\n" + ind(n) + "}";
        s = "( " + imprimirLista(c.body, n).replace(/^ +/, "") + " )"; break;
      case "if": {
        var ifs = function (k, nn) {
          var t = "if " + imprimirListaLinha(c.conds[k]) + "; then\n" + imprimirLista(c.bodies[k], nn + 1) + ";\n";
          if (k + 1 < c.conds.length) t += ind(nn) + "else\n" + ind(nn + 1) + ifs(k + 1, nn + 1) + ";\n";
          else if (c.els) t += ind(nn) + "else\n" + imprimirLista(c.els, nn + 1) + ";\n";
          return t + ind(nn) + "fi";
        };
        s = ifs(0, n); break;
      }
      case "while": s = (c.until ? "until " : "while ") + imprimirListaLinha(c.cond) + "; do\n" + imprimirLista(c.body, n + 1) + ";\n" + ind(n) + "done"; break;
      case "for": case "select":
        s = (c.k === "for" ? "for " : "select ") + c.name + " in " + (c.words ? c.words.map(function (w) { return w.raw; }).join(" ") : "\"$@\"") + ";\n" + ind(n) + "do\n" + imprimirLista(c.body, n + 1) + ";\n" + ind(n) + "done"; break;
      case "arfor": s = "for ((" + c.raws.map(function (x) { return x.trim(); }).join("; ") + "))\n" + ind(n) + "do\n" + imprimirLista(c.body, n + 1) + ";\n" + ind(n) + "done"; break;
      case "case":
        s = "case " + c.w.raw + " in \n" + c.items.map(function (it) {
          return ind(n + 1) + it.pats.map(function (p) { return p.raw; }).join(" | ") + ")\n" + (it.body.items.length ? imprimirLista(it.body, n + 2) + "\n" : "") + ind(n + 1) + it.term;
        }).join("\n") + "\n" + ind(n) + "esac"; break;
      case "arith": s = "((" + c.raw + "))"; break;
      case "cond": s = "[[ " + imprimirCond(c.e) + " ]]"; break;
      case "func": s = (n > 0 ? "function " : "") + c.name + " () \n" + ind(n) + imprimirCmd(c.body, n, true); return s;
    }
    if (comoCorpo && c.k !== "group") return "{ \n" + ind(n + 1) + s + red + "\n" + ind(n) + "}";
    return s + red;
  }

  /* ------------------------------------------------------------------
     11. Shell interativo: prompt, histórico, expansão de histórico
     ------------------------------------------------------------------ */
  SP.expandirPrompt = function (p) {
    var self = this, t = tm(this.k.clock);
    var r = p.replace(/\\(\[|\]|[a-zA-Z@$\\#!]|[0-7]{3})/g, function (m, c) {
      switch (c) {
        case "u": return USER; case "h": return HOST; case "H": return HOST;
        case "w": return self.curto(self.cwdLogico); case "W": return self.cwdLogico === (self.valor("HOME") || HOME) ? "~" : (self.cwdLogico === "/" ? "/" : self.cwdLogico.slice(self.cwdLogico.lastIndexOf("/") + 1));
        case "$": return "$"; case "\\": return "\\"; case "n": return "\n"; case "s": return "bash"; case "v": return "5.3"; case "V": return "5.3.9";
        case "d": return DIAS[t.w] + " " + MESES[t.M] + " " + dois(t.D);
        case "t": return dois(t.h) + ":" + dois(t.m) + ":" + dois(t.s); case "T": return dois(t.h % 12 || 12) + ":" + dois(t.m) + ":" + dois(t.s);
        case "A": return dois(t.h) + ":" + dois(t.m); case "@": return dois(t.h % 12 || 12) + ":" + dois(t.m) + " " + (t.h < 12 ? "AM" : "PM");
        case "#": return String((self.raiz || self).hist.length + 1); case "!": return String((self.raiz || self).hist.length + 1);
        case "j": return String(self.jobs.length); case "l": return "pts/0"; case "e": return "\x1b"; case "a": return "\x07"; case "r": return "\r";
        case "[": case "]": return "";
      }
      if (/^[0-7]{3}$/.test(c)) return String.fromCharCode(parseInt(c, 8));
      return m;
    });
    if (this.shopt.promptvars && /[$`]/.test(r)) {
      try {
        var w = new Parser(r, {}).lerAte(null, "hd"), self2 = this;
        var g = (function* () { return yield* self2.expandirStr(w, {}); })();
        var v = this.k.rodarGeradorSync(g);
        if (typeof v === "string") r = v;
      } catch (e) { if (!(e instanceof SyntaxErr || e instanceof Incomplete || e instanceof CmdErr)) throw e; r = this.expandirPromptSimples(r); }
    }
    return r;
  };
  // Expansão de histórico (!!, !n, !-n, !texto, !?texto?, !$, !^, !*, ^a^b, :p)
  SP.expandirHistorico = function (linha) {
    var hist = (this.raiz || this).hist, mudou = false, soImprimir = false, erro = null;
    if (!this.o.histexpand) return { linha: linha };
    if (linha[0] === "^") {
      var m = /^\^([^^]*)\^([^^]*)\^?(.*)$/.exec(linha);
      if (m) {
        var ult = hist[hist.length - 1];
        if (ult === undefined || ult.indexOf(m[1]) < 0) return { erro: "bash: :s" + linha + ": substitution failed" };
        return { linha: ult.replace(m[1], m[2]) + m[3], mudou: true };
      }
    }
    var out = "", i = 0, emSQ = false, emDQ = false;
    function palavras(c) { return c.match(/(?:[^\s'"]+|'[^']*'|"(?:\\.|[^"])*")+/g) || []; }
    while (i < linha.length) {
      var c = linha[i];
      if (c === "\\" && !emSQ) { out += c + (linha[i + 1] || ""); i += 2; continue; }
      if (c === "'" && !emDQ) emSQ = !emSQ;
      if (c === '"' && !emSQ) emDQ = !emDQ;
      if (c !== "!" || emSQ) { out += c; i++; continue; }
      var n = linha[i + 1];
      if (n === undefined || /[\s=(]/.test(n) || (emDQ && n === '"') || (linha[i - 1] === "{" && linha[i - 2] === "$") || linha[i - 1] === "$" || linha[i - 1] === "[") { out += c; i++; continue; }
      var resto = linha.slice(i + 1), ev = null, len = 0, mm;
      if (n === "!") { ev = hist[hist.length - 1]; len = 1; if (ev === undefined) { erro = "!!"; break; } }
      else if ((mm = /^-?[0-9]+/.exec(resto))) {
        var num = parseInt(mm[0], 10); len = mm[0].length;
        ev = num < 0 ? hist[hist.length + num] : hist[num - 1];
        if (ev === undefined) { erro = "!" + mm[0]; break; }
      } else if (n === "$" || n === "^" || n === "*" || n === ":") {
        ev = hist[hist.length - 1]; len = 0;
        if (ev === undefined) { erro = "!" + n; break; }
      } else if (n === "?") {
        mm = /^\?([^?\n]*)\??/.exec(resto); len = mm[0].length;
        for (var k = hist.length - 1; k >= 0; k--) if (hist[k].indexOf(mm[1]) >= 0) { ev = hist[k]; break; }
        if (ev === undefined || ev === null) { erro = "!?" + mm[1]; break; }
      } else {
        mm = /^[^\s:;&|()<>"'`]+/.exec(resto); len = mm ? mm[0].length : 0;
        var pref = mm ? mm[0] : "";
        for (var q = hist.length - 1; q >= 0; q--) if (hist[q].indexOf(pref) === 0) { ev = hist[q]; break; }
        if (ev === undefined || ev === null) { erro = "!" + pref; break; }
      }
      var j = i + 1 + len, sel = ev;
      // designadores de palavra
      var ws = palavras(ev);
      if (linha[j] === "$" && len !== 0 || (n === "$" && len === 0)) { sel = ws[ws.length - 1] || ""; j += 1; }
      else if (linha[j] === "^" || (n === "^" && len === 0)) { sel = ws[1] || ""; j += 1; }
      else if (linha[j] === "*" || (n === "*" && len === 0)) { sel = ws.slice(1).join(" "); j += 1; }
      else if (linha[j] === ":" && /^[0-9$^*]/.test(linha[j + 1] || "")) {
        var d = /^:([0-9]+|\$|\^|\*)(-([0-9]+|\$))?/.exec(linha.slice(j));
        if (d) {
          var idx = function (x) { return x === "$" ? ws.length - 1 : x === "^" ? 1 : parseInt(x, 10); };
          if (d[1] === "*") sel = ws.slice(1).join(" ");
          else if (d[2]) sel = ws.slice(idx(d[1]), idx(d[3]) + 1).join(" ");
          else sel = ws[idx(d[1])] !== undefined ? ws[idx(d[1])] : "";
          j += d[0].length;
        }
      }
      // modificadores
      while (linha[j] === ":") {
        var md = linha[j + 1];
        if (md === "p") { soImprimir = true; j += 2; continue; }
        if (md === "h") { sel = sel.replace(/\/[^\/]*$/, ""); j += 2; continue; }
        if (md === "t") { sel = sel.replace(/^.*\//, ""); j += 2; continue; }
        if (md === "r") { sel = sel.replace(/\.[^.\/]*$/, ""); j += 2; continue; }
        if (md === "e") { var me = /\.[^.\/]*$/.exec(sel); sel = me ? me[0] : ""; j += 2; continue; }
        if (md === "s" || md === "g") {
          var g = md === "g"; if (g && linha[j + 2] === "s") j++;
          var sm = /^s\/([^\/]*)\/([^\/]*)\/?/.exec(linha.slice(j + 1 + (g ? 1 : 0)));
          if (sm) { sel = g ? sel.split(sm[1]).join(sm[2]) : sel.replace(sm[1], sm[2]); j += 1 + (g ? 1 : 0) + sm[0].length; continue; }
        }
        break;
      }
      out += sel; mudou = true; i = j;
    }
    if (erro) return { erro: "bash: " + erro + ": event not found" };
    return { linha: out, mudou: mudou, soImprimir: soImprimir };
  };
  SP.ajudaDe = function (pads) {
    var self = this, st = 0, achou = false;
    var curto = false, desc = false, man = false;
    while (pads.length && /^-[dms]+$/.test(pads[0])) { if (pads[0].indexOf("d") >= 0) desc = true; if (pads[0].indexOf("s") >= 0) curto = true; if (pads[0].indexOf("m") >= 0) man = true; pads = pads.slice(1); }
    if (!pads.length) { this.escrever(1, TEXTO_HELP + NOTA_SIM); return 0; }
    if (!carregarAjuda()) { this.escrever(2, "(simulador) os textos de ajuda ainda estão carregando; tente de novo em um instante.\n"); return 1; }
    pads.forEach(function (p) {
      var nomes = Object.keys(AJUDA).filter(function (k) { return casaPadrao(p, k, {}) || k === p; });
      if (!nomes.length) nomes = Object.keys(AJUDA).filter(function (k) { return k.indexOf(p) === 0; });
      if (!nomes.length) { self.erro("help: nenhum tópico de ajuda corresponde a `" + p + "'.  Tente `help help' ou `man -k " + p + "' ou `info " + p + "'."); st = 1; return; }
      nomes.forEach(function (k) {
        var t = AJUDA[k];
        if (desc) { self.escrever(1, k + " - " + (AJUDA_D[k] || "") + "\n"); return; }
        if (curto) { self.escrever(1, t.split("\n")[0] + "\n"); return; }
        self.escrever(1, t);
      });
    });
    return st;
  };
  var NOTA_SIM = "\n(simulador) Este terminal é um simulador de Bash 5.3 rodando no navegador, numa\nmáquina fictícia. Funcionam: variáveis, arrays, aspas, expansões, if/case/for/\nwhile, funções, redirecionamentos, pipes, here-docs, jobs, trap, set -euxo, e os\nprogramas ls cat head tail wc sort uniq cut tr tee grep sed awk find xargs\nmkdir rm cp mv ln chmod touch date seq bc expr stat du ps kill e outros.\nRede, pacotes, editores (nano, vim) e sudo não existem aqui.\n";

  // roda uma linha completa digitada no terminal (já sem continuação pendente)
  SP.rodarInterativo = function* (fonte, opt) {
    opt = opt || {};
    var st = this.status;
    var raiz = this;
    try {
      var p = new Parser(fonte, { aliases: this.shopt.expand_aliases ? this.aliases : null, extglob: this.shopt.extglob, interativo: false, linha: this.lineno });
      while (true) {
        var ast;
        p.aliases = this.shopt.expand_aliases ? this.aliases : null;
        p.extglob = this.shopt.extglob;
        try { ast = p.parseLinha(); }
        catch (e) {
          if (e instanceof SyntaxErr) { this.escrever(2, "bash: " + e.msg + "\n"); if (e.extra) this.escrever(2, "bash: " + e.extra + "\n"); this.status = 2; return 2; }
          throw e;
        }
        if (p.avisos.length) { var self = this; p.avisos.forEach(function (a) { self.escrever(2, "bash: aviso: " + a.msg.replace(/^aviso: /, "") + "\n"); }); p.avisos = []; }
        if (ast === undefined) break;
        if (ast === null) continue;
        try { st = yield* this.rodarLista(ast); }
        catch (e2) { if (e2 instanceof CmdErr) { st = e2.code; this.status = st; break; } throw e2; }
      }
    } catch (e3) {
      if (e3 instanceof AbortSig) {
        if (e3.msg === "int") { this.status = 130; return 130; }
        if (e3.msg === "recursao") { this.status = 1; return 1; }
        var msg = e3.msg === "saida" ? "(simulador) execução interrompida: saída grande demais." : e3.msg === "impasse" ? "(simulador) execução interrompida." : "(simulador) execução interrompida: passou de " + this.k.limit + " passos (laço infinito?). No terminal de verdade, use Ctrl+C para parar.";
        this.k.bytesSaida = 0;
        this.escrever(2, msg + "\n");
        this.status = 130; return 130;
      }
      if (e3 instanceof ReturnSig) { this.erro("return: possível retornar (`return') apenas de uma função ou script carregado (com `source')"); this.status = 2; return 2; }
      if (e3 instanceof BreakSig || e3 instanceof ContSig) { return this.status; }
      if (e3 instanceof FatalSig) { this.status = e3.code; return e3.code; }
      throw e3;
    }
    return st;
  };
  // "Incompleta?" — devolve true se a fonte precisa de mais linhas (prompt PS2)
  function incompleta(fonte, sh) {
    try {
      var p = new Parser(fonte, { aliases: sh && sh.shopt.expand_aliases ? sh.aliases : null, extglob: sh && sh.shopt.extglob, interativo: true });
      while (true) { var a = p.parseLinha(); if (a === undefined) break; }
      return false;
    } catch (e) {
      if (e instanceof Incomplete) return true;
      return false;
    }
  }

  /* ------------------------------------------------------------------
     12. Programas externos simulados — utilidades e arquivos
     ------------------------------------------------------------------ */
  function IO(sh, nome) { this.sh = sh; this.k = sh.k; this.nome = nome; this.st = 0; }
  var IOP = IO.prototype;
  IOP.out = function (s) {
    if (!s) return;
    var o = this.sh.fds[1];
    if (!o) { if (!this.errEscrita) { this.errEscrita = true; this.err(this.nome + ": erro de escrita: Descritor de arquivo inválido\n"); } this.st = 1; return; }
    try { escreverOFD(this.k, o, s); }
    catch (e) { if (e instanceof SigPipe || e instanceof AbortSig) throw e; if (!this.errEscrita) { this.errEscrita = true; this.err(this.nome + ": erro de escrita: Descritor de arquivo inválido\n"); } this.st = 1; }
  };
  IOP.err = function (s) { this.sh.escrever(2, s); };
  IOP.msg = function (m) { this.err(this.nome + ": " + m + "\n"); };
  IOP.tente = function (m) { if (m) this.msg(m); this.err("Tente \"" + this.nome + " --help\" para mais informações.\n"); return this.nome === "ls" ? 2 : 1; };
  IOP.tty = function () { var o = this.sh.fds[1]; return isTTY(o) && !o.naoTTY; };
  IOP.stdin = function* () { var o = this.sh.fds[0]; if (!o) { this.msg("-: erro de leitura: Descritor de arquivo inválido"); return ""; } return yield* lerTudo(this.k, o); };
  IOP.passo = function () { this.k.passo(); };
  IOP.fluir = function* () {
    this.k.passo();
    var o = this.sh.fds[1];
    if (o && o.kind === "pipe-w" && !o.p.semLimite && o.p.buf.length > 65536) {
      if (o.p.r === 0) throw new SigPipe();
      var p = o.p; yield { t: "block", cond: function () { return p.buf.length <= 16384 || p.r === 0; } };
      if (p.r === 0) throw new SigPipe();
    }
  };
  // lê um arquivo ("-" = entrada padrão). Devolve {txt} ou {err}
  IOP.ler = function* (arq) {
    if (arq === "-") return { txt: yield* this.stdin() };
    var r = this.sh.lerArquivo(arq);
    if (r.fd !== undefined) { var o = this.sh.fds[r.fd]; if (!o) return { err: "EBADF" }; return { txt: yield* lerTudo(this.k, o) }; }
    return r;
  };
  IOP.decimal = function () { return localeNum(this.sh); };
  IOP.env = function (n) { return this.sh.valor(n); };
  IOP.pergunta = function* (texto) {
    this.err(texto);
    var o = this.sh.fds[0];
    if (!o) return false;
    var r = yield* lerAte(this.k, o, "\n", null, { prompt: texto });
    return /^[sSyY]/.test(r.s);
  };
  function errMsg(e) { return ERRNO[e] || e; }
  // argumentos no estilo GNU: opções curtas agrupadas, longas, "--"; opções podem vir depois dos operandos
  function getopt(args, curtasComValor, longas, opt) {
    opt = opt || {};
    var o = {}, ops = [], i = 1, erro = null;
    longas = longas || {};
    for (; i < args.length; i++) {
      var a = args[i];
      if (a === "--") { ops = ops.concat(args.slice(i + 1)); break; }
      if (a.length > 2 && a.slice(0, 2) === "--") {
        var eq = a.indexOf("="), nome = eq > 0 ? a.slice(2, eq) : a.slice(2), val = eq > 0 ? a.slice(eq + 1) : null;
        var cands = Object.keys(longas).filter(function (l) { return l.indexOf(nome) === 0; });
        var exato = cands.indexOf(nome) >= 0 ? nome : (cands.length === 1 ? cands[0] : null);
        if (!exato) { erro = { tipo: cands.length > 1 ? "ambigua" : "longa", op: a }; break; }
        var spec = longas[exato];
        if (spec.indexOf("=") >= 0 && val === null && spec.indexOf("?") < 0) { val = args[++i]; if (val === undefined) { erro = { tipo: "faltaLonga", op: exato }; break; } }
        o[spec.replace(/[=?]/g, "")] = val === null ? true : val;
        continue;
      }
      if (a[0] === "-" && a.length > 1 && !(opt.numerico && /^-[0-9]/.test(a))) {
        for (var j = 1; j < a.length; j++) {
          var c = a[j];
          if (opt.validas && opt.validas.indexOf(c) < 0 && curtasComValor.indexOf(c) < 0) { erro = { tipo: "curta", op: c }; break; }
          if (curtasComValor.indexOf(c) >= 0) {
            var v = a.slice(j + 1);
            if (v === "") { v = args[++i]; if (v === undefined) { erro = { tipo: "falta", op: c }; break; } }
            if (o[c] !== undefined && opt.multi && opt.multi.indexOf(c) >= 0) { if (!Array.isArray(o[c])) o[c] = [o[c]]; o[c].push(v); }
            else o[c] = v;
            break;
          }
          o[c] = true;
        }
        if (erro) break;
        continue;
      }
      if (opt.parar) { ops = ops.concat(args.slice(i)); break; }
      ops.push(a);
    }
    return { o: o, ops: ops, erro: erro };
  }
  IOP.erroOpcao = function (e) {
    if (e.tipo === "curta") this.msg("opção inválida -- “" + e.op + "”");
    else if (e.tipo === "falta") this.msg("a opção requer um argumento -- “" + e.op + "”");
    else if (e.tipo === "ambigua") this.msg("a opção “" + e.op + "” é ambígua");
    else if (e.tipo === "faltaLonga") this.msg("a opção “--" + e.op + "” exige um argumento");
    else this.msg("opção não reconhecida “" + e.op + "”");
    this.err("Tente \"" + this.nome + " --help\" para mais informações.\n");
    return this.nome === "ls" || this.nome === "grep" ? 2 : 1;
  };
  function q1(s) { return "'" + s + "'"; }               // aspas simples (quotef/quoteaf)
  function qa(s) { return "‘" + s + "’"; }              // aspas tipográficas (quote)
  function qn(s) { return precisaAspasLs(s) ? aspasLs(s) : "'" + s + "'"; }
  function qs(s) { return precisaAspasLs(s) ? aspasLs(s) : s; }

  /* ---------- ls ---------- */
  function tipoCor(no, nome, alvoNo) {
    if (no.t === "d") return no.m & 2 && no.m & 512 ? "g" : "d";
    if (no.t === "l") return alvoNo ? "a" : "r";
    if (no.t === "c") return "y";
    if (no.m & 73) return "x";
    var ext = (nome.match(/\.([^.]+)$/) || [])[1];
    ext = ext ? ext.toLowerCase() : "";
    if (/^(tar|tgz|zip|gz|bz2|xz|7z|rar|deb|rpm|jar|zst|lz|lzma|z|tbz2|txz)$/.test(ext)) return "z";
    if (/^(jpg|jpeg|png|gif|bmp|svg|webp|tif|tiff|mp4|mkv|webm|avi|mov|ico|xcf)$/.test(ext)) return "m";
    if (/^(mp3|ogg|wav|flac|m4a|aac|opus|oga)$/.test(ext)) return "s";
    return "";
  }
  function modoStr(no) {
    var r = no.t === "d" ? "d" : no.t === "l" ? "l" : no.t === "c" ? "c" : "-", m = no.m, l = "rwxrwxrwx";
    for (var i = 0; i < 9; i++) r += (m & (256 >> i)) ? l[i] : "-";
    var a = r.split("");
    if (m & 2048) a[3] = a[3] === "x" ? "s" : "S";
    if (m & 1024) a[6] = a[6] === "x" ? "s" : "S";
    if (m & 512) a[9] = a[9] === "x" ? "t" : "T";
    return a.join("");
  }
  function versaoCmp(a, b) { // ordem de -v / sort -V
    var re = /(\d+|\D+)/g, x = a.match(re) || [], y = b.match(re) || [];
    for (var i = 0; i < Math.min(x.length, y.length); i++) {
      var p = x[i], q = y[i];
      if (/^\d/.test(p) && /^\d/.test(q)) { var d = parseInt(p, 10) - parseInt(q, 10); if (d) return d; if (p.length !== q.length) return q.length - p.length; continue; }
      if (p !== q) return p < q ? -1 : 1;
    }
    return x.length - y.length;
  }
  function tabular(de, ate, semTab) { if (semTab) return repete(" ", ate - de); var s = ""; while (ate > de) { if (Math.floor(ate / 8) > Math.floor((de + 1) / 8)) { s += "\t"; de += 8 - de % 8; } else { s += " "; de++; } } return s; }
  function colunasLs(itens, larguraTela, horizontal, semTab) {
    // itens: [{txt, w}]
    var n = itens.length;
    if (!n) return [];
    var maxCols = Math.max(1, Math.min(n, Math.floor(larguraTela / 3)));
    var melhor = 1, melhorLarg = null;
    for (var cols = maxCols; cols >= 1; cols--) {
      var rows = Math.ceil(n / cols);
      if (!horizontal && Math.ceil(n / rows) !== cols && cols > 1) continue;
      var larg = [];
      for (var i = 0; i < n; i++) {
        var c = horizontal ? i % cols : Math.floor(i / rows);
        var w = itens[i].w + (c === cols - 1 ? 0 : 2);
        larg[c] = Math.max(larg[c] || 0, w);
      }
      var tot = larg.reduce(function (a, b) { return a + b; }, 0);
      if (tot < larguraTela) { melhor = cols; melhorLarg = larg; break; }
    }
    if (!melhorLarg) { melhor = 1; melhorLarg = [0]; }
    var linhas = [], rws = Math.ceil(n / melhor);
    for (var r = 0; r < rws; r++) {
      var s = "", pos = 0;
      for (var cc = 0; cc < melhor; cc++) {
        var ix = horizontal ? r * melhor + cc : cc * rws + r;
        if (ix >= n) break;
        var prox = horizontal ? ix + 1 : ix + rws;
        s += itens[ix].txt;
        if (prox < n && (horizontal ? cc < melhor - 1 : true)) { var alvo = pos + melhorLarg[cc]; s += tabular(pos + itens[ix].w, alvo, semTab); pos = alvo; }
      }
      linhas.push(s);
    }
    return linhas;
  }
  EXT.ls = function* (args, io) {
    var sh = io.sh;
    var g = getopt(args, "wIT", { all: "a", "almost-all": "A", long: "l", "human-readable": "h", "color": "color?=", "classify": "F", "directory": "d", "recursive": "R", "reverse": "r", "size": "s", inode: "i", "full-time": "full-time", "time-style": "time-style=", "group-directories-first": "gdf", "numeric-uid-gid": "n", "sort": "sort=", "indicator-style": "indicator-style=", "dereference": "L", "width": "w=", "hide": "hide=", "ignore": "ignore=", "quoting-style": "quoting-style=", "literal": "N", "quote-name": "Q", "si": "si", "escape": "b", "zero": "zero", "time": "time=", "help": "help", "version": "version" }, { validas: "aAlhdFRrSstXvUi1CxmgnoGLpcuNQbBk" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o;
    if (o.p === true) o.p = true;
    if (o["indicator-style"] === "classify") o.F = true;
    if (o.version) { io.out("ls (GNU coreutils) 9.7\n"); return 0; }
    if (o.help) { io.out("Uso: ls [OPÇÃO]... [ARQUIVO]...\n"); return 0; }
    var tty = io.tty();
    var usaCor = o.color === "always" || o.color === "yes" || o.color === "force" || ((o.color === "auto" || o.color === "tty" || o.color === "if-tty" || o.color === true) && tty);
    if (o.color === true && !tty) usaCor = false;
    var longo = o.l || o.n || o.g || o.o || o["full-time"];
    var todos = o.a, quase = o.A && !o.a, umPor = o["1"] || (!tty && !o.C && !o.x && !o.m);
    var lcAll = sh.valor("LC_ALL") || sh.valor("LC_COLLATE") || sh.valor("LANG") || "";
    var ordemC = /^(C|POSIX)(\.|$)/.test(lcAll);
    var cmpNome = OPCOES.casaGuiaBash ? (ordemC ? cmpBytes : collate) : cmpBytes; // Guia Git: o ls do Ubuntu 26.04 (uutils) ordena por bytes (HEAD antes de config; Área de trabalho por último)
    var ops = g.ops.length ? g.ops : ["."];
    var semOps = !g.ops.length;
    var st = 0, arquivos = [], pastas = [];
    var aspas = tty && !o.N && o["quoting-style"] !== "literal" || o["quoting-style"] === "shell-escape" || o["quoting-style"] === "shell" || o.Q;
    ops.forEach(function (a) {
      var r = sh.resolver(a, !!o.L || (!longo && !o.d && !o.F) || (longo && /\/$/.test(a)));
      if (!r.no) { io.msg("não foi possível acessar " + q1(a) + ": " + errMsg(r.err || "ENOENT")); st = 2; return; }
      var no = r.no;
      if (no.t === "l" && !o.d && !longo && !o.F) { var rr = sh.resolver(a, true); if (rr.no) no = rr.no; }
      if (no.t === "l" && (o.H || (!o.d && !longo && o.F && /\/$/.test(a)))) { var r3 = sh.resolver(a, true); if (r3.no) no = r3.no; }
      if (no.t === "d" && !o.d) pastas.push({ rot: a, no: no });
      else arquivos.push({ nome: a, no: no, pasta: a.indexOf("/") >= 0 ? a.slice(0, a.lastIndexOf("/") + 1) : "" });
    });
    function ext(n) { var i = n.lastIndexOf("."); return i > 0 ? n.slice(i + 1) : ""; }
    function ordenar(l) {
      var por = o.sort || (o.t ? "time" : o.S ? "size" : o.X ? "extension" : o.v ? "version" : (o.U || o.f) ? "none" : "name");
      if (por === "none") return l;
      l.sort(function (x, y) {
        var r = 0;
        if (por === "time") { var tx = o.c ? x.no.ct : o.u ? (x.no.at || x.no.mt) : x.no.mt, ty = o.c ? y.no.ct : o.u ? (y.no.at || y.no.mt) : y.no.mt; r = ty - tx; }
        else if (por === "size") r = tamanho(y.no) - tamanho(x.no);
        else if (por === "extension") r = cmpNome(ext(x.nome), ext(y.nome));
        else if (por === "version") return versaoCmp(x.nome, y.nome);
        return r || cmpNome(x.nome, y.nome);
      });
      if (o.gdf) l.sort(function (x, y) { return (y.no.t === "d") - (x.no.t === "d"); });
      return l;
    }
    function sufixo(it) {
      var no = it.no;
      if (o.F) { if (no.t === "d") return "/"; if (no.t === "l") return "@"; if (no.t === "f" && no.m & 73) return "*"; return ""; }
      if (o.p && no.t === "d") return "/";
      return "";
    }
    function nomeVis(it, alinhar) {
      var n = it.nome, alvoNo = null;
      if (it.no.t === "l") { var rr = sh.resolver((it.base || "") + it.nome, true); alvoNo = rr.no; }
      var txt = aspas && precisaAspasLs(n) ? aspasLs(n) : (alinhar ? " " + n : n);
      if (o.Q && !precisaAspasLs(n)) txt = '"' + n + '"';
      var w = largura(txt);
      if (usaCor) { var tc = tipoCor(it.no, n, alvoNo); if (tc) txt = cor_(tc, txt); }
      var suf = sufixo(it);
      return { txt: txt + suf, w: w + suf.length };
    }
    function cor_(l, t) { if (/^ /.test(t)) return " " + cor(l, t.slice(1)); return cor(l, t); }
    function data(no) {
      var t = o.c ? no.ct : o.u ? (no.at || no.mt) : no.mt;
      if (o["full-time"] || o["time-style"] === "full-iso") { var x = tm(t); return x.Y + "-" + dois(x.M + 1) + "-" + dois(x.D) + " " + dois(x.h) + ":" + dois(x.m) + ":" + dois(x.s) + ".000000000 -0300"; }
      if (o["time-style"] === "long-iso") { var y = tm(t); return y.Y + "-" + dois(y.M + 1) + "-" + dois(y.D) + " " + dois(y.h) + ":" + dois(y.m); }
      if (o["time-style"] === "iso") { var z = tm(t); return (sh.k.clock - t < 15778476000 ? dois(z.M + 1) + "-" + dois(z.D) + " " + dois(z.h) + ":" + dois(z.m) : z.Y + "-" + dois(z.M + 1) + "-" + dois(z.D) + " "); }
      return dataLs(t, sh.k.clock);
    }
    function tamTxt(no) {
      if (no.t === "c") return ({ "null": "1, 3", zero: "1, 5", random: "1, 8", urandom: "1, 9", full: "1, 7", tty: "5, 0" })[no.dev] || "1, 3";
      var t = tamanho(no);
      return o.h || o.si ? humano(t, o.si) : String(t);
    }
    function blocosTxt(no) { var b = blocos(no); return o.h || o.si ? (b === 0 ? "0" : humano(b * 1024, o.si)) : String(b); }
    function linhasLongas(l) {
      var alinhar = aspas && l.some(function (it) { return precisaAspasLs(it.nome); });
      var cols = l.map(function (it) {
        var no = it.no;
        var c = [modoStr(no), String(contarLinks(no)), o.n ? String(no.u) : (USUARIOS[no.u] || String(no.u)), o.n ? String(no.g) : (GRUPOS[no.g] || String(no.g)), tamTxt(no), data(no)];
        var nv = nomeVis(it, alinhar).txt;
        if (no.t === "l") { var alvo = sh.resolver((it.base || "") + it.nome, true); var alvoTxt = aspas && precisaAspasLs(no.alvo) ? aspasLs(no.alvo) : no.alvo; if (usaCor) { var tcA = alvo.no ? tipoCor(alvo.no, no.alvo, alvo.no) : "r"; if (tcA) alvoTxt = cor(tcA, alvoTxt); } nv += " -> " + alvoTxt; }
        var pre = o.i ? String(no.ino) + " " : "";
        var bl = o.s ? blocosTxt(no) : null;
        return { c: c, nv: nv, pre: pre, bl: bl };
      });
      var w = [0, 0, 0, 0, 0, 0], wi = 0, wb = 0;
      cols.forEach(function (x) { for (var k = 1; k < 5; k++) w[k] = Math.max(w[k], largura(x.c[k])); wi = Math.max(wi, x.pre.length); if (x.bl !== null) wb = Math.max(wb, x.bl.length); });
      return cols.map(function (x) {
        var partes = [x.c[0], pad(x.c[1], w[1])];
        if (!o.g) partes.push(pad(x.c[2], w[2], true));
        if (!o.o && !o.G) partes.push(pad(x.c[3], w[3], true));
        if (o.g && o.G) { /* nada */ }
        partes.push(pad(x.c[4], w[4]));
        partes.push(x.c[5]);
        partes.push(x.nv);
        return (x.pre ? pad(x.pre.trim(), wi - 1) + " " : "") + (x.bl !== null ? pad(x.bl, wb) + " " : "") + partes.join(" ");
      });
    }
    function linhasCurtas(l) {
      var alinhar = aspas && l.some(function (it) { return precisaAspasLs(it.nome); });
      var fmt = l.map(function (it) {
        var v = nomeVis(it, alinhar && !umPor);
        if (o.i || o.s) { var pre = (o.i ? String(it.no.ino) + " " : "") + (o.s ? blocosTxt(it.no) + " " : ""); return { txt: pre + v.txt, w: pre.length + v.w, pre: pre }; }
        return v;
      });
      if (o.s || o.i) {
        // alinha a coluna de blocos/inode
        var wb = 0; l.forEach(function (it) { wb = Math.max(wb, (o.s ? blocosTxt(it.no) : String(it.no.ino)).length); });
        fmt = l.map(function (it, i) { var v = nomeVis(it, alinhar && !umPor); var pre = (o.i ? pad(String(it.no.ino), o.s ? 0 : wb) + " " : "") + (o.s ? pad(blocosTxt(it.no), wb) + " " : ""); return { txt: pre + v.txt, w: largura(pre) + v.w }; });
      }
      if (o.m) {
        var linhas = [], cur = "";
        fmt.forEach(function (f, i) {
          var pedaco = f.txt + (i < fmt.length - 1 ? "," : "");
          if (cur && largura(semCor(cur)) + 1 + largura(semCor(pedaco)) > 80) { linhas.push(cur); cur = pedaco; }
          else cur = cur ? cur + " " + pedaco : pedaco;
        });
        if (cur) linhas.push(cur);
        return linhas;
      }
      if (umPor) return fmt.map(function (f) { return f.txt; });
      var larg = parseInt(o.w || sh.valor("COLUMNS") || "80", 10) || 80;
      return colunasLs(fmt, larg, !!o.x, usaCor);
    }
    function total(l) { var t = 0; l.forEach(function (it) { t += blocos(it.no); }); return o.h || o.si ? (t === 0 ? "0" : humano(t * 1024, o.si)) : String(t); }
    var saida = [];
    ordenar(arquivos);
    if (o.r) arquivos.reverse();
    if (arquivos.length) {
      arquivos.forEach(function (a) { a.base = ""; });
      (longo ? linhasLongas(arquivos) : linhasCurtas(arquivos)).forEach(function (x) { saida.push(x); });
    }
    ordenar(pastas.map(function (p) { p.nome = p.rot; return p; }));
    if (o.r) pastas.reverse();
    var multi = ops.length > 1 || o.R;
    var self = this;
    function listar(p, primeiro) {
      if (!sh.pode(p.no, 4)) { io.msg("não foi possível abrir o diretório " + q1(p.rot) + ": Permissão negada"); st = 2; return; }
      var itens = Object.keys(p.no.c).filter(function (n) { return todos || quase || n[0] !== "."; }).filter(function (n) { return !o.hide || n[0] === "." && todos || !casaPadrao(o.hide, n); }).filter(function (n) { return !o.ignore || !casaPadrao(o.ignore, n); }).map(function (n) { return { nome: n, no: p.no.c[n], base: p.rot.replace(/\/?$/, "/") }; });
      if (todos) { itens.push({ nome: ".", no: p.no, base: "" }); var pai = sh.resolver(p.rot + "/..", true); itens.push({ nome: "..", no: pai.no || p.no, base: "" }); }
      ordenar(itens);
      if (o.r) itens.reverse();
      if (multi) { if (saida.length || !primeiro) saida.push(""); saida.push((aspas && precisaAspasLs(p.rot) ? aspasLs(p.rot) : p.rot) + ":"); }
      if (longo || o.s) saida.push("total " + total(itens.filter(function (it) { return true; })));
      (longo ? linhasLongas(itens) : linhasCurtas(itens)).forEach(function (x) { saida.push(x); });
      if (o.R) itens.forEach(function (it) { if (it.no.t === "d" && it.nome !== "." && it.nome !== "..") listar({ rot: p.rot.replace(/\/$/, "") + "/" + it.nome, no: it.no }, false); });
    }
    pastas.forEach(function (p, i) { listar(p, i === 0 && !arquivos.length); });
    if (saida.length) io.out(saida.join("\n") + "\n");
    return st;
  };
  EXT.dir = function* (args, io) { return yield* EXT.ls.call(this, ["ls", "-C"].concat(args.slice(1)), io); };
  EXT.vdir = function* (args, io) { return yield* EXT.ls.call(this, ["ls", "-l"].concat(args.slice(1)), io); };

  /* ---------- criar / remover ---------- */
  SP.paiDe = function (p) { // {pai, nome} para criar algo em p
    var limpo = p.replace(/\/+$/, "");
    var i = limpo.lastIndexOf("/");
    var dir = i < 0 ? "." : (i === 0 ? "/" : limpo.slice(0, i)), nome = limpo.slice(i + 1);
    var r = this.resolver(dir, true);
    return { pai: r.no, err: r.err, nome: nome, dir: dir };
  };
  EXT.mkdir = function* (args, io) {
    var sh = io.sh, g = getopt(args, "m", { parents: "p", verbose: "v", mode: "m=" }, { validas: "pvm" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (!g.ops.length) return io.tente("falta operando");
    var st = 0, modo = 511 & ~sh.umask;
    if (g.o.m) { var mm = aplicarModo(g.o.m, 511, true, sh.umask); if (mm === null) { io.msg("modo inválido " + qa(g.o.m)); return 1; } modo = mm; }
    g.ops.forEach(function (a) {
      if (g.o.p) {
        var partes = a.split("/"), cam = a[0] === "/" ? "" : "";
        for (var i = 0; i < partes.length; i++) {
          if (partes[i] === "" && i > 0) continue;
          cam = i === 0 ? (partes[0] === "" ? "/" : partes[0]) : (cam === "/" ? "/" : cam + "/") + partes[i];
          if (cam === "/" || partes[i] === "." || partes[i] === "..") continue;
          var r = sh.resolver(cam, true);
          if (r.no) { if (r.no.t !== "d") { io.msg("cannot create directory " + qa(a) + ": Arquivo existe"); st = 1; return; } continue; }
          var p = sh.paiDe(cam);
          if (!p.pai || p.pai.t !== "d") { io.msg("cannot create directory " + qa(cam) + ": " + errMsg(p.err || "ENOTDIR")); st = 1; return; }
          if (!sh.pode(p.pai, 2)) { io.msg("cannot create directory " + qa(cam) + ": Permissão negada"); st = 1; return; }
          p.pai.c[p.nome] = mkD(UID, i === partes.length - 1 ? modo : 509 & ~sh.umask | 448, sh.k.clock); if (p.pai.tmpfs) p.pai.c[p.nome].tmpfs = true; p.pai.mt = sh.k.clock;
          if (g.o.v) io.out("mkdir: foi criado o diretório " + qn(cam) + "\n");
        }
        return;
      }
      var r2 = sh.resolver(a, false);
      if (r2.no) { io.msg("cannot create directory " + qa(a) + ": Arquivo existe"); st = 1; return; }
      var pp = sh.paiDe(a);
      if (!pp.pai) { io.msg("cannot create directory " + qa(a) + ": " + errMsg(pp.err || "ENOENT")); st = 1; return; }
      if (pp.pai.t !== "d") { io.msg("cannot create directory " + qa(a) + ": Não é um diretório"); st = 1; return; }
      if (!sh.pode(pp.pai, 2)) { io.msg("cannot create directory " + qa(a) + ": Permissão negada"); st = 1; return; }
      pp.pai.c[pp.nome] = mkD(UID, modo, sh.k.clock); if (pp.pai.tmpfs) pp.pai.c[pp.nome].tmpfs = true; pp.pai.mt = pp.pai.ct = sh.k.clock;
      if (g.o.v) io.out("mkdir: foi criado o diretório " + qn(a) + "\n");
    });
    return st;
  };
  EXT.rmdir = function* (args, io) {
    var sh = io.sh, g = getopt(args, "", { parents: "p", verbose: "v", "ignore-fail-on-non-empty": "ig" }, { validas: "pv" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (!g.ops.length) return io.tente("falta operando");
    var st = 0;
    g.ops.forEach(function (a) {
      var alvos = [a];
      if (g.o.p) { var x = a.replace(/\/+$/, ""); while (x.indexOf("/") > 0) { x = x.slice(0, x.lastIndexOf("/")); alvos.push(x); } }
      for (var i = 0; i < alvos.length; i++) {
        var c = alvos[i];
        if (g.o.v) io.out("rmdir: removendo o diretório " + qn(c) + "\n");
        var r = sh.resolver(c, false);
        if (!r.no) { io.msg("falhou em remover " + qn(c) + ": " + errMsg(r.err || "ENOENT")); st = 1; return; }
        if (r.no.t !== "d") { io.msg("falhou em remover " + qn(c) + ": Não é um diretório"); st = 1; return; }
        if (Object.keys(r.no.c).length) { if (!g.o.ig) { io.msg("falhou em remover " + qn(c) + ": Diretório não vazio"); st = 1; } return; }
        if (!sh.pode(r.pai, 2)) { io.msg("falhou em remover " + qn(c) + ": Permissão negada"); st = 1; return; }
        delete r.pai.c[r.nome]; r.pai.mt = sh.k.clock;
      }
    });
    return st;
  };
  EXT.touch = function* (args, io) {
    var sh = io.sh, g = getopt(args, "drt", { date: "d=", reference: "r=", "no-create": "c" }, { validas: "acmdrthf" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (!g.ops.length) return io.tente("falta o operando arquivo");
    var quando = sh.k.clock, st = 0;
    if (g.o.d) { var d = interpretarData(g.o.d, sh.k.clock); if (d === null) { io.msg("data inválida " + qa(g.o.d)); return 1; } quando = d; }
    if (g.o.t) { var m = /^(?:(\d\d)?(\d\d))?(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d\d))?$/.exec(g.o.t); if (!m) { io.msg("formato de data inválido " + qa(g.o.t)); return 1; } var ano = m[2] ? parseInt((m[1] || "20") + m[2], 10) : tm(sh.k.clock).Y; quando = epochDe(ano, +m[3] - 1, +m[4], +m[5], +m[6], +(m[7] || 0)); }
    if (g.o.r) { var rn = sh.no(g.o.r); if (!rn) { io.msg("falha ao obter atributos de " + q1(g.o.r) + ": Arquivo ou diretório inexistente"); return 1; } quando = rn.mt; }
    g.ops.forEach(function (a) {
      var r = sh.resolver(a, true);
      if (r.no) { if (r.no.u !== UID && !sh.pode(r.no, 2)) { io.msg("não foi possível tocar " + qn(a) + ": Permissão negada"); st = 1; return; } if (!g.o.a || g.o.m) r.no.mt = quando; r.no.at = quando; r.no.ct = sh.k.clock; return; }
      if (g.o.c) return;
      if (r.err && r.err !== "ENOENT") { io.msg("não foi possível tocar " + qn(a) + ": " + errMsg(r.err)); st = 1; return; }
      if (/\/$/.test(a)) { io.msg("não foi possível tocar " + qn(a) + ": É um diretório"); st = 1; return; }
      var p = sh.paiDe(a);
      if (!p.pai || p.pai.t !== "d") { io.msg("não foi possível tocar " + qn(a) + ": " + errMsg(p.pai ? "ENOTDIR" : (p.err || "ENOENT"))); st = 1; return; }
      if (!sh.pode(p.pai, 2)) { io.msg("não foi possível tocar " + qn(a) + ": Permissão negada"); st = 1; return; }
      var novo = mkF(UID, 438 & ~sh.umask, "", quando); novo.ct = sh.k.clock;
      p.pai.c[p.nome] = novo; p.pai.mt = sh.k.clock;
    });
    return st;
  };
  function tipoArqIngles(no) { return no.t === "d" ? "directory" : no.t === "l" ? "symbolic link" : (tamanho(no) === 0 ? "regular empty file" : "regular file"); }
  EXT.rm = function* (args, io) {
    var sh = io.sh, g = getopt(args, "", { recursive: "r", force: "f", interactive: "interactive?=", verbose: "v", dir: "d", "preserve-root": "pr", "no-preserve-root": "npr" }, { validas: "rRfivdI" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o; if (o.R) o.r = true;
    if (!g.ops.length) { if (o.f) return 0; return io.tente("falta operando"); }
    var st = 0;
    if (o.I && (g.ops.length > 3 || o.r)) { var ok = yield* io.pergunta("rm: remover " + (o.r ? "recursivamente " : "") + g.ops.length + " argumento" + (g.ops.length > 1 ? "s" : "") + "? "); if (!ok) return 0; }
    for (var i = 0; i < g.ops.length; i++) {
      var a = g.ops[i];
      if (/(^|\/)\.\.?\/*$/.test(a)) { io.msg("recusa-se a remover os diretórios '.' ou '..': ignorando " + q1(a)); st = 1; continue; }
      if (a === "/" ) { io.msg("é perigoso operar recursivamente em '/'"); io.msg("use --no-preserve-root para ignorar esta falha de segurança"); st = 1; continue; }
      var r = sh.resolver(a, false);
      if (!r.no) { if (!o.f) { io.msg("não foi possível remover " + qn(a) + ": " + errMsg(r.err || "ENOENT")); st = 1; } continue; }
      var res = yield* remover(r.no, r.pai, r.nome, a);
      if (!res) st = 1;
    }
    function* remover(no, pai, nome, rot) {
      if (no.t === "d") {
        if (!o.r && !o.d) { io.msg("não foi possível remover " + qn(rot) + ": É um diretório"); return false; }
        if (!o.r && o.d && Object.keys(no.c).length) { io.msg("não foi possível remover " + qn(rot) + ": Diretório não vazio"); return false; }
        if (o.i && Object.keys(no.c).length) { var ok1 = yield* io.pergunta("rm: descer ao diretório " + qn(rot) + "? "); if (!ok1) return true; }
        var tudo = true, nomes = Object.keys(no.c).sort(cmpBytes);
        for (var k = 0; k < nomes.length; k++) { var ok2 = yield* remover(no.c[nomes[k]], no, nomes[k], rot.replace(/\/+$/, "") + "/" + nomes[k]); if (!ok2) tudo = false; }
        if (!tudo) return false;
        if (Object.keys(no.c).length) return true;
        if (o.i) { var ok3 = yield* io.pergunta("rm: remover directory " + qn(rot) + "? "); if (!ok3) return true; }
        if (!sh.pode(pai, 2)) { io.msg("não foi possível remover " + qn(rot) + ": Permissão negada"); return false; }
        delete pai.c[nome]; pai.mt = sh.k.clock;
        if (o.v) io.out("removido diretório " + qn(rot) + "\n");
        return true;
      }
      if (o.i) { var ok4 = yield* io.pergunta("rm: remover " + tipoArqIngles(no) + " " + qn(rot) + "? "); if (!ok4) return true; }
      else if (!o.f && no.t === "f" && !sh.pode(no, 2) && isTTY(sh.fds[0])) { var ok5 = yield* io.pergunta("rm: remover " + tipoArqIngles(no) + " protegido contra escrita " + qn(rot) + "? "); if (!ok5) return true; }
      if (!sh.pode(pai, 2) || !sh.pode(pai, 1)) { io.msg("não foi possível remover " + qn(rot) + ": Permissão negada"); return false; }
      delete pai.c[nome]; pai.mt = pai.ct = sh.k.clock;
      if (no.nl > 1) no.nl--;
      if (o.v) io.out("removido " + qn(rot) + "\n");
      return true;
    }
    return st;
  };
  function clonarNo(no, k, preservar, umask) {
    var n;
    if (no.t === "d") { n = mkD(UID, preservar ? no.m : no.m & ~umask, preservar ? no.mt : k.clock); for (var c in no.c) n.c[c] = clonarNo(no.c[c], k, preservar, umask); }
    else if (no.t === "l") { n = mkL(no.alvo, preservar ? no.mt : k.clock); n.u = UID; n.g = GID; }
    else { n = mkF(UID, preservar ? no.m : (no.m & ~umask), no.d, preservar ? no.mt : k.clock); if (no.d === null) { n.d = null; n.z = no.z; } }
    if (!preservar) n.ct = k.clock;
    return n;
  }
  SP.copiarMover = function* (args, io, mover) {
    var sh = this, nome = mover ? "mv" : "cp";
    var g = getopt(args, mover ? "tS" : "tS", { recursive: "r", archive: "a", force: "f", interactive: "i", "no-clobber": "n", verbose: "v", update: "update?=", "target-directory": "t=", "no-target-directory": "T", backup: "backup?=", link: "l", "symbolic-link": "s", preserve: "preserve?=", parents: "parents", "no-dereference": "P", dereference: "L", "remove-destination": "rd", "strip-trailing-slashes": "sts" }, { validas: mover ? "fivnuTbt" : "rRaivnfuTtblsdpPLHx" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o; if (o.R || o.a) o.r = true;
    var ops = g.ops.slice();
    if (!ops.length) return io.tente("falta o operando arquivo");
    var destino;
    if (o.t) destino = o.t;
    else { if (ops.length < 2) return io.tente("falta o operando arquivo de destino após " + qn(ops[0])); destino = ops.pop(); }
    if (o.n && !mover) io.msg("warning: behavior of -n is non-portable and may change in future; use --update=none instead");
    var rd = sh.resolver(destino, true);
    var destDir = rd.no && rd.no.t === "d" && !o.T;
    if (ops.length > 1 && !destDir) { if (!rd.no) { io.msg("o destino " + qn(destino) + " não é um diretório"); return 1; } io.msg("o destino " + qn(destino) + " não é um diretório"); return 1; }
    var st = 0;
    for (var i = 0; i < ops.length; i++) {
      var f = ops[i];
      var rf = sh.resolver(f, !mover && !o.P && !(o.a && false));
      if (!rf.no) { io.msg("não foi possível obter estado de " + qn(f) + ": " + errMsg(rf.err || "ENOENT")); st = 1; continue; }
      var src = rf.no;
      if (!mover && src.t === "d" && !o.r) { io.msg("-r não especificado; omitindo o diretório " + qn(f)); st = 1; continue; }
      var base = f.replace(/\/+$/, ""); base = base.slice(base.lastIndexOf("/") + 1) || base;
      var alvo = destDir ? destino.replace(/\/+$/, "") + "/" + base : destino;
      var ra = sh.resolver(alvo, true);
      var pa = sh.paiDe(alvo);
      if (!pa.pai || pa.pai.t !== "d") {
        if (!mover) io.msg("não foi possível criar arquivo comum " + qn(alvo) + ": " + errMsg(pa.err || "ENOENT"));
        else io.msg("não foi possível mover " + qn(f) + " para " + qn(alvo) + ": " + errMsg(pa.err || "ENOENT"));
        st = 1; continue;
      }
      if (ra.no === src) { io.msg(qn(f) + " e " + qn(alvo) + " são o mesmo arquivo"); st = 1; continue; }
      if (src.t === "d") {
        // não copiar/mover pasta para dentro de si mesma
        var absF = rf.caminho, absA = sh.abs(alvo);
        if (absA.indexOf(absF + "/") === 0) { io.msg("não é possível " + (mover ? "mover" : "copiar") + " um diretório, " + qn(f) + ", para dentro de si mesmo, " + qn(alvo)); st = 1; continue; }
      }
      if (ra.no) {
        if (o.n) { continue; }
        if (o.update === true || o.update === "older" || (o.u && o.update === undefined)) { if (ra.no.mt >= src.mt) continue; }
        if (o.update === "none") continue;
        if (ra.no.t === "d" && src.t !== "d") { io.msg("não foi possível sobrescrever o diretório " + qn(alvo) + " com um não-diretório"); st = 1; continue; }
        if (ra.no.t !== "d" && src.t === "d") { io.msg("não foi possível sobrescrever não-diretório " + qn(alvo) + " com diretório " + qn(f)); st = 1; continue; }
        if (o.i && !o.f) { var ok = yield* io.pergunta(nome + ": sobrescrever " + qn(alvo) + "? "); if (!ok) { st = mover || true ? 1 : 0; continue; } }
        if (o.backup !== undefined || o.b) { pa.pai.c[pa.nome + "~"] = ra.no; }
      }
      if (!sh.pode(pa.pai, 2)) {
        if (mover) io.msg("não foi possível mover " + qn(f) + " para " + qn(alvo) + ": Permissão negada");
        else io.msg((ra.no ? "não foi possível abrir " + qn(alvo) + " para escrita" : "não foi possível criar arquivo comum " + qn(alvo)) + ": Permissão negada");
        st = 1; continue;
      }
      if (mover) {
        if (!sh.pode(rf.pai, 2)) { io.msg("não foi possível mover " + qn(f) + " para " + qn(alvo) + ": Permissão negada"); st = 1; continue; }
        if (ra.no && ra.no.t === "d" && src.t === "d" && Object.keys(ra.no.c).length) { io.msg("não foi possível mover " + qn(f) + " para " + qn(alvo) + ": Diretório não vazio"); st = 1; continue; }
        delete rf.pai.c[rf.nome];
        pa.pai.c[pa.nome] = src; src.ct = sh.k.clock;
        rf.pai.mt = pa.pai.mt = sh.k.clock;
        if (o.v) io.out("renomeado " + qn(f) + " -> " + qn(alvo) + "\n");
      } else {
        var preservar = !!o.a || o.preserve !== undefined || o.p;
        if (o.l && src.t !== "d") { pa.pai.c[pa.nome] = src; src.nl = (src.nl || 1) + 1; }
        else if (o.s) { pa.pai.c[pa.nome] = mkL(f, sh.k.clock); pa.pai.c[pa.nome].u = UID; pa.pai.c[pa.nome].g = GID; }
        else if (ra.no && ra.no.t === "f" && src.t === "f") { ra.no.d = src.d; if (src.d === null) ra.no.z = src.z; else delete ra.no.z; ra.no.mt = preservar ? src.mt : sh.k.clock; if (preservar) ra.no.m = src.m; }
        else if (ra.no && ra.no.t === "d" && src.t === "d") { for (var c in src.c) ra.no.c[c] = clonarNo(src.c[c], sh.k, preservar, sh.umask); }
        else pa.pai.c[pa.nome] = clonarNo(src, sh.k, preservar, 0);
        pa.pai.mt = sh.k.clock;
        if (o.v) {
          io.out(qn(f) + " -> " + qn(alvo) + "\n");
          if (src.t === "d") (function lista(no, de, para) { Object.keys(no.c).sort(cmpBytes).forEach(function (n) { io.out(qn(de + "/" + n) + " -> " + qn(para + "/" + n) + "\n"); if (no.c[n].t === "d") lista(no.c[n], de + "/" + n, para + "/" + n); }); })(src, f.replace(/\/+$/, ""), alvo);
        }
      }
    }
    return st;
  };
  EXT.cp = function* (args, io) { return yield* io.sh.copiarMover(args, io, false); };
  EXT.mv = function* (args, io) { return yield* io.sh.copiarMover(args, io, true); };
  EXT.ln = function* (args, io) {
    var sh = io.sh, g = getopt(args, "t", { symbolic: "s", force: "f", verbose: "v", relative: "r", "no-dereference": "n", "target-directory": "t=" }, { validas: "sfvrnTit" });
    if (g.erro) return io.erroOpcao(g.erro);
    var ops = g.ops.slice();
    if (!ops.length) return io.tente("falta o operando arquivo");
    var dest = g.o.t || (ops.length > 1 ? ops.pop() : ".");
    var rd = sh.resolver(dest, !g.o.n);
    var st = 0;
    ops.forEach(function (alvo) {
      var base = alvo.replace(/\/+$/, ""); base = base.slice(base.lastIndexOf("/") + 1);
      var link = rd.no && rd.no.t === "d" && !(g.o.n && rd.no.t === "l") ? dest.replace(/\/+$/, "") + "/" + base : dest;
      var rl = sh.resolver(link, false);
      if (rl.no) {
        if (!g.o.f) { io.msg("falha ao criar " + (g.o.s ? "link simbólico " : "link físico ") + qn(link) + ": Arquivo existe"); st = 1; return; }
        delete rl.pai.c[rl.nome];
      }
      var p = sh.paiDe(link);
      if (!p.pai || p.pai.t !== "d") { io.msg("falha ao criar " + (g.o.s ? "link simbólico " : "link físico ") + qn(link) + ": Arquivo ou diretório inexistente"); st = 1; return; }
      if (g.o.s) {
        var t = alvo;
        p.pai.c[p.nome] = mkL(t, sh.k.clock); p.pai.c[p.nome].u = UID; p.pai.c[p.nome].g = GID;
      } else {
        var ra = sh.resolver(alvo, false);
        if (!ra.no) { io.msg("falha ao acessar " + qn(alvo) + ": " + errMsg(ra.err || "ENOENT")); st = 1; return; }
        if (ra.no.t === "d") { io.msg(qn(alvo) + ": links físicos não são permitidos para diretórios"); st = 1; return; }
        p.pai.c[p.nome] = ra.no; ra.no.nl = (ra.no.nl || 1) + 1; ra.no.ct = sh.k.clock;
      }
      p.pai.mt = sh.k.clock;
      if (g.o.v) io.out(qn(link) + " -> " + qn(alvo) + "\n");
    });
    return st;
  };
  function aplicarModo(modo, atual, ehDir, umask) {
    if (/^[0-7]{1,4}$/.test(modo)) return parseInt(modo, 8) | (ehDir && modo.length < 4 ? atual & 3072 : 0);
    var m = atual, ok = true;
    modo.split(",").forEach(function (parte) {
      var x = /^([ugoa]*)((?:[+\-=][rwxXstugo]*)+)$/.exec(parte);
      if (!x) { ok = false; return; }
      var quem = x[1], ops = x[2].match(/[+\-=][rwxXstugo]*/g);
      ops.forEach(function (op) {
        var sinal = op[0], perms = op.slice(1), bits = 0;
        var q = quem || "a";
        perms.split("").forEach(function (c) {
          var v = 0;
          if (c === "r") v = 4; else if (c === "w") v = 2; else if (c === "x" || (c === "X" && (ehDir || m & 73))) v = 1;
          else if (c === "u") v = (m >> 6) & 7; else if (c === "g") v = (m >> 3) & 7; else if (c === "o") v = m & 7;
          if (v) { if (/[ua]/.test(q)) bits |= v << 6; if (/[ga]/.test(q)) bits |= v << 3; if (/[oa]/.test(q)) bits |= v; }
          if (c === "s") { if (/[ua]/.test(q)) bits |= 2048; if (/[ga]/.test(q)) bits |= 1024; }
          if (c === "t") bits |= 512;
        });
        if (!quem && sinal !== "=") bits &= ~umask | 3584;
        if (sinal === "+") m |= bits;
        else if (sinal === "-") m &= ~bits;
        else { var mask = 0; if (/[ua]/.test(q)) mask |= 448 | 2048; if (/[ga]/.test(q)) mask |= 56 | 1024; if (/[oa]/.test(q)) mask |= 7 | 512; m = (m & ~mask) | bits; }
      });
    });
    return ok ? m : null;
  }
  function rwx9(m) { var l = "rwxrwxrwx", r = ""; for (var i = 0; i < 9; i++) r += (m & (256 >> i)) ? l[i] : "-"; if (m & 2048) r = r.slice(0, 2) + (r[2] === "x" ? "s" : "S") + r.slice(3); if (m & 1024) r = r.slice(0, 5) + (r[5] === "x" ? "s" : "S") + r.slice(6); if (m & 512) r = r.slice(0, 8) + (r[8] === "x" ? "t" : "T"); return r; }
  function oct4(m) { var o = (m & 4095).toString(8); while (o.length < 4) o = "0" + o; return o; }
  EXT.chmod = function* (args, io) {
    var sh = io.sh, a = args.slice(1), o = {}, resto = [];
    for (var i = 0; i < a.length; i++) {
      if (a[i] === "--") { resto = resto.concat(a.slice(i + 1)); break; }
      if (/^-[Rvcf]+$/.test(a[i])) { a[i].slice(1).split("").forEach(function (c) { o[c] = true; }); continue; }
      if (a[i] === "--recursive") { o.R = true; continue; } if (a[i] === "--verbose") { o.v = true; continue; } if (a[i] === "--changes") { o.c = true; continue; }
      resto.push(a[i]);
    }
    if (!resto.length) return io.tente("falta operando");
    var modo = resto.shift();
    if (!resto.length) return io.tente("falta operando depois de " + qa(modo));
    if (aplicarModo(modo, 0, false, 0) === null) { io.msg("modo inválido: " + qa(modo)); io.err("Tente \"chmod --help\" para mais informações.\n"); return 1; }
    var st = 0;
    resto.forEach(function (arq) {
      var r = sh.resolver(arq, true);
      if (!r.no) { io.msg("não foi possível acessar " + qn(arq) + ": " + errMsg(r.err || "ENOENT")); st = 1; return; }
      (function vai(no, rot) {
        if (no.u !== UID) { io.msg("alterando as permissões de " + qn(rot) + ": Operação não permitida"); st = 1; return; }
        var novo = aplicarModo(modo, no.m, no.t === "d", sh.umask);
        if (o.v || (o.c && novo !== no.m)) io.out(novo === no.m ? "modo de " + qn(rot) + " mantido como " + oct4(no.m) + " (" + rwx9(no.m) + ")\n" : "modo de " + qn(rot) + " alterado de " + oct4(no.m) + " (" + rwx9(no.m) + ") para " + oct4(novo) + " (" + rwx9(novo) + ")\n");
        no.m = novo; no.ct = sh.k.clock;
        if (o.R && no.t === "d") Object.keys(no.c).sort(cmpBytes).forEach(function (n) { if (no.c[n].t !== "l") vai(no.c[n], rot.replace(/\/$/, "") + "/" + n); });
      })(r.no, arq);
    });
    return st;
  };
  EXT.chown = function* (args, io) {
    var sh = io.sh, a = args.slice(1).filter(function (x) { return !/^-/.test(x); });
    if (a.length < 2) return io.tente("falta operando");
    var dono = a[0].split(":")[0], st = 0;
    a.slice(1).forEach(function (arq) {
      var r = sh.resolver(arq, true);
      if (!r.no) { io.msg("não foi possível acessar " + qn(arq) + ": Arquivo ou diretório inexistente"); st = 1; return; }
      if (dono && dono !== "ana" && dono !== "1000") { io.msg("alterando o dono de " + qn(arq) + ": Operação não permitida"); st = 1; }
    });
    return st;
  };
  EXT.chgrp = function* (args, io) {
    var sh = io.sh, a = args.slice(1).filter(function (x) { return !/^-/.test(x); });
    if (a.length < 2) return io.tente("falta operando");
    var grupos = { ana: 1000, adm: 4, cdrom: 24, sudo: 27, dip: 30, plugdev: 46, users: 100 }, st = 0;
    a.slice(1).forEach(function (arq) {
      var r = sh.resolver(arq, true);
      if (!r.no) { io.msg("não foi possível acessar " + qn(arq) + ": Arquivo ou diretório inexistente"); st = 1; return; }
      if (!(a[0] in grupos)) { io.msg("grupo inválido: " + qa(a[0])); st = 1; return; }
      r.no.g = grupos[a[0]];
    });
    return st;
  };

  /* ---------- texto: bytes ↔ string ---------- */
  function decodUtf8(b) { // decodifica bytes; bytes inválidos viram U+FFFD (como o Node/terminal)
    var s = "", i = 0, n = b.length;
    while (i < n) {
      var c = b[i];
      if (c < 0x80) { s += String.fromCharCode(c); i++; continue; }
      var len = c >= 0xf0 && c < 0xf5 ? 4 : c >= 0xe0 ? 3 : c >= 0xc2 && c < 0xe0 ? 2 : 0;
      if (!len) { s += "�"; i++; continue; }
      var cp = c & (len === 2 ? 31 : len === 3 ? 15 : 7), ok = true, j;
      for (j = 1; j < len; j++) {
        var d = b[i + j];
        if (d === undefined || (d & 0xc0) !== 0x80) { ok = false; break; }
        cp = (cp << 6) | (d & 63);
      }
      if (!ok) { s += "�"; i += j; continue; }
      s += String.fromCodePoint(cp); i += len;
    }
    return s;
  }
  function linhasDe(txt) { if (txt === "") return []; var l = txt.split("\n"); if (l[l.length - 1] === "") l.pop(); return l; }
  function terminaNL(txt) { return txt === "" || txt[txt.length - 1] === "\n"; }
  // lê cada arquivo (ou stdin) e chama cb(txt, nome). Mensagem de erro por estilo.
  IOP.cadaArquivo = function* (arqs, cb, estilo) {
    var st = 0, lista = arqs.length ? arqs : ["-"];
    for (var i = 0; i < lista.length; i++) {
      var a = lista[i], r = yield* this.ler(a);
      if (r.err) {
        st = 1;
        var m = errMsg(r.err);
        if (estilo === "abrir") this.msg("não foi possível abrir " + q1(a) + " para leitura: " + m);
        else if (estilo === "sort") this.msg("não foi possível ler: " + a + ": " + m);
        else if (estilo === "tac") this.msg("falha ao abrir " + q1(a) + " para leitura: " + m);
        else if (estilo === "rev") this.msg("não foi possível abrir " + a + ": " + m);
        else if (estilo === "sed") this.msg("não foi possível ler " + a + ": " + m);
        else if (r.err === "EISDIR" && estilo === "head") this.msg("erro ao ler " + q1(a) + ": É um diretório");
        else this.msg(a + ": " + m);
        continue;
      }
      var res = cb(r.txt, a, i);
      if (res && typeof res.next === "function") yield* res;
    }
    return st;
  };
  EXT.cat = function* (args, io) {
    var g = getopt(args, "", { number: "n", "number-nonblank": "b", "squeeze-blank": "s", "show-all": "A", "show-ends": "E", "show-tabs": "T", "show-nonprinting": "v" }, { validas: "nbsAETvetu" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o; if (o.A) { o.v = o.E = o.T = true; } if (o.e) { o.v = o.E = true; } if (o.t) { o.v = o.T = true; }
    var n = 0, anteriorVazia = false, meioLinha = false;
    var st = yield* io.cadaArquivo(g.ops, function* (txt) {
      if (txt === null || txt === undefined) return;
      if (!o.n && !o.b && !o.s && !o.v && !o.E && !o.T) { io.out(txt); yield* io.fluir(); return; }
      var partes = txt.split("\n"), out = "";
      for (var i = 0; i < partes.length; i++) {
        var l = partes[i], ultimaParte = i === partes.length - 1;
        if (ultimaParte && l === "") break;
        if (o.s && l === "" && !ultimaParte) { if (anteriorVazia) continue; anteriorVazia = true; } else anteriorVazia = false;
        if (o.v) l = mostrarNaoImprimiveis(l, o.T);
        else if (o.T) l = l.replace(/\t/g, "^I");
        if (!meioLinha) { if (o.b) { if (l !== "") out += pad(++n, 6) + "\t"; } else if (o.n) out += pad(++n, 6) + "\t"; }
        out += l;
        if (!ultimaParte) { out += (o.E ? "$" : "") + "\n"; meioLinha = false; } else meioLinha = true;
      }
      io.out(out);
    });
    return st || io.st;
  };
  function mostrarNaoImprimiveis(l, tabs) {
    var b = utf8bytes(l), r = "";
    for (var i = 0; i < b.length; i++) {
      var c = b[i];
      if (c === 9 && !tabs) { r += "\t"; continue; }
      if (c >= 128) { r += "M-"; c -= 128; }
      if (c < 32) r += "^" + String.fromCharCode(c + 64);
      else if (c === 127) r += "^?";
      else r += String.fromCharCode(c);
    }
    return r;
  }
  function numHeadTail(v, io, tipo) {
    var m = /^([+-]?)([0-9]+)(b|kB|K|k|KiB|MB|M|MiB|GB|G)?$/.exec(v);
    if (!m) return null;
    var mult = { b: 512, kB: 1000, K: 1024, k: 1024, KiB: 1024, MB: 1e6, M: 1048576, MiB: 1048576, GB: 1e9, G: 1073741824 }[m[3]] || 1;
    return { sinal: m[1], n: parseInt(m[2], 10) * mult };
  }
  function headTail(cauda) {
    return function* (args, io) {
      var a = args.slice(0);
      for (var i = 1; i < a.length; i++) { if (/^-[0-9]+$/.test(a[i]) && !/^-[nc]$/.test(a[i - 1] || "")) a[i] = "-n" + a[i].slice(1); else if (/^\+[0-9]+$/.test(a[i]) && cauda && !/^-[nc]$/.test(a[i - 1] || "")) a[i] = "-n+" + a[i].slice(1); else if (a[i] === "--") break; }
      var g = getopt(a, "ncs", { lines: "n=", bytes: "c=", quiet: "q", silent: "q", verbose: "v", follow: "f", retry: "retry", "zero-terminated": "z" }, { validas: cauda ? "ncqvfFsz" : "ncqvz" });
      if (g.erro) return io.erroOpcao(g.erro);
      var o = g.o, modo = o.c !== undefined ? "c" : "n", spec = o.c !== undefined ? o.c : (o.n !== undefined ? o.n : "10");
      var num = numHeadTail(String(spec), io);
      if (!num) { io.msg("número inválido de " + (modo === "c" ? "bytes" : "linhas") + ": " + qa(spec)); return 1; }
      var arqs = g.ops.length ? g.ops : ["-"], multi = arqs.length > 1 && !o.q || o.v;
      var primeiro = true, sh = io.sh;
      if (!cauda && arqs.length === 1 && arqs[0] === "-" && num.sinal !== "-" && !multi) {
        // lê só o necessário (yes | head não trava)
        var ent = sh.fds[0];
        if (!ent) return 1;
        if (modo === "n") {
          for (var q = 0; q < num.n; q++) { var lr = yield* lerAte(sh.k, ent, "\n", null, {}); if (!lr.achou && lr.s === "") break; io.out(lr.s + (lr.achou ? "\n" : "")); if (!lr.achou) break; }
        } else {
          var acc = [];
          while (acc.length < num.n) { var lc = yield* lerAte(sh.k, ent, null, 1, {}); if (lc.s === "") break; utf8bytes(lc.s).forEach(function (b) { acc.push(b); }); }
          io.out(decodUtf8(acc.slice(0, num.n)));
        }
        return 0;
      }
      var st = yield* io.cadaArquivo(arqs, function (txt, nome) {
        if (multi) { io.out((primeiro ? "" : "\n") + "==> " + (nome === "-" ? "entrada padrão" : nome) + " <==\n"); }
        primeiro = false;
        if (modo === "c") {
          var b = utf8bytes(txt), sel;
          if (!cauda) sel = num.sinal === "-" ? b.slice(0, Math.max(0, b.length - num.n)) : b.slice(0, num.n);
          else sel = num.sinal === "+" ? b.slice(Math.max(0, num.n - 1)) : b.slice(Math.max(0, b.length - num.n));
          io.out(decodUtf8(sel)); return;
        }
        var ls = txt.split("\n"), temFim = ls[ls.length - 1] === "";
        if (temFim) ls.pop();
        var r;
        if (!cauda) r = num.sinal === "-" ? ls.slice(0, Math.max(0, ls.length - num.n)) : ls.slice(0, num.n);
        else r = num.sinal === "+" ? ls.slice(Math.max(0, num.n - 1)) : ls.slice(Math.max(0, ls.length - num.n));
        var fimIncl = r.length && (cauda ? true : (num.sinal === "-" ? true : r.length >= ls.length)) ;
        var out = r.join("\n");
        if (r.length) out += (!temFim && (cauda || r.length === ls.length) && fimIncl && r[r.length - 1] === ls[ls.length - 1] && (cauda || r.length === ls.length)) ? "" : "\n";
        io.out(out);
      }, cauda ? "abrir" : "abrir");
      if (cauda && o.f && !sh.k.semTeclado) {
        // tail -f: fica esperando o arquivo crescer (Ctrl+C para parar)
        var arq = g.ops[g.ops.length - 1], no = arq ? sh.no(arq) : null, tam = no ? dadosDe(no).length : 0;
        while (true) {
          yield { t: "sleep", ms: 1000 };
          no = arq ? sh.no(arq) : null;
          if (no && dadosDe(no).length > tam) { io.out(dadosDe(no).slice(tam)); tam = dadosDe(no).length; }
        }
      }
      return st;
    };
  }
  EXT.head = headTail(false);
  EXT.tail = headTail(true);
  EXT.wc = function* (args, io) {
    var g = getopt(args, "", { lines: "l", words: "w", bytes: "c", chars: "m", "max-line-length": "L", "files0-from": "f0=", total: "total=" }, { validas: "lwcmL" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o, todas = !o.l && !o.w && !o.c && !o.m && !o.L;
    var res = [], tot = [0, 0, 0, 0, 0], soRegular = true, tamTot = 0, sh = io.sh;
    var arqs = g.ops.length ? g.ops : ["-"];
    var st = yield* io.cadaArquivo(arqs, function (txt, nome) {
      var c = [linhasDe(txt + "x").length - 1, (txt.match(/[^\s]+/g) || []).length, utf8len(txt), Array.from(txt).length, 0];
      c[0] = (txt.match(/\n/g) || []).length;
      linhasDe(txt).forEach(function (l) { var w = 0; for (var ch of l) w += ch === "\t" ? 8 - w % 8 : 1; c[4] = Math.max(c[4], w); });
      for (var k = 0; k < 5; k++) tot[k] = k === 4 ? Math.max(tot[k], c[k]) : tot[k] + c[k];
      if (nome === "-") { var fd0 = sh.fds[0]; if (!(fd0 && fd0.kind === "file" && !fd0.hd)) soRegular = false; else tamTot += c[2]; }
      else { var no = sh.no(nome); if (no && no.t === "f") tamTot += tamanho(no); else soRegular = false; }
      res.push({ c: c, nome: nome === "-" && !g.ops.length ? "" : nome });
    });
    function campos(c) { var r = []; if (todas || o.l) r.push(c[0]); if (todas || o.w) r.push(c[1]); if (o.m) r.push(c[3]); if (todas || o.c) r.push(c[2]); if (o.L) r.push(c[4]); return r; }
    var nCampos = campos(tot).length;
    var mostrarTotal = o.total === "always" || (res.length > 1 && o.total !== "never") || (arqs.length > 1 && o.total !== "never" && o.total !== "only");
    var larg;
    if (nCampos === 1 && arqs.length === 1) larg = 1;
    else if (!soRegular) larg = 7;
    else larg = Math.max(1, String(tamTot).length);
    if (o.total === "only") { io.out(campos(tot).join(" ") + "\n"); return st; }
    var saida = "";
    res.forEach(function (x) { saida += campos(x.c).map(function (v) { return pad(v, larg); }).join(" ") + (x.nome ? " " + x.nome : "") + "\n"; });
    if (mostrarTotal) saida += campos(tot).map(function (v) { return pad(v, larg); }).join(" ") + " total\n";
    io.out(saida);
    return st;
  };

  /* ---------- sort ---------- */
  function chaveNum(s, dec, mil) {
    var t = s.replace(/^\s+/, ""), m = new RegExp("^-?[0-9" + (mil ? "\\" + mil : "") + "]*(\\" + dec + "[0-9]*)?").exec(t);
    if (!m || !/[0-9]/.test(m[0])) return 0;
    var x = m[0];
    if (mil) x = x.split(mil).join("");
    return parseFloat(x.replace(dec, "."));
  }
  function chaveHum(s, dec) {
    var m = new RegExp("^\\s*(-?[0-9]+(?:\\" + dec + "[0-9]*)?)([KMGTPEkmgtpe]?)").exec(s);
    if (!m) return 0;
    var v = parseFloat(m[1].replace(dec, "."));
    return v * Math.pow(1024, " KMGTPE".indexOf((m[2] || " ").toUpperCase()));
  }
  var RE_DICT = (function () { try { return new RegExp("[^\\p{L}\\p{N}\\s]", "gu"); } catch (e) { return /[^A-Za-z0-9À-ÿ\s]/g; } })();
  var MESES_SORT = { jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12 };
  EXT.sort = function* (args, io) {
    var g = getopt(args, "ktoST", { numeric: "n", reverse: "r", unique: "u", key: "k=", "field-separator": "t=", "ignore-case": "f", "human-numeric-sort": "h", "version-sort": "V", "month-sort": "M", "random-sort": "R", output: "o=", stable: "s", check: "c", "general-numeric-sort": "g", "ignore-leading-blanks": "b", "zero-terminated": "z", "dictionary-order": "d" }, { validas: "nrukt foshVMRcgbzdCS", multi: "k" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o, sh = io.sh, dec = localeNum(sh), mil = dec === "," ? "." : "";
    var lc = sh.valor("LC_ALL") || sh.valor("LC_COLLATE") || sh.valor("LANG") || "";
    var ordemC = /^(C|POSIX)(\.|$)/.test(lc);
    var cmpTxt = ordemC ? cmpBytes : collate;
    var chaves = [];
    var ks = o.k === undefined ? [] : (Array.isArray(o.k) ? o.k : [o.k]);
    for (var i = 0; i < ks.length; i++) {
      var m = /^([0-9]+)(?:\.([0-9]+))?([bdfgiMhnRrV]*)(?:,([0-9]+)(?:\.([0-9]+))?([bdfgiMhnRrV]*))?$/.exec(ks[i]);
      if (!m || m[1] === "0") { io.msg("número inválido no início do campo: contagem inválida no início de " + qa(ks[i])); return 2; }
      chaves.push({ f1: +m[1], c1: m[2] ? +m[2] : 1, f2: m[4] ? +m[4] : null, c2: m[5] ? +m[5] : 0, op: (m[3] || "") + (m[6] || "") });
    }
    if (o.t !== undefined && o.t.length !== 1) { io.msg("o separador deve ser um único caractere"); return 2; }
    var linhas = [];
    var st = yield* io.cadaArquivo(g.ops, function (txt) { linhasDe(txt).forEach(function (l) { linhas.push(l); }); }, "sort");
    if (st) return 2;
    function campos(l) {
      if (o.t !== undefined) return l.split(o.t).map(function (x, i, arr) { return { s: x, ini: 0 }; });
      var r = [], re = /(\s*)(\S+)/g, mm;
      while ((mm = re.exec(l))) r.push({ s: mm[1] + mm[2] });
      return r;
    }
    function extrai(l, k) {
      if (!k) return l;
      var cs = campos(l);
      var sep = o.t !== undefined ? o.t : "";
      var ini = k.f1 - 1, fim = k.f2 === null ? cs.length - 1 : k.f2 - 1;
      if (ini >= cs.length) return "";
      var parte = cs.slice(ini, fim + 1).map(function (c) { return c.s; });
      var s = parte.join(sep);
      if (k.c1 > 1) { var primeiroC = parte[0] || ""; if (o.t === undefined && /[bB]/.test(k.op + (o.b ? "b" : ""))) { var tr = primeiroC.replace(/^\s+/, ""); s = s.slice(primeiroC.length - tr.length); } s = s.slice(k.c1 - 1); }
      if (k.c2) { var corte = 0; for (var q = 0; q < parte.length - 1; q++) corte += parte[q].length + sep.length; s = s.slice(0, corte + k.c2 - (k.c1 > 1 ? k.c1 - 1 : 0)); }
      return s;
    }
    function cmpChave(a, b, op) {
      var num = /n/.test(op) || (!op.replace(/[br]/g, "") && o.n), hum = /h/.test(op) || (!op.replace(/[br]/g, "") && o.h), ver = /V/.test(op) || (!op.replace(/[br]/g, "") && o.V), mes = /M/.test(op) || (!op.replace(/[br]/g, "") && o.M), gen = /g/.test(op) || (!op.replace(/[br]/g, "") && o.g);
      var fold = /f/.test(op) || o.f, blank = /b/.test(op) || o.b;
      if (num) return chaveNum(a, dec, mil) - chaveNum(b, dec, mil);
      if (gen) { var x = parseFloat(a.replace(",", ".")), y = parseFloat(b.replace(",", ".")); x = isNaN(x) ? -Infinity : x; y = isNaN(y) ? -Infinity : y; return x - y; }
      if (hum) return chaveHum(a, dec) - chaveHum(b, dec);
      if (ver) return versaoCmp(a, b);
      if (mes) { var ma = MESES_SORT[a.trim().slice(0, 3).toLowerCase()] || 0, mb = MESES_SORT[b.trim().slice(0, 3).toLowerCase()] || 0; return ma - mb; }
      if (blank) { a = a.replace(/^\s+/, ""); b = b.replace(/^\s+/, ""); }
      if (fold) { a = a.toUpperCase(); b = b.toUpperCase(); }
      if (/d/.test(op) || o.d) { a = a.replace(RE_DICT, ""); b = b.replace(RE_DICT, ""); }
      return cmpTxt(a, b);
    }
    function cmp(a, b) {
      var r = 0;
      if (chaves.length) {
        for (var i = 0; i < chaves.length && !r; i++) { r = cmpChave(extrai(a, chaves[i]), extrai(b, chaves[i]), chaves[i].op.replace(/r/g, "")); if (/r/.test(chaves[i].op)) r = -r; }
      } else r = cmpChave(a, b, "");
      if (!r && !o.s && !o.u) { r = ordemC ? cmpBytes(a, b) : collate(a, b); if (!r) r = cmpBytes(a, b); }
      return o.r && !(chaves.length && chaves.every(function (k) { return /r/.test(k.op); })) ? -r : r;
    }
    if (o.R) { linhas.sort(function () { return Math.random() - 0.5; }); }
    else if (o.c) {
      for (var j = 1; j < linhas.length; j++) if (cmp(linhas[j - 1], linhas[j]) > 0) { io.msg("-:" + (j + 1) + ": desordenado: " + linhas[j]); return 1; }
      return 0;
    } else {
      var idx = linhas.map(function (l, i) { return { l: l, i: i }; });
      idx.sort(function (x, y) { return cmp(x.l, y.l) || x.i - y.i; });
      linhas = idx.map(function (x) { return x.l; });
    }
    if (o.u) {
      var u = [];
      linhas.forEach(function (l) { if (!u.length) { u.push(l); return; } var ant = u[u.length - 1]; var igual = chaves.length ? chaves.every(function (k) { return cmpChave(extrai(ant, k), extrai(l, k), k.op.replace(/r/g, "")) === 0; }) : cmpChave(ant, l, "") === 0; if (!igual) u.push(l); });
      linhas = u;
    }
    var saida = linhas.length ? linhas.join("\n") + "\n" : "";
    if (o.o) { var f = sh.abrir(o.o, "w"); if (f.err) { io.msg("não foi possível abrir " + q1(o.o) + " para escrita: " + errMsg(f.err)); return 2; } escreverOFD(sh.k, f, saida); return 0; }
    io.out(saida);
    return 0;
  };
  EXT.uniq = function* (args, io) {
    var g = getopt(args, "fsw", { count: "c", repeated: "d", unique: "u", "ignore-case": "i", "skip-fields": "f=", "skip-chars": "s=", "check-chars": "w=", "all-repeated": "D" }, { validas: "cduifswDz" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o, sh = io.sh;
    var ent = g.ops[0] || "-", saidaArq = g.ops[1];
    var linhas = [];
    var st = yield* io.cadaArquivo([ent], function (txt) { linhas = linhasDe(txt); });
    if (st) return 1;
    function chave(l) {
      var s = l;
      if (o.f) { var n = +o.f; s = s.replace(new RegExp("^(\\s*\\S+){" + n + "}"), ""); }
      if (o.s) s = s.slice(+o.s);
      if (o.w) s = s.slice(0, +o.w);
      return o.i ? s.toLowerCase() : s;
    }
    var grupos = [];
    linhas.forEach(function (l) { var g2 = grupos[grupos.length - 1]; if (g2 && chave(g2.l) === chave(l)) { g2.n++; g2.todas.push(l); } else grupos.push({ l: l, n: 1, todas: [l] }); });
    var out = "";
    grupos.forEach(function (gr) {
      if (o.d && gr.n < 2) return; if (o.u && gr.n > 1) return;
      if (o.D) { if (gr.n > 1) gr.todas.forEach(function (x) { out += x + "\n"; }); return; }
      out += (o.c ? pad(gr.n, 7) + " " : "") + gr.l + "\n";
    });
    if (saidaArq) { var f = sh.abrir(saidaArq, "w"); if (f.err) { io.msg(saidaArq + ": " + errMsg(f.err)); return 1; } escreverOFD(sh.k, f, out); return 0; }
    io.out(out);
    return 0;
  };
  function listaFaixas(spec) {
    var s = [], ok = true;
    spec.split(/[,\s]/).forEach(function (x) {
      var m = /^([0-9]*)-([0-9]*)$/.exec(x);
      if (m) { if (!m[1] && !m[2]) { ok = false; return; } var a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : Infinity; if (a === 0) { ok = false; return; } s.push([a, b]); }
      else if (/^[0-9]+$/.test(x)) { if (+x === 0) { ok = false; return; } s.push([+x, +x]); }
      else ok = false;
    });
    if (!ok) return null;
    return function (i) { return s.some(function (r) { return i >= r[0] && i <= r[1]; }); };
  }
  EXT.cut = function* (args, io) {
    var g = getopt(args, "dfcb", { delimiter: "d=", fields: "f=", characters: "c=", bytes: "b=", "only-delimited": "s", complement: "complement", "output-delimiter": "od=" }, { validas: "dfcbsnz" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o, modos = (o.f !== undefined) + (o.c !== undefined) + (o.b !== undefined);
    if (modos === 0) { io.msg("você deve especificar uma lista de bytes, caracteres ou campos"); return io.tente(); }
    if (modos > 1) { io.msg("apenas um tipo de lista pode ser especificado"); return io.tente(); }
    var spec = o.f !== undefined ? o.f : o.c !== undefined ? o.c : o.b;
    var sel = listaFaixas(spec);
    if (!sel) { io.msg(/(^|[,\-])0/.test(spec) ? "campos e posições são numerados a partir de 1" : "intervalo inválido " + qa(spec)); return io.tente(); }
    var d = o.d !== undefined ? o.d : "\t";
    if (o.d !== undefined && o.f === undefined) { io.msg("um delimitador pode ser especificado apenas quando operando sobre campos"); return io.tente(); }
    if (Array.from(d).length !== 1) { io.msg("o delimitador deve ser um único caractere"); return io.tente(); }
    var comp = !!o.complement;
    function s2(i) { var x = sel(i); return comp ? !x : x; }
    var od = o.od !== undefined ? o.od : d;
    var st = yield* io.cadaArquivo(g.ops, function (txt) {
      var out = "";
      linhasDe(txt).forEach(function (l) {
        if (o.f === undefined) {
          var b = utf8bytes(l), r = [];
          b.forEach(function (x, i) { if (s2(i + 1)) r.push(x); });
          out += decodUtf8(r) + "\n"; return;
        }
        if (l.indexOf(d) < 0) { if (!o.s) out += l + "\n"; return; }
        var cs = l.split(d);
        out += cs.filter(function (c, i) { return s2(i + 1); }).join(od) + "\n";
      });
      io.out(out);
    });
    return st;
  };

  /* ---------- tr (por bytes, como o GNU) ---------- */
  function trConjunto(s, io) {
    var b = utf8bytes(s), r = [], i = 0;
    var CL = { upper: [65, 90], lower: [97, 122], digit: [48, 57] };
    function esc() {
      var c = b[i + 1];
      if (c === undefined) { i++; return 92; }
      var m = { 110: 10, 116: 9, 114: 13, 92: 92, 97: 7, 98: 8, 102: 12, 118: 11 }[c];
      if (m !== undefined) { i += 2; return m; }
      if (c >= 48 && c <= 55) { var v = 0, k = 0; i++; while (k < 3 && b[i] >= 48 && b[i] <= 55) { v = v * 8 + b[i] - 48; i++; k++; } return v & 255; }
      i += 2; return c;
    }
    while (i < b.length) {
      if (b[i] === 91 && b[i + 1] === 58) { // [:classe:]
        var fim = -1; for (var j = i + 2; j < b.length - 1; j++) if (b[j] === 58 && b[j + 1] === 93) { fim = j; break; }
        if (fim > 0) {
          var nome = String.fromCharCode.apply(null, b.slice(i + 2, fim));
          var add = [];
          for (var c = 0; c < 256; c++) {
            var ch = String.fromCharCode(c), ok = false;
            switch (nome) {
              case "upper": ok = c >= 65 && c <= 90; break; case "lower": ok = c >= 97 && c <= 122; break;
              case "digit": ok = c >= 48 && c <= 57; break; case "alpha": ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122); break;
              case "alnum": ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57); break;
              case "space": ok = c === 32 || (c >= 9 && c <= 13); break; case "blank": ok = c === 32 || c === 9; break;
              case "punct": ok = c > 32 && c < 127 && !/[A-Za-z0-9]/.test(ch); break; case "cntrl": ok = c < 32 || c === 127; break;
              case "print": ok = c >= 32 && c < 127; break; case "graph": ok = c > 32 && c < 127; break; case "xdigit": ok = /[0-9A-Fa-f]/.test(ch) && c < 128; break;
              default: io.msg("classe de caractere inválida " + qa(nome)); return null;
            }
            if (ok) add.push(c);
          }
          r.push({ cls: nome, bytes: add });
          i = fim + 2; continue;
        }
      }
      if (b[i] === 91 && b[i + 2] === 42 && i + 3 < b.length) { // [c*n]
        var f2 = b.indexOf(93, i + 3);
        if (f2 > 0) { var nn = String.fromCharCode.apply(null, b.slice(i + 3, f2)); r.push({ rep: b[i + 1], n: nn === "" ? -1 : parseInt(nn, nn[0] === "0" ? 8 : 10) }); i = f2 + 1; continue; }
      }
      var x = b[i] === 92 ? esc() : b[i++];
      if (b[i] === 45 && i + 1 < b.length) {
        i++;
        var y = b[i] === 92 ? esc() : b[i++];
        if (y < x) { io.msg("os pontos finais do intervalo de " + qa(String.fromCharCode(x) + "-" + String.fromCharCode(y)) + " estão na ordem inversa de agrupamento"); return null; }
        for (var z = x; z <= y; z++) r.push(z);
        continue;
      }
      r.push(x);
    }
    return r;
  }
  function trExpandir(set, alvoLen) {
    var out = [];
    set.forEach(function (x) { if (typeof x === "number") out.push(x); else if (x.bytes) x.bytes.forEach(function (y) { out.push(y); }); else if (x.n >= 0) for (var k = 0; k < x.n; k++) out.push(x.rep); });
    var rep = set.filter(function (x) { return x.rep !== undefined && x.n < 0; })[0];
    if (rep && alvoLen !== undefined) { var falta = alvoLen - out.length; var idx = set.indexOf(rep), antes = trExpandir(set.slice(0, idx)).length; var ins = []; for (var q = 0; q < falta; q++) ins.push(rep.rep); out.splice(antes, 0, ...ins); }
    return out;
  }
  EXT.tr = function* (args, io) {
    var g = getopt(args, "", { delete: "d", "squeeze-repeats": "s", complement: "c", truncate: "t" }, { validas: "dscCt" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o; if (o.C) o.c = true;
    var ops = g.ops;
    if (!ops.length) return io.tente("falta operando");
    if (!o.d && !o.s && ops.length < 2) { io.msg("falta operando depois de " + qa(ops[0])); io.err("Dois conjuntos devem ser fornecidos na tradução.\n"); return io.tente(); }
    if (o.d && !o.s && ops.length > 1) { io.msg("operando extra " + qa(ops[1])); io.err("Somente um conjunto pode ser fornecido ao excluir.\n"); return io.tente(); }
    var s1 = trConjunto(ops[0], io); if (!s1) return 1;
    var s2 = ops[1] !== undefined ? trConjunto(ops[1], io) : null; if (ops[1] !== undefined && !s2) return 1;
    var a = trExpandir(s1), b = s2 ? trExpandir(s2, a.length) : null;
    var em = {};
    a.forEach(function (x) { em[x] = true; });
    if (o.c) { var comp = []; for (var c = 0; c < 256; c++) if (!em[c]) comp.push(c); a = comp; em = {}; a.forEach(function (x) { em[x] = true; }); }
    var mapa = null;
    if (b && !o.d) {
      if (o.t) a = a.slice(0, b.length);
      if (!b.length && a.length) { io.msg("quando não estiver truncando o conjunto1, o conjunto2 deve ser não vazio"); return 1; }
      mapa = {};
      a.forEach(function (x, i) { mapa[x] = b[Math.min(i, b.length - 1)]; });
      if (o.c) { var ult = b[b.length - 1]; a.forEach(function (x) { mapa[x] = ult; }); }
    }
    var apertar = {};
    if (o.s) (o.d ? (s2 ? trExpandir(s2) : []) : (b || a)).forEach(function (x) { apertar[x] = true; });
    var txt = yield* io.stdin(), ent = utf8bytes(txt), sai = [], ult2 = -1;
    for (var i = 0; i < ent.length; i++) {
      var x = ent[i];
      if (o.d && em[x]) continue;
      if (mapa && hasOwn(mapa, x)) x = mapa[x];
      if (o.s && apertar[x] && x === ult2) continue;
      sai.push(x); ult2 = x;
    }
    io.out(decodUtf8(sai));
    return 0;
  };
  EXT.tee = function* (args, io) {
    var g = getopt(args, "", { append: "a", "ignore-interrupts": "i" }, { validas: "aip" });
    if (g.erro) return io.erroOpcao(g.erro);
    var sh = io.sh, st = 0, saidas = [];
    g.ops.forEach(function (f) { var o = sh.abrir(f, g.o.a ? "a" : "w"); if (o.err) { io.msg(f + ": " + errMsg(o.err)); st = 1; return; } ref(o); saidas.push(o); });
    var ent = sh.fds[0];
    try {
      while (true) {
        var r = yield* lerAte(sh.k, ent, "\n", null, {});
        if (!r.achou && r.s === "") break;
        var s = r.s + (r.achou ? "\n" : "");
        io.out(s);
        saidas.forEach(function (o) { escreverOFD(sh.k, o, s); });
        if (!r.achou) break;
      }
    } finally { saidas.forEach(unref); }
    return st;
  };
  EXT.nl = function* (args, io) {
    var g = getopt(args, "bswvin", { "body-numbering": "b=", "number-separator": "s=", "number-width": "w=", "starting-line-number": "v=", "line-increment": "i=", "number-format": "n=" }, { validas: "bswvin" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o, estilo = o.b || "t", sep = o.s !== undefined ? o.s : "\t", larg = o.w ? +o.w : 6, n = o.v ? +o.v : 1, inc = o.i ? +o.i : 1, fmt = o.n || "rn";
    var re = /^p/.test(estilo) ? new RegExp(estilo.slice(1)) : null;
    var st = yield* io.cadaArquivo(g.ops, function (txt) {
      var out = "";
      linhasDe(txt).forEach(function (l) {
        var num = estilo === "a" || (estilo === "t" && l !== "") || (re && re.test(l));
        if (num) {
          var sn = String(n); n += inc;
          if (fmt === "ln") sn = pad(sn, larg, true); else if (fmt === "rz") { while (sn.length < larg) sn = "0" + sn; } else sn = pad(sn, larg);
          out += sn + sep + l + "\n";
        } else out += repete(" ", larg + sep.length) + l + "\n";
      });
      io.out(out);
    });
    return st;
  };
  EXT.paste = function* (args, io) {
    var g = getopt(args, "d", { delimiters: "d=", serial: "s" }, { validas: "dsz" });
    if (g.erro) return io.erroOpcao(g.erro);
    var delims = (g.o.d !== undefined ? g.o.d : "\t").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\0/g, "").replace(/\\\\/g, "\\");
    var dl = Array.from(delims); if (!dl.length) dl = [""];
    var arqs = g.ops.length ? g.ops : ["-"], conteudos = [], st = 0;
    var stdinLido = null;
    for (var i = 0; i < arqs.length; i++) {
      if (arqs[i] === "-") { if (stdinLido === null) stdinLido = linhasDe(yield* io.stdin()); conteudos.push({ stdin: true }); continue; }
      var r = yield* io.ler(arqs[i]);
      if (r.err) { io.msg(arqs[i] + ": " + errMsg(r.err)); return 1; }
      conteudos.push(linhasDe(r.txt));
    }
    var nStdin = conteudos.filter(function (c) { return c.stdin; }).length, kS = 0;
    conteudos = conteudos.map(function (c) { if (!c.stdin) return c; var k = kS++; return g.o.s ? (k === 0 ? stdinLido : []) : stdinLido.filter(function (l, i) { return i % nStdin === k; }); });
    var out = "";
    if (g.o.s) conteudos.forEach(function (ls) { out += ls.map(function (l, i) { return (i ? dl[(i - 1) % dl.length] : "") + l; }).join("") + "\n"; });
    else {
      var n = Math.max.apply(null, conteudos.map(function (c) { return c.length; }));
      for (var j = 0; j < n; j++) out += conteudos.map(function (c, k) { return (k ? dl[(k - 1) % dl.length] : "") + (c[j] !== undefined ? c[j] : ""); }).join("") + "\n";
    }
    io.out(out);
    return st;
  };
  EXT.rev = function* (args, io) {
    var st = yield* io.cadaArquivo(args.slice(1).filter(function (a) { return a[0] !== "-" || a === "-"; }), function (txt) {
      var ls = txt.split("\n");
      io.out(ls.map(function (l) { return Array.from(l).reverse().join(""); }).join("\n"));
    }, "rev");
    return st;
  };
  EXT.tac = function* (args, io) {
    var st = yield* io.cadaArquivo(args.slice(1), function (txt) {
      var ls = linhasDe(txt); ls.reverse();
      io.out(ls.length ? ls.join("\n") + "\n" : "");
    }, "tac");
    return st;
  };
  EXT.fold = function* (args, io) {
    var a = args.slice(); for (var i = 1; i < a.length; i++) if (/^-[0-9]+$/.test(a[i])) a[i] = "-w" + a[i].slice(1);
    var g = getopt(a, "w", { width: "w=", spaces: "s", bytes: "b" }, { validas: "wsb" });
    if (g.erro) return io.erroOpcao(g.erro);
    var w = g.o.w ? +g.o.w : 80;
    var st = yield* io.cadaArquivo(g.ops, function (txt) {
      var out = "";
      txt.split("\n").forEach(function (l, i, arr) {
        if (i === arr.length - 1 && l === "") return;
        var cs = Array.from(l);
        while (cs.length > w) {
          var corte = w;
          if (g.o.s) { var sp = cs.slice(0, w).lastIndexOf(" "); if (sp >= 0) corte = sp + 1; }
          out += cs.slice(0, corte).join("") + "\n"; cs = cs.slice(corte);
        }
        out += cs.join("") + (i < arr.length - 1 ? "\n" : "");
      });
      io.out(out);
    });
    return st;
  };
  EXT.column = function* (args, io) {
    var g = getopt(args, "socN", { table: "t", separator: "s=", "output-separator": "o=", "table-columns": "N=", "output-width": "c=" }, { validas: "tsoxcNnRJ" });
    if (g.erro) return io.erroOpcao(g.erro);
    var linhas = [];
    var st = yield* io.cadaArquivo(g.ops, function (txt) { linhasDe(txt).forEach(function (l) { linhas.push(l); }); });
    if (g.o.t) {
      var sep = g.o.s, osep = g.o.o !== undefined ? g.o.o : "  ";
      var tab = linhas.filter(function (l) { return l.trim() !== ""; }).map(function (l) { return sep ? l.split(new RegExp("[" + sep.replace(/[\]\\^-]/g, "\\$&") + "]")) : l.trim().split(/\s+/); });
      if (g.o.N) tab.unshift(g.o.N.split(","));
      var w = [];
      tab.forEach(function (r) { r.forEach(function (c, i) { w[i] = Math.max(w[i] || 0, largura(c)); }); });
      io.out(tab.map(function (r) { return r.map(function (c, i) { return i === r.length - 1 ? c : pad(c, w[i], true); }).join(osep); }).join("\n") + (tab.length ? "\n" : ""));
      return st;
    }
    var itens = linhas.filter(function (l) { return l !== ""; }).map(function (l) { return { txt: l, w: largura(l) }; });
    var maxw = 0; itens.forEach(function (x) { maxw = Math.max(maxw, x.w); });
    var colw = Math.ceil((maxw + 1) / 8) * 8, larg = g.o.c ? +g.o.c : 80;
    var cols = Math.max(1, Math.floor(larg / colw)), rows = Math.ceil(itens.length / cols), out = "";
    for (var r = 0; r < rows; r++) {
      var s = "";
      for (var c = 0; c < cols; c++) { var ix = c * rows + r; if (ix >= itens.length) break; s += itens[ix].txt; if ((c + 1) * rows + r < itens.length) s += repete("\t", Math.ceil((colw - itens[ix].w) / 8)); }
      out += s + "\n";
    }
    io.out(out);
    return st;
  };
  EXT.comm = function* (args, io) {
    var g = getopt(args, "", {}, { validas: "123" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (g.ops.length < 2) return io.tente(g.ops.length ? "falta operando depois de " + qa(g.ops[0]) : "falta operando");
    var r1 = yield* io.ler(g.ops[0]); if (r1.err) { io.msg(g.ops[0] + ": " + errMsg(r1.err)); return 1; }
    var r2 = yield* io.ler(g.ops[1]); if (r2.err) { io.msg(g.ops[1] + ": " + errMsg(r2.err)); return 1; }
    var a = linhasDe(r1.txt), b = linhasDe(r2.txt), i = 0, j = 0, out = "";
    var c1 = g.o["1"] ? null : "", c2 = g.o["2"] ? null : (c1 === null ? "" : "\t"), c3 = g.o["3"] ? null : ((c1 === null ? "" : "\t") + (g.o["2"] ? "" : "\t"));
    while (i < a.length || j < b.length) {
      var cmp = i >= a.length ? 1 : j >= b.length ? -1 : collate(a[i], b[j]);
      if (cmp < 0) { if (c1 !== null) out += c1 + a[i] + "\n"; i++; }
      else if (cmp > 0) { if (c2 !== null) out += c2 + b[j] + "\n"; j++; }
      else { if (c3 !== null) out += c3 + a[i] + "\n"; i++; j++; }
    }
    io.out(out);
    return 0;
  };
  // diff: formato normal, -u, -q, -s
  function lcs(a, b) {
    var n = a.length, m = b.length, dp = [];
    for (var i = 0; i <= n; i++) { dp[i] = new Array(m + 1); dp[i][m] = 0; }
    for (var j = 0; j <= m; j++) dp[n][j] = 0;
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var ops = []; i = 0; j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { ops.push({ t: "=", i: i, j: j }); i++; j++; }
      else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ t: "-", i: i }); i++; }
      else { ops.push({ t: "+", j: j }); j++; }
    }
    return ops;
  }
  EXT.diff = function* (args, io) {
    var g = getopt(args, "UC", { unified: "U?=", brief: "q", "report-identical-files": "s", "ignore-case": "i", "ignore-all-space": "w", "side-by-side": "y", context: "C?=", color: "color?=" }, { validas: "uUqsiwyBbcC" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (g.ops.length < 2) { io.msg(g.ops.length ? "faltando operando após " + qa(g.ops[0]) : "faltando operando após " + qa("diff")); io.msg("Tente \"diff --help\" para mais informações."); return 2; }
    var r1 = yield* io.ler(g.ops[0]); if (r1.err) { io.msg(g.ops[0] + ": " + errMsg(r1.err)); return 2; }
    var r2 = yield* io.ler(g.ops[1]); if (r2.err) { io.msg(g.ops[1] + ": " + errMsg(r2.err)); return 2; }
    var norm = function (l) { if (g.o.i) l = l.toLowerCase(); if (g.o.w) l = l.replace(/\s+/g, ""); else if (g.o.b) l = l.replace(/\s+/g, " ").replace(/ $/, ""); return l; };
    var a = linhasDe(r1.txt), b = linhasDe(r2.txt);
    var na = a.map(norm), nb = b.map(norm);
    var igual = na.length === nb.length && na.every(function (x, i) { return x === nb[i]; });
    if (igual) { if (g.o.s) io.out("Os arquivos " + g.ops[0] + " e " + g.ops[1] + " são idênticos\n"); return 0; }
    if (g.o.q) { io.out("Os arquivos " + g.ops[0] + " e " + g.ops[1] + " são diferentes\n"); return 1; }
    var ops = lcs(na, nb);
    // agrupa em blocos de mudanças
    var blocos = [], cur = null;
    ops.forEach(function (op, k) {
      if (op.t === "=") { if (cur) { blocos.push(cur); cur = null; } return; }
      if (!cur) { var prevI = 0, prevJ = 0; for (var q = k - 1; q >= 0; q--) if (ops[q].t === "=") { prevI = ops[q].i + 1; prevJ = ops[q].j + 1; break; } cur = { del: [], add: [], i0: prevI, j0: prevJ }; }
      if (op.t === "-") cur.del.push(op.i); else cur.add.push(op.j);
    });
    if (cur) blocos.push(cur);
    var out = "";
    if (g.o.u !== undefined || g.o.U !== undefined || g.o.unified !== undefined) {
      var ctx = 3;
      if (typeof g.o.U === "string") ctx = +g.o.U;
      var t = tm(io.sh.k.clock);
      var stamp = function (nome) { var no = io.sh.no(nome), x = tm(no ? no.mt : io.sh.k.clock); return x.Y + "-" + dois(x.M + 1) + "-" + dois(x.D) + " " + dois(x.h) + ":" + dois(x.m) + ":" + dois(x.s) + ".000000000 -0300"; };
      out += "--- " + g.ops[0] + "\t" + stamp(g.ops[0]) + "\n+++ " + g.ops[1] + "\t" + stamp(g.ops[1]) + "\n";
      // hunks
      var hunks = [], hcur = null;
      ops.forEach(function (op, k) {
        if (op.t !== "=") {
          var ini = Math.max(0, k - ctx);
          if (hcur && ini <= hcur.fim) { hcur.fim = Math.min(ops.length, k + ctx + 1); }
          else { if (hcur) hunks.push(hcur); hcur = { ini: ini, fim: Math.min(ops.length, k + ctx + 1) }; }
        }
      });
      if (hcur) hunks.push(hcur);
      hunks.forEach(function (h) {
        var sl = ops.slice(h.ini, h.fim), ai = null, bj = null, an = 0, bn = 0, corpo = "";
        sl.forEach(function (op) {
          if (op.t === "=") { if (ai === null) ai = op.i; if (bj === null) bj = op.j; an++; bn++; corpo += " " + a[op.i] + "\n"; }
          else if (op.t === "-") { if (ai === null) ai = op.i; an++; corpo += "-" + a[op.i] + "\n"; }
          else { if (bj === null) bj = op.j; bn++; corpo += "+" + b[op.j] + "\n"; }
        });
        if (ai === null) { var pi = 0; for (var q = h.ini - 1; q >= 0; q--) if (ops[q].t !== "+") { pi = (ops[q].i || 0) + 1; break; } ai = pi; }
        if (bj === null) { var pj = 0; for (var q2 = h.ini - 1; q2 >= 0; q2--) if (ops[q2].t !== "-") { pj = (ops[q2].j || 0) + 1; break; } bj = pj; }
        var fa = an === 0 ? ai + ",0" : (an === 1 ? String(ai + 1) : (ai + 1) + "," + an);
        var fb = bn === 0 ? bj + ",0" : (bn === 1 ? String(bj + 1) : (bj + 1) + "," + bn);
        out += "@@ -" + fa + " +" + fb + " @@\n" + corpo;
      });
      if (!terminaNL(r1.txt) || !terminaNL(r2.txt)) { /* simplificado */ }
      io.out(out);
      return 1;
    }
    function faixa(ini, n) { return n <= 1 ? String(ini + 1) : (ini + 1) + "," + (ini + n); }
    blocos.forEach(function (bl) {
      var tipo = bl.del.length && bl.add.length ? "c" : bl.del.length ? "d" : "a";
      var esq = bl.del.length ? faixa(bl.del[0], bl.del.length) : String(bl.i0);
      var dir = bl.add.length ? faixa(bl.add[0], bl.add.length) : String(bl.j0);
      out += esq + tipo + dir + "\n";
      bl.del.forEach(function (i) { out += "< " + a[i] + "\n"; });
      if (tipo === "c") out += "---\n";
      bl.add.forEach(function (j) { out += "> " + b[j] + "\n"; });
    });
    if (!terminaNL(r1.txt) && a.length) out = out.replace(/(< [^\n]*\n)(?![\s\S]*< )/, "$1\\ Sem quebra de linha no final do arquivo\n");
    io.out(out);
    return 1;
  };
  EXT.cmp = function* (args, io) {
    var ops = args.slice(1).filter(function (a) { return a[0] !== "-" || a === "-"; }), silencio = args.indexOf("-s") >= 0;
    if (ops.length < 2) return io.tente("falta operando depois de " + qa(ops[0] || "cmp"));
    var r1 = yield* io.ler(ops[0]); if (r1.err) { io.msg(ops[0] + ": " + errMsg(r1.err)); return 2; }
    var r2 = yield* io.ler(ops[1]); if (r2.err) { io.msg(ops[1] + ": " + errMsg(r2.err)); return 2; }
    var a = utf8bytes(r1.txt), b = utf8bytes(r2.txt), linha = 1;
    for (var i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) { if (!silencio) io.out(ops[0] + " " + ops[1] + " diferem: byte " + (i + 1) + ", linha " + linha + "\n"); return 1; }
      if (a[i] === 10) linha++;
    }
    if (a.length !== b.length) { if (!silencio) io.msg("EOF em " + (a.length < b.length ? ops[0] : ops[1]) + " depois do byte " + Math.min(a.length, b.length) + ", linha " + (linha - 1)); return 1; }
    return 0;
  };
  EXT.shuf = function* (args, io) {
    var g = getopt(args, "neio", { "head-count": "n=", echo: "e", "input-range": "i=" }, { validas: "neior" });
    var linhas;
    if (g.o.e) linhas = g.ops.slice();
    else if (g.o.i) { var m = /^(\d+)-(\d+)$/.exec(g.o.i); linhas = []; if (m) for (var k = +m[1]; k <= +m[2]; k++) linhas.push(String(k)); }
    else { linhas = []; var st = yield* io.cadaArquivo(g.ops, function (t) { linhas = linhas.concat(linhasDe(t)); }); if (st) return st; }
    for (var i = linhas.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t2 = linhas[i]; linhas[i] = linhas[j]; linhas[j] = t2; }
    if (g.o.n) linhas = linhas.slice(0, +g.o.n);
    io.out(linhas.length ? linhas.join("\n") + "\n" : "");
    return 0;
  };
  EXT.expand = function* (args, io) {
    var st = yield* io.cadaArquivo(args.slice(1).filter(function (a) { return a[0] !== "-"; }), function (txt) {
      io.out(txt.split("\n").map(function (l) { var r = ""; for (var ch of l) { if (ch === "\t") { r += repete(" ", 8 - r.length % 8); } else r += ch; } return r; }).join("\n"));
    });
    return st;
  };
  EXT.od = function* (args, io) {
    var g = getopt(args, "tAjN", { format: "t=", "address-radix": "A=" }, { validas: "tAcbxdoNjv" });
    var txt = "";
    var st = yield* io.cadaArquivo(g.ops, function (t) { txt += t; });
    var b = utf8bytes(txt), radix = g.o.A || "o", out = "";
    var tipo = g.o.c ? "c" : (g.o.t || "o2");
    if (g.o.N) b = b.slice(0, +g.o.N);
    function ender(n) { if (radix === "n") return ""; var s = n.toString(radix === "x" ? 16 : radix === "d" ? 10 : 8); while (s.length < 7) s = "0" + s; return s; }
    for (var i = 0; i < b.length; i += 16) {
      var lin = b.slice(i, i + 16), cel;
      if (tipo === "c") cel = lin.map(function (x) { var esc = { 0: "\\0", 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r" }[x]; return pad(esc || (x >= 32 && x < 127 ? String.fromCharCode(x) : x.toString(8)), 4); }).join("");
      else if (/^x1/.test(tipo)) cel = lin.map(function (x) { return " " + ("0" + x.toString(16)).slice(-2); }).join("");
      else if (/^d1|^u1/.test(tipo)) cel = lin.map(function (x) { return pad(x, 4); }).join("");
      else { var w = []; for (var k = 0; k < lin.length; k += 2) { var v = lin[k] | ((lin[k + 1] || 0) << 8); w.push(" " + ("000000" + v.toString(8)).slice(-6)); } cel = w.join(""); }
      out += ender(i) + cel + "\n";
    }
    out += ender(b.length) + (radix === "n" ? "" : "\n");
    io.out(out);
    return st;
  };

  /* ---------- datas ---------- */
  function formatarData(fmt, ms, utc) {
    var off = utc ? 0 : TZ_OFF;
    var d = new Date(ms + off);
    var t = { Y: d.getUTCFullYear(), M: d.getUTCMonth(), D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), w: d.getUTCDay(), ms: d.getUTCMilliseconds() };
    var yday = Math.floor((Date.UTC(t.Y, t.M, t.D) - Date.UTC(t.Y, 0, 1)) / 864e5);
    function semanaISO() { var dt = new Date(Date.UTC(t.Y, t.M, t.D)); var dn = (t.w + 6) % 7; dt.setUTCDate(dt.getUTCDate() - dn + 3); var pri = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return { w: 1 + Math.round(((dt - pri) / 864e5 - 3 + ((pri.getUTCDay() + 6) % 7)) / 7), Y: dt.getUTCFullYear() }; }
    var zona = utc ? "UTC" : "-03", z = utc ? "+0000" : "-0300";
    return fmt.replace(/%([-_0^#]?)([0-9]*)(:{0,3})([a-zA-Z%+])/g, function (m, flag, larg, dp, c) {
      var v, num = true, w = 2;
      switch (c) {
        case "Y": v = t.Y; w = 4; break; case "C": v = Math.floor(t.Y / 100); break; case "y": v = t.Y % 100; break;
        case "m": v = t.M + 1; break; case "d": v = t.D; break; case "e": v = t.D; if (!flag) flag = "_"; break;
        case "H": v = t.h; break; case "k": v = t.h; if (!flag) flag = "_"; break; case "I": v = t.h % 12 || 12; break; case "l": v = t.h % 12 || 12; if (!flag) flag = "_"; break;
        case "M": v = t.m; break; case "S": v = t.s; break; case "j": v = yday + 1; w = 3; break;
        case "u": v = t.w || 7; w = 1; break; case "w": v = t.w; w = 1; break;
        case "U": v = Math.floor((yday + 7 - t.w) / 7); break; case "W": v = Math.floor((yday + 7 - ((t.w + 6) % 7)) / 7); break;
        case "V": v = semanaISO().w; break; case "G": v = semanaISO().Y; w = 4; break; case "g": v = semanaISO().Y % 100; break;
        case "s": v = Math.floor(ms / 1000); w = 1; break; case "N": v = (t.ms * 1000000); w = 9; break;
        default: num = false;
      }
      if (num) {
        var s = String(v), wl = larg ? parseInt(larg, 10) : w;
        if (flag === "-") return s;
        var ch = flag === "_" ? " " : "0";
        while (s.length < wl) s = ch + s;
        return s;
      }
      var r;
      switch (c) {
        case "a": r = DIAS[t.w]; break; case "A": r = DIAS_LONGO[t.w]; break;
        case "b": case "h": r = MESES[t.M]; break; case "B": r = MESES_LONGO[t.M]; break;
        case "p": r = ""; break; case "P": r = ""; break;
        case "Z": r = zona; break; case "z": r = dp === ":" ? z.slice(0, 3) + ":" + z.slice(3) : dp === "::" ? z.slice(0, 3) + ":" + z.slice(3) + ":00" : dp === ":::" ? z.slice(0, 3) : z; break;
        case "n": r = "\n"; break; case "t": r = "\t"; break; case "%": r = "%"; break;
        case "F": r = formatarData("%Y-%m-%d", ms, utc); break; case "T": r = formatarData("%H:%M:%S", ms, utc); break;
        case "D": r = formatarData("%m/%d/%y", ms, utc); break; case "R": r = formatarData("%H:%M", ms, utc); break;
        case "r": r = formatarData("%I:%M:%S ", ms, utc); break; case "c": r = formatarData("%a %d %b %Y %H:%M:%S", ms, utc); break;
        case "x": r = formatarData("%d/%m/%Y", ms, utc); break; case "X": r = formatarData("%H:%M:%S", ms, utc); break;
        case "+": r = formatarData("%a %d %b %Y %H:%M:%S %Z", ms, utc); break;
        default: return m;
      }
      if (flag === "^") r = r.toUpperCase();
      if (flag === "#") r = r === r.toUpperCase() ? r.toLowerCase() : r.toUpperCase();
      if (larg) r = pad(r, parseInt(larg, 10));
      return r;
    });
  }
  var UNIDADES = { sec: 1e3, second: 1e3, s: 1e3, min: 6e4, minute: 6e4, m: 6e4, hour: 36e5, h: 36e5, day: 864e5, d: 864e5, week: 6048e5, fortnight: 12096e5, month: "M", year: "Y" };
  function interpretarData(s, agora) {
    interpretarData.absoluto = false;
    s = s.trim().toLowerCase();
    if (s === "" || s === "now" || s === "today" || s === "hoje" || s === "agora") return agora;
    var m;
    if ((m = /^@(-?[0-9]+(?:\.[0-9]+)?)$/.exec(s))) return Math.floor(parseFloat(m[1]) * 1000);
    var base = agora, resto = s;
    // data absoluta no início
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(resto))) {
      base = epochDe(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
      if (+m[2] > 12 || +m[3] > 31) return null;
      interpretarData.absoluto = true;
      resto = resto.slice(m[0].length).trim();
    } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(resto))) {
      var ano = +m[3]; if (ano < 100) ano += 2000;
      base = epochDe(ano, +m[1] - 1, +m[2], 0, 0, 0); resto = resto.slice(m[0].length).trim();
    } else if ((m = /^(\d{1,2}) (jan|feb|fev|mar|apr|abr|may|mai|jun|jul|aug|ago|sep|set|oct|out|nov|dec|dez)[a-z]* (\d{4})/.exec(resto))) {
      var mesN = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"].indexOf({ feb: "fev", apr: "abr", may: "mai", aug: "ago", sep: "set", oct: "out", dec: "dez" }[m[2]] || m[2]);
      base = epochDe(+m[3], mesN, +m[1], 0, 0, 0); resto = resto.slice(m[0].length).trim();
    }
    if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(resto))) {
      var t = tm(base);
      base = epochDe(t.Y, t.M, t.D, +m[1], +m[2], m[3] ? +m[3] : 0); resto = resto.slice(m[0].length).trim();
    }
    if (resto === "tomorrow") return base + 864e5;
    if (resto === "yesterday") return base - 864e5;
    if (resto === "now" || resto === "today") return base;
    var dias = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    if ((m = /^(next|last|this)?\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/.exec(resto))) {
      var alvo = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(m[2]), t2 = tm(base);
      var meia = epochDe(t2.Y, t2.M, t2.D, 0, 0, 0), diff = (alvo - t2.w + 7) % 7;
      if (m[1] === "next" && diff === 0) diff = 7;
      if (m[1] === "last") { diff = diff - 7; if (diff === 0) diff = -7; }
      return meia + diff * 864e5;
    }
    var re = /([+-]?\s*\d+)?\s*(sec|second|min|minute|hour|day|week|fortnight|month|year)s?(\s+ago)?/g, achou = false, total = 0, meses = 0, ult = 0;
    while ((m = re.exec(resto))) {
      if (m.index !== ult && resto.slice(ult, m.index).trim() !== "") return null;
      ult = re.lastIndex; achou = true;
      var n = m[1] ? parseInt(m[1].replace(/\s+/g, ""), 10) : 1;
      if (m[3]) n = -n;
      var u = UNIDADES[m[2]];
      if (u === "M") meses += n; else if (u === "Y") meses += 12 * n; else total += n * u;
    }
    if (resto && (!achou || resto.slice(ult).trim() !== "")) return null;
    if (meses) { var t3 = tm(base); base = epochDe(t3.Y, t3.M + meses, t3.D, t3.h, t3.m, t3.s); }
    return base + total;
  }
  EXT.date = function* (args, io) {
    args = args.map(function (x, i) { return i > 0 && /^-I./.test(x) ? "--iso-8601=" + x.slice(2) : x; });
    var g = getopt(args, "drs", { date: "d=", utc: "u", universal: "u", reference: "r=", "iso-8601": "I?=", "rfc-email": "R", set: "s=", rfc3339: "rfc3339=" }, { validas: "durIRs" });
    if (g.erro) return io.erroOpcao(g.erro);
    var sh = io.sh, quando = sh.k.clock, o = g.o;
    if (o.s) { io.msg("não foi possível definir a data: Operação não permitida"); return 1; }
    if (o.d !== undefined) { var q = interpretarData(o.d, sh.k.clock); if (q === null) { io.msg("data inválida " + qa(o.d)); return 1; } if (o.u && interpretarData.absoluto) q += TZ_OFF; quando = q; }
    if (o.r) { var no = sh.no(o.r); if (!no) { io.msg(o.r + ": Arquivo ou diretório inexistente"); return 1; } quando = no.mt; }
    var fmt = null;
    var mais = g.ops.filter(function (x) { return x[0] === "+"; });
    var extra = g.ops.filter(function (x) { return x[0] !== "+"; });
    if (extra.length) { io.msg("data inválida " + qa(extra[0])); return 1; }
    if (mais.length > 1) { io.msg("operando extra " + qa(mais[1])); return io.tente(); }
    if (mais.length) fmt = mais[0].slice(1);
    else if (o.I !== undefined) { var p = o.I === true ? "date" : o.I; fmt = p === "date" ? "%Y-%m-%d" : p === "hours" ? "%Y-%m-%dT%H%:z" : p === "minutes" ? "%Y-%m-%dT%H:%M%:z" : p === "ns" ? "%Y-%m-%dT%H:%M:%S,%N%:z" : "%Y-%m-%dT%H:%M:%S%:z"; }
    else if (o.R) { var d = new Date(quando + (o.u ? 0 : TZ_OFF)); var DE = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], ME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; io.out(DE[d.getUTCDay()] + ", " + dois(d.getUTCDate()) + " " + ME[d.getUTCMonth()] + " " + d.getUTCFullYear() + " " + dois(d.getUTCHours()) + ":" + dois(d.getUTCMinutes()) + ":" + dois(d.getUTCSeconds()) + (o.u ? " +0000" : " -0300") + "\n"); return 0; }
    else if (o.rfc3339) fmt = o.rfc3339 === "date" ? "%Y-%m-%d" : "%Y-%m-%d %H:%M:%S%:z";
    else fmt = "%a %d %b %Y %H:%M:%S %Z";
    io.out(formatarData(fmt, quando, !!o.u) + "\n");
    return 0;
  };
  EXT.cal = function* (args, io) {
    var t = tm(io.sh.k.clock), ano = t.Y, mes = t.M;
    var cab = MESES_LONGO[mes][0].toUpperCase() + MESES_LONGO[mes].slice(1) + " " + ano;
    var esp = Math.floor((20 - cab.length) / 2);
    var out = pad(repete(" ", esp) + cab, 20, true) + "  \ndo se te qu qu se sá  \n";
    var primeiro = new Date(Date.UTC(ano, mes, 1)).getUTCDay(), dias = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    var linha = repete("   ", primeiro);
    for (var d = 1; d <= dias; d++) {
      var sd = pad(d, 2);
      linha += sd + " ";
      if ((primeiro + d) % 7 === 0) { out += linha + " \n"; linha = ""; }
    }
    if (linha) out += pad(linha, 21, true) + " \n";
    io.out(out);
    return 0;
  };

  /* ---------- seq / sleep / yes ---------- */
  EXT.seq = function* (args, io) {
    var a = args.slice(1), o = {}, ops = [];
    for (var i = 0; i < a.length; i++) {
      if (a[i] === "-w" || a[i] === "--equal-width") { o.w = true; continue; }
      if (a[i] === "-s" || a[i] === "--separator") { o.s = a[++i]; continue; }
      if (/^-s./.test(a[i])) { o.s = a[i].slice(2); continue; }
      if (a[i] === "-f" || a[i] === "--format") { o.f = a[++i]; continue; }
      if (/^-f./.test(a[i])) { o.f = a[i].slice(2); continue; }
      if (a[i] === "--") { ops = ops.concat(a.slice(i + 1)); break; }
      if (/^-[^0-9.]/.test(a[i])) return io.erroOpcao({ tipo: "curta", op: a[i][1] });
      ops.push(a[i]);
    }
    if (!ops.length) return io.tente("falta operando");
    if (ops.length > 3) return io.tente("operando extra " + qa(ops[3]));
    var dec = io.decimal();
    var nums = [];
    for (var j = 0; j < ops.length; j++) {
      var s = ops[j].trim();
      if (!/^[+-]?([0-9]+([.,][0-9]*)?|[.,][0-9]+)([eE][+-]?[0-9]+)?$/.test(s) || (s.indexOf(",") >= 0 && dec === ".")) { io.msg("argumento inválido de ponto flutuante: " + qa(ops[j])); return io.tente(); }
      nums.push({ v: parseFloat(s.replace(",", ".")), casas: /[.,]([0-9]*)/.test(s) && !/[eE]/.test(s) ? /[.,]([0-9]*)/.exec(s)[1].length : 0 });
    }
    var ini = ops.length > 1 ? nums[0] : { v: 1, casas: 0 }, inc = ops.length === 3 ? nums[1] : { v: 1, casas: 0 }, fim = nums[nums.length - 1];
    if (inc.v === 0) { io.msg("valor de incremento inválido: zero"); return io.tente(); }
    var casas = Math.max(ini.casas, inc.casas);
    var sep = o.s !== undefined ? o.s : "\n";
    var larg = 0;
    function fmt(v) {
      if (o.f) return io.sh.printfFormatar(o.f, [String(v).replace(".", dec)], "seq").s;
      var s = casas ? v.toFixed(casas) : String(Math.round(v));
      s = s.replace(".", dec);
      if (o.w) { var neg = s[0] === "-"; var c = neg ? s.slice(1) : s; while (c.length + (neg ? 1 : 0) < larg) c = "0" + c; s = (neg ? "-" : "") + c; }
      return s;
    }
    if (o.w) { var a1 = (casas ? ini.v.toFixed(casas) : String(ini.v)), a2 = casas ? fim.v.toFixed(casas) : String(Math.floor(fim.v)); larg = Math.max(a1.length, a2.length); }
    var out = "", n = 0, primeiro = true;
    for (var k = 0; ; k++) {
      var v = ini.v + k * inc.v;
      v = Math.round(v * 1e10) / 1e10;
      if (inc.v > 0 ? v > fim.v + 1e-12 : v < fim.v - 1e-12) break;
      out += (primeiro ? "" : sep) + fmt(v); primeiro = false;
      if (++n % 2000 === 0) { io.out(out); out = ""; yield* io.fluir(); }
    }
    if (!primeiro) out += "\n";
    io.out(out);
    return 0;
  };
  EXT.sleep = function* (args, io) {
    var ops = args.slice(1).filter(function (a) { return a !== "--"; });
    if (!ops.length) return io.tente("falta operando");
    var total = 0;
    for (var i = 0; i < ops.length; i++) {
      var m = /^([0-9]*\.?[0-9]+|[0-9]+\.)([smhd]?)$/.exec(ops[i]);
      if (!m || (io.decimal() === "," && false)) { io.msg("intervalo inválido de tempo " + qa(ops[i])); return io.tente(); }
      total += parseFloat(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]]) * 1000;
    }
    yield { t: "sleep", ms: total };
    return 0;
  };
  EXT.yes = function* (args, io) {
    var s = (args.length > 1 ? args.slice(1).join(" ") : "y") + "\n", bloco = repete(s, Math.max(1, Math.floor(2048 / s.length)));
    while (true) { io.out(bloco); yield* io.fluir(); }
  };

  /* ---------- ambiente / identidade ---------- */
  EXT.env = function* (args, io) {
    var sh = io.sh, a = args.slice(1), limpar = false, tirar = [], defs = [];
    while (a.length) {
      if (a[0] === "-i" || a[0] === "-" || a[0] === "--ignore-environment") { limpar = true; a.shift(); continue; }
      if (a[0] === "-u") { tirar.push(a[1]); a.splice(0, 2); continue; }
      if (a[0] === "--") { a.shift(); break; }
      if (/^[^=]+=/.test(a[0])) { defs.push(a.shift()); continue; }
      if (/^-/.test(a[0])) return io.erroOpcao({ tipo: "curta", op: a[0][1] });
      break;
    }
    var env = limpar ? {} : sh.exportadas();
    tirar.forEach(function (n) { delete env[n]; });
    defs.forEach(function (d) { var i = d.indexOf("="); env[d.slice(0, i)] = d.slice(i + 1); });
    if (!a.length) { var s = ""; for (var k in env) s += k + "=" + env[k] + "\n"; io.out(s); return 0; }
    var n = sh.novoShell(); n.interativo = false;
    n.globais = Object.create(null);
    for (var k2 in env) n.globais[k2] = new Var(env[k2], { x: true });
    var semPath = !n.globais.PATH;
    if (semPath) n.globais.PATH = new Var("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", {});
    var t = n.acharNoPath(a[0]);
    if (!t && a[0].indexOf("/") < 0) { io.msg(qa(a[0]) + ": Arquivo ou diretório inexistente"); n.fecharTudo(); return 127; }
    try { return yield* n.executar(a, { semFuncao: true, externo: true }); } finally { n.fecharTudo(); }
  };
  EXT.printenv = function* (args, io) {
    var env = io.sh.exportadas(), nomes = args.slice(1).filter(function (x) { return x[0] !== "-"; });
    if (!nomes.length) { var s = ""; for (var k in env) s += k + "=" + env[k] + "\n"; io.out(s); return 0; }
    var st = 0; nomes.forEach(function (n) { if (env[n] !== undefined) io.out(env[n] + "\n"); else st = 1; });
    return st;
  };
  EXT.whoami = function* (args, io) { if (args.length > 1) return io.tente("operando extra " + qa(args[1])); io.out("ana\n"); return 0; };
  EXT.logname = EXT.whoami;
  EXT.hostname = function* (args, io) { if (args[1] === "-I" || args[1] === "-i") { io.out(args[1] === "-I" ? "192.168.0.15 \n" : "127.0.1.1\n"); return 0; } if (args[1] === "-f") { io.out("notebook\n"); return 0; } if (args[1] && args[1][0] !== "-") { io.msg("você deve ser root para alterar o nome da máquina"); return 1; } io.out("notebook\n"); return 0; };
  EXT.id = function* (args, io) {
    var g = getopt(args, "", { user: "u", group: "g", groups: "G", name: "n", real: "r" }, { validas: "ugGnrz" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (g.ops.length && g.ops[0] !== "ana" && g.ops[0] !== "1000") {
      if (g.ops[0] === "root") { io.out(g.o.u ? (g.o.n ? "root\n" : "0\n") : "uid=0(root) gid=0(root) grupos=0(root)\n"); return 0; }
      io.msg(qa(g.ops[0]) + ": usuário inexistente"); return 1;
    }
    var gs = GROUPS;
    if (g.o.u) { io.out(g.o.n ? "ana\n" : "1000\n"); return 0; }
    if (g.o.g) { io.out(g.o.n ? "ana\n" : "1000\n"); return 0; }
    if (g.o.G) { io.out(gs.map(function (x) { return g.o.n ? GRUPOS[x] : x; }).join(" ") + "\n"); return 0; }
    io.out("uid=1000(ana) gid=1000(ana) grupos=" + gs.map(function (x) { return x + "(" + GRUPOS[x] + ")"; }).join(",") + "\n");
    return 0;
  };
  EXT.groups = function* (args, io) { io.out((args[1] ? args[1] + " : " : "") + GROUPS.map(function (x) { return GRUPOS[x]; }).join(" ") + "\n"); return 0; };
  EXT.uname = function* (args, io) {
    var g = getopt(args, "", { all: "a", "kernel-name": "s", nodename: "n", "kernel-release": "r", "kernel-version": "v", machine: "m", processor: "p", "hardware-platform": "i", "operating-system": "o" }, { validas: "asnrvmpio" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o, p = [];
    var vv = "#38-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 09:10:14 UTC 2026";
    if (o.a) { io.out("Linux notebook 7.0.0-38-generic " + vv + " x86_64 x86_64 x86_64 GNU/Linux\n"); return 0; }
    if (o.s || !Object.keys(o).length) p.push("Linux"); if (o.n) p.push("notebook"); if (o.r) p.push("7.0.0-38-generic"); if (o.v) p.push(vv);
    if (o.m) p.push("x86_64"); if (o.p) p.push("x86_64"); if (o.i) p.push("x86_64"); if (o.o) p.push("GNU/Linux");
    io.out(p.join(" ") + "\n");
    return 0;
  };
  EXT.nproc = function* (args, io) { io.out("4\n"); return 0; };
  EXT.tty = function* (args, io) { var o = io.sh.fds[0]; if (isTTY(o) && !o.naoTTY) { io.out("/dev/pts/0\n"); return 0; } io.out("não é um tty\n"); return 1; };
  EXT.uptime = function* (args, io) { var t = tm(io.sh.k.clock); io.out(" " + dois(t.h) + ":" + dois(t.m) + ":" + dois(t.s) + " up  2:30,  1 user,  load average: 0,15, 0,20, 0,18\n"); return 0; };
  EXT.free = function* (args, io) {
    var h = args.indexOf("-h") >= 0;
    io.out(h ? "               total        usada       livre    compart.  buff/cache  disponível\nMem.:           15Gi       5,2Gi       4,1Gi       512Mi       6,5Gi        10Gi\nSwap:          4,0Gi          0B       4,0Gi\n"
      : "               total        usada       livre    compart.  buff/cache  disponível\nMem.:        15743128     5452100     4301216      524288     6815040    10291028\nSwap:         4194300           0     4194300\n");
    return 0;
  };
  EXT.factor = function* (args, io) {
    var nums = args.slice(1);
    if (!nums.length) nums = linhasDe(yield* io.stdin()).join(" ").split(/\s+/).filter(Boolean);
    var st = 0;
    nums.forEach(function (x) {
      if (!/^[0-9]+$/.test(x)) { io.msg(qa(x) + " não é um inteiro positivo válido"); st = 1; return; }
      var n = parseInt(x, 10), f = [];
      for (var d = 2; d * d <= n; d++) while (n % d === 0) { f.push(d); n /= d; }
      if (n > 1) f.push(n);
      io.out(x + ":" + f.map(function (y) { return " " + y; }).join("") + "\n");
    });
    return st;
  };

  /* ---------- caminhos ---------- */
  EXT.basename = function* (args, io) {
    var g = getopt(args, "s", { multiple: "a", suffix: "s=", zero: "z" }, { validas: "asz" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (!g.ops.length) return io.tente("falta operando");
    var multi = g.o.a || g.o.s !== undefined, suf = g.o.s;
    if (!multi && g.ops.length > 2) return io.tente("operando extra " + qa(g.ops[2]));
    if (!multi && g.ops.length === 2) suf = g.ops[1];
    var lista = multi ? g.ops : [g.ops[0]];
    lista.forEach(function (p) {
      var b = p.replace(/\/+$/, "");
      if (b === "" && p !== "") b = "/"; else b = b.slice(b.lastIndexOf("/") + 1);
      if (suf && b !== suf && b.slice(-suf.length) === suf) b = b.slice(0, -suf.length);
      io.out(b + "\n");
    });
    return 0;
  };
  EXT.dirname = function* (args, io) {
    var ops = args.slice(1).filter(function (x) { return x !== "--"; });
    if (!ops.length) return io.tente("falta operando");
    ops.forEach(function (p) {
      var s = p.replace(/\/+$/, "");
      if (s === "" && p !== "") { io.out("/\n"); return; }
      var i = s.lastIndexOf("/");
      if (i < 0) { io.out(".\n"); return; }
      var d = s.slice(0, i).replace(/\/+$/, "");
      io.out((d === "" ? "/" : d) + "\n");
    });
    return 0;
  };
  SP.canonico = function (p, modo) { // modo: f (último pode faltar), e (tudo existe), m (nada precisa existir)
    var abs = p[0] === "/" ? p : this.cwd + "/" + p;
    var partes = abs.split("/").filter(function (x) { return x && x !== "."; }), atual = [], self = this, saltos = 0;
    for (var i = 0; i < partes.length; i++) {
      var x = partes[i];
      if (x === "..") { atual.pop(); continue; }
      var cand = "/" + atual.concat([x]).join("/");
      var r = this.resolver(cand, false);
      if (r.no && r.no.t === "l") {
        if (++saltos > 40) return null;
        var alvo = r.no.alvo[0] === "/" ? r.no.alvo : "/" + atual.join("/") + "/" + r.no.alvo;
        var novas = alvo.split("/").filter(function (y) { return y && y !== "."; });
        partes = novas.concat(partes.slice(i + 1)); i = -1; atual = [];
        continue;
      }
      if (!r.no) {
        if (modo === "e") return null;
        if (modo === "f" && i < partes.length - 1) return null;
      } else if (r.no.t !== "d" && i < partes.length - 1 && modo !== "m") return null;
      atual.push(x);
    }
    return "/" + atual.join("/");
  };
  EXT.realpath = function* (args, io) {
    var g = getopt(args, "", { "canonicalize-existing": "e", "canonicalize-missing": "m", "no-symlinks": "s", strip: "s", "relative-to": "rel=", quiet: "q" }, { validas: "emsqLPz" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (!g.ops.length) return io.tente("falta operando");
    var st = 0, sh = io.sh;
    g.ops.forEach(function (p) {
      var r = g.o.s ? normalizar(p[0] === "/" ? p : sh.cwd + "/" + p) : sh.canonico(p, g.o.e ? "e" : g.o.m ? "m" : "f");
      if (r === null) { if (!g.o.q) io.msg(p + ": Arquivo ou diretório inexistente"); st = 1; return; }
      if (g.o.rel) { var base = sh.canonico(g.o.rel, "m"); r = relativo(base, r); }
      io.out(r + "\n");
    });
    return st;
  };
  function relativo(de, para) {
    var a = de.split("/").filter(Boolean), b = para.split("/").filter(Boolean), i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    var r = repete("../", a.length - i) + b.slice(i).join("/");
    return r.replace(/\/$/, "") || ".";
  }
  EXT.readlink = function* (args, io) {
    var g = getopt(args, "", { canonicalize: "f", "canonicalize-existing": "e", "canonicalize-missing": "m", "no-newline": "n", verbose: "v" }, { validas: "femnqsvz" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (!g.ops.length) return io.tente("falta operando");
    var st = 0, sh = io.sh;
    g.ops.forEach(function (p) {
      if (g.o.f || g.o.e || g.o.m) { var r = sh.canonico(p, g.o.e ? "e" : g.o.m ? "m" : "f"); if (r === null) { st = 1; return; } io.out(r + (g.o.n ? "" : "\n")); return; }
      var x = sh.resolver(p, false);
      if (!x.no || x.no.t !== "l") { if (g.o.v) io.msg(p + ": Argumento inválido"); st = 1; return; }
      io.out(x.no.alvo + (g.o.n ? "" : "\n"));
    });
    return st;
  };
  EXT.mktemp = function* (args, io) {
    var g = getopt(args, "p", { directory: "d", tmpdir: "p?=", dry: "u", quiet: "q", suffix: "suffix=" }, { validas: "dpuqt" });
    if (g.erro) return io.erroOpcao(g.erro);
    var sh = io.sh, tpl = g.ops[0] || "tmp.XXXXXXXXXX";
    var dir = g.o.p !== undefined ? (g.o.p === true ? (sh.valor("TMPDIR") || "/tmp") : g.o.p) : (g.ops[0] && !g.o.t ? "" : (sh.valor("TMPDIR") || "/tmp"));
    var m = /X{3,}/.exec(tpl);
    if (!m || !/X{3,}[^\/]*$/.test(tpl)) { io.msg("modelo " + qa(tpl) + " tem poucos X"); return 1; }
    var CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", rnd = "";
    for (var i = 0; i < m[0].length; i++) rnd += CH[Math.floor(Math.random() * CH.length)];
    var nome = tpl.slice(0, m.index) + rnd + tpl.slice(m.index + m[0].length) + (g.o.suffix || "");
    var cam = dir ? dir.replace(/\/$/, "") + "/" + nome : nome;
    if (!g.o.u) {
      var p = sh.paiDe(cam);
      if (!p.pai || p.pai.t !== "d") { io.msg("falha ao criar " + (g.o.d ? "diretório" : "arquivo") + " via modelo " + qa(cam.replace(rnd, m[0])) + ": Arquivo ou diretório inexistente"); return 1; }
      p.pai.c[p.nome] = g.o.d ? mkD(UID, 448, sh.k.clock) : mkF(UID, 384, "", sh.k.clock);
    }
    io.out(cam + "\n");
    return 0;
  };

  /* ---------- stat / du / df / file / which ---------- */
  function tipoArqStat(no) { return no.t === "d" ? "directory" : no.t === "l" ? "symbolic link" : no.t === "c" ? "character special file" : (tamanho(no) === 0 ? "regular empty file" : "regular file"); }
  function dataCompleta(ms) { var t = tm(ms); return t.Y + "-" + dois(t.M + 1) + "-" + dois(t.D) + " " + dois(t.h) + ":" + dois(t.m) + ":" + dois(t.s) + ".000000000 -0300"; }
  EXT.stat = function* (args, io) {
    var g = getopt(args, "cf", { format: "c=", printf: "printf=", dereference: "L", terse: "t", "file-system": "f" }, { validas: "cLtf" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (!g.ops.length) return io.tente("falta operando");
    var sh = io.sh, st = 0;
    g.ops.forEach(function (p) {
      var r = sh.resolver(p, !!g.o.L);
      if (!r.no) { io.msg("não foi possível obter statx de " + qn(p) + ": " + errMsg(r.err || "ENOENT")); st = 1; return; }
      var no = r.no, fmt = g.o.c !== undefined ? g.o.c + "\n" : g.o.printf;
      var tam = tamanho(no), blk = blocos(no) * 2;
      if (fmt !== undefined) {
        io.out(fmt.replace(/%([%nNsaAUGugyYxXzZwWFhibBoditT])/g, function (m, c) {
          switch (c) {
            case "%": return "%"; case "n": return p; case "N": return no.t === "l" ? qn(p) + " -> " + qn(no.alvo) : qn(p);
            case "s": return String(tam); case "a": return (no.m & 4095).toString(8); case "A": return modoStr(no);
            case "U": return USUARIOS[no.u] || String(no.u); case "G": return GRUPOS[no.g] || String(no.g); case "u": return String(no.u); case "g": return String(no.g);
            case "y": return dataCompleta(no.mt); case "Y": return String(Math.floor(no.mt / 1000));
            case "x": return dataCompleta(no.at || no.mt); case "X": return String(Math.floor((no.at || no.mt) / 1000));
            case "z": return dataCompleta(no.ct || no.mt); case "Z": return String(Math.floor((no.ct || no.mt) / 1000));
            case "w": return dataCompleta(no.ct || no.mt); case "W": return String(Math.floor((no.ct || no.mt) / 1000));
            case "F": return tipoArqStat(no); case "h": return String(contarLinks(no)); case "i": return String(no.ino);
            case "b": return String(blk); case "B": return "512"; case "o": return "4096"; case "d": return "2050"; case "D": return "802"; case "t": return "0"; case "T": return "0";
          }
          return m;
        }).replace(/\\n/g, "\n").replace(/\\t/g, "\t"));
        return;
      }
      var nomeTxt = no.t === "l" ? qn(p) + " -> " + qn(no.alvo) : p;
      io.out("  Arquivo: " + nomeTxt + "\n" +
        "    Tamanho: " + pad(tam, 10, true) + "\tBlocos: " + pad(blk, 10, true) + " bloco de E/S: " + pad(4096, 6, true) + " " + tipoArqStat(no) + "\n" +
        "Dispositivo: 8,2\tInode: " + pad(no.ino, 11, true) + " Ligações: " + contarLinks(no) + "\n" +
        "Acesso: (" + ("0000" + (no.m & 4095).toString(8)).slice(-4) + "/" + modoStr(no) + ")  Uid: (" + pad(no.u, 5) + "/" + pad(USUARIOS[no.u] || no.u, 8) + ")   Gid: (" + pad(no.g, 5) + "/" + pad(GRUPOS[no.g] || no.g, 8) + ")\n" +
        "Acesso: " + dataCompleta(no.at || no.mt) + "\n" +
        "Modificação: " + dataCompleta(no.mt) + "\n" +
        "  Alteração: " + dataCompleta(no.ct || no.mt) + "\n" +
        "    Criação: " + dataCompleta(no.ct || no.mt) + "\n");
    });
    return st;
  };
  EXT.du = function* (args, io) {
    var a = args.slice(); for (var i = 1; i < a.length; i++) if (a[i] === "--max-depth" && a[i + 1]) { a.splice(i, 2, "-d" + a[i + 1]); } else if (/^--max-depth=/.test(a[i])) a[i] = "-d" + a[i].split("=")[1];
    var g = getopt(a, "dB", { summarize: "s", "human-readable": "h", all: "a", total: "c", "apparent-size": "A", si: "si", bytes: "b" }, { validas: "shacdkmxLB" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o, sh = io.sh, st = 0, total = 0, out = "";
    var maxD = o.s ? 0 : (o.d !== undefined ? +o.d : Infinity);
    function fmt(k) { if (o.b) return String(k); if (o.h) return k === 0 ? "0" : humano(k * 1024); if (o.m) return String(Math.ceil(k / 1024)); return String(k); }
    function anda(no, rot, prof) {
      var t = blocos(no);
      if (o.A || o.b) t = o.b ? tamanho(no) : Math.ceil(tamanho(no) / 1024);
      if (no.t === "d") {
        if (!sh.pode(no, 4)) { io.msg("não foi possível ler o diretório " + q1(rot) + ": Permissão negada"); st = 1; }
        else listarDir(no).forEach(function (n) {
          var f = no.c[n], c = rot.replace(/\/$/, "") + "/" + n;
          if (f.t === "d") t += anda(f, c, prof + 1);
          else { var ft = o.A || o.b ? (o.b ? tamanho(f) : Math.ceil(tamanho(f) / 1024)) : blocos(f); t += ft; if (o.a && prof + 1 <= maxD) out += fmt(ft) + "\t" + c + "\n"; }
        });
      }
      if (prof <= maxD || (no.t !== "d" && prof === 0)) out += fmt(t) + "\t" + rot + "\n";
      return t;
    }
    (g.ops.length ? g.ops : ["."]).forEach(function (p) {
      var r = sh.resolver(p, true);
      if (!r.no) { io.msg("não foi possível acessar " + q1(p) + ": " + errMsg(r.err || "ENOENT")); st = 1; return; }
      total += anda(r.no, p, 0);
    });
    if (o.c) out += fmt(total) + "\ttotal\n";
    io.out(out);
    return st;
  };
  EXT.df = function* (args, io) {
    var h = args.some(function (x) { return /^-[a-zA-Z]*h/.test(x); }), T = args.some(function (x) { return /^-[a-zA-Z]*T/.test(x); });
    var ops = args.slice(1).filter(function (x) { return x[0] !== "-"; }), sh = io.sh;
    var linhas = [["/dev/sda2", "ext4", 478512880, 297974896, 156157416, "66%", "/"], ["tmpfs", "tmpfs", 7871564, 0, 7871564, "0%", "/dev"], ["tmpfs", "tmpfs", 1574316, 3300, 1571016, "1%", "/run"], ["/dev/sda1", "vfat", 1098628, 6452, 1092176, "1%", "/boot/efi"], ["tmpfs", "tmpfs", 7871564, 0, 7871564, "0%", "/tmp"]];
    var st = 0;
    if (ops.length) {
      var sel = [];
      ops.forEach(function (p) { var r = sh.resolver(p, true); if (!r.no) { io.msg(p + ": Arquivo ou diretório inexistente"); st = 1; return; } var c = r.caminho; sel.push(c.indexOf("/tmp") === 0 ? linhas[4] : c.indexOf("/boot/efi") === 0 ? linhas[3] : c.indexOf("/run") === 0 ? linhas[2] : linhas[0]); });
      linhas = sel;
    }
    if (!linhas.length) return st;
    var cab = h ? ["Sist. Arq.", "Tipo", "Tam.", "Usado", "Disp.", "Uso%", "Montado em"] : ["Sist. Arq.", "Tipo", "Blocos de 1K", "Usado", "Disponível", "Uso%", "Montado em"];
    var tab = linhas.map(function (l) { return [l[0], l[1], h ? humano(l[2] * 1024) : String(l[2]), h ? (l[3] ? humano(l[3] * 1024) : "0") : String(l[3]), h ? humano(l[4] * 1024) : String(l[4]), l[5], l[6]]; });
    if (!T) { cab.splice(1, 1); tab.forEach(function (r) { r.splice(1, 1); }); }
    var all = [cab].concat(tab), w = [];
    all.forEach(function (r) { r.forEach(function (c, i) { w[i] = Math.max(w[i] || 0, largura(c)); }); });
    io.out(all.map(function (r) { return r.map(function (c, i) { return i === 0 || (T && i === 1) ? pad(c, w[i], true) : (i === r.length - 1 ? c : pad(c, w[i])); }).join(" "); }).join("\n") + "\n");
    return st;
  };
  function descreverArquivo(sh, p) {
    var r = sh.resolver(p, false);
    if (!r.no) return "cannot open `" + p + "' (No such file or directory)";
    var no = r.no;
    if (no.t === "l") return "symbolic link to " + no.alvo;
    if (no.t === "d") return "directory";
    if (no.t === "c") return "character special (1/3)";
    if (no.d === null) return "data";
    var d = no.d;
    if (d === "") return "empty";
    var exec = no.m & 73 ? " executable" : "";
    var ascii = /^[\x00-\x7f]*$/.test(d) ? "ASCII text" : "Unicode text, UTF-8 text";
    if (/^#!/.test(d)) {
      var l1 = d.split("\n")[0];
      if (/\b(bash)\b/.test(l1)) return "Bourne-Again shell script, " + ascii + exec;
      if (/\b(sh|dash)\b/.test(l1)) return "POSIX shell script, " + ascii + exec;
      if (/python/.test(l1)) return "Python script, " + ascii + exec;
      return "a " + l1.slice(2).trim() + " script, " + ascii + exec;
    }
    if (/^\s*<(!doctype html|html|head|body)/i.test(d)) return "HTML document, " + ascii + exec;
    if (/\.csv$/.test(p) && /,/.test(d)) return "CSV " + ascii + exec;
    if (/\0/.test(d)) return "data";
    var longa = d.split("\n").some(function (l) { return l.length > 300; });
    return ascii + (longa ? ", with very long lines" : "") + (/\r\n/.test(d) ? ", with CRLF line terminators" : "") + (!/\n$/.test(d) ? ", with no line terminators" : "") + exec;
  }
  EXT.file = function* (args, io) {
    var g = getopt(args, "", { brief: "b", "mime-type": "i", "mime": "i" }, { validas: "bLiz" });
    if (g.erro) return io.erroOpcao(g.erro);
    if (!g.ops.length) { io.err("Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n"); return 1; }
    var w = 0; g.ops.forEach(function (p) { w = Math.max(w, largura(p) + 1); });
    g.ops.forEach(function (p) {
      var d = descreverArquivo(io.sh, p);
      if (g.o.i) { d = /directory/.test(d) ? "inode/directory" : /empty/.test(d) ? "inode/x-empty" : /shell script/.test(d) ? "text/x-shellscript" : /HTML/.test(d) ? "text/html" : /CSV/.test(d) ? "text/csv" : /text/.test(d) ? "text/plain" : /cannot open/.test(d) ? d : "application/octet-stream"; }
      io.out(g.o.b ? d + "\n" : pad(p + ":", w + (g.ops.length > 1 ? 0 : 0), true) + " " + d + "\n");
    });
    return 0;
  };
  EXT.which = function* (args, io) {
    var todos = args[1] === "-a", ops = args.slice(todos ? 2 : 1), sh = io.sh, st = 0;
    ops.forEach(function (n) {
      if (n.indexOf("/") >= 0) { var r = sh.resolver(n, true); if (r.no && r.no.t === "f" && sh.pode(r.no, 1)) io.out(n + "\n"); else st = 1; return; }
      var path = (sh.valor("PATH") || "").split(":"), achou = false;
      for (var i = 0; i < path.length; i++) { var c = (path[i] || ".") + "/" + n, r2 = sh.resolver(c, true); if (r2.no && r2.no.t === "f" && sh.pode(r2.no, 1)) { io.out(c + "\n"); achou = true; if (!todos) break; } }
      if (!achou) st = 1;
    });
    return st;
  };
  EXT.whereis = function* (args, io) { args.slice(1).forEach(function (n) { var p = io.sh.acharNoPath(n); io.out(n + ":" + (p ? " " + p : "") + "\n"); }); return 0; };

  /* ---------- processos ---------- */
  SP.listaProcessos = function (extra) {
    var k = this.k, l = k.sistema.map(function (p) { return { pid: p.pid, ppid: p.ppid, u: p.u, tty: p.tty, cmd: p.cmd, comm: p.comm, stat: p.stat, start: p.start }; });
    if (!k.acharProc(3001)) l.push({ pid: 3001, ppid: 2950, u: UID, tty: "pts/0", cmd: "bash", comm: "bash", stat: "Ss", start: "10:10" });
    k.procs.forEach(function (p) { if (p.done) return; l.push({ pid: p.pid, ppid: p.pid === 3001 ? 2950 : (p.ppid === 1 ? 3001 : p.ppid), u: UID, tty: "pts/0", cmd: p.cmdline || p.nome, comm: p.nome, stat: p.pid === 3001 ? "Ss" : (p.state === "sleep" ? "S" : "S+"), start: "10:30" }); });
    if (extra) l.push(extra);
    var vistos = {};
    l = l.filter(function (p) { if (vistos[p.pid]) return false; vistos[p.pid] = 1; return true; });
    l.sort(function (a, b) { return a.pid - b.pid; });
    return l;
  };
  EXT.ps = function* (args, io) {
    var sh = io.sh, a = args.slice(1), meu = { pid: sh.k.nextPid++, ppid: sh.proc ? sh.proc.pid : 3001, u: UID, tty: "pts/0", cmd: args.join(" "), comm: "ps", stat: "R+", start: "10:30" };
    var todos = sh.listaProcessos(meu);
    var bsd = a.length && /^[a-z]+$/.test(a[0]) && a[0] !== "--";
    var o = {}, pids = null, colunas = null, sortKey = null, user = null, cmdName = null;
    for (var i = 0; i < a.length; i++) {
      var x = a[i];
      if (x === "-p" || x === "--pid" || x === "p") { pids = String(a[++i]).split(/[,\s]+/).map(Number); continue; }
      if (/^-p\d/.test(x)) { pids = x.slice(2).split(",").map(Number); continue; }
      if (x === "-o" || x === "o" || x === "--format") { colunas = (colunas ? colunas + "," : "") + a[++i]; continue; }
      if (/^-o./.test(x)) { colunas = x.slice(2); continue; }
      if (x === "-u" || x === "-U" || x === "--user") { user = a[++i]; continue; }
      if (x === "-C") { cmdName = a[++i]; continue; }
      if (/^--sort=/.test(x)) { sortKey = x.slice(7); continue; }
      if (x === "--sort") { sortKey = a[++i]; continue; }
      if (x === "--forest") { o.forest = true; continue; }
      if (x === "--no-headers") { o.semCab = true; continue; }
      var letras = x.replace(/^-/, "");
      letras.split("").forEach(function (c) { o[(x[0] === "-" ? "-" : "") + c] = true; });
    }
    var lista = todos;
    var tudo = o.a && o.x || o["-e"] || o["-A"] || o.x;
    if (!tudo && !pids && !user && !cmdName) lista = todos.filter(function (p) { return p.tty === "pts/0" && (p.pid === 3001 || p.pid >= 3001); });
    if (o.x && !o.a) lista = todos.filter(function (p) { return p.u === UID; });
    if (pids) lista = todos.filter(function (p) { return pids.indexOf(p.pid) >= 0; });
    if (user) lista = todos.filter(function (p) { return (USUARIOS[p.u] || String(p.u)) === user || String(p.u) === user; });
    if (cmdName) lista = todos.filter(function (p) { return p.comm === cmdName; });
    function tempo() { return "00:00:00"; }
    var cols;
    if (colunas) cols = colunas.split(/[,\s]+/).filter(Boolean);
    else if (o.u || (bsd && o.a && o.u)) cols = ["user", "pid", "%cpu", "%mem", "vsz", "rss", "tty", "stat", "start", "time", "command"];
    else if (o["-f"]) cols = ["uid", "pid", "ppid", "c", "stime", "tty", "time", "cmd"];
    else if (o.a && o.x || o.x) cols = ["pid", "tty", "stat", "time", "command"];
    else cols = ["pid", "tty", "time", "cmd"];
    var CAB = { pid: "PID", ppid: "PPID", tty: "TTY", time: "TIME", cmd: "CMD", command: "COMMAND", comm: "COMMAND", user: "USER", uid: "UID", "%cpu": "%CPU", "%mem": "%MEM", vsz: "VSZ", rss: "RSS", stat: "STAT", start: "START", stime: "STIME", c: "C", args: "COMMAND", etime: "ELAPSED", ni: "NI", pri: "PRI" };
    var DIR = { pid: 1, ppid: 1, "%cpu": 1, "%mem": 1, vsz: 1, rss: 1, c: 1, etime: 1, ni: 1, pri: 1, time: 1 };
    var LARG = { pid: 7, ppid: 7, tty: 8, time: o.u ? 6 : 8, user: 8, uid: 8, "%cpu": 4, "%mem": 4, vsz: 6, rss: 5, stat: 4, start: 5, c: 2, stime: 5 };
    var nomeCols = cols.map(function (c) { var m = /^([^=]+)(?:=(.*))?$/.exec(c); return { k: m[1].toLowerCase(), cab: m[2] !== undefined ? m[2] : (CAB[m[1].toLowerCase()] || m[1].toUpperCase()) }; });
    function val(p, k) {
      switch (k) {
        case "pid": return String(p.pid); case "ppid": return String(p.ppid); case "tty": return p.tty; case "time": return o.u ? "0:00" : tempo();
        case "cmd": return o["-f"] ? p.cmd : p.comm; case "comm": return p.comm; case "command": case "args": return p.cmd;
        case "user": return USUARIOS[p.u] || String(p.u); case "uid": return o["-f"] ? (USUARIOS[p.u] || String(p.u)) : String(p.u);
        case "%cpu": return p.pid === 2210 ? "5.4" : p.pid === 1534 ? "3.1" : "0.0"; case "%mem": return p.pid === 2210 ? "6.8" : p.pid === 1534 ? "4.2" : "0.1";
        case "vsz": return String(p.pid === 2210 ? 3254120 : p.pid === 1534 ? 4381236 : 12000 + p.pid % 7000); case "rss": return String(p.pid === 2210 ? 412300 : p.pid === 1534 ? 289400 : 5000 + p.pid % 3000);
        case "stat": return p.stat; case "start": case "stime": return p.start; case "c": return "0"; case "etime": return "00:05"; case "ni": return "0"; case "pri": return "19";
      }
      return "-";
    }
    var tab = lista.map(function (p) { return nomeCols.map(function (c) { return val(p, c.k); }); });
    var w = nomeCols.map(function (c, i) { var m = largura(c.cab); tab.forEach(function (r) { m = Math.max(m, largura(r[i])); }); return Math.max(m, LARG[c.k] || 0); });
    function linha(r) { return r.map(function (v, i) { var c = nomeCols[i].k; if (i === r.length - 1) return v; return DIR[c] ? pad(v, w[i]) : pad(v, w[i], true); }).join(" "); }
    var out = (o.semCab || cols.every(function (c) { return /=$/.test(c); }) ? "" : linha(nomeCols.map(function (c) { return c.cab; })) + "\n") + tab.map(linha).join("\n") + (tab.length ? "\n" : "");
    io.out(out);
    return lista.length ? 0 : 1;
  };
  EXT.pgrep = function* (args, io) {
    var g = getopt(args, "uUd", { full: "f", list_name: "l", "list-full": "a", count: "c", exact: "x", "ignore-case": "i", newest: "n", oldest: "o", delimiter: "d=" }, { validas: "flacxinouUdv" });
    if (g.erro) return io.erroOpcao(g.erro);
    var o = g.o, pat = g.ops[0];
    if (pat === undefined && !o.u) { io.msg("nenhum critério de correspondência especificado"); io.err("Tente \"pgrep --help\" para mais informações.\n"); return 2; }
    var re = criarRegex(o.x ? "^(?:" + (pat || "") + ")$" : (pat || ""), o.i ? "i" : "");
    var meuPid = io.sh.proc ? io.sh.proc.pid : 0;
    var l = io.sh.listaProcessos().filter(function (p) { return p.pid !== meuPid && re.test(o.f ? p.cmd : p.comm) && (!o.u || USUARIOS[p.u] === o.u || String(p.u) === o.u) && p.comm !== "pgrep"; });
    if (o.v) { var ids = l.map(function (p) { return p.pid; }); l = io.sh.listaProcessos().filter(function (p) { return ids.indexOf(p.pid) < 0; }); }
    if (o.n) l = l.slice(-1); if (o.o) l = l.slice(0, 1);
    if (o.c) io.out(l.length + "\n");
    else io.out(l.map(function (p) { return p.pid + (o.a ? " " + p.cmd : o.l ? " " + p.comm : ""); }).join(o.d || "\n") + (l.length ? "\n" : ""));
    return l.length ? 0 : 1;
  };
  EXT.pidof = function* (args, io) { var l = io.sh.listaProcessos().filter(function (p) { return args.slice(1).indexOf(p.comm) >= 0; }); if (!l.length) return 1; io.out(l.map(function (p) { return p.pid; }).reverse().join(" ") + "\n"); return 0; };
  function matarPorNome(io, nomes, sig, completo) {
    var sh = io.sh, n = 0;
    sh.listaProcessos().forEach(function (p) {
      if (!nomes(completo ? p.cmd : p.comm)) return;
      if (p.pid === (sh.proc ? sh.proc.pid : -1)) return;
      var sis = sh.k.sistema.filter(function (q) { return q.pid === p.pid; })[0];
      if (sis) { if (sis.u !== UID) return; sh.k.sistema = sh.k.sistema.filter(function (q) { return q !== sis; }); n++; return; }
      if (p.pid === 3001) return;
      if (sh.k.sinal(p.pid, sig)) n++;
    });
    return n;
  }
  EXT.pkill = function* (args, io) {
    var sig = 15, a = args.slice(1), f = false;
    a = a.filter(function (x) { if (/^-[0-9]+$/.test(x) || /^-[A-Z]+$/.test(x)) { sig = sinalNum(x.slice(1)); return false; } if (x === "-f") { f = true; return false; } return true; });
    if (!a.length) { io.msg("nenhum critério de correspondência especificado"); return 2; }
    var re = criarRegex(a[0]);
    return matarPorNome(io, function (n) { return re.test(n); }, sig, f) ? 0 : 1;
  };
  EXT.killall = function* (args, io) {
    var sig = 15, a = args.slice(1).filter(function (x) { if (/^-[0-9A-Z]+$/.test(x)) { sig = sinalNum(x.slice(1)); return false; } return true; });
    var st = 0;
    a.forEach(function (nome) { if (!matarPorNome(io, function (n) { return n === nome; }, sig)) { io.err(nome + ": nenhum processo localizado\n"); st = 1; } });
    return st;
  };
  EXT.kill = function* (args, io) { return yield* BUILTINS.kill.call(io.sh, args); };

  /* ---------- expr ---------- */
  EXT.expr = function* (args, io) {
    var a = args.slice(1), p = 0;
    if (!a.length) return io.tente("falta operando");
    function ErroE(m, cod) { this.m = m; this.cod = cod || 2; }
    function ehInt(s) { return /^[+-]?[0-9]+$/.test(s); }
    function num(s) { if (!ehInt(String(s))) throw new ErroE("argumento não inteiro"); return parseInt(s, 10); }
    function prim() {
      if (p >= a.length) throw new ErroE("erro de sintaxe: faltam argumentos após " + qa(a[p - 1]));
      var t = a[p];
      if (t === "(") { p++; var v = ou(); if (a[p] !== ")") throw new ErroE(p >= a.length ? "erro de sintaxe: esperava ')' após " + qa(a[p - 1]) : "erro de sintaxe: esperava ')' em vez de " + qa(a[p])); p++; return v; }
      if (t === "length") { p++; return String(Array.from(prim()).length); }
      if (t === "substr") { p++; var s = String(prim()), i = num(prim()), n = num(prim()); return i < 1 || n < 1 ? "" : Array.from(s).slice(i - 1, i - 1 + n).join(""); }
      if (t === "index") { p++; var s2 = String(prim()), cs = String(prim()); for (var k = 0; k < s2.length; k++) if (cs.indexOf(s2[k]) >= 0) return String(k + 1); return "0"; }
      if (t === "match") { p++; var s3 = String(prim()), re = String(prim()); return casar(s3, re); }
      if (t === "+") { p++; return a[p++]; }
      p++; return t;
    }
    function casar(s, re) {
      var r = criarRegex("^(?:" + ereParaJs(re, { bre: true }) + ")");
      if (!r) throw new ErroE("expressão regular inválida");
      var m = r.exec(s);
      if (/\\\(/.test(re)) return m && m[1] !== undefined ? m[1] : "";
      return m ? String(Array.from(m[0]).length) : "0";
    }
    function dois_() { var v = prim(); while (a[p] === ":") { p++; v = casar(String(v), String(prim())); } return v; }
    function mult() { var v = dois_(); while (a[p] === "*" || a[p] === "/" || a[p] === "%") { var o = a[p++]; var w = dois_(); var x = num(v), y = num(w); if ((o === "/" || o === "%") && y === 0) throw new ErroE("divisão por zero"); v = String(o === "*" ? x * y : o === "/" ? Math.trunc(x / y) : x % y); } return v; }
    function soma() { var v = mult(); while (a[p] === "+" || a[p] === "-") { var o = a[p++]; var w = mult(); v = String(o === "+" ? num(v) + num(w) : num(v) - num(w)); } return v; }
    function cmp() {
      var v = soma();
      while (["=", "==", "!=", "<", "<=", ">", ">="].indexOf(a[p]) >= 0) {
        var o = a[p++], w = soma(), r;
        var c = ehInt(String(v)) && ehInt(String(w)) ? num(v) - num(w) : collate(String(v), String(w));
        r = o === "=" || o === "==" ? c === 0 : o === "!=" ? c !== 0 : o === "<" ? c < 0 : o === "<=" ? c <= 0 : o === ">" ? c > 0 : c >= 0;
        v = r ? "1" : "0";
      }
      return v;
    }
    function nulo(v) { return v === "" || (ehInt(String(v)) && num(v) === 0); }
    function e_() { var v = cmp(); while (a[p] === "&") { p++; var w = cmp(); v = nulo(v) || nulo(w) ? "0" : v; } return v; }
    function ou() { var v = e_(); while (a[p] === "|") { p++; var w = e_(); v = !nulo(v) ? v : (!nulo(w) ? w : "0"); } return v; }
    try {
      var r = ou();
      if (p < a.length) throw new ErroE("erro de sintaxe: argumento inesperado " + qa(a[p]));
      r = String(r);
      if (ehInt(r)) r = String(parseInt(r, 10));
      io.out(r + "\n");
      return nulo(r) ? 1 : 0;
    } catch (e) { if (e instanceof ErroE) { io.msg(e.m); return e.cod; } throw e; }
  };

  /* ---------- bc (decimais de precisão arbitrária) ---------- */
  function Dec(v, s) { this.v = v; this.s = s; } // valor = v / 10^s
  var B10 = HAS_BIG ? BigInt(10) : 10;
  function pot10(n) { if (!HAS_BIG) return Math.pow(10, n); var r = BigInt(1), dez = BigInt(10); for (var i = 0; i < n; i++) r *= dez; return r; }
  function decEscala(d, s) { if (s === d.s) return d; if (s > d.s) return new Dec(d.v * pot10(s - d.s), s); return new Dec(d.v / pot10(d.s - s), s); }
  function decDe(txt) { txt = txt.toUpperCase(); var neg = txt[0] === "-"; if (neg) txt = txt.slice(1); var i = txt.indexOf("."), s = i < 0 ? 0 : txt.length - i - 1; var dig = (txt.replace(".", "") || "0"); var v = BigInt(dig); return new Dec(neg ? -v : v, s); }
  function decStr(d, obase) {
    var neg = d.v < 0, v = neg ? -d.v : d.v;
    if (obase && obase !== 10) {
      var ip = v / pot10(d.s), r = ip.toString(obase).toUpperCase();
      if (obase > 16) r = ip.toString(10);
      return (neg ? "-" : "") + r;
    }
    var s = v.toString();
    if (d.s > 0) { while (s.length <= d.s) s = "0" + s; s = s.slice(0, s.length - d.s) + "." + s.slice(s.length - d.s); if (s[0] === "0") s = s.slice(1); }
    if (s === "" ) s = "0";
    if (neg && /[1-9]/.test(s)) s = "-" + s;
    // quebra de linha a cada 70 caracteres (com \)
    if (s.length > 70) { var partes = []; while (s.length > 69) { partes.push(s.slice(0, 69) + "\\"); s = s.slice(69); } partes.push(s); s = partes.join("\n"); }
    return s;
  }
  function BcErr(m) { this.m = m; }
  function Bc(io) { this.io = io; this.vars = {}; this.arr = {}; this.funcs = {}; this.scale = 0; this.ibase = 10; this.obase = 10; this.saida = ""; this.lastV = new Dec(HAS_BIG ? BigInt(0) : 0, 0); }
  Bc.prototype.tokens = function (src) {
    var t = [], i = 0, m;
    while (i < src.length) {
      var c = src[i];
      if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (src.substr(i, 2) === "/*") { var f = src.indexOf("*/", i + 2); i = f < 0 ? src.length : f + 2; continue; }
      if (c === "\n" || c === ";") { t.push({ t: "sep", v: c }); i++; continue; }
      if ((m = /^[0-9A-F]+(\.[0-9A-F]*)?|^\.[0-9A-F]+/.exec(src.slice(i)))) { t.push({ t: "num", v: m[0] }); i += m[0].length; continue; }
      if ((m = /^[a-z][a-z0-9_]*/.exec(src.slice(i)))) { t.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
      if (c === '"') { var f2 = src.indexOf('"', i + 1); t.push({ t: "str", v: src.slice(i + 1, f2 < 0 ? src.length : f2) }); i = f2 < 0 ? src.length : f2 + 1; continue; }
      if ((m = /^(\+\+|--|<=|>=|==|!=|&&|\|\||\^=|\*=|\/=|%=|\+=|-=|[-+*\/%^=<>!(){}\[\],])/.exec(src.slice(i)))) { t.push({ t: "op", v: m[0] }); i += m[0].length; continue; }
      throw new BcErr("(standard_in) 1: illegal character: " + c);
    }
    t.push({ t: "eof" });
    return t;
  };
  Bc.prototype.rodar = function (src) {
    this.t = this.tokens(src); this.p = 0;
    var self = this;
    while (this.t[this.p].t !== "eof") {
      if (this.t[this.p].t === "sep") { this.p++; continue; }
      var st = this.stmt();
      this.exec(st, true);
    }
  };
  Bc.prototype.peek = function () { return this.t[this.p]; };
  Bc.prototype.next = function () { return this.t[this.p++]; };
  Bc.prototype.espera = function (v) { var t = this.next(); if (t.v !== v) throw new BcErr("(standard_in) 1: syntax error"); };
  Bc.prototype.stmt = function () {
    var t = this.peek();
    if (t.t === "op" && t.v === "{") { this.next(); var l = []; while (!(this.peek().t === "op" && this.peek().v === "}")) { if (this.peek().t === "sep") { this.next(); continue; } if (this.peek().t === "eof") throw new BcErr("(standard_in) 1: syntax error"); l.push(this.stmt()); } this.next(); return { k: "bloco", l: l }; }
    if (t.t === "id") {
      if (t.v === "quit") { this.next(); return { k: "quit" }; }
      if (t.v === "print") { this.next(); var itens = [this.peek().t === "str" ? { s: this.next().v } : { e: this.expr() }]; while (this.peek().v === ",") { this.next(); itens.push(this.peek().t === "str" ? { s: this.next().v } : { e: this.expr() }); } return { k: "print", itens: itens }; }
      if (t.v === "if") { this.next(); this.espera("("); var c = this.expr(); this.espera(")"); while (this.peek().t === "sep" && this.peek().v === "\n") this.next(); var s1 = this.stmt(), s2 = null; var sv = this.p; while (this.peek().t === "sep") this.next(); if (this.peek().v === "else") { this.next(); while (this.peek().t === "sep" && this.peek().v === "\n") this.next(); s2 = this.stmt(); } else this.p = sv; return { k: "if", c: c, s1: s1, s2: s2 }; }
      if (t.v === "while") { this.next(); this.espera("("); var c2 = this.expr(); this.espera(")"); while (this.peek().t === "sep" && this.peek().v === "\n") this.next(); return { k: "while", c: c2, s: this.stmt() }; }
      if (t.v === "for") { this.next(); this.espera("("); var a = this.peek().v === ";" ? null : this.expr(); this.espera(";"); var b = this.peek().v === ";" ? null : this.expr(); this.espera(";"); var c3 = this.peek().v === ")" ? null : this.expr(); this.espera(")"); while (this.peek().t === "sep" && this.peek().v === "\n") this.next(); return { k: "for", a: a, b: b, c: c3, s: this.stmt() }; }
      if (t.v === "break") { this.next(); return { k: "break" }; }
      if (t.v === "return") { this.next(); var e = null; if (this.peek().v === "(") { this.next(); e = this.peek().v === ")" ? null : this.expr(); this.espera(")"); } return { k: "return", e: e }; }
      if (t.v === "define") {
        this.next(); var nome = this.next().v; this.espera("("); var params = [];
        while (this.peek().v !== ")") { params.push(this.next().v); if (this.peek().v === ",") this.next(); }
        this.next(); while (this.peek().t === "sep") this.next();
        this.espera("{"); var corpo = [], autos = [];
        while (this.peek().v !== "}") { if (this.peek().t === "sep") { this.next(); continue; } if (this.peek().v === "auto") { this.next(); while (this.peek().t === "id") { autos.push(this.next().v); if (this.peek().v === ",") this.next(); } continue; } corpo.push(this.stmt()); }
        this.next();
        this.funcs[nome] = { params: params, corpo: corpo, autos: autos };
        return { k: "nada" };
      }
    }
    if (t.t === "str") { this.next(); return { k: "str", s: t.v }; }
    return { k: "expr", e: this.expr() };
  };
  Bc.prototype.expr = function () { return this.atrib(); };
  Bc.prototype.atrib = function () {
    var t = this.peek(), t2 = this.t[this.p + 1];
    if (t.t === "id" && t2 && t2.t === "op" && /^[-+*\/%^]?=$/.test(t2.v) && t2.v !== "==") { this.p += 2; return { k: "atr", n: t.v, op: t2.v, e: this.atrib() }; }
    if (t.t === "id" && t2 && t2.v === "[") {
      var sv = this.p; this.p += 2; var idx = this.expr(); this.espera("]");
      var t3 = this.peek();
      if (t3.t === "op" && /^[-+*\/%^]?=$/.test(t3.v) && t3.v !== "==") { this.next(); return { k: "atr", n: t.v, idx: idx, op: t3.v, e: this.atrib() }; }
      this.p = sv;
    }
    return this.ou();
  };
  Bc.prototype.bin = function (ops, prox) { var self = this; return function () { var a = prox.call(self); while (self.peek().t === "op" && ops.indexOf(self.peek().v) >= 0) { var o = self.next().v; a = { k: "bin", o: o, a: a, b: prox.call(self) }; } return a; }; };
  Bc.prototype.ou = function () { return this.bin(["||"], this.e_)(); };
  Bc.prototype.e_ = function () { return this.bin(["&&"], this.nao)(); };
  Bc.prototype.nao = function () { if (this.peek().v === "!") { this.next(); return { k: "not", a: this.nao() }; } return this.rel(); };
  Bc.prototype.rel = function () { return this.bin(["<", ">", "<=", ">=", "==", "!="], this.soma)(); };
  Bc.prototype.soma = function () { return this.bin(["+", "-"], this.mult)(); };
  Bc.prototype.mult = function () { return this.bin(["*", "/", "%"], this.pot)(); };
  Bc.prototype.pot = function () { var a = this.un(); if (this.peek().v === "^") { this.next(); return { k: "bin", o: "^", a: a, b: this.pot() }; } return a; };
  Bc.prototype.un = function () {
    var t = this.peek();
    if (t.v === "-") { this.next(); return { k: "neg", a: this.un() }; }
    if (t.v === "++" || t.v === "--") { this.next(); var n = this.next(); return { k: "pre", o: t.v, n: n.v }; }
    return this.post();
  };
  Bc.prototype.post = function () {
    var t = this.next();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.v === "(") { var e = this.expr(); this.espera(")"); return e; }
    if (t.t === "id") {
      if (t.v === "scale" || t.v === "ibase" || t.v === "obase" || t.v === "last") { if (this.peek().v === "(") { this.next(); var ee = this.expr(); this.espera(")"); return { k: "fscale", a: ee }; } return { k: "var", n: t.v }; }
      if (t.v === "sqrt" || t.v === "length" || (this.peek().v === "(")) {
        this.espera("("); var args = []; while (this.peek().v !== ")") { args.push(this.expr()); if (this.peek().v === ",") this.next(); } this.next();
        return { k: "call", n: t.v, args: args };
      }
      if (this.peek().v === "[") { this.next(); var idx = this.expr(); this.espera("]"); return { k: "idx", n: t.v, idx: idx }; }
      if (this.peek().v === "++" || this.peek().v === "--") { var o = this.next().v; return { k: "post", o: o, n: t.v }; }
      return { k: "var", n: t.v };
    }
    throw new BcErr("(standard_in) 1: syntax error");
  };
  Bc.prototype.num = function (txt) {
    if (this.ibase === 10 || txt.length === 1) return decDe(txt);
    var i = txt.indexOf("."), ip = i < 0 ? txt : txt.slice(0, i), v = BigInt(0);
    for (var k = 0; k < ip.length; k++) v = v * BigInt(this.ibase) + BigInt(parseInt(ip[k], 16));
    return new Dec(v, 0);
  };
  Bc.prototype.ev = function (e) {
    var self = this, Z = BigInt(0);
    switch (e.k) {
      case "num": return this.num(e.v);
      case "var": if (e.n === "scale") return new Dec(BigInt(this.scale), 0); if (e.n === "ibase") return new Dec(BigInt(this.ibase), 0); if (e.n === "obase") return new Dec(BigInt(this.obase), 0); if (e.n === "last") return this.lastV; return this.vars[e.n] || new Dec(Z, 0);
      case "idx": var ia = Number(decEscala(this.ev(e.idx), 0).v); return (this.arr[e.n] || {})[ia] || new Dec(Z, 0);
      case "neg": var x = this.ev(e.a); return new Dec(-x.v, x.s);
      case "not": return new Dec(this.ev(e.a).v === Z ? BigInt(1) : Z, 0);
      case "atr": {
        var v = this.ev(e.e);
        if (e.op !== "=") { var atual = this.ev(e.idx ? { k: "idx", n: e.n, idx: e.idx } : { k: "var", n: e.n }); v = this.op(e.op[0], atual, v); }
        if (e.n === "scale") { this.scale = Number(decEscala(v, 0).v); return v; }
        if (e.n === "ibase") { this.ibase = Number(decEscala(v, 0).v); return v; }
        if (e.n === "obase") { this.obase = Number(decEscala(v, 0).v); return v; }
        if (e.idx) { var ix = Number(decEscala(this.ev(e.idx), 0).v); (this.arr[e.n] = this.arr[e.n] || {})[ix] = v; }
        else this.vars[e.n] = v;
        return v;
      }
      case "pre": case "post": {
        var cur = this.vars[e.n] || new Dec(Z, 0), novo = this.op(e.o[0], cur, new Dec(BigInt(1), 0));
        this.vars[e.n] = novo; return e.k === "pre" ? novo : cur;
      }
      case "bin":
        if (e.o === "&&") return new Dec(this.ev(e.a).v !== Z && this.ev(e.b).v !== Z ? BigInt(1) : Z, 0);
        if (e.o === "||") return new Dec(this.ev(e.a).v !== Z || this.ev(e.b).v !== Z ? BigInt(1) : Z, 0);
        return this.op(e.o, this.ev(e.a), this.ev(e.b));
      case "fscale": var fx = this.ev(e.a); return new Dec(BigInt(fx.s), 0);
      case "call": {
        if (e.n === "sqrt") { var a = this.ev(e.args[0]); if (a.v < Z) throw new BcErr("Runtime error (func=(main), adr=8): Square root of a negative number"); var sc = Math.max(this.scale, a.s), an = decEscala(a, sc * 2 + 2).v; var r = bigSqrt(an); return decEscala(new Dec(r, sc + 1), sc); }
        if (e.n === "length") { var l = this.ev(e.args[0]); return new Dec(BigInt((l.v < Z ? -l.v : l.v).toString().replace(/^0+(?=\d)/, "").length), 0); }
        var f = this.funcs[e.n];
        if (!f) throw new BcErr("Runtime error (func=(main), adr=0): Function " + e.n + " not defined.");
        var salvo = {}, nomes = f.params.concat(f.autos);
        nomes.forEach(function (n) { salvo[n] = self.vars[n]; });
        f.params.forEach(function (n, i) { self.vars[n] = e.args[i] ? self.ev(e.args[i]) : new Dec(Z, 0); });
        f.autos.forEach(function (n) { self.vars[n] = new Dec(Z, 0); });
        var ret = new Dec(Z, 0);
        try { f.corpo.forEach(function (s) { self.exec(s, false); }); }
        catch (r2) { if (r2 && r2.ret) ret = r2.v; else throw r2; }
        finally { nomes.forEach(function (n) { self.vars[n] = salvo[n]; }); }
        return ret;
      }
    }
    return new Dec(Z, 0);
  };
  function bigSqrt(n) { if (n < BigInt(2)) return n; var x = n, y = (x + BigInt(1)) / BigInt(2); while (y < x) { x = y; y = (x + n / x) / BigInt(2); } return x; }
  Bc.prototype.op = function (o, a, b) {
    var Z = BigInt(0), s;
    switch (o) {
      case "+": case "-": s = Math.max(a.s, b.s); var x = decEscala(a, s).v, y = decEscala(b, s).v; return new Dec(o === "+" ? x + y : x - y, s);
      case "*": var sm = Math.min(a.s + b.s, Math.max(this.scale, a.s, b.s)); return decEscala(new Dec(a.v * b.v, a.s + b.s), sm);
      case "/": if (b.v === Z) throw new BcErr("Runtime error (func=(main), adr=3): Divide by zero"); var sc = this.scale; var num = a.v * pot10(sc + b.s), den = b.v * pot10(a.s); return new Dec(num / den, sc);
      case "%": if (b.v === Z) throw new BcErr("Runtime error (func=(main), adr=6): Modulo by zero"); var sc2 = Math.max(this.scale + b.s, a.s); var q = this.op("/", a, b); var prod = decEscala(new Dec(q.v * b.v, q.s + b.s), Math.max(q.s + b.s, 0)); return decEscala(this.op("-", a, prod), sc2);
      case "^": {
        var e = Number(decEscala(b, 0).v), neg = e < 0; if (neg) e = -e;
        var r = new Dec(BigInt(1), 0), base = a;
        for (var i = 0; i < e; i++) r = new Dec(r.v * base.v, r.s + base.s);
        var esc = neg ? this.scale : Math.min(a.s * e, Math.max(this.scale, a.s));
        r = decEscala(r, Math.max(esc, 0));
        if (neg) return this.op("/", new Dec(BigInt(1), 0), r);
        return r;
      }
      case "<": case ">": case "<=": case ">=": case "==": case "!=": {
        var s2 = Math.max(a.s, b.s), p = decEscala(a, s2).v, q2 = decEscala(b, s2).v;
        var r2 = o === "<" ? p < q2 : o === ">" ? p > q2 : o === "<=" ? p <= q2 : o === ">=" ? p >= q2 : o === "==" ? p === q2 : p !== q2;
        return new Dec(r2 ? BigInt(1) : Z, 0);
      }
    }
    return a;
  };
  Bc.prototype.exec = function (st, topo) {
    var self = this, Z = BigInt(0);
    switch (st.k) {
      case "expr": var v = this.ev(st.e); if (st.e.k !== "atr") { this.saida += decStr(v, this.obase) + "\n"; this.lastV = v; } return;
      case "str": this.saida += st.s.replace(/\\n/g, "\n"); return;
      case "print": st.itens.forEach(function (it) { self.saida += it.s !== undefined ? it.s.replace(/\\n/g, "\n").replace(/\\t/g, "\t") : decStr(self.ev(it.e), self.obase); }); return;
      case "bloco": st.l.forEach(function (s) { self.exec(s, topo); }); return;
      case "if": if (this.ev(st.c).v !== Z) this.exec(st.s1, topo); else if (st.s2) this.exec(st.s2, topo); return;
      case "while": { var n = 0; try { while (this.ev(st.c).v !== Z) { this.exec(st.s, topo); if (++n > 100000) throw new BcErr("(simulador) laço longo demais no bc"); } } catch (e) { if (!(e && e.brk)) throw e; } return; }
      case "for": { if (st.a) this.ev(st.a); var n2 = 0; try { while (!st.b || this.ev(st.b).v !== Z) { this.exec(st.s, topo); if (st.c) this.ev(st.c); if (++n2 > 100000) throw new BcErr("(simulador) laço longo demais no bc"); } } catch (e2) { if (!(e2 && e2.brk)) throw e2; } return; }
      case "break": throw { brk: true };
      case "return": throw { ret: true, v: st.e ? this.ev(st.e) : new Dec(Z, 0) };
      case "quit": throw { quit: true };
    }
  };
  var BC_LIB = "scale=20\ndefine e(x){auto a,b,c,i,n,s,v;s=scale;scale=s+5;n=1;if(x<0){n=-1;x=-x};a=1;b=1;c=1;for(i=1;i<200;i++){a=a*x;b=b*i;v=a/b;if(v==0)break;c=c+v};if(n<0)c=1/c;scale=s;return(c/1)}\ndefine l(x){auto a,b,i,s,y,n;if(x<=0)return(0);s=scale;scale=s+5;n=0;while(x>2){x=sqrt(x);n=n+1};while(x<0.5){x=sqrt(x);n=n+1};y=(x-1)/(x+1);a=y;b=y;for(i=3;i<400;i=i+2){a=a*y*y;if(a/i==0)break;b=b+a/i};b=b*2;for(i=0;i<n;i++)b=b*2;scale=s;return(b/1)}\ndefine s(x){auto a,b,i,s,v;s=scale;scale=s+5;a=x;b=x;for(i=3;i<400;i=i+2){a=-a*x*x/((i-1)*i);if(a==0)break;b=b+a};scale=s;return(b/1)}\ndefine c(x){auto s,v;s=scale;scale=s+5;v=s(x+2*a(1));scale=s;return(v/1)}\ndefine a(x){auto a,b,i,s,n,y;s=scale;scale=s+5;n=0;if(x<0){n=1;x=-x};y=0;while(x>0.2){x=(x)/(1+sqrt(1+x*x));y=y+1};a=x;b=x;for(i=3;i<400;i=i+2){a=-a*x*x;if(a/i==0)break;b=b+a/i};for(i=0;i<y;i++)b=b*2;if(n)b=-b;scale=s;return(b/1)}\n";
  EXT.bc = function* (args, io) {
    var sh = io.sh, lib = false, arqs = [], q = false;
    args.slice(1).forEach(function (a) { if (a === "-l" || a === "--mathlib") lib = true; else if (a === "-q" || a === "--quiet") q = true; else if (/^-/.test(a)) { } else arqs.push(a); });
    var bc = new Bc(io);
    var fontes = [];
    if (lib) fontes.push(BC_LIB);
    for (var i = 0; i < arqs.length; i++) { var r = sh.lerArquivo(arqs[i]); if (r.err) { io.err("File " + arqs[i] + " is unavailable.\n"); return 1; } fontes.push(r.txt); }
    var st = 0, sairCedo = false;
    try { fontes.forEach(function (f) { bc.rodar(f); }); } catch (e) { if (e && e.quit) sairCedo = true; else if (e instanceof BcErr) { io.out(bc.saida); bc.saida = ""; io.err(e.m + "\n"); } else throw e; }
    io.out(bc.saida); bc.saida = "";
    if (sairCedo) return 0;
    var ent = sh.fds[0];
    if (!ent) return 0;
    if (isTTY(ent) && !ent.naoTTY && !arqs.length && !q) io.out("bc 1.08.2\nCopyright 1991-1994, 1997, 1998, 2000, 2004, 2006, 2008, 2012-2017 Free Software Foundation, Inc.\nThis is free software with ABSOLUTELY NO WARRANTY.\nFor details type `warranty'. \n");
    // lê linha a linha (permite uso interativo)
    var pend = "";
    while (true) {
      var l = yield* lerAte(sh.k, ent, "\n", null, {});
      if (!l.achou && l.s === "") break;
      pend += l.s + "\n";
      if (/\\$/.test(l.s) || (pend.split("{").length > pend.split("}").length)) { if (!l.achou) break; continue; }
      try { bc.rodar(pend); }
      catch (e2) {
        if (e2 && e2.quit) { io.out(bc.saida); return 0; }
        if (e2 instanceof BcErr) { io.out(bc.saida); bc.saida = ""; io.err(e2.m + "\n"); st = 0; }
        else throw e2;
      }
      pend = "";
      io.out(bc.saida); bc.saida = "";
      if (!l.achou) break;
    }
    return st;
  };

  /* ---------- outros ---------- */
  EXT.true = function* () { return 0; };
  EXT.false = function* () { return 1; };
  EXT.echo = function* (args, io) { var sh = io.sh; var r = yield* BUILTINS.echo.call(sh, args); return r; };
  EXT.printf = function* (args, io) {
    if (args.length < 2) { io.msg("falta operando"); io.err("Tente \"printf --help\" para mais informações.\n"); return 1; }
    var r = io.sh.printfFormatar(args[1], args.slice(2), "printf");
    io.out(r.s); return r.st;
  };
  EXT.test = function* (args, io) { return yield* BUILTINS.test.call(io.sh, args); };
  EXT["["] = function* (args, io) { return yield* BUILTINS["["].call(io.sh, args); };
  EXT.pwd = function* (args, io) { io.out((args[1] === "-L" ? io.sh.cwdLogico : io.sh.cwd) + "\n"); return 0; };
  EXT.clear = function* (args, io) { if (io.tty()) io.out("\x1b[H\x1b[2J\x1b[3J"); else io.out("\x1b[H\x1b[2J\x1b[3J"); return 0; };
  EXT.reset = EXT.clear;
  EXT.tput = function* (args, io) {
    var sh = io.sh, c = args[1], n = args[2];
    var cores = { setaf: "3", setab: "4" };
    switch (c) {
      case "cols": io.out((sh.valor("COLUMNS") || "80") + "\n"); return 0;
      case "lines": io.out((sh.valor("LINES") || "24") + "\n"); return 0;
      case "colors": io.out("256\n"); return 0;
      case "setaf": case "setab": { var v = parseInt(n || "0", 10); io.out(v < 8 ? "\x1b[" + cores[c] + v + "m" : v < 16 ? "\x1b[" + (c === "setaf" ? 9 : 10) + (v - 8) + "m" : "\x1b[" + (c === "setaf" ? 38 : 48) + ";5;" + v + "m"); return 0; }
      case "sgr0": io.out("\x1b(B\x1b[m"); return 0;
      case "bold": io.out("\x1b[1m"); return 0; case "dim": io.out("\x1b[2m"); return 0; case "rev": io.out("\x1b[7m"); return 0;
      case "smul": io.out("\x1b[4m"); return 0; case "rmul": io.out("\x1b[24m"); return 0; case "smso": io.out("\x1b[7m"); return 0; case "rmso": io.out("\x1b[27m"); return 0;
      case "clear": io.out("\x1b[H\x1b[2J\x1b[3J"); return 0; case "el": io.out("\x1b[K"); return 0;
      case "cup": io.out("\x1b[" + (parseInt(n, 10) + 1) + ";" + (parseInt(args[3] || "0", 10) + 1) + "H"); return 0;
      case "civis": io.out("\x1b[?25l"); return 0; case "cnorm": io.out("\x1b[?12l\x1b[?25h"); return 0; case "bel": io.out("\x07"); return 0;
      case "init": case "reset": return 0;
    }
    if (c === undefined) { io.msg("nenhum tipo de terminal especificado e nenhuma variável de ambiente TERM"); return 2; }
    io.err("tput: código de capacidade desconhecido \"" + c + "\" (simulador)\n");
    return 4;
  };
  EXT.less = function* (args, io) { var st = yield* io.cadaArquivo(args.slice(1).filter(function (a) { return a[0] !== "-" && a[0] !== "+"; }), function (txt) { io.out(txt); }); return st; };
  EXT.more = EXT.less; EXT.most = EXT.less;
  EXT.timeout = function* (args, io) {
    var a = args.slice(1), sig = 15;
    while (a.length && /^-/.test(a[0])) { if (a[0] === "-s") { sig = sinalNum(a[1]); a.splice(0, 2); continue; } if (/^--signal=/.test(a[0])) { sig = sinalNum(a[0].split("=")[1]); a.shift(); continue; } a.shift(); }
    if (a.length < 2) return io.tente("falta operando");
    var m = /^([0-9.]+)([smhd]?)$/.exec(a[0]);
    if (!m) { io.msg("intervalo inválido de tempo " + qa(a[0])); return 125; }
    var ms = parseFloat(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]]) * 1000;
    var sh = io.sh, filho = sh.fork(), k = sh.k;
    var p = k.spawn(filho, function* () { try { return yield* filho.executar(a.slice(1), { semFuncao: true, externo: true }); } catch (e) { if (e instanceof ExitSig) return e.code; throw e; } }, { bg: sh.proc ? sh.proc.bg : false, nome: a[1] });
    var limite = k.clock + ms;
    yield { t: "sleep", ms: 0 };
    while (!p.done) {
      if (k.clock >= limite) { k.terminar(p, sig); return 124; }
      var falta = limite - k.clock;
      yield { t: "block", cond: function () { return p.done || k.clock >= limite; } };
      if (!p.done && k.clock < limite) yield { t: "sleep", ms: falta };
    }
    return p.status;
  };
  EXT.nohup = function* (args, io) {
    if (args.length < 2) return io.tente("falta operando");
    var sh = io.sh;
    if (io.tty()) {
      io.msg("ignorando entrada e anexando saída a 'nohup.out'");
      var o = sh.abrir("nohup.out", "a"); if (o.err) return 127;
      var salvo = sh.fds[1]; sh.fds[1] = ref(o);
      try { return yield* sh.executar(args.slice(1), { semFuncao: true, externo: true }); } finally { unref(sh.fds[1]); sh.fds[1] = salvo; }
    }
    return yield* sh.executar(args.slice(1), { semFuncao: true, externo: true });
  };
  EXT.watch = function* (args, io) { io.err("(simulador) watch redesenha a tela a cada 2 segundos; aqui ele não existe. Use um laço: while sleep 2; do comando; done\n"); return 1; };

  /* ---------- bash / sh ---------- */
  EXT.bash = function* (args, io) {
    var sh = io.sh, a = args.slice(1), opcoes = {}, modoC = null, soChecar = false, i = 0, ehSh = args[0] === "sh" || /\/sh$/.test(args[0]) || args[0] === "dash";
    for (; i < a.length; i++) {
      var x = a[i];
      if (x === "--version") { io.out(BASH_VERSAO_TXT); return 0; }
      if (x === "--help") { io.out("GNU bash, versão 5.3.9(1)-release-(x86_64-pc-linux-gnu)\nUso:\tbash [opção-longa-GNU] [opção] ...\n\tbash [opção-longa-GNU] [opção] arquivo-script ...\n"); return 0; }
      if (x === "--norc" || x === "--noprofile" || x === "--posix" || x === "--login" || x === "-l") continue;
      if (x === "--") { i++; break; }
      if (x === "-c") { modoC = true; continue; }
      if (x === "-o" || x === "+o") { opcoes[a[++i]] = x[0] === "-" ? 1 : 0; continue; }
      if (/^[-+][a-zA-Z]+$/.test(x)) {
        var liga = x[0] === "-";
        for (var j = 1; j < x.length; j++) {
          var c = x[j];
          if (c === "c") modoC = true;
          else if (c === "n") { soChecar = true; opcoes.noexec = 1; }
          else if (c === "s" || c === "i") { }
          else if (SET_LETRA[c]) opcoes[SET_LETRA[c]] = liga ? 1 : 0;
          else { io.err((ehSh ? "sh" : "bash") + ": " + x[0] + c + ": opção inválida\n"); return 2; }
        }
        continue;
      }
      break;
    }
    var resto = a.slice(i);
    if (modoC) {
      if (!resto.length) { io.err((ehSh ? "sh" : "bash") + ": -c: a opção requer um argumento\n"); return 2; }
      var txt = resto[0], argv0 = resto[1] !== undefined ? resto[1] : (ehSh ? "sh" : "bash");
      return yield* sh.rodarScriptNovo(argv0, txt + "\n", resto.slice(2), { argv0: argv0, nome0: argv0, modoC: true, opcoes: opcoes, soChecar: soChecar, sh: ehSh });
    }
    if (!resto.length) {
      var ent = sh.fds[0];
      if (ent && isTTY(ent) && !ent.naoTTY) { io.err("(simulador) abrir um novo shell interativo dentro deste não é suportado. Use bash -c 'comandos' ou bash arquivo.sh.\n"); return 1; }
      var codigo = yield* lerTudo(sh.k, ent);
      return yield* sh.rodarScriptNovo("bash", codigo, [], { argv0: ehSh ? "sh" : "bash", nome0: ehSh ? "sh" : "bash", opcoes: opcoes, soChecar: soChecar, sh: ehSh });
    }
    var arq = resto[0], r = sh.resolver(arq, true);
    if (!r.no && arq.indexOf("/") < 0) { var p2 = sh.acharNoPath(arq); if (p2) r = sh.resolver(p2, true); }
    if (!r.no) { io.err((ehSh ? "sh: 0: cannot open " + arq + ": No such file" : "bash: " + arq + ": Arquivo ou diretório inexistente") + "\n"); return ehSh ? 2 : 127; }
    if (r.no.t === "d") { io.err("bash: " + arq + ": é um diretório\n"); return 126; }
    if (!sh.pode(r.no, 4)) { io.err("bash: " + arq + ": Permissão negada\n"); return 126; }
    if (r.no.d === null) { io.err("bash: " + arq + ": impossível executar o arquivo binário\n"); return 126; }
    return yield* sh.rodarScriptNovo(arq, dadosDe(r.no), resto.slice(1), { argv0: arq, opcoes: opcoes, soChecar: soChecar, sh: ehSh });
  };
  EXT.sh = EXT.bash; EXT.dash = EXT.bash; EXT.rbash = EXT.bash;

  /* ---------- xargs ---------- */
  EXT.xargs = function* (args, io) {
    var a = args.slice(1), o = {}, i = 0;
    for (; i < a.length; i++) {
      var x = a[i];
      if (x === "--") { i++; break; }
      if (!/^-/.test(x)) break;
      if (x === "-0" || x === "--null") { o.z = true; continue; }
      if (/^-[ntLPdIEs]$/.test(x) || /^-[nLPdIEs]./.test(x) || /^-i/.test(x) || x === "-r" || x === "-t" || x === "-p" || x === "-x" || /^--/.test(x)) {
        var c = x[1];
        if (x === "-r" || x === "--no-run-if-empty") { o.r = true; continue; }
        if (x === "-t" || x === "--verbose") { o.t = true; continue; }
        if (x === "-p" || x === "--interactive") { o.p = true; o.t = true; continue; }
        if (x === "-x") continue;
        if (/^-i/.test(x)) { o.I = x.length > 2 ? x.slice(2) : "{}"; continue; }
        var v = x.length > 2 ? x.slice(2) : a[++i];
        if (v === undefined) { io.msg("a opção requer um argumento -- “" + c + "”"); io.err("Tente \"xargs --help\" para mais informações.\n"); return 1; }
        o[c] = v;
        continue;
      }
      io.msg("opção inválida -- “" + x[1] + "”"); io.err("Tente \"xargs --help\" para mais informações.\n"); return 1;
    }
    var cmd = a.slice(i); if (!cmd.length) cmd = ["echo"];
    var txt = yield* io.stdin();
    var itens = [];
    if (o.z) itens = txt.split("\0").filter(function (x, k, arr) { return !(k === arr.length - 1 && x === ""); });
    else if (o.d) itens = txt.split(o.d.replace(/\\n/g, "\n").replace(/\\t/g, "\t")).filter(function (x, k, arr) { return !(k === arr.length - 1 && x === ""); });
    else if (o.I) itens = linhasDe(txt).map(function (l) { return l.replace(/^\s+/, ""); }).filter(function (l) { return l !== ""; });
    else {
      var re = /\s*(?:"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'\\])+))+/g, m, cur;
      var s = txt, k = 0;
      while (k < s.length) {
        while (k < s.length && /\s/.test(s[k])) k++;
        if (k >= s.length) break;
        cur = "";
        while (k < s.length && !/\s/.test(s[k])) {
          if (s[k] === '"' || s[k] === "'") {
            var q = s[k], f = s.indexOf(q, k + 1);
            if (f < 0) { io.msg("aspas " + (q === '"' ? "duplas" : "simples") + " sem correspondência; por padrão, as aspas são especiais para xargs, a menos que você use a opção -0"); return 1; }
            cur += s.slice(k + 1, f); k = f + 1; continue;
          }
          if (s[k] === "\\") { cur += s[k + 1] || ""; k += 2; continue; }
          cur += s[k]; k++;
        }
        itens.push(cur);
      }
    }
    if (o.E) { var e = itens.indexOf(o.E); if (e >= 0) itens = itens.slice(0, e); }
    var grupos = [];
    if (o.I) itens.forEach(function (it) { grupos.push(cmd.map(function (c) { return c.split(o.I).join(it); })); });
    else if (o.L) { var ls = linhasDe(txt), n = +o.L; for (var g2 = 0; g2 < ls.length; g2 += n) grupos.push(cmd.concat(ls.slice(g2, g2 + n).join(" ").trim().split(/\s+/).filter(Boolean))); }
    else if (o.n) { var nn = +o.n; for (var g3 = 0; g3 < itens.length; g3 += nn) grupos.push(cmd.concat(itens.slice(g3, g3 + nn))); }
    else grupos.push(cmd.concat(itens));
    if (!itens.length && !o.I) { if (o.r) return 0; grupos = [cmd]; }
    var st = 0, sh = io.sh;
    for (var j = 0; j < grupos.length; j++) {
      if (o.t) io.err(grupos[j].join(" ") + (o.p ? " ?..." : "") + "\n");
      if (o.p) { var resp = yield* lerAte(sh.k, new OFD("tty-in"), "\n", null, {}); if (!/^[sSyY]/.test(resp.s)) continue; }
      var t = sh.acharNoPath(grupos[j][0]);
      if (!t && grupos[j][0].indexOf("/") < 0) { io.msg(grupos[j][0] + ": Arquivo ou diretório inexistente"); return 127; }
      var f2 = sh.fork();
      unref(f2.fds[0]); f2.fds[0] = ref(new OFD("null"));
      var r;
      try { r = yield* f2.executar(grupos[j], { semFuncao: true, externo: true }); }
      catch (ex) { if (ex instanceof ExitSig) r = ex.code; else throw ex; }
      finally { f2.fecharTudo(); }
      if (r === 255) { io.msg(grupos[j][0] + ": terminado com status 255; abortando"); return 124; }
      if (r === 127 || r === 126) return r;
      if (r >= 128) return 125;
      if (r !== 0) st = 123;
    }
    return st;
  };

  /* ---------- grep ---------- */
  EXT.grep = function* (args, io) {
    var nomeProg = args[0];
    var g = getopt(args, "efABCmd", {
      "extended-regexp": "E", "fixed-strings": "F", "basic-regexp": "G", "perl-regexp": "P", "ignore-case": "i", "no-ignore-case": "noi", "invert-match": "v", count: "c", "line-number": "n", "only-matching": "o",
      "word-regexp": "w", "line-regexp": "x", recursive: "r", "dereference-recursive": "R", "files-with-matches": "l", "files-without-match": "L", quiet: "q", silent: "q", "no-messages": "s",
      "no-filename": "h", "with-filename": "H", "after-context": "A=", "before-context": "B=", context: "C=", "max-count": "m=", regexp: "e=", file: "f=", color: "color?=", colour: "color?=",
      include: "include=", exclude: "exclude=", "exclude-dir": "exclude-dir=", "null-data": "z", "byte-offset": "b", text: "a", "label": "label=", "initial-tab": "T", "null": "Z", "binary-files": "binary-files="
    }, { validas: "EFGPivcnowxrRlLqshHABCmefzbaTZUu0123456789y", multi: "e" });
    if (g.erro) { if (g.erro.tipo === "curta") { io.msg("opção inválida -- “" + g.erro.op + "”"); } else if (g.erro.tipo === "falta") io.msg("a opção requer um argumento -- “" + g.erro.op + "”"); else io.msg("opção não reconhecida “" + g.erro.op + "”"); io.err("Uso: grep [OPÇÃO]... PADRÕES [ARQUIVO]...\nExperimente \"grep --help\" para mais informações.\n"); return 2; }
    var o = g.o, sh = io.sh, ops = g.ops.slice();
    if (nomeProg === "egrep") o.E = true; if (nomeProg === "fgrep") o.F = true;
    if (o.y) o.i = true;
    var padroes = [];
    if (o.e !== undefined) padroes = padroes.concat(Array.isArray(o.e) ? o.e : [o.e]);
    if (o.f !== undefined) { var rf = sh.lerArquivo(o.f); if (rf.err) { io.msg(o.f + ": " + errMsg(rf.err)); return 2; } padroes = padroes.concat(linhasDe(rf.txt)); }
    if (o.e === undefined && o.f === undefined) {
      if (!ops.length) { io.err("Uso: grep [OPÇÃO]... PADRÕES [ARQUIVO]...\nExperimente \"grep --help\" para mais informações.\n"); return 2; }
      padroes = padroes.concat(ops.shift().split("\n"));
    }
    var srcs = padroes.map(function (p) {
      if (o.P) return p;
      if (o.F) return p.replace(/[\\^$.*+?()[\]{}|\/]/g, "\\$&");
      return ereParaJs(p, { bre: !o.E });
    });
    var src = srcs.length === 1 ? srcs[0] : srcs.map(function (s) { return "(?:" + s + ")"; }).join("|");
    var vazioPadrao = padroes.some(function (p) { return p === ""; });
    if (o.w) src = "(?<![\\p{L}\\p{N}_])(?:" + src + ")(?![\\p{L}\\p{N}_])";
    if (o.x) src = "^(?:" + src + ")$";
    var re = criarRegex(src, (o.i && !o.noi ? "i" : "") + "g");
    if (!re) {
      io.msg("Expressão regular inválida"); return 2;
    }
    var tty = io.tty(), cor = (o.color === "always") || ((o.color === "auto" || o.color === true) && tty);
    var recursivo = o.r || o.R;
    if (!ops.length) ops = recursivo ? ["."] : ["-"];
    var multi = (ops.length > 1 || recursivo) && !o.h || o.H;
    var antes = o.B !== undefined ? +o.B : (o.C !== undefined ? +o.C : 0), depois = o.A !== undefined ? +o.A : (o.C !== undefined ? +o.C : 0);
    for (var dg = 0; dg <= 9; dg++) if (o[String(dg)]) { antes = depois = dg; }
    var maxM = o.m !== undefined ? +o.m : Infinity;
    var achouAlgum = false, erro = false, saiu = false;
    var arquivos = [];
    var semDotSlash = recursivo && g.ops.length === (o.e === undefined && o.f === undefined ? 1 : 0);
    function incluido(nome) {
      if (o.include && !casaPadrao(o.include, nome.slice(nome.lastIndexOf("/") + 1))) return false;
      if (o.exclude && casaPadrao(o.exclude, nome.slice(nome.lastIndexOf("/") + 1))) return false;
      return true;
    }
    ops.forEach(function (a) {
      if (a === "-") { arquivos.push({ nome: "-", rot: o.label || "(entrada padrão)" }); return; }
      var r = sh.resolver(a, true);
      if (r.no && r.no.t === "d") {
        if (!recursivo) { if (!o.s) io.msg(a + ": É um diretório"); return; }
        (function anda(no, rot) {
          listarDir(no).forEach(function (n) {
            var f = no.c[n], c = rot === "." && semDotSlash ? n : rot.replace(/\/$/, "") + "/" + n;
            if (f.t === "l") { if (!o.R) return; f = sh.resolver(c, true).no; if (!f) return; }
            if (f.t === "d") { if (o["exclude-dir"] && casaPadrao(o["exclude-dir"], n)) return; if (!sh.pode(f, 4)) { if (!o.s) io.msg(c + ": Permissão negada"); erro = true; return; } anda(f, c); }
            else if (f.t === "f" && incluido(c)) arquivos.push({ nome: c, rot: c });
          });
        })(r.no, a);
        return;
      }
      arquivos.push({ nome: a, rot: a });
    });
    for (var i = 0; i < arquivos.length && !saiu; i++) {
      var arq = arquivos[i];
      var rr = yield* io.ler(arq.nome);
      if (rr.err) { if (!o.s) io.msg(arq.nome + ": " + errMsg(rr.err)); erro = true; continue; }
      var txt = rr.txt;
      var binario = !o.a && txt.indexOf("\0") >= 0 && !o.z;
      var linhas = o.z ? txt.split("\0") : txt.split("\n");
      if (linhas[linhas.length - 1] === "") linhas.pop();
      var n = 0, contagem = 0, ultimaImpressa = -1, saidaArq = "", pendDepois = 0;
      var pref = function (rot, num, sep) {
        var p = "";
        if (multi) p += (cor ? cor_("p", rot) + cor_("s", sep) : rot + sep);
        if (o.n) p += (cor ? cor_("g", String(num)) + cor_("s", sep) : num + sep);
        if (o.T) p += "\t";
        return p;
      };
      for (var j = 0; j < linhas.length; j++) {
        var l = linhas[j];
        re.lastIndex = 0;
        var bate = vazioPadrao ? true : re.test(l);
        if (o.v) bate = !bate;
        if (bate && contagem < maxM) {
          contagem++;
          achouAlgum = true;
          if (o.q) { saiu = true; break; }
          if (o.l || o.L || o.c) continue;
          if (binario) continue;
          if ((antes || depois) && ultimaImpressa >= 0 && j - antes > ultimaImpressa + 1) saidaArq += (cor ? cor_("s", "--") : "--") + "\n";
          for (var b = Math.max(ultimaImpressa + 1, j - antes); b < j; b++) saidaArq += pref(arq.rot, b + 1, "-") + linhas[b] + "\n";
          if (o.o) {
            if (!o.v) { re.lastIndex = 0; var m; while ((m = re.exec(l))) { if (m[0] === "") { re.lastIndex++; continue; } saidaArq += pref(arq.rot, j + 1, ":") + (cor ? cor_("r", m[0]) : m[0]) + "\n"; } }
          } else {
            var corpo = l;
            if (cor && !o.v) { re.lastIndex = 0; corpo = l.replace(re, function (x) { return x ? cor_("r", x) : x; }); }
            saidaArq += pref(arq.rot, j + 1, ":") + corpo + "\n";
          }
          ultimaImpressa = j; pendDepois = depois;
        } else if (pendDepois > 0 && !o.q && !o.l && !o.L && !o.c && !binario) {
          if (contagem >= maxM && !bate) { }
          saidaArq += pref(arq.rot, j + 1, "-") + l + "\n"; ultimaImpressa = j; pendDepois--;
        } else if (contagem >= maxM) break;
      }
      if (o.c) saidaArq += (multi ? (cor ? cor_("p", arq.rot) + cor_("s", ":") : arq.rot + ":") : "") + contagem + "\n";
      else if (o.l && contagem) saidaArq += (cor ? cor_("p", arq.rot) : arq.rot) + (o.Z ? "\0" : "\n");
      else if (o.L && !contagem) saidaArq += (cor ? cor_("p", arq.rot) : arq.rot) + "\n";
      else if (binario && contagem && !o.q) saidaArq += "grep: " + arq.rot + ": arquivo binário corresponde\n";
      io.out(saidaArq);
      yield* io.fluir();
    }
    function cor_(l, t) { return cor ? C0 + l + t + C1 : t; }
    if (erro && !(o.q && achouAlgum)) return 2;
    if (o.L) return achouAlgum ? 0 : 1;
    return achouAlgum ? 0 : 1;
  };
  EXT.egrep = function* (args, io) { io.msg("warning: egrep is obsolescent; using grep -E"); return yield* EXT.grep.call(this, ["egrep"].concat(args.slice(1)), io); };
  EXT.fgrep = function* (args, io) { io.msg("warning: fgrep is obsolescent; using grep -F"); return yield* EXT.grep.call(this, ["fgrep"].concat(args.slice(1)), io); };

  /* ---------- sed ---------- */
  function SedErr(msg) { this.msg = msg; }
  function compilarSed(script, ere, numExpr) {
    var cmds = [], i = 0, s = script, rotulos = {};
    function erro(m) { throw new SedErr("-e expressão #" + numExpr + ", caractere " + i + ": " + m); }
    function brancos() { while (i < s.length && (s[i] === " " || s[i] === "\t")) i++; }
    function lerRe(delim) {
      var r = "";
      while (i < s.length && s[i] !== delim) {
        if (s[i] === "\\" && i + 1 < s.length) { if (s[i + 1] === delim) { r += delim === "/" ? "\\/" : delim; i += 2; continue; } if (s[i + 1] === "n") { r += "\\n"; i += 2; continue; } r += s[i] + s[i + 1]; i += 2; continue; }
        if (s[i] === "\n") { return null; }
        if (s[i] === "[") { var k = i + 1; if (s[k] === "^") k++; if (s[k] === "]") k++; while (k < s.length && s[k] !== "]") { if (s[k] === "[" && /[:.=]/.test(s[k + 1])) { var f = s.indexOf(s[k + 1] + "]", k + 2); if (f > 0) k = f + 1; } k++; } if (k < s.length) { r += s.slice(i, k + 1); i = k + 1; continue; } }
        r += s[i]; i++;
      }
      if (i >= s.length) return null;
      i++;
      return r;
    }
    function lerEndereco() {
      var m;
      if (s[i] === "$") { i++; return { t: "ultima" }; }
      if ((m = /^([0-9]+)~([0-9]+)/.exec(s.slice(i)))) { i += m[0].length; return { t: "passo", a: +m[1], p: +m[2] }; }
      if ((m = /^[0-9]+/.exec(s.slice(i)))) { i += m[0].length; return { t: "linha", n: +m[0] }; }
      if (s[i] === "/" || s[i] === "\\") {
        var delim = "/";
        if (s[i] === "\\") { delim = s[i + 1]; i++; }
        i++;
        var re = lerRe(delim);
        if (re === null) erro("expressão regular não terminada");
        var fl = "";
        while (s[i] === "I" || s[i] === "M") { fl += s[i] === "I" ? "i" : "m"; i++; }
        return { t: "re", re: re, fl: fl };
      }
      return null;
    }
    function lerTexto() { // texto de a/i/c
      brancos();
      if (s[i] === "\\") { i++; if (s[i] === "\n") i++; }
      var t = "";
      while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) { if (s[i + 1] === "\n") { t += "\n"; i += 2; continue; } t += s[i + 1] === "t" ? "\t" : s[i + 1]; i += 2; continue; }
        if (s[i] === "\n") { break; }
        t += s[i]; i++;
      }
      return t;
    }
    function lerNomeArq() { brancos(); var ini = i; while (i < s.length && s[i] !== "\n") i++; return s.slice(ini, i); }
    var pilha = [];
    while (i < s.length) {
      while (i < s.length && /[\s;]/.test(s[i])) i++;
      if (i >= s.length) break;
      if (s[i] === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
      var c = { a1: null, a2: null, neg: false };
      c.a1 = lerEndereco();
      if (c.a1 && s[i] === ",") {
        i++; brancos();
        var m2;
        if ((m2 = /^\+([0-9]+)/.exec(s.slice(i)))) { i += m2[0].length; c.a2 = { t: "mais", n: +m2[1] }; }
        else if ((m2 = /^~([0-9]+)/.exec(s.slice(i)))) { i += m2[0].length; c.a2 = { t: "mult", n: +m2[1] }; }
        else { c.a2 = lerEndereco(); if (!c.a2) erro("endereço inesperado"); }
      }
      brancos();
      while (s[i] === "!") { c.neg = !c.neg; i++; brancos(); }
      if (i >= s.length) erro("faltando comando");
      var cmd = s[i++];
      c.cmd = cmd;
      switch (cmd) {
        case "{": pilha.push(cmds.length); cmds.push(c); continue;
        case "}": if (!pilha.length) erro("\"}\" inesperado"); cmds[pilha.pop()].fim = cmds.length; c.cmd = "nop"; cmds.push(c); continue;
        case "s": {
          var delim = s[i++];
          if (delim === undefined || delim === "\n" || delim === "\\") erro("comando `s' não terminado");
          var re = lerRe(delim);
          if (re === null) erro("comando `s' não terminado");
          var rep = "";
          while (i < s.length && s[i] !== delim) {
            if (s[i] === "\\" && i + 1 < s.length) { rep += s[i] + s[i + 1]; i += 2; continue; }
            if (s[i] === "\n" && false) break;
            rep += s[i]; i++;
          }
          if (i >= s.length) { erro("comando `s' não terminado"); }
          i++;
          var fl = { g: false, p: false, n: 1, i: false, w: null, m: false, e: false };
          while (i < s.length && /[gpiImMe0-9w]/.test(s[i])) {
            var f = s[i];
            if (f === "g") fl.g = true; else if (f === "p") fl.p = true; else if (f === "i" || f === "I") fl.i = true; else if (f === "m" || f === "M") fl.m = true; else if (f === "e") fl.e = true;
            else if (f === "w") { i++; fl.w = lerNomeArq(); break; }
            else { var mn = /^[0-9]+/.exec(s.slice(i)); fl.n = +mn[0]; i += mn[0].length - 1; }
            i++;
          }
          c.re = re; c.rep = rep; c.fl = fl;
          brancos();
          if (i < s.length && !/[;\n}#]/.test(s[i])) erro("opção desconhecida para `s'");
          break;
        }
        case "y": {
          var d2 = s[i++], a = lerRe(d2), b = lerRe(d2);
          if (a === null || b === null) erro("comando `y' não terminado");
          a = a.replace(/\\n/g, "\n").replace(/\\\\/g, "\\"); b = b.replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
          if (Array.from(a).length !== Array.from(b).length) erro("strings para o comando `y' têm tamanhos diferentes");
          c.de = Array.from(a); c.para = Array.from(b);
          break;
        }
        case "a": case "i": case "c": c.txt = lerTexto(); break;
        case ":": { brancos(); var ini = i; while (i < s.length && !/[;\n]/.test(s[i])) i++; var nomeR = s.slice(ini, i).trim(); if (!nomeR) erro("\":\" não tem um rótulo"); rotulos[nomeR] = cmds.length; c.cmd = "nop"; break; }
        case "b": case "t": case "T": { brancos(); var ini2 = i; while (i < s.length && !/[;\n}]/.test(s[i])) i++; c.rot = s.slice(ini2, i).trim(); break; }
        case "r": case "R": case "w": case "W": c.arq = lerNomeArq(); break;
        case "q": case "Q": case "l": case "L": { brancos(); var mq = /^[0-9]+/.exec(s.slice(i)); if (mq) { c.n = +mq[0]; i += mq[0].length; } break; }
        case "=": case "d": case "D": case "p": case "P": case "n": case "N": case "h": case "H": case "g": case "G": case "x": case "z": case "F": break;
        case "e": c.txtCmd = lerNomeArq(); break;
        default: i--; i++; erro("comando desconhecido: `" + cmd + "'");
      }
      cmds.push(c);
      brancos();
      if (i < s.length && !/[;\n}#]/.test(s[i]) && c.cmd !== "a" && c.cmd !== "i" && c.cmd !== "c") { i++; erro("caracteres extras após o comando"); }
    }
    if (pilha.length) { i = s.length; erro("\"{\" sem correspondente"); }
    cmds.forEach(function (c) { if ((c.cmd === "b" || c.cmd === "t" || c.cmd === "T") && c.rot && !hasOwn(rotulos, c.rot)) throw new SedErr("-e expressão #" + numExpr + ", caractere 0: não foi possível localizar o rótulo para pular para `" + c.rot + "'"); });
    return { cmds: cmds, rotulos: rotulos };
  }
  function sedRegex(re, ere, fl, ultimo) {
    if (re === "") { if (!ultimo.re) throw new SedErr("nenhuma expressão regular anterior"); return ultimo.re; }
    var src = ereParaJs(re, { bre: !ere });
    var r = criarRegex(src, (fl || "") + "g");
    if (!r) throw new SedErr("-e expressão #1, caractere 0: expressão regular inválida");
    ultimo.re = r;
    return r;
  }
  // substitui todos os casamentos como o regex POSIX: um casamento vazio logo depois de outro é ignorado
  function substituirPosix(s, re, fn) {
    var rx = new RegExp(re.source, re.flags.indexOf("g") >= 0 ? re.flags : re.flags + "g"), out = "", pos = 0, fimAnt = -1, m;
    rx.lastIndex = 0;
    while ((m = rx.exec(s))) {
      if (m[0] === "" && m.index === fimAnt) { if (m.index >= s.length) break; rx.lastIndex = m.index + 1; continue; }
      out += s.slice(pos, m.index) + fn(m);
      pos = m.index + m[0].length; fimAnt = pos;
      if (m[0] === "") { if (m.index >= s.length) break; rx.lastIndex = m.index + 1; }
    }
    return out + s.slice(pos);
  }
  function sedRep(rep, m, ere) {
    var out = "", caso = null, umCaso = null;
    function add(t) {
      for (var ch of t) {
        if (umCaso) { ch = umCaso === "u" ? ch.toUpperCase() : ch.toLowerCase(); umCaso = null; }
        else if (caso) ch = caso === "U" ? ch.toUpperCase() : ch.toLowerCase();
        out += ch;
      }
    }
    for (var i = 0; i < rep.length; i++) {
      var c = rep[i];
      if (c === "\\" && i + 1 < rep.length) {
        var n = rep[++i];
        if (/[0-9]/.test(n)) { add(m[+n] || ""); continue; }
        if (n === "n") { add("\n"); continue; } if (n === "t") { add("\t"); continue; } if (n === "&") { add("&"); continue; }
        if (n === "U" || n === "L") { caso = n; continue; } if (n === "E") { caso = null; continue; }
        if (n === "u" || n === "l") { umCaso = n; continue; }
        if (n === "\n") { add("\n"); continue; }
        add(n); continue;
      }
      if (c === "&") { add(m[0]); continue; }
      add(c);
    }
    return out;
  }
  EXT.sed = function* (args, io) {
    var a = args.slice(1), o = { e: [] }, ops = [], sh = io.sh;
    for (var i = 0; i < a.length; i++) {
      var x = a[i];
      if (x === "--") { ops = ops.concat(a.slice(i + 1)); break; }
      if (x === "-n" || x === "--quiet" || x === "--silent") { o.n = true; continue; }
      if (x === "-E" || x === "-r" || x === "--regexp-extended") { o.E = true; continue; }
      if (x === "-s" || x === "--separate") { o.s = true; continue; }
      if (x === "-z" || x === "--null-data") { o.z = true; continue; }
      if (x === "--version") { io.out("sed (GNU sed) 4.9\nPackaged by Debian\nCopyright (C) 2022 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n"); return 0; }
      if (x === "--help") { io.out(SED_USO); return 0; }
      if (x === "-u" || x === "--unbuffered" || x === "--posix" || x === "--debug" || x === "--sandbox") continue;
      if (x === "-e" || x === "--expression") { o.e.push(a[++i]); continue; }
      if (/^-e./.test(x)) { o.e.push(x.slice(2)); continue; }
      if (/^--expression=/.test(x)) { o.e.push(x.slice(13)); continue; }
      if (x === "-f" || x === "--file") { var rf = sh.lerArquivo(a[++i]); if (rf.err) { io.msg("não foi possível ler " + a[i] + ": " + errMsg(rf.err)); return 1; } o.e.push(rf.txt.replace(/\n$/, "")); continue; }
      if (/^-i/.test(x) || /^--in-place/.test(x)) { o.i = true; o.suf = x.indexOf("=") > 0 ? x.split("=")[1] : x.slice(2); continue; }
      if (/^-[nErsuz]+$/.test(x)) { x.slice(1).split("").forEach(function (c) { if (c === "n") o.n = true; if (c === "E" || c === "r") o.E = true; if (c === "s") o.s = true; if (c === "z") o.z = true; }); continue; }
      if (/^-[nErsuz]*i/.test(x)) { x.slice(1).split("").forEach(function (c) { if (c === "n") o.n = true; if (c === "E" || c === "r") o.E = true; }); o.i = true; o.suf = x.slice(x.indexOf("i") + 1); continue; }
      if (/^-./.test(x)) { io.msg("opção inválida -- “" + x[1] + "”"); io.err("Uso: sed [OPÇÃO]... {script-apenas-se-for-único} [arquivo-entrada]...\n\n"); return 1; }
      ops.push(x);
    }
    if (!o.e.length) {
      if (!ops.length) { io.err(SED_USO); return 1; }
      o.e.push(ops.shift());
    }
    var prog;
    try {
      prog = { cmds: [], rotulos: {} };
      var todo = o.e.join("\n");
      prog = compilarSed(todo, o.E, 1);
    } catch (e) { if (e instanceof SedErr) { io.msg(e.msg); return 1; } throw e; }
    var arquivos = ops.length ? ops : ["-"];
    var ultimo = {}, st = 0, sair = null;
    var arqsSaida = {};
    function escreverArq(nome, txt) {
      if (nome === "/dev/stdout") { saidaAtual.push(txt); return; }
      if (!arqsSaida[nome]) { var f = sh.abrir(nome, "w"); if (f.err) { io.msg("não foi possível abrir o arquivo " + nome + ": " + errMsg(f.err)); return; } arqsSaida[nome] = f; }
      escreverOFD(sh.k, arqsSaida[nome], txt);
    }
    var saidaAtual;
    // modo normal: todos os arquivos formam um só fluxo (-s/-i: separados)
    var grupos = [];
    if (o.i || o.s) arquivos.forEach(function (f) { grupos.push([f]); });
    else grupos.push(arquivos);
    for (var gi = 0; gi < grupos.length && sair === null; gi++) {
      var linhas = [], nomes = [], temFinalNL = true;
      for (var fi = 0; fi < grupos[gi].length; fi++) {
        var nomeA = grupos[gi][fi];
        var r = yield* io.ler(nomeA);
        if (r.err) { io.msg("não foi possível ler " + nomeA + ": " + errMsg(r.err)); st = 2; continue; }
        var sep = o.z ? "\0" : "\n";
        var ls = r.txt.split(sep);
        if (ls[ls.length - 1] === "") ls.pop(); else if (r.txt !== "") temFinalNL = false; else ls = [];
        if (ls.length) temFinalNL = r.txt[r.txt.length - 1] === sep;
        ls.forEach(function (l) { linhas.push(l); });
      }
      if (o.i && grupos[gi][0] !== "-") { var noA = sh.no(grupos[gi][0]); if (!noA) continue; }
      saidaAtual = [];
      var res = rodarSed(prog, linhas, o, ultimo, escreverArq, sh, io, saidaAtual);
      if (res.sair !== null) sair = res.sair;
      var texto = saidaAtual.join("");
      if (!temFinalNL && texto.slice(-1) === "\n" && res.ultimaSemNL) texto = texto.slice(0, -1);
      if (o.i && grupos[gi][0] !== "-") {
        var nomeArq = grupos[gi][0], no = sh.no(nomeArq);
        if (o.suf) { var bk = sh.abrir(nomeArq.indexOf("*") >= 0 ? o.suf.replace("*", nomeArq) : nomeArq + o.suf, "w"); if (!bk.err) escreverOFD(sh.k, bk, dadosDe(no)); }
        no.d = texto; delete no.z; no.mt = no.ct = sh.k.clock;
      } else io.out(texto);
    }
    return sair !== null ? sair : st;
  };
  var SED_USO = "Uso: sed [OPÇÃO]... {script-apenas-se-for-único} [arquivo-entrada]...\n\n  -n, --quiet, --silent\n                 suprime a impressão automática do buffer padrão\n      --debug\n                 anota a execução do programa\n  -e script, --expression=script\n                 adiciona o script aos comandos a serem executados\n  -f arquivo-script, --file=arquivo-script\n                 adiciona o conteúdo do arquivo-script aos comandos\n                 a serem executados\n  --follow-symlinks\n                 segue links simbólicos ao editar o próprio arquivo original\n  -i[SUFIXO], --in-place[=SUFIXO]\n                 edita o arquivo original (faz backup se usado SUFIXO)\n  -l N, --line-length=N\n                 determina comprimento da quebra de linha para comando `l'\n  --posix\n                 desativa todas as extensões GNU.\n  -E, -r, --regexp-extended\n                 usa sintaxe moderna de expressões regulares, sem escapes.\n                 (para portabilidade, use POSIX -E).\n  -s, --separate\n                 considera arquivos como entidades separadas, e não\n                 como um longo e único fluxo de dados.\n      --sandbox\n                 opera em modo sandbox (desabilita comandos e/r/w).\n  -u, --unbuffered\n                 carrega uma quantidade mínima de dados dos arquivos de entrada\n                 e descarrega os buffers de saída com mais frequência\n  -z, --null-data\n                 separa linhas por caracteres NULOs\n      --help     mostra esta ajuda e sai\n      --version  mostra informações sobre a versão e sai\n\nSe nenhuma opção -e, --expression, -f, ou --file é dada, o primeiro\nargumento que não seja uma opção é considerado como o script sed a\nser interpretado. Todos os argumentos restantes são considerados\ncomo nomes de arquivos de entrada. Caso nenhum arquivo de entrada\nseja especificado, então a entrada padrão será lida.\n\nPágina do GNU sed: <https://www.gnu.org/software/sed/>.\nAjuda sobre softwares GNU: <https://www.gnu.org/gethelp/>.\n";
  function rodarSed(prog, linhas, o, ultimo, escreverArq, sh, io, saida) {
    var cmds = prog.cmds, n = linhas.length, ln = 0, hold = "", sair = null;
    var faixa = cmds.map(function () { return { ativa: false, fim: 0 }; });
    var nl = o.z ? "\0" : "\n";
    var ultimaSemNL = false;
    function casaEnd(a, ps, numLinha) {
      if (!a) return true;
      if (a.t === "ultima") return numLinha === n;
      if (a.t === "linha") return numLinha === a.n;
      if (a.t === "passo") return a.p <= 0 ? numLinha === a.a : (numLinha >= a.a && (numLinha - a.a) % a.p === 0);
      if (a.t === "re") { var r = sedRegex(a.re, o.E, a.fl, ultimo); r.lastIndex = 0; return r.test(ps); }
      return false;
    }
    function seleciona(c, idx, ps, numLinha) {
      var r;
      if (!c.a1) r = true;
      else if (!c.a2) r = casaEnd(c.a1, ps, numLinha);
      else {
        var f = faixa[idx];
        if (f.ativa) {
          if (c.a2.t === "linha") { if (numLinha >= c.a2.n) f.ativa = false; r = true; if (numLinha > c.a2.n) { r = false; } }
          else if (c.a2.t === "mais") { r = true; if (numLinha >= f.fim) f.ativa = false; }
          else if (c.a2.t === "mult") { r = true; if (numLinha % c.a2.n === 0) f.ativa = false; }
          else { r = true; if (casaEnd(c.a2, ps, numLinha)) f.ativa = false; }
        } else if (c.a1.t === "linha" && c.a1.n === 0) {
          r = numLinha === 1;
          if (r) f.ativa = !casaEnd(c.a2, ps, numLinha);
          if (!r) r = false;
        } else if (casaEnd(c.a1, ps, numLinha)) {
          r = true;
          if (c.a2.t === "linha") f.ativa = c.a2.n > numLinha;
          else if (c.a2.t === "mais") { f.fim = numLinha + c.a2.n; f.ativa = c.a2.n > 0; }
          else if (c.a2.t === "mult") f.ativa = c.a2.n > 0 && numLinha % c.a2.n !== 0;
          else f.ativa = true;
          if (c.a1.t === "linha" && c.a1.n === 0 && casaEnd(c.a2, ps, numLinha)) f.ativa = false;
        } else r = false;
      }
      return c.neg ? !r : r;
    }
    var passos = 0;
    while (ln < n && sair === null) {
      var ps = linhas[ln++], anexos = [], subst = false, apagar = false, reiniciar = false, imprimiuAuto = false;
      var pc = 0;
      ciclo: while (pc < cmds.length) {
        if (++passos > 200000) throw new AbortSig("passos");
        var c = cmds[pc];
        if (c.cmd === "nop") { pc++; continue; }
        if (!seleciona(c, pc, ps, ln)) { if (c.cmd === "{") { pc = c.fim + 1; continue; } pc++; continue; }
        switch (c.cmd) {
          case "{": break;
          case "s": {
            var re = sedRegex(c.re, o.E, (c.fl.i ? "i" : "") + (c.fl.m ? "m" : ""), ultimo), cont = 0, feito = false;
            var novo = substituirPosix(ps, re, function (m) {
              cont++;
              if (cont < c.fl.n || (!c.fl.g && cont > c.fl.n)) return m[0];
              feito = true;
              return sedRep(c.rep, m, o.E);
            });
            if (feito) { ps = novo; subst = true; if (c.fl.p) saida.push(ps + nl); if (c.fl.w) escreverArq(c.fl.w, ps + "\n"); }
            break;
          }
          case "y": ps = Array.from(ps).map(function (ch) { var k = c.de.indexOf(ch); return k >= 0 ? c.para[k] : ch; }).join(""); break;
          case "p": saida.push(ps + nl); break;
          case "P": saida.push(ps.split("\n")[0] + nl); break;
          case "d": apagar = true; break ciclo;
          case "D": if (ps.indexOf("\n") < 0) { apagar = true; break ciclo; } ps = ps.slice(ps.indexOf("\n") + 1); reiniciar = true; break ciclo;
          case "n": if (!o.n) saida.push(ps + nl); if (ln >= n) { anexos.forEach(function (x) { saida.push(x); }); anexos = []; apagar = true; imprimiuAuto = true; break ciclo; } anexos.forEach(function (x) { saida.push(x); }); anexos = []; ps = linhas[ln++]; break;
          case "N": if (ln >= n) { break ciclo; } ps += "\n" + linhas[ln++]; break;
          case "h": hold = ps; break; case "H": hold += "\n" + ps; break;
          case "g": ps = hold; break; case "G": ps += "\n" + hold; break;
          case "x": var t = ps; ps = hold; hold = t; break;
          case "z": ps = ""; break;
          case "=": saida.push(ln + "\n"); break;
          case "l": saida.push(ps.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n") + "$\n"); break;
          case "a": anexos.push(c.txt + "\n"); break;
          case "i": saida.push(c.txt + "\n"); break;
          case "c": if (!c.a2 || !faixa[pc].ativa) saida.push(c.txt + "\n"); apagar = true; break ciclo;
          case "r": { var rr = sh.lerArquivo(c.arq); if (!rr.err) anexos.push(rr.txt); break; }
          case "w": escreverArq(c.arq, ps + "\n"); break;
          case "F": saida.push("-\n"); break;
          case "q": sair = c.n || 0; break ciclo;
          case "Q": sair = c.n || 0; apagar = true; imprimiuAuto = true; break ciclo;
          case "b": if (!c.rot) { pc = cmds.length; continue; } pc = prog.rotulos[c.rot]; continue;
          case "t": if (subst) { subst = false; if (!c.rot) { pc = cmds.length; continue; } pc = prog.rotulos[c.rot]; continue; } break;
          case "T": if (!subst) { if (!c.rot) { pc = cmds.length; continue; } pc = prog.rotulos[c.rot]; continue; } subst = false; break;
        }
        pc++;
      }
      if (!apagar && !o.n) saida.push(ps + nl);
      anexos.forEach(function (x) { saida.push(x); });
      if (reiniciar) { linhas.splice(ln, 0, ps); n++; }
      if (ln === n) ultimaSemNL = !apagar;
    }
    return { sair: sair, ultimaSemNL: ultimaSemNL };
  }

  /* ---------- awk (subconjunto do mawk 1.3.4) ---------- */
  function AwkErr(msg) { this.msg = msg; }
  // o mawk trabalha com bytes: dentro do awk as strings são "binárias" (1 caractere = 1 byte)
  function paraB(s) { var b = utf8bytes(s), r = ""; for (var i = 0; i < b.length; i += 8192) r += String.fromCharCode.apply(null, b.slice(i, i + 8192)); return r; }
  function deB(s) { var b = new Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return decodUtf8(b); }
  function AwkSai(code) { this.code = code; }
  function SN(s) { this.s = s; } // "strnum": texto vindo da entrada (campo, getline, ARGV…)
  SN.prototype.toString = function () { return this.s; };
  var AWK_KW = { BEGIN: 1, END: 1, "function": 1, func: 1, "if": 1, "else": 1, "while": 1, "for": 1, "do": 1, "break": 1, "continue": 1, next: 1, nextfile: 1, exit: 1, "return": 1, "delete": 1, getline: 1, print: 1, printf: 1, "in": 1 };
  var AWK_BUILTIN = { length: 1, substr: 1, index: 1, split: 1, sub: 1, gsub: 1, match: 1, sprintf: 1, tolower: 1, toupper: 1, "int": 1, sqrt: 1, exp: 1, log: 1, sin: 1, cos: 1, atan2: 1, rand: 1, srand: 1, system: 1, close: 1, fflush: 1 };
  function awkLexer(src) {
    var t = [], i = 0, ln = 1, prev = null;
    function push(tok) { tok.ln = ln; t.push(tok); prev = tok; }
    function operando() { return prev && (prev.t === "num" || prev.t === "str" || prev.t === "name" || prev.t === "builtin" || prev.t === "ere" || (prev.t === "op" && (prev.v === ")" || prev.v === "]" || prev.v === "$" || prev.v === "++" || prev.v === "--")) || (prev.t === "kw" && prev.v === "getline")); }
    while (i < src.length) {
      var c = src[i], m;
      if (c === "\\" && src[i + 1] === "\n") { i += 2; ln++; continue; }
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "\n") { push({ t: "nl" }); i++; ln++; continue; }
      if ((m = /^([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?/.exec(src.slice(i)))) { push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if (c === '"') {
        var s = "", j = i + 1;
        while (j < src.length && src[j] !== '"') {
          if (src[j] === "\\") {
            var n = src[j + 1], mm;
            var mapa = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "/": "/", a: "\x07", b: "\b", f: "\f", v: "\v" };
            if (hasOwn(mapa, n)) { s += mapa[n]; j += 2; continue; }
            if ((mm = /^[0-7]{1,3}/.exec(src.slice(j + 1)))) { s += String.fromCharCode(parseInt(mm[0], 8)); j += 1 + mm[0].length; continue; }
            if (n === "\n") { j += 2; ln++; continue; }
            s += "\\" + n; j += 2; continue;
          }
          if (src[j] === "\n") throw new AwkErr("line " + ln + ": runaway string constant \"" + s.slice(0, 10) + " ...");
          s += src[j]; j++;
        }
        if (j >= src.length) throw new AwkErr("line " + ln + ": runaway string constant \"" + s.slice(0, 10) + " ...");
        push({ t: "str", v: s }); i = j + 1; continue;
      }
      if (c === "/" && !operando()) {
        var r = "", k = i + 1, emCls = false;
        while (k < src.length && (src[k] !== "/" || emCls)) {
          if (src[k] === "\\" && k + 1 < src.length) { r += src[k] + src[k + 1]; k += 2; continue; }
          if (src[k] === "[") emCls = true; else if (src[k] === "]") emCls = false;
          if (src[k] === "\n") throw new AwkErr("line " + ln + ": runaway regular expression /" + r.slice(0, 10) + " ...");
          r += src[k]; k++;
        }
        if (k >= src.length) throw new AwkErr("line " + ln + ": runaway regular expression /" + r.slice(0, 10) + " ...");
        push({ t: "ere", v: r }); i = k + 1; continue;
      }
      if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)))) {
        var w = m[0]; i += w.length;
        if (AWK_KW[w]) push({ t: "kw", v: w === "func" ? "function" : w });
        else if (AWK_BUILTIN[w]) push({ t: "builtin", v: w });
        else push({ t: src[i] === "(" ? "fname" : "name", v: w });
        continue;
      }
      if ((m = /^(\+\+|--|\+=|-=|\*=|\/=|%=|\^=|\*\*=|\*\*|==|<=|>=|!=|!~|&&|\|\||>>|[-+*\/%^!<>=~?:,;{}()\[\]$|])/.exec(src.slice(i)))) {
        var v = m[0] === "**" ? "^" : m[0] === "**=" ? "^=" : m[0];
        push({ t: "op", v: v }); i += m[0].length; continue;
      }
      throw new AwkErr("line " + ln + ": syntax error at or near " + c);
    }
    push({ t: "eof" });
    return t;
  }
  function AwkParser(toks) { this.t = toks; this.p = 0; this.funcs = {}; }
  var APR = AwkParser.prototype;
  APR.peek = function (o) { return this.t[this.p + (o || 0)]; };
  APR.next = function () { return this.t[this.p++]; };
  APR.ehOp = function (v) { var t = this.peek(); return t.t === "op" && t.v === v; };
  APR.erro = function (t) { t = t || this.peek(); var perto = t.t === "eof" ? "end of file" : t.t === "nl" ? "end of line" : t.t === "str" ? "\"" + t.v + "\"" : t.t === "ere" ? "/" + t.v + "/" : String(t.v); return new AwkErr("line " + t.ln + ": syntax error at or near " + perto); };
  APR.espera = function (v) { var t = this.next(); if (!((t.t === "op" || t.t === "kw") && t.v === v)) { if (t.t === "eof" && v === "}") throw new AwkErr("line " + t.ln + ": missing } near end of file"); throw this.erro(t); } return t; };
  APR.nls = function () { while (this.peek().t === "nl") this.p++; };
  APR.terms = function () { while (this.peek().t === "nl" || this.ehOp(";")) this.p++; };
  APR.programa = function () {
    var itens = [];
    this.terms();
    while (this.peek().t !== "eof") {
      var t = this.peek();
      if (t.t === "kw" && t.v === "function") {
        this.next(); var nt = this.next(); var nome = nt.v;
        this.espera("("); var params = [];
        while (!this.ehOp(")")) { params.push(this.next().v); if (this.ehOp(",")) { this.next(); this.nls(); } }
        this.next(); this.nls();
        this.funcs[nome] = { params: params, corpo: this.bloco() };
      } else if (t.t === "kw" && (t.v === "BEGIN" || t.v === "END")) {
        this.next(); this.nls();
        itens.push({ tipo: t.v, acao: this.bloco() });
      } else {
        var pat = null, pat2 = null;
        if (!this.ehOp("{")) {
          pat = this.expr();
          if (this.ehOp(",")) { this.next(); this.nls(); pat2 = this.expr(); }
        }
        var acao = this.ehOp("{") ? this.bloco() : null;
        itens.push({ tipo: "main", pat: pat, pat2: pat2, acao: acao, ativo: false });
      }
      this.terms();
    }
    return itens;
  };
  APR.bloco = function () {
    this.espera("{");
    var l = [];
    this.terms();
    while (!this.ehOp("}")) {
      if (this.peek().t === "eof") throw new AwkErr("line " + this.peek().ln + ": missing } near end of file");
      l.push(this.stmt()); this.terms();
    }
    this.next();
    return { k: "bloco", l: l };
  };
  APR.fimStmt = function () {
    var t = this.peek();
    if (t.t === "nl" || (t.t === "op" && t.v === ";")) { this.next(); return; }
    if (t.t === "op" && t.v === "}") return;
    if (t.t === "eof") return;
    throw this.erro(t);
  };
  APR.stmtSimplesOuBloco = function () { this.nls(); if (this.ehOp(";")) { this.next(); return { k: "bloco", l: [] }; } return this.stmt(); };
  APR.stmt = function () {
    var t = this.peek();
    if (t.t === "op" && t.v === "{") return this.bloco();
    if (t.t === "kw") {
      switch (t.v) {
        case "if": {
          this.next(); this.espera("("); var c = this.expr(); this.espera(")");
          var s1 = this.stmtSimplesOuBloco(), sv = this.p; this.terms();
          if (this.peek().t === "kw" && this.peek().v === "else") { this.next(); return { k: "if", c: c, s1: s1, s2: this.stmtSimplesOuBloco() }; }
          this.p = sv;
          return { k: "if", c: c, s1: s1 };
        }
        case "while": { this.next(); this.espera("("); var c2 = this.expr(); this.espera(")"); if (this.ehOp(";")) { this.next(); return { k: "while", c: c2, s: { k: "bloco", l: [] } }; } return { k: "while", c: c2, s: this.stmtSimplesOuBloco() }; }
        case "do": { this.next(); var s = this.stmtSimplesOuBloco(); this.terms(); if (!(this.peek().t === "kw" && this.peek().v === "while")) throw this.erro(); this.next(); this.espera("("); var c3 = this.expr(); this.espera(")"); this.fimStmt(); return { k: "do", c: c3, s: s }; }
        case "for": {
          this.next(); this.espera("(");
          if (this.peek().t === "name" && this.peek(1).t === "kw" && this.peek(1).v === "in" && this.peek(3) && this.peek(2).t === "name" && this.peek(3).t === "op" && this.peek(3).v === ")") {
            var v = this.next().v; this.next(); var arr = this.next().v; this.espera(")");
            return { k: "forin", v: v, arr: arr, s: this.stmtSimplesOuBloco() };
          }
          var a = this.ehOp(";") ? null : this.simples(); this.espera(";"); this.nls();
          var b = this.ehOp(";") ? null : this.expr(); this.espera(";"); this.nls();
          var c4 = this.ehOp(")") ? null : this.simples(); this.espera(")");
          if (this.ehOp(";")) { this.next(); return { k: "for", a: a, b: b, c: c4, s: { k: "bloco", l: [] } }; }
          return { k: "for", a: a, b: b, c: c4, s: this.stmtSimplesOuBloco() };
        }
        case "break": this.next(); this.fimStmt(); return { k: "break" };
        case "continue": this.next(); this.fimStmt(); return { k: "continue" };
        case "next": this.next(); this.fimStmt(); return { k: "next" };
        case "nextfile": this.next(); this.fimStmt(); return { k: "nextfile" };
        case "exit": { this.next(); var e = this.fimExpr() ? null : this.expr(); this.fimStmt(); return { k: "exit", e: e }; }
        case "return": { this.next(); var e2 = this.fimExpr() ? null : this.expr(); this.fimStmt(); return { k: "return", e: e2 }; }
        case "delete": { this.next(); var nome = this.next().v; var idx = null; if (this.ehOp("[")) { this.next(); idx = this.exprLista(); this.espera("]"); } this.fimStmt(); return { k: "delete", n: nome, idx: idx }; }
      }
    }
    if (this.ehOp(";")) { this.next(); return { k: "bloco", l: [] }; }
    var st = this.simples();
    this.fimStmt();
    return st;
  };
  APR.fimExpr = function () { var t = this.peek(); return t.t === "nl" || t.t === "eof" || (t.t === "op" && (t.v === ";" || t.v === "}")); };
  APR.simples = function () {
    var t = this.peek();
    if (t.t === "kw" && (t.v === "print" || t.v === "printf")) {
      this.next();
      var args = [];
      if (this.ehOp("(")) {
        // print (a,b) > "x"  ou  print (a)(b)
        var sv = this.p;
        this.next();
        var l = this.exprListaPrint(false);
        if (this.ehOp(")") ) {
          this.next();
          if (this.fimExpr() || this.ehOp(">") || this.ehOp(">>") || this.ehOp("|")) args = l;
          else { this.p = sv; args = this.exprListaPrint(true); }
        } else { this.p = sv; args = this.exprListaPrint(true); }
      } else if (!this.fimExpr() && !this.ehOp(">") && !this.ehOp(">>") && !this.ehOp("|")) args = this.exprListaPrint(true);
      var red = null;
      if (this.ehOp(">") || this.ehOp(">>") || this.ehOp("|")) { var op = this.next().v; red = { op: op, e: this.concat(true) }; }
      return { k: t.v, args: args, red: red };
    }
    return { k: "expr", e: this.expr() };
  };
  APR.exprListaPrint = function (semGt) {
    var l = [this.expr(semGt)];
    while (this.ehOp(",")) { this.next(); this.nls(); l.push(this.expr(semGt)); }
    return l;
  };
  APR.exprLista = function () { var l = [this.expr()]; while (this.ehOp(",")) { this.next(); this.nls(); l.push(this.expr()); } return l; };
  APR.expr = function (semGt) { return this.ternario(semGt); };
  APR.ternario = function (semGt) {
    var c = this.ou(semGt);
    if (this.ehOp("?")) { this.next(); this.nls(); var a = this.ternario(semGt); this.nls(); this.espera(":"); this.nls(); var b = this.ternario(semGt); return { k: "?", c: c, a: a, b: b }; }
    if (this.peek().t === "op" && /^([-+*\/%^]?=)$/.test(this.peek().v) && c && (c.k === "var" || c.k === "idx" || c.k === "campo")) {
      var op = this.next().v; this.nls();
      return { k: "atr", op: op, alvo: c, e: this.ternario(semGt) };
    }
    return c;
  };
  APR.ou = function (semGt) { var a = this.e_(semGt); while (this.ehOp("||")) { this.next(); this.nls(); a = { k: "||", a: a, b: this.e_(semGt) }; } return a; };
  APR.e_ = function (semGt) { var a = this.emIn(semGt); while (this.ehOp("&&")) { this.next(); this.nls(); a = { k: "&&", a: a, b: this.emIn(semGt) }; } return a; };
  APR.emIn = function (semGt) { var a = this.casa(semGt); while (this.peek().t === "kw" && this.peek().v === "in") { this.next(); a = { k: "in", idx: a.k === "grupo" ? a.l : [a], arr: this.next().v }; } return a; };
  APR.casa = function (semGt) { var a = this.rel(semGt); while (this.ehOp("~") || this.ehOp("!~")) { var o = this.next().v; a = { k: o, a: a, b: this.rel(semGt) }; } return a; };
  APR.rel = function (semGt) {
    var a = this.concat(semGt);
    var t = this.peek();
    if (t.t === "op" && (t.v === "<" || t.v === "<=" || t.v === "!=" || t.v === "==" || t.v === ">=" || (t.v === ">" && !semGt))) { this.next(); a = { k: "cmp", o: t.v, a: a, b: this.concat(semGt) }; }
    return a;
  };
  APR.iniciaOperando = function () {
    var t = this.peek();
    if (t.t === "num" || t.t === "str" || t.t === "ere" || t.t === "name" || t.t === "fname" || t.t === "builtin") return true;
    if (t.t === "op" && (t.v === "$" || t.v === "!" || t.v === "(" || t.v === "-" || t.v === "+" || t.v === "++" || t.v === "--")) return true;
    if (t.t === "kw" && t.v === "getline") return true;
    return false;
  };
  APR.concat = function (semGt) {
    var a = this.soma();
    while (this.iniciaOperando() && !(this.peek().t === "kw" && this.peek().v === "in")) {
      if (this.ehOp("-") || this.ehOp("+")) break;
      a = { k: "concat", a: a, b: this.soma() };
    }
    // cmd | getline
    while (this.ehOp("|") && this.peek(1).t === "kw" && this.peek(1).v === "getline") {
      this.next(); this.next();
      var alvo = this.ehLvalInicio() ? this.primario() : null;
      a = { k: "getline", cmd: a, alvo: alvo };
    }
    return a;
  };
  APR.ehLvalInicio = function () { var t = this.peek(); return t.t === "name" || (t.t === "op" && t.v === "$"); };
  APR.soma = function () { var a = this.mult(); while (this.ehOp("+") || this.ehOp("-")) { var o = this.next().v; a = { k: "bin", o: o, a: a, b: this.mult() }; } return a; };
  APR.mult = function () { var a = this.unario(); while (this.ehOp("*") || this.ehOp("/") || this.ehOp("%")) { var o = this.next().v; a = { k: "bin", o: o, a: a, b: this.unario() }; } return a; };
  APR.unario = function () {
    if (this.ehOp("!")) { this.next(); return { k: "not", a: this.unario() }; }
    if (this.ehOp("-")) { this.next(); return { k: "neg", a: this.unario() }; }
    if (this.ehOp("+")) { this.next(); return { k: "pos", a: this.unario() }; }
    return this.pot();
  };
  APR.pot = function () { var a = this.incr(); if (this.ehOp("^")) { this.next(); return { k: "bin", o: "^", a: a, b: this.unarioPot() }; } return a; };
  APR.unarioPot = function () { if (this.ehOp("-")) { this.next(); return { k: "neg", a: this.unarioPot() }; } if (this.ehOp("+")) { this.next(); return this.unarioPot(); } if (this.ehOp("!")) { this.next(); return { k: "not", a: this.unarioPot() }; } return this.pot(); };
  APR.incr = function () {
    if (this.ehOp("++") || this.ehOp("--")) { var o = this.next().v; var lv = this.primario(); return { k: "pre", o: o, alvo: lv }; }
    var e = this.primario();
    if ((this.ehOp("++") || this.ehOp("--")) && (e.k === "var" || e.k === "idx" || e.k === "campo")) { var o2 = this.next().v; return { k: "post", o: o2, alvo: e }; }
    return e;
  };
  APR.primario = function () {
    var t = this.next();
    switch (t.t) {
      case "num": return { k: "num", v: t.v };
      case "str": return { k: "str", v: t.v };
      case "ere": return { k: "ere", v: t.v };
      case "name":
        if (this.ehOp("[")) { this.next(); var idx = this.exprLista(); this.espera("]"); return { k: "idx", n: t.v, idx: idx }; }
        return { k: "var", n: t.v };
      case "fname": {
        (this.chamadas = this.chamadas || []).push(t.v);
        this.espera("("); var args = []; this.nls();
        while (!this.ehOp(")")) { args.push(this.expr()); this.nls(); if (this.ehOp(",")) { this.next(); this.nls(); } }
        this.next();
        return { k: "call", n: t.v, args: args };
      }
      case "builtin": {
        var args2 = [];
        if (this.ehOp("(")) { this.next(); this.nls(); while (!this.ehOp(")")) { args2.push(this.expr()); this.nls(); if (this.ehOp(",")) { this.next(); this.nls(); } } this.next(); }
        else if (t.v !== "length") throw this.erro();
        return { k: "bcall", n: t.v, args: args2 };
      }
      case "kw":
        if (t.v === "getline") {
          var alvo = this.ehLvalInicio() ? this.primarioLval() : null;
          var arq = null;
          if (this.ehOp("<")) { this.next(); arq = this.primarioSemConcat(); }
          return { k: "getline", alvo: alvo, arq: arq };
        }
        break;
      case "op":
        if (t.v === "$") { var e = this.incrCampo(); return { k: "campo", e: e }; }
        if (t.v === "(") {
          this.nls();
          var l = this.exprLista(); this.nls(); this.espera(")");
          if (l.length > 1) { if (this.peek().t === "kw" && this.peek().v === "in") return { k: "grupo", l: l }; throw this.erro(); }
          return { k: "paren", e: l[0] };
        }
        if (t.v === "-") return { k: "neg", a: this.unario() };
        if (t.v === "!") return { k: "not", a: this.unario() };
    }
    this.p--;
    throw this.erro(t);
  };
  APR.primarioLval = function () { var t = this.next(); if (t.t === "name") { if (this.ehOp("[")) { this.next(); var idx = this.exprLista(); this.espera("]"); return { k: "idx", n: t.v, idx: idx }; } return { k: "var", n: t.v }; } if (t.t === "op" && t.v === "$") return { k: "campo", e: this.incrCampo() }; throw this.erro(t); };
  APR.primarioSemConcat = function () { return this.incr(); };
  APR.incrCampo = function () {
    if (this.ehOp("++") || this.ehOp("--")) { var o = this.next().v; return { k: "pre", o: o, alvo: this.primario() }; }
    if (this.ehOp("-")) { this.next(); return { k: "neg", a: this.incrCampo() }; }
    return this.primario();
  };

  function Awk(io, prog, funcs, dec) {
    this.io = io; this.prog = prog; this.funcs = funcs; this.dec = dec;
    this.v = {}; this.arr = {};
    this.campos = [""]; this.nf = 0; this.registro = "";
    this.saidas = {}; this.entradas = {};
    this.semente = 0; this.rndEstado = 1;
    this.passos = 0;
  }
  var AW = Awk.prototype;
  AW.num = function (x) {
    if (typeof x === "number") return x;
    var s = x instanceof SN ? x.s : String(x);
    var re = this.dec === "," ? /^\s*[-+]?([0-9]+,?[0-9]*|,[0-9]+)([eE][-+]?[0-9]+)?/ : /^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?/;
    var m = re.exec(s);
    if (!m) { var mm = /^\s*[-+]?(inf|infinity|nan)/i.exec(s); if (mm) return parseFloat(mm[0]); return 0; }
    return parseFloat(m[0].replace(",", "."));
  };
  AW.ehNumerico = function (x) { // strnum que parece número
    if (typeof x === "number") return true;
    if (!(x instanceof SN)) return false;
    var re = this.dec === "," ? /^\s*[-+]?([0-9]+,?[0-9]*|,[0-9]+)([eE][-+]?[0-9]+)?\s*$/ : /^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$/;
    return re.test(x.s);
  };
  AW.fmtNum = function (n, fmt) {
    if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
    if (!isFinite(n)) return isNaN(n) ? (n < 0 ? "-nan" : "nan") : (n < 0 ? "-inf" : "inf");
    return this.sprintf(fmt, [n]);
  };
  AW.str = function (x) {
    if (typeof x === "number") return this.fmtNum(x, this.getVar("CONVFMT") ? this.str(this.getVar("CONVFMT")) : "%.6g");
    if (x === undefined || x === null) return "";
    return x instanceof SN ? x.s : String(x);
  };
  AW.strOut = function (x) { if (typeof x === "number") return this.fmtNum(x, this.str(this.getVar("OFMT") || "%.6g")); return this.str(x); };
  AW.bool = function (x) { if (typeof x === "number") return x !== 0; if (x instanceof SN) return this.ehNumerico(x) ? this.num(x) !== 0 : x.s !== ""; return String(x) !== ""; };
  AW.getVar = function (n) {
    if (n === "NF") return this.nf;
    return hasOwn(this.v, n) ? this.v[n] : "";
  };
  AW.setVar = function (n, val) {
    if (hasOwn(this.arr, n)) throw new AwkErr("run time error: can't assign to " + n + "; it's an array name.");
    if (n === "NF") { this.setNF(Math.floor(this.num(val))); return; }
    this.v[n] = val;
  };
  AW.dividir = function (s, fs) {
    if (fs === " ") return s.split(/[ \t\n]+/).filter(function (x) { return x !== ""; });
    if (s === "") return [];
    if (fs.length === 1 && fs !== "\\") { if (fs === "\t" || !/[.[\]()*+?^$|{}]/.test(fs)) return s.split(fs); }
    var re = criarRegex(ereParaJs(fs, { ascii: true }), "");
    return s.split(re);
  };
  AW.setRegistro = function (s) {
    this.registro = s;
    var fs = this.str(this.getVar("FS"));
    var cs = this.dividir(s, fs);
    this.campos = [s].concat(cs);
    this.nf = cs.length;
    this.dirty = false;
  };
  AW.reconstruir = function () {
    var ofs = this.str(this.getVar("OFS")), cs = [];
    for (var i = 1; i <= this.nf; i++) cs.push(this.str(this.campos[i] === undefined ? "" : this.campos[i]));
    this.registro = cs.join(ofs);
    this.campos[0] = this.registro;
  };
  AW.setNF = function (n) {
    if (n < 0) n = 0;
    for (var i = this.nf + 1; i <= n; i++) this.campos[i] = "";
    this.campos.length = n + 1;
    this.nf = n;
    this.reconstruir();
  };
  AW.getCampo = function (i) {
    i = Math.floor(this.num(i));
    if (i < 0) throw new AwkErr("run time error: negative field index $" + i);
    if (i === 0) return new SN(this.registro);
    if (i > this.nf) return new SN("");
    var c = this.campos[i];
    return c instanceof SN || typeof c === "number" ? c : new SN(String(c));
  };
  AW.setCampo = function (i, val) {
    i = Math.floor(this.num(i));
    if (i === 0) { this.setRegistro(this.str(val)); return; }
    if (i > this.nf) { for (var k = this.nf + 1; k < i; k++) this.campos[k] = ""; this.nf = i; }
    this.campos[i] = typeof val === "number" ? this.str(val) : val;
    this.reconstruir();
  };
  AW.chave = function (idx) { var self = this; return idx.map(function (e) { var v = self.ev(e); return typeof v === "number" ? self.str(v) : self.str(v); }).join(this.str(this.getVar("SUBSEP"))); };
  AW.array = function (n) {
    if (hasOwn(this.v, n) && this.v[n] !== "") throw new AwkErr("run time error: can't use scalar " + n + " as array");
    if (!hasOwn(this.arr, n)) this.arr[n] = new Map();
    return this.arr[n];
  };
  AW.regex = function (e) {
    var src = e.k === "ere" ? e.v : this.str(this.ev(e));
    var c = this.cacheRe = this.cacheRe || {};
    if (!c[src]) { var r = criarRegex(ereParaJs(src, { ascii: true }), ""); if (!r) throw new AwkErr("run time error: regular expression compile failed (missing operand)\n" + src); c[src] = r; }
    return c[src];
  };
  AW.cmp = function (a, b) {
    var na = typeof a === "number" || (a instanceof SN && this.ehNumerico(a)), nb = typeof b === "number" || (b instanceof SN && this.ehNumerico(b));
    if (na && nb) { var x = this.num(a), y = this.num(b); return x < y ? -1 : x > y ? 1 : 0; }
    var s = this.str(a), t = this.str(b);
    return s < t ? -1 : s > t ? 1 : 0;
  };
  AW.atribuir = function (alvo, val) {
    if (alvo.k === "var") this.setVar(alvo.n, val);
    else if (alvo.k === "idx") this.array(alvo.n).set(this.chave(alvo.idx), val);
    else if (alvo.k === "campo") this.setCampo(this.ev(alvo.e), val);
    else throw new AwkErr("syntax error");
    return val;
  };
  AW.ler = function (alvo) {
    if (alvo.k === "var") return this.getVar(alvo.n);
    if (alvo.k === "idx") { var m = this.array(alvo.n), k = this.chave(alvo.idx); if (!m.has(k)) m.set(k, ""); return m.get(k); }
    if (alvo.k === "campo") return this.getCampo(this.ev(alvo.e));
  };
  AW.ev = function (e) {
    if (++this.passos > 3000000) throw new AbortSig("passos");
    switch (e.k) {
      case "num": return e.v;
      case "str": return e.v;
      case "ere": { var r = this.regex(e); r.lastIndex = 0; return r.test(this.registro) ? 1 : 0; }
      case "var": return this.getVar(e.n);
      case "idx": return this.ler(e);
      case "campo": return this.getCampo(this.ev(e.e));
      case "paren": return this.ev(e.e);
      case "grupo": return this.ev(e.l[0]);
      case "atr": {
        var v = this.ev(e.e);
        if (e.op !== "=") { var cur = this.num(this.ler(e.alvo)), x = this.num(v); v = this.aritm(e.op[0], cur, x); }
        else if (v instanceof SN) { /* mantém strnum */ }
        return this.atribuir(e.alvo, v);
      }
      case "pre": case "post": { var cur2 = this.num(this.ler(e.alvo)); var novo = e.o === "++" ? cur2 + 1 : cur2 - 1; this.atribuir(e.alvo, novo); return e.k === "pre" ? novo : cur2; }
      case "?": return this.bool(this.ev(e.c)) ? this.ev(e.a) : this.ev(e.b);
      case "||": return this.bool(this.ev(e.a)) || this.bool(this.ev(e.b)) ? 1 : 0;
      case "&&": return this.bool(this.ev(e.a)) && this.bool(this.ev(e.b)) ? 1 : 0;
      case "in": return this.array(e.arr).has(this.chave(e.idx)) ? 1 : 0;
      case "~": case "!~": { var s = this.str(this.ev(e.a)), re = this.regex(e.b); re.lastIndex = 0; var ok = re.test(s); return (e.k === "~" ? ok : !ok) ? 1 : 0; }
      case "cmp": { var c = this.cmp(this.ev(e.a), this.ev(e.b)); switch (e.o) { case "<": return c < 0 ? 1 : 0; case "<=": return c <= 0 ? 1 : 0; case ">": return c > 0 ? 1 : 0; case ">=": return c >= 0 ? 1 : 0; case "==": return c === 0 ? 1 : 0; case "!=": return c !== 0 ? 1 : 0; } return 0; }
      case "concat": return this.str(this.ev(e.a)) + this.str(this.ev(e.b));
      case "bin": return this.aritm(e.o, this.num(this.ev(e.a)), this.num(this.ev(e.b)));
      case "neg": return -this.num(this.ev(e.a));
      case "pos": return this.num(this.ev(e.a));
      case "not": return this.bool(this.ev(e.a)) ? 0 : 1;
      case "bcall": return this.builtin(e.n, e.args);
      case "call": return this.chamar(e.n, e.args);
      case "getline": return this.getline(e);
    }
    throw new AwkErr("expressão desconhecida");
  };
  AW.aritm = function (o, a, b) {
    switch (o) {
      case "+": return a + b; case "-": return a - b; case "*": return a * b;
      case "/": if (b === 0) throw new AwkErr("division by zero"); return a / b;
      case "%": if (b === 0) throw new AwkErr("division by zero in %"); return a % b;
      case "^": return Math.pow(a, b);
    }
    return 0;
  };
  AW.sprintf = function (fmt, vals, nomeF) {
    var self = this, i = 0, dec = this.dec, faltou = false;
    var r = fmt.replace(/%([-+ #0]*)(\*|[0-9]+)?(?:\.(\*|[0-9]*))?([cdiouxXeEfgGs%])/g, function (m, fl, w, p, c) {
      if (c === "%") return "%";
      if (faltou) return "";
      if (w === "*") w = String(Math.floor(self.num(vals[i++])));
      if (p === "*") p = String(Math.floor(self.num(vals[i++])));
      if (i >= vals.length) { faltou = true; return "\u0000FALHOU\u0000"; }
      var v = vals[i++];
      var larg = w ? parseInt(w, 10) : null, prec = p !== undefined ? (p === "" ? 0 : parseInt(p, 10)) : null;
      if (larg !== null && larg < 0) { fl += "-"; larg = -larg; }
      var s;
      if (c === "s") { s = v === undefined ? "" : self.str(v); if (prec !== null) s = s.slice(0, prec); }
      else if (c === "c") { if (typeof v === "number") s = String.fromCharCode(Math.floor(v) & 255); else { s = v === undefined ? "" : self.str(v).charAt(0); } }
      else {
        var n = v === undefined ? 0 : self.num(v);
        if (c === "d" || c === "i") { n = Math.trunc(n); return formatarNum("d", fl, larg, prec, isFinite(n) ? n : 0, dec); }
        if (c === "u") return formatarNum("u", fl, larg, prec, Math.trunc(n) >>> 0, dec);
        if (c === "o" || c === "x" || c === "X") return formatarNum(c, fl, larg, prec, Math.trunc(n), dec);
        return formatarNum(c, fl, larg, prec, n, dec);
      }
      if (larg !== null) { var wl = s.length; while (wl < larg) { s = fl.indexOf("-") >= 0 ? s + " " : " " + s; wl++; } }
      return s;
    });
    if (faltou) { var e = new AwkErr("run time error: not enough arguments passed to " + (nomeF || "sprintf") + "(\"" + fmt + "\")"); e.parcial = r.slice(0, r.indexOf("\u0000FALHOU\u0000")); throw e; }
    return r;
  };
  AW.alvoDe = function (e) { return e && (e.k === "var" || e.k === "idx" || e.k === "campo") ? e : null; };
  AW.subst = function (args, global) {
    var re = this.regex(args[0]), rep = this.str(this.ev(args[1]));
    var alvo = args[2] ? this.alvoDe(args[2]) : { k: "campo", e: { k: "num", v: 0 } };
    if (!alvo) throw new AwkErr("syntax error");
    var s = this.str(this.ler(alvo)), n = 0, self = this;
    var rx = new RegExp(re.source, re.flags.replace("g", "") + "g");
    var out = "", pos = 0, m;
    rx.lastIndex = 0;
    while ((m = rx.exec(s))) {
      out += s.slice(pos, m.index);
      var r = "";
      for (var k = 0; k < rep.length; k++) {
        if (rep[k] === "\\" && rep[k + 1] === "&") { r += "&"; k++; continue; }
        if (rep[k] === "\\" && rep[k + 1] === "\\") { r += "\\"; k++; continue; }
        r += rep[k] === "&" ? m[0] : rep[k];
      }
      out += r; n++;
      pos = m.index + m[0].length;
      if (m[0] === "") { if (m.index < s.length) out += s[m.index]; pos = m.index + 1; rx.lastIndex = m.index + 1; }
      if (!global) break;
    }
    if (!n) return 0;
    out += s.slice(pos);
    this.atribuir(alvo, out);
    return n;
  };
  AW.builtin = function (n, args) {
    var self = this;
    var a = function (i) { return self.ev(args[i]); };
    switch (n) {
      case "length": if (!args.length) return this.registro.length; if (args[0].k === "var" && hasOwn(this.arr, args[0].n)) return this.arr[args[0].n].size; return this.str(a(0)).length;
      case "substr": {
        var s = this.str(a(0)), L = s.length, ini = Math.trunc(this.num(a(1)));
        var len = args.length > 2 ? Math.trunc(this.num(a(2))) : L;
        if (ini < 1) { if (args.length > 2) len -= ini; ini = 1; }
        if (len <= 0) return "";
        return s.substr(ini - 1, len);
      }
      case "index": { var s1 = this.str(a(0)), t = this.str(a(1)), i = s1.indexOf(t); return i < 0 ? 0 : i + 1; }
      case "split": {
        var s2 = this.str(a(0)), nome = args[1].n, fs = args[2] ? (args[2].k === "ere" ? null : this.str(a(2))) : this.str(this.getVar("FS"));
        var partes = args[2] && args[2].k === "ere" ? (s2 === "" ? [] : s2.split(this.regex(args[2]))) : this.dividir(s2, fs);
        var m2 = new Map(); partes.forEach(function (p, i) { m2.set(String(i + 1), new SN(p)); });
        this.arr[nome] = m2; delete this.v[nome];
        return partes.length;
      }
      case "sub": return this.subst(args, false);
      case "gsub": return this.subst(args, true);
      case "match": {
        var s3 = this.str(a(0)), re = this.regex(args[1]); re.lastIndex = 0;
        var mm = re.exec(s3);
        if (!mm) { this.v.RSTART = 0; this.v.RLENGTH = -1; return 0; }
        this.v.RSTART = mm.index + 1; this.v.RLENGTH = mm[0].length;
        return this.v.RSTART;
      }
      case "sprintf": return this.sprintf(this.str(a(0)), args.slice(1).map(function (x) { return self.ev(x); }));
      case "tolower": return this.str(a(0)).replace(/[A-Z]+/g, function (x) { return x.toLowerCase(); });
      case "toupper": return this.str(a(0)).replace(/[a-z]+/g, function (x) { return x.toUpperCase(); });
      case "int": return Math.trunc(this.num(a(0)));
      case "sqrt": return Math.sqrt(this.num(a(0)));
      case "exp": return Math.exp(this.num(a(0)));
      case "log": return Math.log(this.num(a(0)));
      case "sin": return Math.sin(this.num(a(0)));
      case "cos": return Math.cos(this.num(a(0)));
      case "atan2": return Math.atan2(this.num(a(0)), this.num(a(1)));
      case "rand": this.rndEstado = (this.rndEstado * 1103515245 + 12345) % 2147483648; return this.rndEstado / 2147483648;
      case "srand": { var ant = this.semente; this.semente = args.length ? this.num(a(0)) : Math.floor(this.io.sh.k.clock / 1000); this.rndEstado = Math.floor(this.semente) || 1; return ant; }
      case "system": { this.flush(); var cmd = deB(this.str(a(0))); return this.io.sh.k.rodarAninhado(this.io.sh, cmd, null); }
      case "close": { var nm = this.str(a(0)); if (this.saidas[nm]) { var sd = this.saidas[nm]; delete this.saidas[nm]; if (sd.pipe) { this.flush(); return this.io.sh.k.rodarAninhado(this.io.sh, deB(nm), deB(sd.buf)); } if (sd.ofd) unref(sd.ofd); return 0; } if (this.entradas[nm]) { delete this.entradas[nm]; return 0; } return -1; }
      case "fflush": return 0;
    }
    return 0;
  };
  AW.chamar = function (n, args) {
    var f = this.funcs[n];
    if (!f) throw new AwkErr("function " + n + " never defined");
    if (args.length > f.params.length) throw new AwkErr("too many arguments in call to " + n);
    var self = this, salvoV = {}, salvoA = {};
    var vals = args.map(function (x) {
      if (x.k === "var" && (hasOwn(self.arr, x.n))) return { arr: self.arr[x.n] };
      if (x.k === "var" && !hasOwn(self.v, x.n) && !hasOwn(self.arr, x.n)) return { talvezArr: x.n };
      return { v: self.ev(x) };
    });
    f.params.forEach(function (p, i) {
      salvoV[p] = hasOwn(self.v, p) ? self.v[p] : undefined; salvoA[p] = hasOwn(self.arr, p) ? self.arr[p] : undefined;
      delete self.v[p]; delete self.arr[p];
      var x = vals[i];
      if (!x) return;
      if (x.arr) self.arr[p] = x.arr;
      else if (x.talvezArr) { var m = new Map(); self.arr[p] = m; x.mapa = m; }
      else self.v[p] = x.v;
    });
    var ret = "";
    this.prof = (this.prof || 0) + 1;
    if (this.prof > 1000) throw new AwkErr("function call nesting too deep");
    try { this.exec(f.corpo); }
    catch (e) { if (e && e.ret) ret = e.v; else throw e; }
    finally {
      this.prof--;
      f.params.forEach(function (p, i) {
        var x = vals[i];
        if (x && x.talvezArr && self.arr[p] && self.arr[p].size) { self.arr[x.talvezArr] = self.arr[p]; }
        delete self.v[p]; delete self.arr[p];
        if (salvoV[p] !== undefined) self.v[p] = salvoV[p];
        if (salvoA[p] !== undefined) self.arr[p] = salvoA[p];
      });
    }
    return ret;
  };
  AW.getline = function (e) {
    var linha = null;
    if (e.cmd) {
      var cmd = this.str(this.ev(e.cmd));
      if (!this.entradas[cmd]) { this.flush(); var out = paraB(this.io.sh.k.capturarAninhado(this.io.sh, deB(cmd))); this.entradas[cmd] = { linhas: linhasDe(out), i: 0 }; }
      var en = this.entradas[cmd];
      if (en.i >= en.linhas.length) return 0;
      linha = en.linhas[en.i++];
      if (!e.alvo) { this.setRegistro(linha); this.v.NR = this.num(this.getVar("NR")) + 1; }
      else { this.atribuir(e.alvo, new SN(linha)); this.v.NR = this.num(this.getVar("NR")) + 1; }
      return 1;
    }
    if (e.arq) {
      var nome = this.str(this.ev(e.arq));
      if (!this.entradas[nome]) {
        var r = nome === "-" || nome === "/dev/stdin" ? { txt: this.lerStdinSync() } : this.io.sh.lerArquivo(deB(nome));
        if (r.err) return -1;
        this.entradas[nome] = { linhas: linhasDe(nome === "-" || nome === "/dev/stdin" ? r.txt : paraB(r.txt || "")), i: 0 };
      }
      var en2 = this.entradas[nome];
      if (en2.i >= en2.linhas.length) return 0;
      linha = en2.linhas[en2.i++];
      if (!e.alvo) this.setRegistro(linha); else this.atribuir(e.alvo, new SN(linha));
      return 1;
    }
    var l = this.proxRegistro();
    if (l === null) return 0;
    this.v.NR = this.num(this.getVar("NR")) + 1; this.v.FNR = this.num(this.getVar("FNR")) + 1;
    if (!e.alvo) this.setRegistro(l); else this.atribuir(e.alvo, new SN(l));
    return 1;
  };
  AW.flush = function () { if (this.buf) { this.io.out(deB(this.buf)); this.buf = ""; } };
  AW.escrever = function (txt, red) {
    if (!red) { this.buf = (this.buf || "") + txt; if (this.buf.length > 8192) this.flush(); return; }
    var nome = this.str(this.ev(red.e));
    if (nome === "/dev/stdout" || nome === "-") { this.buf = (this.buf || "") + txt; return; }
    if (nome === "/dev/stderr") { this.flush(); this.io.err(deB(txt)); return; }
    var sd = this.saidas[nome];
    if (!sd) {
      if (red.op === "|") sd = this.saidas[nome] = { pipe: true, buf: "" };
      else { var o = this.io.sh.abrir(deB(nome), red.op === ">>" ? "a" : "w"); if (o.err) throw new AwkErr("cannot open \"" + nome + "\" for output"); ref(o); sd = this.saidas[nome] = { ofd: o }; }
    }
    if (sd.pipe) sd.buf += txt; else escreverOFD(this.io.sh.k, sd.ofd, deB(txt));
  };
  AW.exec = function (s) {
    var self = this;
    switch (s.k) {
      case "bloco": for (var i = 0; i < s.l.length; i++) this.exec(s.l[i]); return;
      case "expr": this.ev(s.e); return;
      case "print": {
        var txt = s.args.length ? s.args.map(function (a) { return self.strOut(self.ev(a)); }).join(this.str(this.getVar("OFS"))) : this.registro;
        this.escrever(txt + this.str(this.getVar("ORS")), s.red); return;
      }
      case "printf": {
        if (!s.args.length) throw new AwkErr("syntax error");
        var vals = s.args.map(function (a) { return self.ev(a); });
        var txtP;
        try { txtP = this.sprintf(this.str(vals[0]), vals.slice(1), "printf"); }
        catch (ep) { if (ep instanceof AwkErr && ep.parcial !== undefined) this.escrever(ep.parcial, s.red); throw ep; }
        this.escrever(txtP, s.red); return;
      }
      case "if": if (this.bool(this.ev(s.c))) this.exec(s.s1); else if (s.s2) this.exec(s.s2); return;
      case "while": while (this.bool(this.ev(s.c))) { try { this.exec(s.s); } catch (e) { if (e === "break") break; if (e === "continue") continue; throw e; } } return;
      case "do": do { try { this.exec(s.s); } catch (e) { if (e === "break") break; if (e === "continue") continue; throw e; } } while (this.bool(this.ev(s.c))); return;
      case "for": if (s.a) this.exec(s.a); while (!s.b || this.bool(this.ev(s.b))) { try { this.exec(s.s); } catch (e) { if (e === "break") break; if (e !== "continue") throw e; } if (s.c) this.exec(s.c); } return;
      case "forin": { var m = this.array(s.arr), ks = Array.from(m.keys()); for (var k = 0; k < ks.length; k++) { if (!m.has(ks[k])) continue; this.setVar(s.v, new SN(ks[k])); try { this.exec(s.s); } catch (e) { if (e === "break") break; if (e === "continue") continue; throw e; } } return; }
      case "break": throw "break";
      case "continue": throw "continue";
      case "next": throw "next";
      case "nextfile": throw "nextfile";
      case "exit": throw new AwkSai(s.e ? Math.floor(this.num(this.ev(s.e))) : (this.codSaida || 0));
      case "return": throw { ret: true, v: s.e ? this.ev(s.e) : "" };
      case "delete": { if (!s.idx) { if (hasOwn(this.arr, s.n)) this.arr[s.n].clear(); else this.arr[s.n] = new Map(); return; } this.array(s.n).delete(this.chave(s.idx)); return; }
    }
  };
  EXT.awk = function* (args, io) {
    var sh = io.sh, a = args.slice(1), fs = null, defs = [], fontes = [], i = 0;
    var nome = "awk";
    for (; i < a.length; i++) {
      var x = a[i];
      if (x === "--") { i++; break; }
      if (x === "-F") { fs = a[++i]; continue; }
      if (/^-F./.test(x)) { fs = x.slice(2); continue; }
      if (x === "-v") { defs.push(a[++i]); continue; }
      if (/^-v./.test(x)) { defs.push(x.slice(2)); continue; }
      if (x === "-f") { var rf = sh.lerArquivo(a[++i]); if (rf.err) { io.err(nome + ": couldn't open file " + a[i] + "\n"); return 2; } fontes.push(rf.txt); continue; }
      if (/^-W/.test(x)) { var opt = x.length > 2 ? x.slice(2) : a[++i]; if (/^v/.test(opt)) { io.out("mawk 1.3.4 20240123\nCopyright 2008-2023,2024, Thomas E. Dickey\nCopyright 1991-1996,2014, Michael D. Brennan\n\nrandom-funcs:       srandom/random\nregex-funcs:        internal\n\ncompiled limits:\nsprintf buffer      8192\nmaximum-integer     2147483647\n"); return 0; } continue; }
      if (x === "--version" || x === "-V") { io.out("mawk 1.3.4 20240123\n"); return 0; }
      if (/^-./.test(x) && x !== "-") { io.err(nome + ": not an option: " + x + "\n"); return 2; }
      break;
    }
    if (!fontes.length) {
      if (i >= a.length) { io.err(AWK_USO); return 2; }
      fontes.push(a[i++]);
    }
    var operandos = a.slice(i);
    var dec = localeNum(sh);
    var prog, funcs;
    try {
      var p = new AwkParser(awkLexer(paraB(fontes.join("\n") + "\n")));
      prog = p.programa(); funcs = p.funcs;
      (p.chamadas || []).forEach(function (n) { if (!funcs[n]) throw new AwkErr("line " + p.t[p.t.length - 1].ln + ": function " + n + " never defined"); });
    } catch (e) { if (e instanceof AwkErr) { io.err(nome + ": " + deB(e.msg) + "\n"); return 2; } throw e; }
    var aw = new Awk(io, prog, funcs, dec);
    var env = sh.exportadas(), envMap = new Map();
    for (var kk in env) envMap.set(kk, new SN(paraB(env[kk])));
    aw.arr.ENVIRON = envMap;
    aw.v.FS = fs === null ? " " : paraB(fs === "t" ? "\t" : fs.replace(/\\t/g, "\t"));
    aw.v.OFS = " "; aw.v.ORS = "\n"; aw.v.RS = "\n"; aw.v.NR = 0; aw.v.FNR = 0; aw.v.SUBSEP = "\x1c"; aw.v.CONVFMT = "%.6g"; aw.v.OFMT = "%.6g"; aw.v.FILENAME = ""; aw.v.RSTART = 0; aw.v.RLENGTH = -1;
    var argv = new Map(); argv.set("0", nome); operandos.forEach(function (o, k) { argv.set(String(k + 1), new SN(paraB(o))); });
    aw.arr.ARGV = argv; aw.v.ARGC = operandos.length + 1;
    function aplicarDef(d) { var m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(d); if (!m) return false; aw.v[m[1]] = new SN(paraB(decodificarAnsi(m[2]))); return true; }
    for (var d = 0; d < defs.length; d++) if (!aplicarDef(defs[d])) { io.err(nome + ": improper assignment: -v " + defs[d] + "\n"); return 2; }
    // entrada: arquivos lidos sob demanda
    var argIdx = 1, atual = null, st = 0, stdinLido = false, self = this;
    var pendentes = [];
    var leitorPronto = false;
    // pré-carrega arquivos de entrada (precisa de yield para stdin)
    var temMain = prog.some(function (it) { return it.tipo === "main" || it.tipo === "END"; });
    var entradas = [];
    var stdinTxt = null;
    function precisaStdin() { var ops = []; for (var k = 1; k < aw.num(aw.getVar("ARGC")); k++) { var v = argv.get(String(k)); if (v !== undefined && aw.str(v) !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(aw.str(v))) ops.push(aw.str(v)); } return !ops.length || ops.indexOf("-") >= 0 || ops.indexOf("/dev/stdin") >= 0; }
    aw.lerStdinSync = function () { return stdinTxt === null ? "" : stdinTxt; };
    if (temMain && precisaStdin()) stdinTxt = paraB(yield* io.stdin());
    else if (prog.some(function (it) { return /getline/.test(JSON.stringify(it)); })) { var o0 = sh.fds[0]; if (o0 && !isTTY(o0)) stdinTxt = paraB(yield* io.stdin()); }
    var fila = null;
    aw.proxRegistro = function () {
      while (true) {
        if (fila && fila.i < fila.l.length) return fila.l[fila.i++];
        // próximo arquivo
        var argc = aw.num(aw.getVar("ARGC"));
        var achou = false;
        while (argIdx < argc) {
          var v = argv.get(String(argIdx++));
          if (v === undefined) continue;
          var s = aw.str(v);
          if (s === "") continue;
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) { aplicarDef(s); continue; }
          var txt;
          if (s === "-" || s === "/dev/stdin") txt = stdinTxt || "";
          else { var r = sh.lerArquivo(deB(s)); if (r.err) { aw.flush(); io.err(nome + ": cannot open \"" + deB(s) + "\" (No such file or directory)\n"); throw new AwkSai(2); } txt = paraB(r.txt !== undefined ? r.txt : ""); }
          aw.v.FILENAME = s; aw.v.FNR = 0;
          fila = { l: aw.registros(txt), i: 0 };
          achou = true; break;
        }
        if (!achou) {
          if (aw.usouArquivo) return null;
          aw.usouArquivo = true;
          if (argIdx >= argc && !aw.teveArq) { fila = { l: aw.registros(stdinTxt || ""), i: 0 }; aw.v.FILENAME = ""; continue; }
          return null;
        }
        aw.teveArq = true; aw.usouArquivo = false;
      }
    };
    aw.registros = function (txt) {
      var rs = aw.str(aw.getVar("RS"));
      if (rs === "\n") { var l = txt.split("\n"); if (l[l.length - 1] === "") l.pop(); return l; }
      if (rs === "") { return txt.replace(/^\n+/, "").split(/\n\n+/).map(function (x) { return x.replace(/\n+$/, ""); }).filter(function (x) { return x !== ""; }); }
      var partes = rs.length === 1 ? txt.split(rs) : txt.split(criarRegex(ereParaJs(rs, { ascii: true }), ""));
      if (partes[partes.length - 1] === "" || partes[partes.length - 1] === "\n") partes.pop();
      return partes;
    };
    var codigo = 0;
    try {
      try {
        prog.forEach(function (it) { if (it.tipo === "BEGIN") aw.exec(it.acao); });
        if (prog.some(function (it) { return it.tipo !== "BEGIN"; })) {
          var l;
          principal: while ((l = aw.proxRegistro()) !== null) {
            aw.v.NR = aw.num(aw.getVar("NR")) + 1; aw.v.FNR = aw.num(aw.getVar("FNR")) + 1;
            aw.setRegistro(l);
            for (var q = 0; q < prog.length; q++) {
              var it = prog[q];
              if (it.tipo !== "main") continue;
              var casa;
              if (!it.pat) casa = true;
              else if (it.pat2) {
                if (!it.ativo) { if (aw.bool(aw.ev(it.pat))) { casa = true; it.ativo = !aw.bool(aw.ev(it.pat2)); } else casa = false; }
                else { casa = true; if (aw.bool(aw.ev(it.pat2))) it.ativo = false; }
              } else casa = aw.bool(aw.ev(it.pat));
              if (!casa) continue;
              try {
                if (it.acao) aw.exec(it.acao); else aw.escrever(aw.registro + aw.str(aw.getVar("ORS")), null);
              } catch (e) {
                if (e === "next") continue principal;
                if (e === "nextfile") { fila = null; continue principal; }
                throw e;
              }
            }
            if (aw.buf && aw.buf.length > 4096) { aw.flush(); yield* io.fluir(); }
          }
        }
      } catch (e) {
        if (e instanceof AwkSai) { codigo = e.code; aw.codSaida = codigo; if (e.code === 2 && false) throw e; }
        else throw e;
      }
      try { prog.forEach(function (it) { if (it.tipo === "END") aw.exec(it.acao); }); }
      catch (e2) { if (e2 instanceof AwkSai) codigo = e2.code; else throw e2; }
    } catch (e3) {
      if (e3 instanceof AwkErr) { io.err(nome + ": " + (/^line |^run time/.test(e3.msg) ? "" : "run time error: ") + deB(e3.msg) + "\n\tFILENAME=\"" + deB(aw.str(aw.v.FILENAME)) + "\" FNR=" + aw.str(aw.v.FNR) + " NR=" + aw.str(aw.v.NR) + "\n"); aw.flush(); return 2; }
      if (e3 === "break" || e3 === "continue") { aw.flush(); return 2; }
      throw e3;
    }
    aw.flush();
    for (var nm in aw.saidas) { var sd = aw.saidas[nm]; if (sd.pipe) sh.k.rodarAninhado(sh, deB(nm), deB(sd.buf)); else if (sd.ofd) unref(sd.ofd); }
    return codigo;
  };
  EXT.mawk = EXT.awk; EXT.gawk = function* (args, io) { io.err("(simulador) gawk não está instalado nesta máquina; use awk (que é o mawk).\n"); return 127; };
  var AWK_USO = "Usage: mawk [Options] [Program] [file ...]\n\nProgram:\n    The -f option value is the name of a file containing program text.\n    If no -f option is given, a \"--\" ends option processing; the following\n    parameters are the program text.\n\nOptions:\n    -f program-file  Program  text is read from file instead of from the\n                     command-line.  Multiple -f options are accepted.\n    -F value         sets the field separator, FS, to value.\n    -v var=value     assigns value to program variable var.\n    --               unambiguous end of options.\n\n    Implementation-specific options are prefixed with \"-W\".  They can be\n    abbreviated:\n\n    -W version       show version information and exit.\n    -W dump          show assembler-like listing of program and exit.\n    -W help          show this message and exit.\n    -W interactive   set unbuffered output, line-buffered input.\n    -W exec file     use file as program as well as last option.\n    -W posix         stricter POSIX checking.\n    -W random=number set initial random seed.\n    -W sprintf=number adjust size of sprintf buffer.\n    -W traditional   pre-POSIX 2001.\n    -W usage         show this message and exit.\n";

  // roda um comando de shell de forma síncrona (awk system(), "cmd" | getline, print | "cmd")
  KP.rodarAninhado = function (sh, cmd, entrada, capturar) {
    var k = this, f = sh.fork(), buf = null;
    f.fds.forEach(function (x) { /* herdados */ });
    if (entrada !== null && entrada !== undefined) { unref(f.fds[0]); f.fds[0] = ref(new OFD("file", { no: { t: "f", d: entrada, m: 384, u: UID, g: GID }, pos: 0, rd: true })); }
    var pp = null, leitor = null;
    if (capturar) { pp = novoPipe(); pp[0].p.semLimite = true; leitor = ref(pp[0]); unref(f.fds[1]); f.fds[1] = ref(pp[1]); }
    var n = sh.novoShell ? null : null;
    var g = (function* () { try { return yield* f.rodarFonte(cmd + "\n", { script: true, modoC: true }); } catch (e) { if (e instanceof ExitSig || e instanceof FatalSig) return e.code; throw e; } finally { f.fecharTudo(); } })();
    var cur = k.cur, val, r, st = 0, guarda = 0;
    while (true) {
      r = g.next(val); val = undefined;
      if (r.done) { st = r.value; break; }
      var y = r.value || {};
      if (y.t === "sleep") { k.clock += y.ms; continue; }
      if (y.t === "in") { val = null; continue; }
      if (y.t === "block") {
        while (!y.cond()) {
          var l = k.prontos(false).filter(function (p) { return p !== cur; });
          if (!l.length) { var dorm = k.procs.filter(function (p) { return p.state === "sleep" && !p.done && p !== cur; }); if (!dorm.length) break; k.clock = Math.min.apply(null, dorm.map(function (p) { return p.wake; })); continue; }
          l.forEach(function (p) { if (!p.done) k.passoProc(p); });
          k.cur = cur;
          if (++guarda > 1e6) break;
        }
      }
    }
    k.cur = cur;
    if (capturar) { var out = pp[0].p.buf; unref(leitor); return out; }
    return st;
  };
  KP.capturarAninhado = function (sh, cmd) { return this.rodarAninhado(sh, cmd, null, true); };
  // roda um generator até o fim, deixando os outros processos andarem quando ele espera
  KP.rodarGeradorSync = function (g) {
    var k = this, cur = k.cur, val, r, guarda = 0;
    while (true) {
      r = g.next(val); val = undefined;
      if (r.done) { k.cur = cur; return r.value; }
      var y = r.value || {};
      if (y.t === "sleep") { k.clock += y.ms; continue; }
      if (y.t === "in") { val = null; continue; }
      if (y.t === "block") {
        while (!y.cond()) {
          var l = k.prontos(false).filter(function (p) { return p !== cur; });
          if (!l.length) { var dorm = k.procs.filter(function (p) { return p.state === "sleep" && !p.done && p !== cur; }); if (!dorm.length) break; k.clock = Math.min.apply(null, dorm.map(function (p) { return p.wake; })); continue; }
          l.forEach(function (p) { if (!p.done) k.passoProc(p); });
          k.cur = cur;
          if (++guarda > 100000) break;
        }
      }
      if (++guarda > 1000000) { k.cur = cur; return undefined; }
    }
  };

  /* ---------- find ---------- */
  EXT.find = function* (args, io) {
    var sh = io.sh, a = args.slice(1), i = 0, seguir = false;
    while (a[i] === "-L" || a[i] === "-H" || a[i] === "-P") { if (a[i] === "-L") seguir = true; i++; }
    var caminhos = [];
    while (i < a.length && !/^[-!(),]/.test(a[i]) || (i < a.length && a[i] === "-" )) caminhos.push(a[i++]);
    if (!caminhos.length) caminhos = ["."];
    var expr = a.slice(i), p = 0, maxD = Infinity, minD = 0, temAcao = false, depthFirst = false;
    function ErrF(m) { this.m = m; }
    var COM_ARG = { "-name": 1, "-iname": 1, "-path": 1, "-ipath": 1, "-wholename": 1, "-regex": 1, "-iregex": 1, "-type": 1, "-size": 1, "-mtime": 1, "-mmin": 1, "-atime": 1, "-amin": 1, "-ctime": 1, "-cmin": 1, "-newer": 1, "-perm": 1, "-user": 1, "-group": 1, "-printf": 1, "-maxdepth": 1, "-mindepth": 1, "-links": 1, "-inum": 1, "-fprint": 1, "-samefile": 1, "-lname": 1, "-uid": 1, "-gid": 1, "-xtype": 1, "-regextype": 1 };
    function prim() {
      var t = expr[p++];
      if (t === "(" ) { var e = ou(); if (expr[p] !== ")") throw new ErrF("parênteses sem correspondência"); p++; return e; }
      if (t === "!" || t === "-not") return { op: "not", a: prim() };
      if (t === undefined) throw new ErrF("expressão esperada");
      if (t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir") {
        var cmd = [];
        while (p < expr.length && expr[p] !== ";" && !(expr[p] === "+" && expr[p - 1] === "{}")) cmd.push(expr[p++]);
        if (p >= expr.length) throw new ErrF("faltando argumento para “" + t + "”");
        var mais = expr[p] === "+"; p++;
        temAcao = true;
        return { op: t, cmd: cmd, mais: mais, acum: [] };
      }
      if (COM_ARG[t]) {
        if (p >= expr.length) throw new ErrF("faltando argumento para “" + t + "”");
        var v = expr[p++];
        if (t === "-maxdepth") { maxD = +v; return { op: "-true" }; }
        if (t === "-mindepth") { minD = +v; return { op: "-true" }; }
        if (t === "-printf" || t === "-fprint") temAcao = true;
        if (t === "-type" && !/^[fdlbcps](,[fdlbcps])*$/.test(v)) throw new ErrF("Argumento desconhecido para -type: " + v);
        if (t === "-newer") { var r = sh.resolver(v, true); if (!r.no) throw new ErrF(qa(v) + ": Arquivo ou diretório inexistente"); return { op: t, ref: r.no }; }
        if (t === "-regextype") return { op: "-true" };
        return { op: t, v: v };
      }
      if (t === "-print" || t === "-print0" || t === "-ls" || t === "-delete" || t === "-quit") { temAcao = true; if (t === "-delete") depthFirst = true; return { op: t }; }
      if (t === "-depth" || t === "-d") { depthFirst = true; return { op: "-true" }; }
      if (/^-(true|false|empty|prune|readable|writable|executable|nouser|nogroup|xdev|mount|noleaf|follow)$/.test(t)) return { op: t };
      if (/^-/.test(t)) throw new ErrF("predicado inválido \"" + t + "\"");
      throw new ErrF("caminhos devem preceder expressão: “" + t + "”");
    }
    function e_() { var l = prim(); while (p < expr.length && expr[p] !== ")" && expr[p] !== "-o" && expr[p] !== "-or" && expr[p] !== ",") { if (expr[p] === "-a" || expr[p] === "-and") p++; l = { op: "and", a: l, b: prim() }; } return l; }
    function ou() { var l = e_(); while (expr[p] === "-o" || expr[p] === "-or" || expr[p] === ",") { var vir = expr[p] === ","; p++; l = { op: vir ? "," : "or", a: l, b: e_() }; } return l; }
    var arvore;
    try { arvore = expr.length ? ou() : { op: "-true" }; if (p < expr.length) throw new ErrF(expr[p] === ")" ? "parênteses sem correspondência" : "caminhos devem preceder expressão: “" + expr[p] + "”"); }
    catch (e) { if (e instanceof ErrF) { io.msg(e.m); return 1; } throw e; }
    if (!temAcao) arvore = { op: "and", a: arvore, b: { op: "-print" } };
    var agora = sh.k.clock, st = 0, sair = false, self = this;
    function nomeBase(c) { var s = c.replace(/\/+$/, ""); return s.slice(s.lastIndexOf("/") + 1) || "/"; }
    function cmpNum(spec, v) { var m = /^([+-]?)([0-9]+)/.exec(spec); if (!m) return false; var n = +m[2]; return m[1] === "+" ? v > n : m[1] === "-" ? v < n : v === n; }
    function* av(e, item) {
      var no = item.no;
      switch (e.op) {
        case "and": return (yield* av(e.a, item)) && (yield* av(e.b, item));
        case "or": return (yield* av(e.a, item)) || (yield* av(e.b, item));
        case ",": yield* av(e.a, item); return yield* av(e.b, item);
        case "not": return !(yield* av(e.a, item));
        case "-true": return true; case "-false": return false;
        case "-name": return casaPadrao(e.v, nomeBase(item.c), {});
        case "-iname": return casaPadrao(e.v, nomeBase(item.c), { nc: true });
        case "-path": case "-wholename": return casaPadrao(e.v, item.c, {});
        case "-ipath": return casaPadrao(e.v, item.c, { nc: true });
        case "-lname": return no.t === "l" && casaPadrao(e.v, no.alvo, {});
        case "-regex": case "-iregex": { var r = criarRegex("^(?:" + ereParaJs(e.v, { bre: false }) + ")$", e.op === "-iregex" ? "i" : ""); return !!r && r.test(item.c); }
        case "-type": case "-xtype": { var tn = no.t === "l" && seguir ? (sh.resolver(item.c, true).no || no) : no; var tipo = tn.t === "d" ? "d" : tn.t === "l" ? "l" : tn.t === "c" ? "c" : "f"; return e.v.split(",").indexOf(tipo) >= 0; }
        case "-size": {
          var m = /^([+-]?)([0-9]+)([bckwMG]?)$/.exec(e.v); if (!m) return false;
          var u = { b: 512, c: 1, k: 1024, w: 2, M: 1048576, G: 1073741824, "": 512 }[m[3]], tam = tamanho(no);
          var unidades = Math.ceil(tam / u), n = +m[2];
          return m[1] === "+" ? unidades > n : m[1] === "-" ? unidades < n : unidades === n;
        }
        case "-empty": return no.t === "d" ? Object.keys(no.c).length === 0 : (no.t === "f" && tamanho(no) === 0);
        case "-mtime": return cmpNum(e.v, Math.floor((agora - no.mt) / 864e5));
        case "-atime": return cmpNum(e.v, Math.floor((agora - (no.at || no.mt)) / 864e5));
        case "-ctime": return cmpNum(e.v, Math.floor((agora - (no.ct || no.mt)) / 864e5));
        case "-mmin": return cmpNum(e.v, Math.ceil((agora - no.mt) / 6e4));
        case "-amin": return cmpNum(e.v, Math.ceil((agora - (no.at || no.mt)) / 6e4));
        case "-cmin": return cmpNum(e.v, Math.ceil((agora - (no.ct || no.mt)) / 6e4));
        case "-newer": return no.mt > e.ref.mt;
        case "-perm": {
          var spec = e.v, modo = no.m & 4095;
          if (spec[0] === "-") { var w = aplicarModo(spec.slice(1), 0, false, 0); return (modo & w) === w; }
          if (spec[0] === "/") { var w2 = aplicarModo(spec.slice(1), 0, false, 0); return w2 === 0 || (modo & w2) !== 0; }
          return modo === aplicarModo(spec, 0, false, 0);
        }
        case "-user": return (USUARIOS[no.u] || String(no.u)) === e.v || String(no.u) === e.v;
        case "-group": return (GRUPOS[no.g] || String(no.g)) === e.v || String(no.g) === e.v;
        case "-uid": return String(no.u) === e.v; case "-gid": return String(no.g) === e.v;
        case "-nouser": case "-nogroup": return false;
        case "-links": return cmpNum(e.v, contarLinks(no));
        case "-inum": return String(no.ino) === e.v;
        case "-readable": return sh.pode(no, 4); case "-writable": return sh.pode(no, 2); case "-executable": return sh.pode(no, 1);
        case "-prune": item.podar = true; return true;
        case "-print": io.out(item.c + "\n"); return true;
        case "-print0": io.out(item.c + "\0"); return true;
        case "-fprint": { var fo = sh.abrir(e.v, "a"); if (!fo.err) escreverOFD(sh.k, fo, item.c + "\n"); return true; }
        case "-ls": io.out(pad(no.ino, 9) + " " + pad(blocos(no), 6) + " " + modoStr(no) + " " + pad(contarLinks(no), 3) + " " + pad(USUARIOS[no.u] || no.u, 8, true) + " " + pad(GRUPOS[no.g] || no.g, 8, true) + " " + pad(tamanho(no), 8) + " " + dataLs(no.mt, agora) + " " + item.c + (no.t === "l" ? " -> " + no.alvo : "") + "\n"); return true;
        case "-printf": io.out(findPrintf(e.v, item, agora)); return true;
        case "-delete": {
          if (no.t === "d" && Object.keys(no.c).length) { io.msg("não foi possível excluir " + qa(item.c) + ": Diretório não vazio"); st = 1; return false; }
          if (item.pai && sh.pode(item.pai, 2)) { delete item.pai.c[item.nome]; return true; }
          io.msg("não foi possível excluir " + qa(item.c) + ": Permissão negada"); st = 1; return false;
        }
        case "-quit": sair = true; return true;
        case "-exec": case "-execdir": case "-ok": case "-okdir": {
          var cmd;
          var arg = e.op === "-execdir" || e.op === "-okdir" ? "./" + nomeBase(item.c) : item.c;
          if (e.mais) { e.acum.push(arg); return true; }
          cmd = e.cmd.map(function (x) { return x.split("{}").join(arg); });
          if (e.op === "-ok" || e.op === "-okdir") { var ok = yield* io.pergunta("< " + cmd.join(" ") + " ... " + item.c + " > ? "); if (!ok) return false; }
          var rr = yield* executarFilho(cmd, e.op === "-execdir" ? item.c.slice(0, item.c.length - nomeBase(item.c).length) || "." : null);
          return rr === 0;
        }
      }
      return false;
    }
    function* executarFilho(cmd, dir) {
      var f = sh.fork();
      if (dir) { var r = f.resolver(dir, true); if (r.no) { f.cwd = r.caminho; f.cwdLogico = r.caminho; } }
      var t = f.acharNoPath(cmd[0]);
      if (!t && cmd[0].indexOf("/") < 0) { io.msg(qa(cmd[0]) + ": Arquivo ou diretório inexistente"); f.fecharTudo(); st = 1; return 127; }
      try { return yield* f.executar(cmd, { semFuncao: true, externo: true }); }
      catch (ex) { if (ex instanceof ExitSig) return ex.code; throw ex; }
      finally { f.fecharTudo(); }
    }
    function* anda(no, c, prof, pai, nome) {
      if (sair) return;
      var item = { no: no, c: c, pai: pai, nome: nome };
      if (!depthFirst && prof >= minD) yield* av(arvore, item);
      if (no.t === "d" && prof < maxD && !item.podar) {
        if (!sh.pode(no, 4) || !sh.pode(no, 1)) { io.msg(qa(c) + ": Permissão negada"); st = 1; }
        else {
          var nomes = listarDir(no);
          for (var k = 0; k < nomes.length; k++) {
            var f = no.c[nomes[k]];
            if (!f) continue;
            if (f.t === "l" && seguir) { var rr = sh.resolver((c === "/" ? "" : c) + "/" + nomes[k], true); if (rr.no) f = rr.no; }
            yield* anda(f, (c === "/" ? "" : c.replace(/\/$/, "")) + "/" + nomes[k], prof + 1, no, nomes[k]);
            if (sair) return;
          }
        }
      }
      if (depthFirst && prof >= minD) yield* av(arvore, item);
      yield* io.fluir();
    }
    for (var j = 0; j < caminhos.length && !sair; j++) {
      var c = caminhos[j], r = sh.resolver(c, seguir || /\/$/.test(c));
      if (!r.no) { io.msg(qa(c) + ": " + errMsg(r.err || "ENOENT")); st = 1; continue; }
      yield* anda(r.no, c, 0, r.pai, r.nome);
    }
    // -exec … {} +
    function* fimMais(e) {
      if (!e) return;
      if ((e.op === "-exec" || e.op === "-execdir") && e.mais && e.acum.length) {
        var cmd = [];
        e.cmd.forEach(function (x) { if (x === "{}") cmd = cmd.concat(e.acum); else cmd.push(x); });
        var rr = yield* executarFilho(cmd, null);
        if (rr !== 0) st = 1;
      }
      yield* fimMais(e.a); yield* fimMais(e.b);
    }
    yield* fimMais(arvore);
    return st;
  };
  function findPrintf(fmt, item, agora) {
    var no = item.no, c = item.c;
    var base = c.replace(/\/+$/, ""); base = base.slice(base.lastIndexOf("/") + 1) || c;
    var dir = c.lastIndexOf("/") > 0 ? c.slice(0, c.lastIndexOf("/")) : (c.lastIndexOf("/") === 0 ? "/" : ".");
    return fmt.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\0/g, "\0").replace(/%(-?[0-9]*)([pfhsmMugdyYkPlibntaTAcC%])([A-Za-z@+]?)/g, function (m, w, k, sub) {
      var v;
      switch (k) {
        case "p": v = c; break; case "f": v = base; break; case "h": v = dir; break; case "P": v = c.replace(/^[^\/]*\/?/, ""); break;
        case "s": v = String(tamanho(no)); break; case "k": v = String(blocos(no)); break; case "b": v = String(blocos(no) * 2); break;
        case "m": v = (no.m & 4095).toString(8); break; case "M": v = modoStr(no); break;
        case "u": v = USUARIOS[no.u] || String(no.u); break; case "g": v = GRUPOS[no.g] || String(no.g); break; case "U": v = String(no.u); break; case "G": v = String(no.g); break;
        case "d": v = String((c.match(/\//g) || []).length - (c === "/" ? 1 : 0)); break;
        case "y": v = no.t === "d" ? "d" : no.t === "l" ? "l" : no.t === "c" ? "c" : "f"; break; case "Y": v = no.t === "d" ? "d" : "f"; break;
        case "l": v = no.t === "l" ? no.alvo : ""; break; case "i": v = String(no.ino); break; case "n": v = String(contarLinks(no)); break;
        case "t": case "a": case "c": v = formatarData("%a %b %e %H:%M:%S.0000000000 %Y", no.mt); break;
        case "T": case "A": case "C": v = sub === "@" ? String(no.mt / 1000) : sub === "+" ? formatarData("%Y-%m-%d+%H:%M:%S.0000000000", no.mt) : formatarData("%" + (sub || "c"), no.mt); break;
        case "%": return "%";
        default: return m;
      }
      if (w) v = w[0] === "-" ? pad(v, +w.slice(1), true) : pad(v, +w);
      return v;
    });
  }
  EXT.locate = function* (args, io) { io.err("(simulador) locate precisa de um banco de dados que não existe aqui; use find.\n"); return 1; };
  /* ---------- hashes ---------- */
  function sha256Hex(bytes) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var b = bytes.slice(), l = b.length * 8;
    b.push(0x80); while (b.length % 64 !== 56) b.push(0);
    for (var i = 7; i >= 0; i--) b.push(Math.floor(l / Math.pow(2, i * 8)) & 255);
    var w = new Array(64);
    for (var o = 0; o < b.length; o += 64) {
      for (i = 0; i < 16; i++) w[i] = (b[o + i * 4] << 24) | (b[o + i * 4 + 1] << 16) | (b[o + i * 4 + 2] << 8) | b[o + i * 4 + 3];
      for (i = 16; i < 64; i++) { var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & bb) ^ (a & c) ^ (bb & c), t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ("00000000" + (x >>> 0).toString(16)).slice(-8); }).join("");
  }
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function md5Hex(bytes) {
    var s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = []; for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    var b = bytes.slice(), l = b.length * 8;
    b.push(0x80); while (b.length % 64 !== 56) b.push(0);
    for (i = 0; i < 8; i++) b.push(Math.floor(l / Math.pow(2, i * 8)) & 255);
    for (var o = 0; o < b.length; o += 64) {
      var M = []; for (i = 0; i < 16; i++) M[i] = b[o + i * 4] | (b[o + i * 4 + 1] << 8) | (b[o + i * 4 + 2] << 16) | (b[o + i * 4 + 3] << 24);
      var A = a0, B2 = b0, C = c0, D = d0;
      for (i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B2 & C) | (~B2 & D); g = i; } else if (i < 32) { F = (D & B2) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B2 ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B2 | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0; A = D; D = C; C = B2; B2 = (B2 + ((F << s[i]) | (F >>> (32 - s[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B2) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return [a0, b0, c0, d0].map(function (x) { var r = ""; for (var k = 0; k < 4; k++) r += ("0" + ((x >>> (k * 8)) & 255).toString(16)).slice(-2); return r; }).join("");
  }
  function somaHash(fn, nome) {
    return function* (args, io) {
      var check = args.indexOf("-c") >= 0 || args.indexOf("--check") >= 0;
      var ops = args.slice(1).filter(function (x) { return x[0] !== "-" || x === "-"; });
      if (check) {
        var st0 = 0, falhas = 0;
        yield* io.cadaArquivo(ops, function (txt) {
          linhasDe(txt).forEach(function (l) {
            var m = /^([0-9a-f]+) [ *](.*)$/.exec(l); if (!m) return;
            var r = io.sh.lerArquivo(m[2]);
            if (r.err) { io.out(m[2] + ": FAILED open or read\n"); falhas++; return; }
            var ok = fn(utf8bytes(dadosDe({ d: r.txt }))) === m[1];
            io.out(m[2] + ": " + (ok ? "OK" : "FAILED") + "\n"); if (!ok) falhas++;
          });
        });
        if (falhas) { io.msg("AVISO: " + falhas + " soma" + (falhas > 1 ? "s" : "") + " de verificação calculada" + (falhas > 1 ? "s" : "") + " NÃO confere" + (falhas > 1 ? "m" : "")); return 1; }
        return st0;
      }
      var st = yield* io.cadaArquivo(ops, function (txt, n) {
        if (txt.length > 4000000) { io.err("(simulador) arquivo grande demais para calcular o hash aqui.\n"); return; }
        io.out(fn(utf8bytes(txt)) + "  " + n + "\n");
      });
      return st;
    };
  }
  EXT.sha256sum = somaHash(sha256Hex, "sha256sum");
  EXT.md5sum = somaHash(md5Hex, "md5sum");
  EXT.base64 = function* (args, io) {
    var dec = args.indexOf("-d") >= 0 || args.indexOf("--decode") >= 0;
    var ops = args.slice(1).filter(function (x) { return x[0] !== "-" || x === "-"; }), txt = "";
    var st = yield* io.cadaArquivo(ops, function (t) { txt += t; });
    var T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (dec) {
      var limpo = txt.replace(/[^A-Za-z0-9+\/=]/g, ""), bytes = [], buf = 0, bits = 0;
      for (var i = 0; i < limpo.length && limpo[i] !== "="; i++) { buf = (buf << 6) | T.indexOf(limpo[i]); bits += 6; if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 255); } }
      io.out(decodUtf8(bytes)); return st;
    }
    var b = utf8bytes(txt), out = "";
    for (var j = 0; j < b.length; j += 3) {
      var n = (b[j] << 16) | ((b[j + 1] || 0) << 8) | (b[j + 2] || 0);
      out += T[(n >> 18) & 63] + T[(n >> 12) & 63] + (j + 1 < b.length ? T[(n >> 6) & 63] : "=") + (j + 2 < b.length ? T[n & 63] : "=");
    }
    io.out((out.match(/.{1,76}/g) || [""]).join("\n") + (out ? "\n" : ""));
    return st;
  };

  /* ------------------------------------------------------------------
     15. Interface no navegador: .try (terminal) e .tryscript (editor)
     ------------------------------------------------------------------ */
  function escHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  var CORES_ANSI = ["#2e3436", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#d3d7cf"];
  var CORES_ANSI_FORTE = ["#555753", "#ff6b6b", "#9cf55c", "#fff27a", "#8fb8ff", "#d39fd0", "#5ff5f5", "#eeeeec"];
  function cor256(n) {
    if (n < 8) return CORES_ANSI[n];
    if (n < 16) return CORES_ANSI_FORTE[n - 8];
    if (n < 232) { n -= 16; var r = Math.floor(n / 36), g = Math.floor(n / 6) % 6, b = n % 6; var v = function (x) { return x ? 55 + x * 40 : 0; }; return "rgb(" + v(r) + "," + v(g) + "," + v(b) + ")"; }
    var c = 8 + (n - 232) * 10; return "rgb(" + c + "," + c + "," + c + ")";
  }
  // Converte texto com marcas de cor do simulador e sequências ANSI em HTML
  function ansiParaHtml(txt, est) {
    est = est || {};
    var out = "", i = 0, aberto = false;
    function estilo() {
      var css = [], cls = [];
      if (est.fg !== undefined) css.push("color:" + (est.bold && est.fg < 8 ? CORES_ANSI_FORTE[est.fg] : (typeof est.fg === "string" ? est.fg : cor256(est.fg))));
      if (est.bg !== undefined) css.push("background:" + (typeof est.bg === "string" ? est.bg : cor256(est.bg)));
      if (est.bold) css.push("font-weight:700");
      if (est.dim) css.push("opacity:.7");
      if (est.it) css.push("font-style:italic");
      if (est.ul) css.push("text-decoration:underline");
      if (est.rev) cls.push("sim-rev");
      return { css: css.join(";"), cls: cls.join(" ") };
    }
    function abrir() { var e = estilo(); if (e.css || e.cls) { out += '<span' + (e.cls ? ' class="' + e.cls + '"' : "") + (e.css ? ' style="' + e.css + '"' : "") + ">"; aberto = true; } }
    function fechar() { if (aberto) { out += "</span>"; aberto = false; } }
    var buf = "";
    function flush() { if (buf) { abrir(); out += escHtml(buf); fechar(); buf = ""; } }
    while (i < txt.length) {
      var c = txt[i];
      if (c === C0) { flush(); var letra = txt[i + 1], fim = txt.indexOf(C1, i + 2); if (fim < 0) fim = txt.length; out += '<span class="c-' + letra + '">' + escHtml(txt.slice(i + 2, fim)) + "</span>"; i = fim + 1; continue; }
      if (c === "\x1b") {
        var m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(txt.slice(i)) || /^\x1b\(B/.exec(txt.slice(i));
        if (m) {
          flush();
          if (m[2] === "m") {
            var ps = (m[1] || "0").split(";").map(function (x) { return x === "" ? 0 : parseInt(x, 10); });
            for (var k = 0; k < ps.length; k++) {
              var p = ps[k];
              if (p === 0) est = {}; else if (p === 1) est.bold = true; else if (p === 2) est.dim = true; else if (p === 3) est.it = true; else if (p === 4) est.ul = true; else if (p === 7) est.rev = true;
              else if (p === 22) { est.bold = false; est.dim = false; } else if (p === 23) est.it = false; else if (p === 24) est.ul = false; else if (p === 27) est.rev = false;
              else if (p >= 30 && p <= 37) est.fg = p - 30; else if (p === 39) delete est.fg;
              else if (p >= 40 && p <= 47) est.bg = p - 40; else if (p === 49) delete est.bg;
              else if (p >= 90 && p <= 97) est.fg = p - 90 + 8; else if (p >= 100 && p <= 107) est.bg = p - 100 + 8;
              else if ((p === 38 || p === 48) && ps[k + 1] === 5) { if (p === 38) est.fg = ps[k + 2]; else est.bg = ps[k + 2]; k += 2; }
              else if ((p === 38 || p === 48) && ps[k + 1] === 2) { var rgb = "rgb(" + ps[k + 2] + "," + ps[k + 3] + "," + ps[k + 4] + ")"; if (p === 38) est.fg = rgb; else est.bg = rgb; k += 4; }
            }
          }
          i += m[0].length; continue;
        }
        i++; continue;
      }
      if (c === "\x07") { i++; continue; }
      buf += c; i++;
    }
    flush();
    return { html: out, est: est };
  }
  function dividirArgsSimples(s) {
    var r = [], cur = null, i = 0;
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { if (cur !== null) { r.push(cur); cur = null; } i++; continue; }
      if (cur === null) cur = "";
      if (c === "'") { var f = s.indexOf("'", i + 1); if (f < 0) f = s.length; cur += s.slice(i + 1, f); i = f + 1; continue; }
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === "\\" && /["\\$`]/.test(s[i + 1] || "")) i++; cur += s[i]; i++; } i++; continue; }
      if (c === "\\" && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
      cur += c; i++;
    }
    if (cur !== null) r.push(cur);
    return r;
  }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function decodificarAttr(s) { return (s || "").replace(/\\n/g, "\n"); }
  var MSG_INICIAL = "Terminal simulado · máquina fictícia \"notebook\" · usuária \"ana\" · Git 2.53 (simulado) · Bash 5.3. Comece por git status.";

  // completar com Tab: devolve {linha, lista}
  function completar(sh, linha) {
    var m = /(\S*)$/.exec(linha), parcial = m[1], antes = linha.slice(0, linha.length - parcial.length);
    var primeira = /^\s*$/.test(antes) || /(\||&&|\|\||;|\$\(|`|\(|\{|then|do|else)\s*$/.test(antes);
    var opcoes = [], sufixo = " ";
    if (/^\$\{?[A-Za-z_]*$/.test(parcial)) {
      var pv = parcial.replace(/^\$\{?/, ""), chave = parcial.indexOf("${") === 0;
      opcoes = sh.nomesVars().filter(function (n) { return n.indexOf(pv) === 0; }).map(function (n) { return (chave ? "${" : "$") + n + (chave ? "}" : ""); });
    } else if (primeira && parcial.indexOf("/") < 0) {
      var ub = sh.no("/usr/bin"), nomes = Object.keys(BUILTINS).concat(Object.keys(sh.funcs), Object.keys(sh.aliases), PALAVRAS_CHAVE, ub ? Object.keys(ub.c).filter(function (n) { return EXT[n]; }) : []);
      var vistos = {};
      opcoes = nomes.filter(function (n) { if (vistos[n] || n.indexOf(parcial) !== 0) return false; vistos[n] = 1; return true; }).sort(cmpBytes);
      if (parcial === "") opcoes = [];
    } else {
      var semEsc = parcial.replace(/\\(.)/g, "$1").replace(/^['"]/, ""), barra = semEsc.lastIndexOf("/"), dir = barra >= 0 ? semEsc.slice(0, barra + 1) : "", pre = semEsc.slice(barra + 1);
      var dirReal = dir.replace(/^~(?=\/|$)/, sh.valor("HOME") || HOME) || ".";
      var r = sh.resolver(dirReal, true);
      if (r.no && r.no.t === "d" && sh.pode(r.no, 4)) {
        var ehCd = /^\s*(cd|pushd|rmdir)\s+$/.test(antes);
        opcoes = Object.keys(r.no.c).filter(function (n) { return n.indexOf(pre) === 0 && (pre[0] === "." || n[0] !== "."); }).filter(function (n) {
          if (!ehCd) return true; var f = r.no.c[n]; if (f.t === "l") f = sh.resolver(dirReal + "/" + n, true).no; return f && f.t === "d";
        }).sort(collate).map(function (n) {
          var f = r.no.c[n]; if (f.t === "l") f = sh.resolver(dirReal + "/" + n, true).no || f;
          return { txt: dir + n, dir: f.t === "d" };
        });
        opcoes = opcoes.map(function (o) { return { txt: o.txt.replace(/([ '"$`\\()&;|<>*?\[\]!#])/g, "\\$1"), dir: o.dir, nome: o.txt.slice(o.txt.lastIndexOf("/", o.txt.length - 2) + 1) }; });
        if (opcoes.length === 1) return { linha: antes + opcoes[0].txt + (opcoes[0].dir ? "/" : " "), lista: [] };
        if (!opcoes.length) return { linha: linha, lista: [] };
        var comum = opcoes[0].txt;
        opcoes.forEach(function (o) { while (o.txt.indexOf(comum) !== 0) comum = comum.slice(0, -1); });
        return { linha: antes + comum, lista: comum === parcial ? opcoes.map(function (o) { return o.nome + (o.dir ? "/" : ""); }) : [] };
      }
      return { linha: linha, lista: [] };
    }
    if (!opcoes.length) return { linha: linha, lista: [] };
    if (opcoes.length === 1) return { linha: antes + opcoes[0] + (opcoes[0][0] === "$" ? "" : sufixo), lista: [] };
    var c2 = opcoes[0];
    opcoes.forEach(function (o) { while (o.indexOf(c2) !== 0) c2 = c2.slice(0, -1); });
    return { linha: antes + c2, lista: c2 === parcial ? opcoes : [] };
  }

  /* ---------- terminal .try ---------- */
  function montarTry(box) {
    if (box.getAttribute("data-montado")) return;
    box.setAttribute("data-montado", "1");
    var setup = box.getAttribute("data-setup") || "", meta = box.getAttribute("data-goal") || "", solucao = box.getAttribute("data-solucao") || "";
    var caixa = el("div", { "class": "sim" });
    caixa.innerHTML =
      '<div class="sim-bar"><span class="sim-dots"><i></i><i></i><i></i></span><span class="sim-title"></span>' +
      (solucao ? '<button type="button" class="sim-btn sim-ver">Ver solução</button>' : "") +
      '<button type="button" class="sim-btn sim-reset" title="Volta a máquina ao estado inicial">Reiniciar</button></div>' +
      '<div class="sim-screen" tabindex="-1"><div class="sim-out" aria-live="polite"></div>' +
      '<div class="sim-line"><span class="sim-prompt"></span><input class="sim-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Digite um comando"></div></div>';
    box.appendChild(caixa);
    var painelSol = null;
    if (solucao) {
      painelSol = el("div", { "class": "sim-sol", hidden: "" });
      var cmds = solucao.split(";;").map(function (c) { return c.trim(); }).filter(Boolean);
      painelSol.innerHTML = '<p class="sim-sol-tit">Uma solução:</p><pre class="sim-sol-cmd">' + cmds.map(function (c) { return "$ " + escHtml(c); }).join("\n") + '</pre><button type="button" class="sim-btn2 sim-rodar-sol">Rodar solução no terminal</button>';
      box.appendChild(painelSol);
    }
    var status = null;
    if (meta) { status = el("p", { "class": "sim-status" }, "Missão em andamento…"); box.appendChild(status); }
    var tela = caixa.querySelector(".sim-screen"), out = caixa.querySelector(".sim-out"), inp = caixa.querySelector(".sim-input"), pr = caixa.querySelector(".sim-prompt"), titulo = caixa.querySelector(".sim-title");
    var s, pendente = "", ocupado = false, lendo = null, hi = -1, rascunho = "", ultTab = 0, estAnsi = {}, linhaAtual = null, cumprida = false, filaDigitar = [];
    var saidaCmd = "", erroCmd = "";

    function rola() { tela.scrollTop = tela.scrollHeight; }
    function promptHtml() {
      var sh = s.sh;
      var ps1 = sh.valor("PS1");
      if (pendente) { return ansiParaHtml(s.prompt2()).html; }
      if (ps1 === "\\u@\\h:\\w\\$ ") {
        return '<span class="c-u">' + USER + "@" + HOST + '</span>:<span class="c-d">' + escHtml(sh.curto(sh.cwdLogico)) + "</span>$ ";
      }
      var txt = s.prompt().replace(/\x01|\x02/g, "");
      return ansiParaHtml(txt).html;
    }
    function atualizarPrompt() {
      pr.innerHTML = lendo ? "" : promptHtml();
      titulo.textContent = USER + "@" + HOST + ": " + s.sh.curto(s.sh.cwdLogico);
    }
    // escreve saída (pode ter várias linhas e \r)
    function escrever(txt, classe) {
      if (!txt) return;
      if (/\x1b\[H\x1b\[2J/.test(txt)) { out.innerHTML = ""; linhaAtual = null; txt = txt.split(/\x1b\[H\x1b\[2J(?:\x1b\[3J)?/).pop(); if (!txt) return; }
      var partes = txt.split("\n");
      if (partes.length > 1500) {
        var omitidas = partes.length - 1000;
        partes = partes.slice(-1000);
        out.appendChild(el("div", { "class": "sim-info" }, "(simulador) … " + omitidas + " linhas omitidas na tela …"));
        linhaAtual = null;
      }
      partes.forEach(function (p, i) {
        if (p === "" && i === partes.length - 1) return;
        if (!linhaAtual) { linhaAtual = el("div", { "class": classe || "" }); linhaAtual._txt = ""; out.appendChild(linhaAtual); }
        if (p.indexOf("\r") >= 0) { var seg = p.split("\r"); linhaAtual.innerHTML = ""; linhaAtual._txt = ""; p = seg[seg.length - 1]; }
        var r = ansiParaHtml(p, estAnsi); estAnsi = r.est;
        var span = el("span", { "class": classe || "" }, r.html);
        linhaAtual.appendChild(span);
        if (i < partes.length - 1) linhaAtual = null;
      });
      if (out.childNodes.length > 2000) { while (out.childNodes.length > 1500) out.removeChild(out.firstChild); }
    }
    function escreverLinhaCmd(html) { linhaAtual = null; var d = el("div", { "class": "sim-cmd" }, html); out.appendChild(d); }
    // junta pedaços do mesmo tipo e corta saídas enormes (mostra só o fim)
    function compactar(lista) {
      var r = [];
      lista.forEach(function (c) { var u = r[r.length - 1]; if (u && u.s === c.s) u.t += c.t; else r.push({ s: c.s, t: c.t }); });
      var total = 0; r.forEach(function (c) { total += (c.t.match(/\n/g) || []).length; });
      if (total <= 1500) return r;
      var manter = 1000, res = [], omit = total - manter;
      for (var i = r.length - 1; i >= 0 && manter > 0; i--) {
        var ls = r[i].t.split("\n"), n = ls.length - 1;
        if (n <= manter) { res.unshift(r[i]); manter -= n; }
        else { res.unshift({ s: r[i].s, t: ls.slice(ls.length - 1 - manter).join("\n") }); manter = 0; }
      }
      res.unshift({ s: "info", t: "(simulador) … " + omit + " linhas omitidas na tela …\n" });
      return res;
    }
    function despejar() {
      compactar(s.k.tirarSaida()).forEach(function (c) {
        if (c.s === "info") { escrever(c.t, "sim-info"); return; }
        if (c.s === "err" || c.s === "prompt") erroCmd += semCor(c.t); else saidaCmd += semCor(c.t);
        escrever(c.t, c.s === "err" ? "sim-err" : "");
      });
    }
    function checar() {
      if (!status || cumprida) return;
      var f = checarMeta(s.sh, meta, { out: saidaCmd, err: erroCmd, exit: s.sh.status, digitados: s.digitados });
      if (!f.length) { cumprida = true; status.textContent = "✔ Missão cumprida!"; status.className = "sim-status ok"; }
    }
    function terminou() {
      ocupado = false; lendo = null;
      s.finalizar();
      despejar();
      if (linhaAtual) linhaAtual = null;
      if (s.encerrado) {
        escrever("(simulador) o shell foi encerrado (exit). Abrimos um novo terminal; os arquivos continuam como estavam.\n", "sim-info");
        var k = s.k; s = new Sessao({ tty: true }); s.k = k; s.novoShell();
      } else rodarPromptCommand();
      checar();
      atualizarPrompt();
      inp.type = "text";
      rola();
      if (filaDigitar.length) setTimeout(digitarProximo, 350);
    }
    function rodarPromptCommand() {
      var pc = s.sh.valor("PROMPT_COMMAND");
      if (!pc) return;
      var st = s.sh.status, hist = s.sh.hist.length, dig = s.digitados.length;
      var p = s.k.spawn(s.sh, function* () { try { return yield* s.sh.rodarInterativo(pc + "\n"); } catch (e) { if (e instanceof ExitSig) return e.code; throw e; } }, { pid: 3001, manterFds: true });
      s.k.main = p;
      s.k.rodarSync(function () { return null; }, 200);
      s.sh.status = st; s.sh.hist.length = hist; s.digitados.length = dig;
      despejar();
    }
    function bombear() {
      var r;
      try { r = s.k.pump(4000); }
      catch (e) { escrever("(simulador) erro interno: " + (e && e.message || e) + "\n", "sim-err"); terminou(); return; }
      despejar(); rola();
      if (r.t === "fim") { terminou(); return; }
      if (r.t === "in") {
        lendo = r;
        pr.innerHTML = "";
        inp.type = r.req && r.req.req && r.req.req.silencioso ? "password" : "text";
        if (linhaAtual) { linhaAtual.classList.add("sim-semnl"); }
        inp.focus({ preventScroll: true });
        return;
      }
      if (r.t === "sleep") { var ms = Math.min(r.ms, 1200); setTimeout(function () { s.k.avancar(r.ate); bombear(); }, ms); return; }
      setTimeout(bombear, 0);
    }
    function executar(fonte) {
      saidaCmd = ""; erroCmd = "";
      if (s.iniciar(fonte)) { ocupado = true; pr.innerHTML = ""; bombear(); }
      else terminou();
    }
    function enviar(linha) {
      if (ocupado && lendo) {
        // entrada para um comando (read, cat…)
        var silenc = inp.type === "password", vis = silenc ? "" : linha;
        if (linhaAtual) { linhaAtual.appendChild(el("span", { "class": "sim-digitado" }, escHtml(vis))); if (!silenc) linhaAtual = null; }
        else if (!silenc) escreverLinhaCmd(escHtml(vis));
        else { linhaAtual = el("div"); out.appendChild(linhaAtual); }
        var proc = lendo.proc; lendo = null; inp.type = "text";
        s.k.darEntrada(proc, linha);
        bombear(); return;
      }
      if (ocupado) return;
      escreverLinhaCmd(promptHtml() + escHtml(linha));
      var fonte = pendente ? pendente + "\n" + linha : linha;
      if (s.incompleta(fonte)) { pendente = fonte; atualizarPrompt(); rola(); return; }
      pendente = "";
      if (!fonte.trim() && !/\n/.test(fonte)) { atualizarPrompt(); rola(); return; }
      executar(fonte);
    }
    function inicia() {
      s = new Sessao({ tty: true });
      if (setup) setup.split(";;").forEach(function (c) { if (c.trim()) s.rodarSync(c, function () { return null; }); });
      s.k.tirarSaida(); s.sh.hist.length = 0; s.digitados = []; s.sh.status = 0; s.sh.lineno = 1;
      out.innerHTML = ""; linhaAtual = null; estAnsi = {}; pendente = ""; ocupado = false; lendo = null; cumprida = false;
      escrever(MSG_INICIAL + "\n", "sim-msg");
      atualizarPrompt();
      if (status) { status.textContent = "Missão em andamento…"; status.className = "sim-status"; }
    }
    function digitarProximo() {
      if (!filaDigitar.length || ocupado) return;
      var c = filaDigitar.shift(), i = 0;
      inp.value = "";
      (function letra() {
        if (i < c.length) { inp.value += c[i++]; setTimeout(letra, 18); return; }
        setTimeout(function () { inp.value = ""; enviar(c); if (!ocupado && filaDigitar.length) setTimeout(digitarProximo, 300); }, 150);
      })();
    }
    // edição de linha estilo readline
    function palavraAntes(v, pos) { var i = pos; while (i > 0 && /\s/.test(v[i - 1])) i--; while (i > 0 && !/\s/.test(v[i - 1])) i--; return i; }
    function palavraDepois(v, pos) { var i = pos; while (i < v.length && !/[\w\u00c0-\uffff]/.test(v[i])) i++; while (i < v.length && /[\w\u00c0-\uffff]/.test(v[i])) i++; return i; }
    function palavraAntesAlfa(v, pos) { var i = pos; while (i > 0 && !/[\w\u00c0-\uffff]/.test(v[i - 1])) i--; while (i > 0 && /[\w\u00c0-\uffff]/.test(v[i - 1])) i--; return i; }
    // Ctrl+R: busca reversa no histórico, como o readline
    var busca = null; // {q, idx, original}
    function mostrarBusca() {
      var h = s.sh.hist, achou = -1;
      for (var i = Math.min(busca.idx, h.length - 1); i >= 0; i--) if (busca.q && h[i].indexOf(busca.q) >= 0) { achou = i; break; }
      if (busca.q === "") achou = -1;
      busca.achado = achou;
      pr.innerHTML = escHtml((achou < 0 && busca.q ? "(failed reverse-i-search)`" : "(reverse-i-search)`") + busca.q + "': ");
      inp.value = achou >= 0 ? h[achou] : (busca.q ? inp.value : "");
    }
    function sairBusca(aceitar) {
      var b = busca; busca = null; atualizarPrompt();
      if (!aceitar) inp.value = b.original;
    }
    inp.addEventListener("keydown", function (e) {
      if (busca) {
        if (e.ctrlKey && (e.key === "r" || e.key === "R")) { e.preventDefault(); busca.idx = busca.achado > 0 ? busca.achado - 1 : busca.idx; mostrarBusca(); return; }
        if (e.key === "Escape" || (e.ctrlKey && (e.key === "g" || e.key === "G"))) { e.preventDefault(); sairBusca(false); return; }
        if (e.key === "Backspace") { e.preventDefault(); busca.q = busca.q.slice(0, -1); busca.idx = s.sh.hist.length - 1; mostrarBusca(); return; }
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); busca.q += e.key; mostrarBusca(); return; }
        if (e.key === "Enter") { sairBusca(true); }
        else if (/^Arrow|^Home$|^End$/.test(e.key) || e.ctrlKey) { sairBusca(true); if (!e.ctrlKey) return; }
        else return;
      }
      if (e.ctrlKey && (e.key === "r" || e.key === "R") && !lendo && !ocupado) { e.preventDefault(); busca = { q: "", idx: s.sh.hist.length - 1, original: inp.value, achado: -1 }; mostrarBusca(); return; }
      var v = inp.value, pos = inp.selectionStart;
      if (e.key === "Enter") { e.preventDefault(); inp.value = ""; hi = -1; enviar(v); rola(); return; }
      if (e.ctrlKey && !e.altKey && (e.key === "c" || e.key === "C")) {
        if (window.getSelection && String(window.getSelection())) return;
        e.preventDefault();
        if (ocupado) { escrever("^C\n", ""); s.k.ctrlC(); if (lendo) { var p0 = lendo.proc; lendo = null; s.k.darEntrada(p0, null); bombear(); } return; }
        escreverLinhaCmd(promptHtml() + escHtml(v) + "^C"); inp.value = ""; pendente = ""; s.sh.status = 130; atualizarPrompt(); rola(); return;
      }
      if (e.ctrlKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (ocupado && lendo) { if (v === "") { var p1 = lendo.proc; lendo = null; if (linhaAtual) linhaAtual = null; s.k.darEntrada(p1, null); bombear(); } return; }
        return;
      }
      if (e.ctrlKey && (e.key === "l" || e.key === "L")) { e.preventDefault(); out.innerHTML = ""; linhaAtual = null; return; }
      if (e.ctrlKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); inp.setSelectionRange(0, 0); return; }
      if (e.ctrlKey && (e.key === "e" || e.key === "E")) { e.preventDefault(); inp.setSelectionRange(v.length, v.length); return; }
      if (e.ctrlKey && (e.key === "u" || e.key === "U")) { e.preventDefault(); s._kill = v.slice(0, pos); inp.value = v.slice(pos); inp.setSelectionRange(0, 0); return; }
      if (e.ctrlKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); s._kill = v.slice(pos); inp.value = v.slice(0, pos); return; }
      if (e.ctrlKey && (e.key === "w" || e.key === "W")) { e.preventDefault(); var ini = palavraAntes(v, pos); s._kill = v.slice(ini, pos); inp.value = v.slice(0, ini) + v.slice(pos); inp.setSelectionRange(ini, ini); return; }
      if (e.ctrlKey && (e.key === "y" || e.key === "Y")) { e.preventDefault(); var kk = s._kill || ""; inp.value = v.slice(0, pos) + kk + v.slice(pos); inp.setSelectionRange(pos + kk.length, pos + kk.length); return; }
      if (e.altKey && (e.key === "b" || e.key === "B")) { e.preventDefault(); var pb = palavraAntesAlfa(v, pos); inp.setSelectionRange(pb, pb); return; }
      if (e.altKey && (e.key === "f" || e.key === "F")) { e.preventDefault(); var pf = palavraDepois(v, pos); inp.setSelectionRange(pf, pf); return; }
      if (e.altKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); var pd = palavraDepois(v, pos); inp.value = v.slice(0, pos) + v.slice(pd); inp.setSelectionRange(pos, pos); return; }
      if (e.key === "ArrowUp" && !lendo) {
        var h = s.sh.hist; if (!h.length) return; e.preventDefault();
        if (hi === -1) { rascunho = v; hi = h.length; }
        hi = Math.max(0, hi - 1); inp.value = h[hi]; return;
      }
      if (e.key === "ArrowDown" && !lendo) {
        if (hi === -1) return; e.preventDefault();
        hi++; if (hi >= s.sh.hist.length) { hi = -1; inp.value = rascunho; } else inp.value = s.sh.hist[hi];
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (lendo) return;
        var antesC = v.slice(0, pos), depoisC = v.slice(pos);
        var c = completar(s.sh, antesC);
        var agora = Date.now();
        if (c.linha !== antesC) { inp.value = c.linha + depoisC; inp.setSelectionRange(c.linha.length, c.linha.length); ultTab = /[\s\/]$/.test(c.linha) ? 0 : agora; return; }
        if (c.lista.length && agora - ultTab < 800) {
          escreverLinhaCmd(promptHtml() + escHtml(v));
          escrever(colunasLs(c.lista.map(function (x) { return { txt: x, w: largura(x) }; }), 80, false).join("\n") + "\n", "");
          rola(); ultTab = 0; return;
        }
        ultTab = agora;
        return;
      }
    });
    tela.addEventListener("click", function () { if (!String(window.getSelection ? window.getSelection() : "")) inp.focus({ preventScroll: true }); });
    caixa.querySelector(".sim-reset").addEventListener("click", function () { filaDigitar = []; inicia(); inp.focus({ preventScroll: true }); });
    if (painelSol) {
      caixa.querySelector(".sim-ver").addEventListener("click", function () { var esc = painelSol.hasAttribute("hidden"); if (esc) painelSol.removeAttribute("hidden"); else painelSol.setAttribute("hidden", ""); this.textContent = esc ? "Esconder solução" : "Ver solução"; });
      painelSol.querySelector(".sim-rodar-sol").addEventListener("click", function () {
        filaDigitar = solucao.split(";;").map(function (c) { return c.trim(); }).filter(Boolean);
        if (!ocupado) digitarProximo();
        tela.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
    inicia();
  }

  /* ---------- editor .tryscript ---------- */
  function montarTryscript(box) {
    if (box.getAttribute("data-montado")) return;
    box.setAttribute("data-montado", "1");
    var arquivo = box.getAttribute("data-file") || "script.sh", setup = box.getAttribute("data-setup") || "", meta = box.getAttribute("data-goal") || "";
    var argsIni = box.getAttribute("data-args") || "", stdinAttr = box.getAttribute("data-stdin");
    var preS = box.querySelector("pre.script"), preSol = box.querySelector("pre.solucao");
    var original = preS ? preS.textContent.replace(/^\n/, "") : "";
    var sol = preSol ? preSol.textContent.replace(/^\n/, "") : null;
    if (preS) preS.style.display = "none";
    if (preSol) preSol.style.display = "none";
    var w = el("div", { "class": "ts" });
    w.innerHTML =
      '<div class="ts-bar"><span class="ts-arq"></span><span class="ts-sp"></span>' +
      (sol !== null ? '<button type="button" class="sim-btn ts-sol">Ver solução</button>' : "") +
      '<button type="button" class="sim-btn ts-rest" title="Volta ao código original">Restaurar</button></div>' +
      '<div class="ts-confirma" hidden><span>Trocar o seu código pela solução?</span> <button type="button" class="sim-btn2 ts-sim">Sim, mostrar</button> <button type="button" class="sim-btn2 secundario ts-nao">Cancelar</button></div>' +
      '<div class="ts-editor"><pre class="ts-nums" aria-hidden="true"></pre><textarea class="ts-code" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="Código do script"></textarea></div>' +
      '<div class="ts-run"><label class="ts-args-l">Argumentos: <input class="ts-args" type="text" spellcheck="false" autocomplete="off" autocapitalize="off"></label><button type="button" class="ts-rodar">▶ Rodar</button></div>' +
      '<div class="sim ts-saida" hidden><div class="sim-bar"><span class="sim-dots"><i></i><i></i><i></i></span><span class="sim-title">Saída</span></div><div class="sim-screen ts-tela"><div class="sim-out"></div></div></div>';
    box.appendChild(w);
    var status = null;
    if (meta) { status = el("p", { "class": "sim-status" }, "Missão em andamento…"); box.appendChild(status); }
    var ta = w.querySelector(".ts-code"), nums = w.querySelector(".ts-nums"), argsIn = w.querySelector(".ts-args"), btn = w.querySelector(".ts-rodar");
    var saidaBox = w.querySelector(".ts-saida"), out = w.querySelector(".sim-out"), tela = w.querySelector(".ts-tela");
    w.querySelector(".ts-arq").textContent = arquivo;
    ta.value = original; argsIn.value = argsIni;
    var s = null, rodando = false, linhaAtual = null, estAnsi = {}, campo = null, cumprida = false, saidaTxt = "", erroTxt = "";
    function ajustar() {
      var n = ta.value.split("\n").length;
      var t = ""; for (var i = 1; i <= n; i++) t += i + "\n";
      nums.textContent = t;
      ta.style.height = "auto";
      ta.style.height = Math.max(ta.scrollHeight, 60) + "px";
    }
    ta.addEventListener("input", ajustar);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); var a = ta.selectionStart, b = ta.selectionEnd; ta.value = ta.value.slice(0, a) + "  " + ta.value.slice(b); ta.selectionStart = ta.selectionEnd = a + 2; ajustar(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); rodar(); }
      else if (e.key === "Enter") {
        // mantém a indentação da linha anterior
        var p = ta.selectionStart, ini = ta.value.lastIndexOf("\n", p - 1) + 1, ind = /^[ \t]*/.exec(ta.value.slice(ini, p))[0];
        if (ind) { e.preventDefault(); ta.value = ta.value.slice(0, p) + "\n" + ind + ta.value.slice(ta.selectionEnd); ta.selectionStart = ta.selectionEnd = p + 1 + ind.length; ajustar(); }
      }
    });
    function escrever(txt, classe) {
      if (!txt) return;
      if (/\x1b\[H\x1b\[2J/.test(txt)) { out.innerHTML = ""; linhaAtual = null; txt = txt.split(/\x1b\[H\x1b\[2J(?:\x1b\[3J)?/).pop(); if (!txt) return; }
      txt.split("\n").forEach(function (p, i, arr) {
        if (p === "" && i === arr.length - 1) return;
        if (!linhaAtual) { linhaAtual = el("div"); out.appendChild(linhaAtual); }
        if (p.indexOf("\r") >= 0) { linhaAtual.innerHTML = ""; p = p.split("\r").pop(); }
        var r = ansiParaHtml(p, estAnsi); estAnsi = r.est;
        linhaAtual.appendChild(el("span", { "class": classe || "" }, r.html));
        if (i < arr.length - 1) linhaAtual = null;
      });
    }
    function despejar() { var lst = s.k.tirarSaida(); if (lst.length > 50) { var tot = ""; lst.forEach(function (c) { tot += c.t; }); var ls0 = tot.split("\n"); if (ls0.length > 1500) { escrever("(simulador) … " + (ls0.length - 1000) + " linhas omitidas na tela …\n", "sim-info"); lst = [{ s: "out", t: ls0.slice(-1001).join("\n") }]; } } lst.forEach(function (c) { if (c.s === "err" || c.s === "prompt") erroTxt += semCor(c.t); else saidaTxt += semCor(c.t); escrever(c.t, c.s === "err" ? "sim-err" : ""); }); tela.scrollTop = tela.scrollHeight; }
    function fim() {
      rodando = false; btn.disabled = false; btn.textContent = "▶ Rodar";
      despejar();
      linhaAtual = null;
      var st = s.main ? s.main.status : 0;
      out.appendChild(el("div", { "class": "ts-codigo" + (st ? " ts-erro" : "") }, "[código de saída: " + st + "]"));
      tela.scrollTop = tela.scrollHeight;
      if (status && !cumprida) {
        var f = checarMeta(s.sh, meta, { out: saidaTxt, err: erroTxt, exit: st, src: ta.value, digitados: [] });
        if (!f.length) { cumprida = true; status.textContent = "✔ Missão cumprida!"; status.className = "sim-status ok"; }
        else if (!/^(src|out|outre|err)/.test(f[0])) status.textContent = "Missão em andamento… (ainda falta: " + f.join(", ") + ")";
        else status.textContent = "Missão em andamento… (a saída ainda não é a esperada)";
      }
    }
    function bombear() {
      var r;
      try { r = s.k.pump(4000); } catch (e) { escrever("(simulador) erro interno: " + (e && e.message || e) + "\n", "sim-err"); fim(); return; }
      despejar();
      if (r.t === "fim") { fim(); return; }
      if (r.t === "in") {
        // campo para o read
        var proc = r.proc, silencioso = r.req && r.req.req && r.req.req.silencioso;
        if (!linhaAtual) { linhaAtual = el("div"); out.appendChild(linhaAtual); }
        campo = el("input", { "class": "ts-campo", type: silencioso ? "password" : "text", spellcheck: "false", autocomplete: "off", "aria-label": "Entrada para o script (Enter envia, Ctrl+D encerra)" });
        linhaAtual.appendChild(campo);
        campo.focus({ preventScroll: true });
        tela.scrollTop = tela.scrollHeight;
        campo.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || (e.ctrlKey && (e.key === "d" || e.key === "D"))) {
            e.preventDefault();
            var eof = e.key !== "Enter", v = campo.value;
            var span = el("span", { "class": "sim-digitado" }, eof ? "" : escHtml(silencioso ? "" : v));
            campo.parentNode.replaceChild(span, campo); campo = null; if (!silencioso || eof) linhaAtual = null;
            s.k.darEntrada(proc, eof ? null : v);
            bombear();
          } else if (e.ctrlKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); s.k.ctrlC(); campo.parentNode.replaceChild(el("span", {}, "^C"), campo); campo = null; linhaAtual = null; s.k.darEntrada(proc, null); bombear(); }
        });
        return;
      }
      if (r.t === "sleep") { setTimeout(function () { s.k.avancar(r.ate); bombear(); }, Math.min(r.ms, 1200)); return; }
      setTimeout(bombear, 0);
    }
    function rodar() {
      if (rodando) { s.k.ctrlC(); return; }
      s = new Sessao({ tty: true });
      if (setup) setup.split(";;").forEach(function (c) { if (c.trim()) s.rodarSync(c, function () { return null; }); });
      s.k.tirarSaida();
      out.innerHTML = ""; linhaAtual = null; estAnsi = {}; saidaTxt = ""; erroTxt = "";
      saidaBox.hidden = false;
      var args = dividirArgsSimples(argsIn.value);
      out.appendChild(el("div", { "class": "sim-cmd" }, '<span class="c-u">ana@notebook</span>:<span class="c-d">~</span>$ bash ' + escHtml(arquivo) + (argsIn.value.trim() ? " " + escHtml(argsIn.value.trim()) : "")));
      rodando = true; btn.textContent = "■ Parar";
      s.iniciarScript(arquivo, ta.value.replace(/\n?$/, "\n"), args, stdinAttr !== null ? decodificarAttr(stdinAttr) : null);
      bombear();
    }
    btn.addEventListener("click", rodar);
    w.querySelector(".ts-rest").addEventListener("click", function () { ta.value = original; ajustar(); });
    var conf = w.querySelector(".ts-confirma");
    if (sol !== null) {
      w.querySelector(".ts-sol").addEventListener("click", function () { conf.hidden = false; });
      w.querySelector(".ts-sim").addEventListener("click", function () { ta.value = sol; ajustar(); conf.hidden = true; });
      w.querySelector(".ts-nao").addEventListener("click", function () { conf.hidden = true; });
    }
    ajustar();
  }
  function carregarScriptAjuda() {
    if (global.BashSimAjuda) return;
    var scripts = document.getElementsByTagName("script"), base = "assets/";
    for (var i = 0; i < scripts.length; i++) { var src = scripts[i].getAttribute("src") || ""; if (/bashsim\.js(\?|$)/.test(src)) { base = src.replace(/bashsim\.js.*$/, ""); break; } }
    var s = document.createElement("script"); s.src = base + "bashsim-ajuda.js"; s.async = true;
    document.body.appendChild(s);
  }
  function montarTudo() {
    if (document.querySelector(".try, .tryscript")) setTimeout(carregarScriptAjuda, 1500);
    Array.prototype.forEach.call(document.querySelectorAll(".try"), function (b) { try { montarTry(b); } catch (e) { if (typeof console !== "undefined") console.error(e); } });
    Array.prototype.forEach.call(document.querySelectorAll(".tryscript"), function (b) { try { montarTryscript(b); } catch (e) { if (typeof console !== "undefined") console.error(e); } });
  }

  /* ------------------------------------------------------------------
     14. Sessão: um terminal (shell interativo) ou uma rodada de script
     ------------------------------------------------------------------ */
  function Sessao(opt) {
    opt = opt || {};
    this.k = new Kernel();
    this.tty = opt.tty !== false;
    this.digitados = [];
    this.ultimaSaida = ""; this.ultimoErro = "";
    this.novoShell();
  }
  var SEP = Sessao.prototype;
  SEP.novoShell = function () {
    var sh = new Shell(this.k, { interativo: true });
    var k = this.k;
    sh.shopt.expand_aliases = 1; sh.shopt.histappend = 1; sh.shopt.checkwinsize = 1;
    sh.o.histexpand = 1; sh.o.history = 1; sh.o.emacs = 1; sh.o.monitor = this.tty ? 1 : 0;
    sh.aliases.ls = "ls --color=auto"; sh.aliases.grep = "grep --color=auto";
    sh.aliases.ll = "ls -alF"; sh.aliases.la = "ls -A"; sh.aliases.l = "ls -CF";
    sh.globais.HISTCONTROL = new Var("ignoreboth"); sh.globais.HISTSIZE = new Var("1000"); sh.globais.HISTFILESIZE = new Var("2000");
    sh.globais.PS1 = new Var(this.tty ? "\\u@\\h:\\w\\$ " : "$ ");
    var naoTTY = !this.tty;
    sh.fds = [ref(new OFD("tty-in", { naoTTY: naoTTY })), ref(new OFD("tty-out", { stream: "out", naoTTY: naoTTY })), ref(new OFD("tty-out", { stream: "err", naoTTY: naoTTY }))];
    sh.pidShell = 3001;
    sh.semTTY = naoTTY;
    sh.lineno = 1;
    this.sh = sh;
    this.encerrado = false;
  };
  SEP.prompt = function () { var p = this.sh.valor("PS1"); return this.sh.expandirPrompt(p === null ? "" : p); };
  SEP.prompt2 = function () { var p = this.sh.valor("PS2"); return this.sh.expandirPrompt(p === null ? "" : p); };
  SEP.incompleta = function (fonte) { return incompleta(fonte + "\n", this.sh); };
  // começa a rodar um comando completo (possivelmente com várias linhas)
  SEP.iniciar = function (fonte) {
    var sh = this.sh, k = this.k, self = this;
    k.steps = 0; k.bytesSaida = 0;
    this.saidaCmd = ""; this.erroCmd = "";
    var hx = sh.expandirHistorico(fonte);
    if (hx.erro) { k.saida("err", hx.erro + "\n"); sh.status = 1; this.digitados.push(fonte); this.registrarHist(fonte); this.main = null; return false; }
    if (hx.mudou) { fonte = hx.linha; k.saida("out", fonte + "\n"); }
    this.digitados.push(fonte);
    this.registrarHist(fonte);
    if (hx.soImprimir) { this.main = null; return false; }
    var linhas = fonte.split("\n").length;
    var p = k.spawn(sh, function* () {
      try { return yield* sh.rodarInterativo(fonte + "\n"); }
      catch (e) {
        if (e instanceof ExitSig) { self.encerrado = true; throw e; }
        throw e;
      }
    }, { pid: 3001, nome: "bash", semTrap: false, manterFds: true });
    sh.trapSaida = false;
    if (sh.traps[0]) { /* o trap EXIT do shell interativo roda só no exit */ }
    k.main = p;
    p.onFim = function (pr) { if (pr.status !== null && self.encerrado) { /* saiu */ } };
    this.main = p;
    sh.lineno += 0;
    this._linhas = linhas;
    return true;
  };
  SEP.registrarHist = function (fonte) {
    var sh = this.sh, hc = sh.valor("HISTCONTROL") || "";
    var linha = juntarHist(fonte);
    if (/ignorespace|ignoreboth/.test(hc) && /^\s/.test(fonte)) return;
    if (/ignoredups|ignoreboth/.test(hc) && sh.hist[sh.hist.length - 1] === linha) return;
    if (!linha.trim()) return;
    sh.hist.push(linha);
  };
  function juntarHist(fonte) {
    var ls = fonte.split("\n");
    if (ls.length === 1) return fonte;
    var r = ls[0];
    for (var i = 1; i < ls.length; i++) {
      var ant = r.replace(/\s+$/, "");
      var l = ls[i].replace(/^\s+/, "");
      if (l === "") continue;
      if (/(\bdo|\bthen|\belse|\{|\(|\||&&|\|\||;|\bin)$/.test(ant)) r = ant + " " + l;
      else r = ant + "; " + l;
    }
    return r;
  }
  // depois que o comando termina: avisos de jobs, $?
  SEP.finalizar = function () {
    var sh = this.sh, k = this.k;
    if (this.main && this.main.done) {
      if (this.encerrado || (this.main.status !== null && this.main.porSinal === undefined && sh.saiu)) { }
    }
    var linhas = sh.limparJobs(!!sh.o.monitor);
    linhas.forEach(function (l) { k.saida("err", l + "\n"); });
    sh.lineno += this._linhas || 1;
    this.main = null;
  };
  // Node: roda um comando completo até o fim. entrada(req) devolve linhas para o teclado.
  SEP.rodarSync = function (fonte, entrada) {
    if (this.iniciar(fonte)) this.k.rodarSync(entrada);
    this.finalizar();
    return this.k.tirarSaida();
  };
  // roda um script como "bash arquivo args" a partir da pasta pessoal
  SEP.iniciarScript = function (arquivo, codigo, args, stdin) {
    var sh = this.sh, k = this.k;
    var r = sh.abrir(arquivo, "w");
    if (!r.err) { escreverOFD(k, r, codigo); }
    var self = this;
    k.steps = 0; k.bytesSaida = 0;
    var p = k.spawn(sh, function* () {
      var salvo0 = sh.fds[0];
      if (stdin !== null && stdin !== undefined) { sh.fds[0] = ref(new OFD("file", { no: { t: "f", d: stdin, m: 384, u: UID, g: GID }, pos: 0, rd: true })); }
      try { return yield* sh.executar(["bash", arquivo].concat(args || []), {}); }
      catch (e) {
        if (e instanceof AbortSig) {
          if (e.msg === "int") { k.saida("err", "^C\n"); return 130; }
          if (e.msg === "recursao") return 1;
          k.saida("err", e.msg === "saida" ? "(simulador) execução interrompida: saída grande demais.\n" : "(simulador) execução interrompida: passou de " + k.limit + " passos (laço infinito?). No terminal de verdade, use Ctrl+C para parar.\n");
          return 130;
        }
        throw e;
      }
      finally { if (sh.fds[0] !== salvo0) { unref(sh.fds[0]); sh.fds[0] = salvo0; } }
    }, { pid: 3001, nome: "bash", semTrap: true, manterFds: true });
    k.main = p;
    this.main = p;
    return p;
  };
  SEP.statusUltimo = function () { return this.main ? this.main.status : this.sh.status; };

  /* ---------- metas (data-goal) ---------- */
  function dividirMetas(meta) {
    var r = [], cur = "";
    for (var i = 0; i < meta.length; i++) {
      if (meta[i] === "\\" && meta[i + 1] === ",") { cur += ","; i++; continue; }
      if (meta[i] === "," && (/^\s*(dir|file|absent|exec|link|contains|cwd|var|func|alias|ran|out|outre|err|errre|exit|src|commits|preparado|naopreparado|rastreado|ignorado|branch|semBranch|head|msg|logre|tag|remoto|contem|stash):/.test(meta.slice(i + 1)) || /^\s*(repo|limpo|conflito|semconflito)\s*(,|$)/.test(meta.slice(i + 1)))) { r.push(cur); cur = ""; continue; }
      cur += meta[i];
    }
    r.push(cur);
    return r.map(function (x) { return x.trim(); }).filter(Boolean);
  }
  // ctx: {out, err, exit, digitados[], src}
  function checarMeta(sh, meta, ctx) {
    var falhas = [];
    dividirMetas(meta).forEach(function (g) {
      var i = g.indexOf(":"); if (i < 0) i = g.length;
      var tipo = g.slice(0, i), val = g.slice(i + 1), ok = false, r;
      function cam(v) { return v === "~" ? HOME : v.indexOf("~/") === 0 ? HOME + v.slice(1) : (v[0] === "/" ? v : HOME + "/" + v); }
      try {
        switch (tipo) {
          case "dir": r = sh.resolver(cam(val), true); ok = !!(r.no && r.no.t === "d"); break;
          case "file": r = sh.resolver(cam(val), true); ok = !!(r.no && r.no.t === "f"); break;
          case "absent": r = sh.resolver(cam(val), false); ok = !r.no; break;
          case "exec": r = sh.resolver(cam(val), true); ok = !!(r.no && r.no.t === "f" && sh.pode(r.no, 1)); break;
          case "link": r = sh.resolver(cam(val), false); ok = !!(r.no && r.no.t === "l"); break;
          case "contains": { var e = val.indexOf("="); r = sh.resolver(cam(val.slice(0, e)), true); ok = !!(r.no && r.no.t === "f" && dadosDe(r.no).indexOf(val.slice(e + 1)) >= 0); break; }
          case "cwd": ok = sh.cwdLogico === normalizar(cam(val)) || sh.cwd === normalizar(cam(val)); break;
          case "var": { var e2 = val.indexOf("="); if (e2 < 0) ok = sh.varExiste(val); else { var v = sh.valor(val.slice(0, e2)); ok = v === val.slice(e2 + 1); } break; }
          case "func": ok = !!sh.funcs[val]; break;
          case "alias": ok = sh.aliases[val] !== undefined; break;
          case "ran": { var re = new RegExp(val); ok = (ctx.digitados || []).some(function (d) { return re.test(d); }); break; }
          case "out": ok = (ctx.out || "").indexOf(val) >= 0; break;
          case "outre": ok = new RegExp(val, "m").test(ctx.out || ""); break;
          case "err": ok = (ctx.err || "").indexOf(val) >= 0; break;
          case "errre": ok = new RegExp(val, "m").test(ctx.err || ""); break;
          case "exit": ok = String(ctx.exit) === val; break;
          case "src": ok = new RegExp(val, "m").test(ctx.src || ""); break;
          default: { var mg = BashSim.gitsim ? BashSim.gitsim.meta(sh, tipo, val) : undefined; ok = mg === true; } // metas do Git (gitsim.js)
        }
      } catch (ex) { ok = false; }
      if (!ok) falhas.push(g);
    });
    return falhas;
  }

  /* ------------------------------------------------------------------
     Exportação
     ------------------------------------------------------------------ */
  var BashSim = {
    Sessao: Sessao, Shell: Shell, Kernel: Kernel, Parser: Parser,
    opcoes: OPCOES, checarMeta: checarMeta, dividirMetas: dividirMetas, semCor: semCor,
    incompleta: incompleta, BUILTINS: BUILTINS, EXT: EXT, versao: BASH_VERSION,
    _internos: { mkF: mkF, mkD: mkD, utf8bytes: utf8bytes, compilarSed: compilarSed, casaPadrao: casaPadrao, ereParaJs: ereParaJs, imprimirCmd: imprimirCmd, Arith: Arith }
  };
  global.BashSim = BashSim;
  (global.BashSimExtras || []).forEach(function (f) { f(BashSim); }); // extensões carregadas antes (gitsim.js)
  if (typeof document !== "undefined" && typeof montarTudo === "function") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", montarTudo); else montarTudo();
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = BashSim;
    try { require("./gitsim-ajuda.js"); } catch (e) {}
    try { require("./gitsim.js")(BashSim); } catch (e) { if (!/Cannot find module/.test(e.message)) throw e; } // o Git simulado
  }
})(typeof window !== "undefined" ? window : globalThis);

#!/usr/bin/env node
/*
  tools/testes/rodar.js — testes diferenciais do simulador.

  Cada caso (arquivos tools/testes/*.casos) roda no simulador e no Bash real do laboratório
  (~/guia-bash-lab/lab; os 2*-git*.casos no Git do ~/guia-git-lab/lab), e as saídas são comparadas.

  Formato dos arquivos .casos:
      ### nome-do-caso            sessão interativa (como "lab -i": $ / >, stderr junto)
      linhas digitadas…
      ### nome-do-caso [script]   o corpo vira t.sh e roda "bash t.sh" (stdout+stderr e código)
      ### nome [script args="a b" stdin="x\ny"]
  Linhas começando com "#!" dentro de um caso fazem parte dele; "##" no início é comentário.

  Uso:
    node tools/testes/rodar.js                 # todos os casos (usa o cache do laboratório)
    node tools/testes/rodar.js expansoes       # só os arquivos/casos cujo nome contém "expansoes"
    node tools/testes/rodar.js --lab           # força rodar de novo no laboratório (ignora o cache)
    node tools/testes/rodar.js --diff          # mostra o diff de cada caso diferente
    node tools/testes/rodar.js --lista         # lista os casos diferentes (sem diff)

  O laboratório é chamado UMA vez, com todos os casos que faltam no cache (um processo, com
  timeout), para não pesar na máquina. O cache fica em tools/testes/.cache-lab.json.
*/
"use strict";
var fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
var sim = require(path.join(__dirname, "..", "sim.js"));
var DIR = __dirname, CACHE = path.join(DIR, ".cache-lab.json");
var LAB = path.join(process.env.HOME || require("os").homedir(), "guia-bash-lab", "lab");
var LAB_GIT = path.join(process.env.HOME || require("os").homedir(), "guia-git-lab", "lab"); // casos 2*-git*.casos: o Git real do lab do Guia Git
function ehGit(c) { return /^2\d-git/.test(c.arq); }

function lerCasos(filtro) {
  var casos = [];
  fs.readdirSync(DIR).filter(function (f) { return /\.casos$/.test(f); }).sort().forEach(function (f) {
    var txt = fs.readFileSync(path.join(DIR, f), "utf8"), atual = null;
    txt.split("\n").forEach(function (l) {
      var m = /^### (\S+)(?:\s+\[(script|sessao)([^\]]*)\])?\s*$/.exec(l);
      if (m) {
        atual = { arq: f.replace(/\.casos$/, ""), nome: m[1], tipo: m[2] === "script" ? "s" : "i", linhas: [], args: [], stdin: null };
        var extra = m[3] || "", ma;
        if ((ma = /args="([^"]*)"/.exec(extra))) atual.args = ma[1] ? ma[1].split(" ") : [];
        if ((ma = /stdin="([^"]*)"/.exec(extra))) atual.stdin = ma[1].replace(/\\n/g, "\n");
        casos.push(atual); return;
      }
      if (!atual) return;
      if (/^##(?!#)/.test(l) && atual.tipo === "i") return;
      atual.linhas.push(l);
    });
  });
  casos.forEach(function (c) {
    while (c.linhas.length && c.linhas[c.linhas.length - 1] === "") c.linhas.pop();
    c.texto = c.linhas.join("\n") + "\n";
    c.id = crypto.createHash("sha1").update(c.tipo + "\0" + c.texto + "\0" + c.args.join(" ") + "\0" + (c.stdin || "")).digest("hex").slice(0, 16);
  });
  if (filtro) casos = casos.filter(function (c) { return (c.arq + "/" + c.nome).indexOf(filtro) >= 0; });
  return casos;
}

// Driver que roda dentro da caixa: recebe os casos pela entrada padrão
var DRIVER = [
  'set +o histexpand',
  'D=/dev/shm/labdrv; mkdir -p $D/c; cd $D/c; cat > todos',
  'cp -a --sparse=always /home/ana $D/modelo',
  'reset_home() { cd /; find /home/ana -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; cp -a --sparse=always $D/modelo/. /home/ana/; rm -rf /tmp/* /tmp/.[!.]* 2>/dev/null; cd /home/ana; }',
  'awk -v RS="\\x1e" "NR>1{f=\\"$D/c/caso\\" NR-1; printf \\"%s\\", \\$0 > f; close(f)}" $D/c/todos',
  'for f in $(ls $D/c/caso* | sort -V); do',
  '  reset_home',
  '  read -r cab < "$f"',
  '  id=${cab%% *}; tipo=$(echo "$cab" | cut -d" " -f2)',
  '  tail -n +2 "$f" > $D/c/corpo',
  '  printf "\\x1d%s\\n" "$id"',
  '  if [ "$tipo" = i ]; then',
  '    env -u OLDPWD timeout 20 bash --rcfile /etc/lab-rc -i < $D/c/corpo 2>&1 | sed -e "/^bash: impossível definir grupo do processo/d" -e "/^bash: nenhum controle de trabalho neste shell$/d" -e "\\${/^\\$ exit\\$/d;/^exit\\$/d}" -e "\\$s/^\\$ \\$//" | head -c 200000',
  '  else',
  '    args=$(echo "$cab" | cut -d" " -f3- | sed "s/\\x1f.*//")',
  '    stdin=$(echo "$cab" | sed -n "s/.*\\x1f//p")',
  '    cp $D/c/corpo /home/ana/t.sh',
  '    if [ -n "$stdin" ]; then printf "%b" "$stdin" > $D/c/stdin; else : > $D/c/stdin; fi',
  '    env -u OLDPWD timeout 20 bash t.sh $args < $D/c/stdin > $D/c/saida 2>&1; rc=$?; head -c 200000 $D/c/saida; echo "[código de saída: $rc]"',
  '  fi',
  'done'
].join("\n");

function rodarLab(casos) {
  if (!casos.length) return {};
  var entrada = casos.map(function (c) {
    var cab = c.id + " " + c.tipo + " " + c.args.join(" ") + (c.stdin !== null ? "\x1f" + c.stdin.replace(/\\/g, "\\\\").replace(/\n/g, "\\n") : "");
    return "\x1e" + cab + "\n" + c.texto;
  }).join("");
  process.stderr.write("laboratório: rodando " + casos.length + " caso(s) numa só chamada...\n");
  var git = ehGit(casos[0]);
  var r = cp.spawnSync("timeout", ["900", git ? LAB_GIT : LAB, "-n", git ? "testes-git" : "testes", "-r", "--", "bash", "-c", DRIVER], { input: entrada, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  var res = {};
  r.stdout.split("\x1d").slice(1).forEach(function (bloco) {
    var i = bloco.indexOf("\n");
    res[bloco.slice(0, i)] = bloco.slice(i + 1);
  });
  return res;
}

function rodarSim(c) {
  require(path.join(__dirname, "..", "..", "assets", "bashsim.js")).opcoes.casaGuiaBash = !ehGit(c);
  if (c.tipo === "i") {
    var r = sim.rodarSessao(c.texto.replace(/\n$/, "").split("\n"), { tty: false });
    var t = r.texto;
    // o lab apaga um "$ " final (prompt vazio)
    return t;
  }
  var rs = sim.rodarScript(c.texto, "t.sh", c.args, { tty: false, stdin: c.stdin === null ? "" : c.stdin });
  return rs.texto + "[código de saída: " + rs.status + "]\n";
}

// normalizações que não são diferenças reais (PIDs, horários do relógio de verdade…)
function normalizar(s) {
  // PIDs de jobs ("[1] 12345") variam no Bash real
  return s.replace(/\r/g, "").replace(/^\[(\d+)\] \d+$/gm, "[$1] PID");
}

function diff(a, b) {
  var la = a.split("\n"), lb = b.split("\n"), out = [], n = Math.max(la.length, lb.length);
  for (var i = 0; i < n; i++) {
    if (la[i] === lb[i]) { out.push("  " + (la[i] === undefined ? "" : la[i])); continue; }
    if (la[i] !== undefined) out.push("\x1b[31m- " + la[i] + "\x1b[0m");
    if (lb[i] !== undefined) out.push("\x1b[32m+ " + lb[i] + "\x1b[0m");
  }
  return out.join("\n");
}

function main(argv) {
  var forcar = argv.indexOf("--lab") >= 0, mostrarDiff = argv.indexOf("--diff") >= 0, lista = argv.indexOf("--lista") >= 0;
  var filtro = argv.filter(function (a) { return a[0] !== "-"; })[0];
  var casos = lerCasos(filtro);
  var cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch (e) { /* sem cache */ }
  var faltam = casos.filter(function (c) { return forcar || cache[c.id] === undefined; });
  if (faltam.length) {
    var novos = rodarLab(faltam.filter(function (c) { return !ehGit(c); }));
    var novosG = rodarLab(faltam.filter(ehGit)); Object.keys(novosG).forEach(function (k) { novos[k] = novosG[k]; });
    Object.keys(novos).forEach(function (k) { cache[k] = novos[k]; });
    // limpa entradas que não existem mais
    var todosIds = {}; lerCasos().forEach(function (c) { todosIds[c.id] = 1; });
    Object.keys(cache).forEach(function (k) { if (!todosIds[k]) delete cache[k]; });
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 0));
  }
  var iguais = 0, difs = [];
  casos.forEach(function (c) {
    var real = cache[c.id];
    if (real === undefined) { difs.push({ c: c, real: "(sem resultado do laboratório)", sim: "" }); return; }
    var s;
    try { s = rodarSim(c); } catch (e) { s = "(exceção no simulador) " + (e && e.stack || e); }
    real = normalizar(real); s = normalizar(s);
    if (real === s) iguais++; else difs.push({ c: c, real: real, sim: s });
  });
  difs.forEach(function (d) {
    console.log("✗ " + d.c.arq + "/" + d.c.nome);
    if (mostrarDiff && !lista) console.log(diff(d.real, d.sim) + "\n");
  });
  var pct = casos.length ? (100 * iguais / casos.length).toFixed(1) : "0";
  console.log("\n" + iguais + " de " + casos.length + " casos idênticos (" + pct + "%)" + (mostrarDiff || lista ? "" : "  — use --diff para ver as diferenças"));
  return difs.length ? 1 : 0;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { lerCasos: lerCasos };

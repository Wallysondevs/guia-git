#!/usr/bin/env node
/*
  tools/testar-missoes.js — confere as missões (.try e .tryscript) das páginas.

  Uso:
    node tools/testar-missoes.js                  # todas as páginas .html da raiz
    node tools/testar-missoes.js variaveis.html   # só estas páginas
    node tools/testar-missoes.js --sem-lab ...    # não compara com o Bash real do laboratório
    node tools/testar-missoes.js --refazer-lab    # ignora o cache do laboratório
    node tools/testar-missoes.js --nativo pagina.html   # também roda setup + solução de cada .try no
                                                  # Git REAL do lab (~/guia-git-lab) e compara a saída
                                                  # do terminal com a do simulador (lento: ~2 s por missão)

  Para cada .try:       roda data-setup → confere que a meta AINDA NÃO foi cumprida →
                        digita data-solucao → confere que a meta FOI cumprida.
  Para cada .tryscript: roda o script original → meta não cumprida; roda pre.solucao →
                        meta cumprida; e roda a solução no laboratório (mesmo setup, arquivo,
                        argumentos e entrada) comparando saída, erros e código de saída.
                        Diferenças só de data/hora, de $RANDOM ou de ordem de processos em
                        paralelo viram avisos (⚠). data-comparar="nao" pula a comparação.
  O laboratório é chamado uma vez só, com todas as comparações (resultados em cache em
  tools/.cache-missoes.json).
*/
"use strict";
var fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
var RAIZ = path.join(__dirname, "..");
var BashSim = require(path.join(RAIZ, "assets", "bashsim.js"));
var sim = require(path.join(__dirname, "sim.js"));
var LAB = path.join(process.env.HOME || "/home/wallyson", "guia-git-lab", "lab");
var GITHUB = path.join(process.env.HOME || "/home/wallyson", "guia-git-lab", "github");
var CACHE_NATIVO = path.join(__dirname, ".cache-nativo.json");
var CACHE = path.join(__dirname, ".cache-missoes.json");

function decodificar(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, function (m, e) {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", laquo: "«", raquo: "»", hellip: "…", mdash: "—", ndash: "–" }[e] || m;
  });
}
function atributos(tag) {
  var at = {}, re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g, m;
  tag = tag.replace(/^<\w+/, "").replace(/\/?>$/, "");
  while ((m = re.exec(tag))) at[m[1]] = decodificar(m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : "");
  return at;
}
// acha o conteúdo de um <div ...> até o </div> correspondente
function fimDiv(html, ini) {
  var re = /<div\b|<\/div>/gi, d = 0, m;
  re.lastIndex = ini;
  while ((m = re.exec(html))) { if (m[0][1] === "/") { d--; if (d === 0) return m.index; } else d++; }
  return html.length;
}
function textoPre(html, classe) {
  var re = new RegExp('<pre\\b[^>]*class\\s*=\\s*["\'][^"\']*\\b' + classe + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)</pre>', "i");
  var m = re.exec(html);
  if (!m) return null;
  return decodificar(m[1].replace(/<[^>]+>/g, "")).replace(/^\n/, "");
}
function extrair(html) {
  var res = [], re = /<div\b[^>]*class\s*=\s*["']([^"']*)["'][^>]*>/gi, m;
  while ((m = re.exec(html))) {
    var classes = m[1].split(/\s+/);
    var tipo = classes.indexOf("tryscript") >= 0 ? "tryscript" : classes.indexOf("try") >= 0 ? "try" : null;
    if (!tipo) continue;
    var at = atributos(m[0]), fim = fimDiv(html, m.index), corpo = html.slice(m.index + m[0].length, fim);
    var tarefa = /<p\b[^>]*class\s*=\s*["'][^"']*try-task[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(corpo);
    var linha = html.slice(0, m.index).split("\n").length;
    res.push({ tipo: tipo, at: at, tarefa: tarefa ? decodificar(tarefa[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "", script: textoPre(corpo, "script"), solucao: textoPre(corpo, "solucao"), linha: linha });
  }
  return res;
}
function sessaoComSetup(setup, tty) {
  var s = new BashSim.Sessao({ tty: tty !== false });
  s.k.semTeclado = true;
  if (setup) sim.rodarSetup(s, setup);
  return s;
}
function rodarComandos(s, cmds, stdinLinhas) {
  var fila = (stdinLinhas || []).slice(), ult = { out: "", err: "" };
  cmds.forEach(function (c) {
    var saida = s.rodarSync(c, function () { return fila.length ? fila.shift() : null; });
    ult = { out: "", err: "" };
    saida.forEach(function (x) { var t = BashSim.semCor(x.t); if (x.s === "err" || x.s === "prompt") ult.err += t; else ult.out += t; });
  });
  return ult;
}
function rodarScriptSim(m, codigo, tty) {
  var s = sessaoComSetup(m.at["data-setup"], tty);
  var arq = m.at["data-file"] || "script.sh";
  var stdin = m.at["data-stdin"] !== undefined ? m.at["data-stdin"].replace(/\\n/g, "\n") : (tty ? null : "");
  s.iniciarScript(arq, codigo.replace(/\n?$/, "\n"), dividirArgs(m.at["data-args"] || ""), stdin);
  s.k.rodarSync(function () { return null; });
  var out = "", err = "", texto = "";
  s.k.tirarSaida().forEach(function (c) { var t = BashSim.semCor(c.t); texto += t; if (c.s === "err" || c.s === "prompt") err += t; else out += t; });
  return { s: s, out: out, err: err, texto: texto, status: s.main ? s.main.status : 0 };
}
function dividirArgs(s) {
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
function citar(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }

// ---- laboratório (uma chamada para tudo) ----
var DRIVER = [
  'D=/dev/shm/labdrv; mkdir -p $D/c; cd $D/c; cat > todos',
  'cp -a --sparse=always /home/ana $D/modelo',
  'reset_home() { cd /; find /home/ana -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; cp -a --sparse=always $D/modelo/. /home/ana/; rm -rf /tmp/* /tmp/.[!.]* 2>/dev/null; cd /home/ana; }',
  'awk -v RS="\\x1e" "NR>1{f=\\"$D/c/caso\\" NR-1; printf \\"%s\\", \\$0 > f; close(f)}" $D/c/todos',
  'for f in $(ls $D/c/caso* | sort -V); do',
  '  reset_home',
  '  id=$(sed -n 1p "$f")',
  '  sed -n "2,/^\\x1f\\$/p" "$f" | sed "\\$d" > $D/c/setup',
  '  sed -n "/^\\x1f\\$/,\\$p" "$f" | sed 1d > $D/c/cmd',
  '  env -u OLDPWD timeout 20 bash --rcfile /etc/lab-rc -i < $D/c/setup > /dev/null 2>&1',
  '  history -c 2>/dev/null',
  '  printf "\\x1d%s\\n" "$id"',
  '  env -u OLDPWD timeout 20 bash $D/c/cmd 2>&1; echo "[código de saída: $?]"',
  'done'
].join("\n");
function rodarLab(casos) {
  if (!casos.length) return {};
  var entrada = casos.map(function (c) { return "\x1e" + c.id + "\n" + c.setup + "\n\x1f\n" + c.cmd; }).join("");
  process.stderr.write("laboratório: comparando " + casos.length + " solução(ões) de .tryscript numa só chamada...\n");
  var r = cp.spawnSync("timeout", ["900", LAB, "-n", "testes", "-r", "--", "bash", "-c", DRIVER], { input: entrada, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  var res = {};
  (r.stdout || "").split("\x1d").slice(1).forEach(function (b) { var i = b.indexOf("\n"); res[b.slice(0, i)] = b.slice(i + 1); });
  return res;
}
function casoLab(m) {
  var arq = m.at["data-file"] || "script.sh";
  var setup = (m.at["data-setup"] || "").split(";;").map(function (x) { return x.trim(); }).filter(Boolean).join("\n");
  var stdin = m.at["data-stdin"] !== undefined ? m.at["data-stdin"].replace(/\\n/g, "\n") : "";
  var cmd = "cat > " + citar(arq) + " <<'__FIM_DO_SCRIPT__'\n" + m.solucao.replace(/\n?$/, "\n") + "__FIM_DO_SCRIPT__\n" +
    "printf %s " + citar(stdin) + " | bash " + citar(arq) + (m.at["data-args"] ? " " + m.at["data-args"] : "") + "\n";
  var id = crypto.createHash("sha1").update(setup + "\0" + cmd).digest("hex").slice(0, 16);
  return { id: id, setup: setup, cmd: cmd };
}
// ---- --nativo: a mesma missão no Git real do lab ----
// O setup roda no lab (as linhas "github ..." rodam no ~/guia-git-lab/github, fora do lab, como lá);
// a pasta atual passa de um trecho para o outro. Devolve a transcrição da solução ("$ cmd" + saída).
function rodarNativo(setup, solucao) {
  var nome = "testes-nativo", cwd = null, MARCA = "__FIM_DO_SETUP__";
  function lab(entrada, reset) {
    var r = cp.spawnSync("timeout", ["120", LAB, "-n", nome].concat(reset ? ["-r"] : []).concat(["-i"]), { input: entrada, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw r.error;
    return r.stdout || "";
  }
  cp.spawnSync("timeout", ["60", LAB, "-n", nome, "-r", "--", "true"], { encoding: "utf8" });
  var linhas = (setup || "").split(";;").map(function (x) { return x.trim(); }).filter(Boolean), trecho = [];
  function soltar() {
    if (!trecho.length) return;
    var out = lab((cwd ? "cd " + citar(cwd) + "\n" : "") + trecho.join("\n") + "\necho " + MARCA + "\"$PWD\"\n", false);
    var m = new RegExp("^" + MARCA + "(.*)$", "m").exec(out); if (m) cwd = m[1];
    trecho = [];
  }
  linhas.forEach(function (l) {
    var mg = /^github\s+(.*)$/.exec(l);
    if (mg) { soltar(); cp.spawnSync("timeout", ["60", "bash", "-c", citar(GITHUB) + " -n " + nome + " " + mg[1]], { encoding: "utf8" }); }
    else trecho.push(l);
  });
  soltar();
  var cmds = solucao.split(";;").map(function (x) { return x.trim(); }).filter(Boolean);
  var saida = lab((cwd ? "cd " + citar(cwd) + "\n" : "") + "echo " + MARCA + "\n" + cmds.join("\n") + "\n", false);
  var i = saida.indexOf("\n" + MARCA + "\n");
  return i >= 0 ? saida.slice(i + MARCA.length + 2) : saida;
}
function normalizarDatas(s) {
  return s.replace(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, "AAAA-MM-DD").replace(/\b\d{2}:\d{2}(:\d{2})?\b/g, "HH:MM").replace(/\b\d{8}([_-]?\d{4,6})?\b/g, "AAAAMMDD").replace(/_\d{6}(?!\d)/g, "_HHMMSS").replace(/\b\d{10}\b/g, "EPOCH")
    .replace(/\b(seg|ter|qua|qui|sex|sáb|dom)\b/g, "DIA").replace(/\b\d{1,2} (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b/g, "D MES");
}
function diffLinhas(a, b) {
  var la = a.split("\n"), lb = b.split("\n"), out = [];
  for (var i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] === lb[i]) continue;
    if (la[i] !== undefined) out.push("        lab: " + JSON.stringify(la[i]));
    if (lb[i] !== undefined) out.push("        sim: " + JSON.stringify(lb[i]));
  }
  return out.join("\n");
}

function main(argv) {
  var semLab = argv.indexOf("--sem-lab") >= 0, refazer = argv.indexOf("--refazer-lab") >= 0, nativo = argv.indexOf("--nativo") >= 0;
  var cacheNativo = {}; if (nativo) { try { cacheNativo = JSON.parse(fs.readFileSync(CACHE_NATIVO, "utf8")); } catch (e) { /* */ } }
  var paginas = argv.filter(function (a) { return a[0] !== "-"; });
  if (!paginas.length) paginas = fs.readdirSync(RAIZ).filter(function (f) { return /\.html$/.test(f); }).sort();
  var falhas = 0, total = 0, relatorio = [], comparacoes = [];
  paginas.forEach(function (pg) {
    var arq = fs.existsSync(pg) ? pg : path.join(RAIZ, pg);
    if (!fs.existsSync(arq)) { relatorio.push({ pg: pg, linhas: ["  ✗ arquivo não encontrado"] }); falhas++; return; }
    var missoes = extrair(fs.readFileSync(arq, "utf8"));
    if (!missoes.length) return;
    var linhas = [];
    missoes.forEach(function (m, ix) {
      total++;
      var nome = m.tipo + " #" + (ix + 1) + " (linha " + m.linha + ")" + (m.tarefa ? ": " + m.tarefa.slice(0, 70) + (m.tarefa.length > 70 ? "…" : "") : "");
      var meta = m.at["data-goal"] || "", erros = [], avisos = [];
      try {
        if (m.tipo === "try") {
          var sol = m.at["data-solucao"];
          if (!meta) erros.push("falta data-goal");
          if (!sol) erros.push("falta data-solucao (obrigatório)");
          if (meta && sol) {
            var s = sessaoComSetup(m.at["data-setup"], true);
            var antes = BashSim.checarMeta(s.sh, meta, { out: "", err: "", exit: s.sh.status, digitados: [] });
            if (!antes.length) erros.push("a meta já está cumprida logo depois do setup");
            var cmds = sol.split(";;").map(function (c) { return c.trim(); }).filter(Boolean);
            var ult = rodarComandos(s, cmds, m.at["data-stdin"] ? m.at["data-stdin"].split("\\n") : []);
            var depois = BashSim.checarMeta(s.sh, meta, { out: ult.out, err: ult.err, exit: s.sh.status, digitados: s.digitados });
            if (depois.length) erros.push("depois da solução, a meta não foi cumprida: " + depois.join(", ") + (ult.out || ult.err ? "\n      saída do último comando: " + JSON.stringify((ult.out + ult.err).slice(0, 300)) : ""));
            // metas de arquivo do Bash são a partir de ~: avisa se o caminho só faz sentido a partir da pasta atual
            var s0 = sessaoComSetup(m.at["data-setup"], true), cwd0 = s0.sh.cwd, HOME0 = "/home/ana";
            if (cwd0 !== HOME0) BashSim.dividirMetas(meta).forEach(function (g) {
              var mm = /^(absent|file|dir|contains|exec|link):([^=]*)/.exec(g); if (!mm || /^[~\/]/.test(mm[2])) return;
              var noCwd = s0.sh.resolver(cwd0 + "/" + mm[2], false).no, noHome = s0.sh.resolver(HOME0 + "/" + mm[2], false).no;
              var rel = cwd0.indexOf(HOME0 + "/") === 0 ? cwd0.slice(HOME0.length + 1) + "/" : "";
              if (mm[1] === "absent" && noCwd && !noHome) erros.push("a meta " + g + " é a partir de ~ (pasta pessoal), não da pasta atual (" + cwd0.replace(HOME0, "~") + "): ela já é verdade antes da solução. Você quis dizer absent:" + rel + mm[2] + "?");
              else if (mm[1] !== "absent" && noCwd && !noHome) erros.push("a meta " + g + " é a partir de ~ (pasta pessoal), não da pasta atual (" + cwd0.replace(HOME0, "~") + "). Você quis dizer " + mm[1] + ":" + rel + g.slice(mm[1].length + 1) + "?");
            });
            if (nativo) {
              var chave = crypto.createHash("sha1").update((m.at["data-setup"] || "") + "\u0000" + sol).digest("hex");
              var real = (!refazer && cacheNativo[chave] !== undefined) ? cacheNativo[chave] : (cacheNativo[chave] = rodarNativo(m.at["data-setup"], sol));
              var simT = sim.rodarSessao(sol.split(";;").map(function (c) { return c.trim(); }).filter(Boolean), { setup: m.at["data-setup"], tty: false }).texto;
              if (real !== simT) avisos.push("a saída no simulador difere da do Git real (lab):\n" + diffLinhas(real, simT).split("\n").map(function (l) { return "      " + l; }).join("\n"));
            }
          }
        } else {
          if (m.script === null) erros.push("falta pre.script");
          if (meta && m.solucao === null) erros.push("falta pre.solucao (obrigatório quando há data-goal)");
          if (meta && m.script !== null) {
            var r0 = rodarScriptSim(m, m.script, true);
            var f0 = BashSim.checarMeta(r0.s.sh, meta, { out: r0.out, err: r0.err, exit: r0.status, src: m.script, digitados: [] });
            if (!f0.length) erros.push("o script original já cumpre a meta");
          }
          if (meta && m.solucao !== null) {
            var r1 = rodarScriptSim(m, m.solucao, true);
            var f1 = BashSim.checarMeta(r1.s.sh, meta, { out: r1.out, err: r1.err, exit: r1.status, src: m.solucao, digitados: [] });
            if (f1.length) erros.push("com a solução, a meta não foi cumprida: " + f1.join(", ") + "\n      saída: " + JSON.stringify(r1.texto.slice(0, 300)) + " [código " + r1.status + "]");
          }
          var codigoComparar = m.solucao !== null ? m.solucao : m.script;
          if (!semLab && codigoComparar !== null && !/^\s*$/.test(codigoComparar) && m.at["data-comparar"] !== "nao") {
            var mm = { at: m.at, solucao: codigoComparar };
            var cl = casoLab(mm);
            var rs = rodarScriptSim(m, codigoComparar, false);
            comparacoes.push({ caso: cl, simTexto: rs.texto + "[código de saída: " + rs.status + "]\n", erros: erros, avisos: avisos, nome: nome, codigo: codigoComparar });
          } else if (m.script !== null && !meta) {
            var r2 = rodarScriptSim(m, m.script, true);
            if (/\(simulador\) erro interno/.test(r2.texto)) erros.push("erro interno do simulador: " + r2.texto);
          }
        }
      } catch (e) { erros.push("exceção: " + (e && e.stack || e)); }
      linhas.push({ nome: nome, erros: erros, avisos: avisos });
    });
    relatorio.push({ pg: path.basename(arq), linhas: linhas });
  });
  // laboratório
  if (comparacoes.length) {
    var cache = {};
    try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch (e) { /* */ }
    var faltam = comparacoes.filter(function (c) { return refazer || cache[c.caso.id] === undefined; }).map(function (c) { return c.caso; });
    var vistos = {}; faltam = faltam.filter(function (c) { if (vistos[c.id]) return false; vistos[c.id] = 1; return true; });
    if (faltam.length) {
      try { var novos = rodarLab(faltam); Object.keys(novos).forEach(function (k) { cache[k] = novos[k]; }); fs.writeFileSync(CACHE, JSON.stringify(cache)); }
      catch (e) { process.stderr.write("(não foi possível rodar o laboratório: " + e.message + ")\n"); }
    }
    comparacoes.forEach(function (c) {
      var real = cache[c.caso.id];
      if (real === undefined) { c.erros.push("sem resultado do laboratório"); return; }
      if (real === c.simTexto) return;
      // diferenças esperadas: relógio real do laboratório, números aleatórios, ordem de processos paralelos
      var cod = c.codigo || "";
      if (normalizarDatas(real) === normalizarDatas(c.simTexto)) { c.avisos.push("difere só na data/hora (o laboratório usa o relógio de verdade; o simulador, 15/10/2026 10:30)"); return; }
      if (/\bS?RANDOM\b|\bshuf\b/.test(cod)) { c.avisos.push("usa números aleatórios: a saída não dá para comparar com o laboratório"); return; }
      if (/&\s*($|\n|;)|&$/m.test(cod) && real.split("\n").sort().join("\n") === c.simTexto.split("\n").sort().join("\n")) { c.avisos.push("as mesmas linhas, em outra ordem (processos em paralelo)"); return; }
      c.erros.push("a saída no simulador é diferente da do Bash real:\n" + diffLinhas(real, c.simTexto));
    });
  }
  if (nativo) try { fs.writeFileSync(CACHE_NATIVO, JSON.stringify(cacheNativo)); } catch (e) { /* */ }
  relatorio.forEach(function (r) {
    if (!r.linhas.length) return;
    console.log(r.pg);
    if (!Array.isArray(r.linhas[0]) && typeof r.linhas[0] === "string") { r.linhas.forEach(function (l) { console.log(l); }); return; }
    r.linhas.forEach(function (l) {
      if (!l.erros.length) { console.log("  ✔ " + l.nome); (l.avisos || []).forEach(function (a) { console.log("      ⚠ " + a); }); }
      else { falhas++; console.log("  ✗ " + l.nome); l.erros.forEach(function (e) { console.log("      - " + e); }); }
    });
  });
  console.log("\n" + (total - falhas) + " de " + total + " missões ok" + (falhas ? " — " + falhas + " com problema" : ""));
  return falhas ? 1 : 0;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { extrair: extrair };

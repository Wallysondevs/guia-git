#!/usr/bin/env node
/*
  tools/sim.js — mostra uma sessão do simulador (assets/bashsim.js) no formato do pre.term.

  Uso:
    node tools/sim.js 'cmd1' 'cmd2' ...        # cada argumento é uma linha digitada
    printf '%s\n' 'cmd1' 'cmd2' | node tools/sim.js
    node tools/sim.js --script arquivo.sh [args...]   # roda "bash arquivo.sh args" (a partir da ~)
    node tools/sim.js --setup 'mkdir x;;cd x' 'ls'     # comandos invisíveis antes (separados por ;;)
    node tools/sim.js --stdin 'Ana\n' --script s.sh    # entrada padrão do script (\n = quebra de linha)

  Opções:
    --sem-tty   como o "lab -i": saída não é um terminal (ls um por linha, PS1 '$ ').
    --cores     mantém as marcas de cor (para depurar).

  Como no "lab -i": se um comando lê o teclado (read, cat sem arquivo…), ele consome as
  próximas linhas da entrada, que não aparecem na sessão.
*/
"use strict";
var path = require("path");
var fs = require("fs");
var BashSim = require(path.join(__dirname, "..", "assets", "bashsim.js"));

function main(argv) {
  var opt = { tty: true, setup: null, script: null, args: [], stdin: null, cores: false };
  var linhas = [];
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--sem-tty") { opt.tty = false; continue; }
    if (a === "--cores") { opt.cores = true; continue; }
    if (a === "--setup") { opt.setup = argv[++i]; continue; }
    if (a === "--stdin") { opt.stdin = argv[++i].replace(/\\n/g, "\n"); continue; }
    if (a === "--script") { opt.script = argv[++i]; opt.args = argv.slice(i + 1); break; }
    if (a === "--help" || a === "-h") { process.stdout.write(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^[\s\S]*?\/\*/, "")); return 0; }
    linhas.push(a);
  }
  if (opt.script) {
    var codigo = fs.readFileSync(opt.script, "utf8");
    var r = rodarScript(codigo, path.basename(opt.script), opt.args, { setup: opt.setup, stdin: opt.stdin, tty: opt.tty });
    process.stdout.write("$ bash " + path.basename(opt.script) + (opt.args.length ? " " + opt.args.join(" ") : "") + "\n" + r.texto);
    return r.status;
  }
  if (!linhas.length && !process.stdin.isTTY) {
    var txt = fs.readFileSync(0, "utf8");
    linhas = txt.replace(/\n$/, "").split("\n");
  }
  var sess = rodarSessao(linhas, opt);
  process.stdout.write(sess.texto);
  return 0;
}

// Roda linhas como se a Ana digitasse no terminal. Devolve {texto, sessao}
function rodarSessao(linhas, opt) {
  opt = opt || {};
  var s = new BashSim.Sessao({ tty: opt.tty !== false });
  s.k.semTeclado = true;
  if (opt.setup) rodarSetup(s, opt.setup);
  var fila = linhas.slice(), texto = "";
  function limpa(t) { return opt.cores ? t : BashSim.semCor(t); }
  var ps1Inicial = s.sh.valor("PS1"), ps2Inicial = s.sh.valor("PS2");
  function pr1() { return s.sh.valor("PS1") === ps1Inicial ? "$ " : limpa(s.prompt()).replace(/\x1b\[[0-9;]*m/g, ""); }
  function pr2() { return s.sh.valor("PS2") === ps2Inicial ? "> " : limpa(s.prompt2()).replace(/\x1b\[[0-9;]*m/g, ""); }
  while (fila.length) {
    var l = fila.shift(), fonte = l, mostra = pr1() + l + "\n";
    while (s.incompleta(fonte) && fila.length) { var n = fila.shift(); fonte += "\n" + n; mostra += pr2() + n + "\n"; }
    if (s.incompleta(fonte)) mostra += pr2();
    texto += mostra;
    var saida = s.rodarSync(fonte, function () { return fila.length ? fila.shift() : null; });
    texto += limpa(saida.map(function (c) { return c.t; }).join(""));
    if (s.encerrado) break;
  }
  // como no "lab -i": no fim da entrada o Bash mostra o prompt e "exit" (o "$ exit" é apagado)
  if (!s.encerrado && (pr1() !== "$ " || (texto !== "" && texto[texto.length - 1] !== "\n"))) texto += pr1() + "exit\n";
  return { texto: texto, sessao: s };
}
function rodarSetup(s, setup) {
  setup.split(";;").forEach(function (c) { if (c.trim()) s.rodarSync(c, function () { return null; }); });
  s.k.tirarSaida();
  s.sh.hist.length = 0; s.digitados.length = 0; s.sh.status = 0;
}
// Roda "bash arquivo args" com um script. Devolve {texto, out, err, status, sessao}
function rodarScript(codigo, arquivo, args, opt) {
  opt = opt || {};
  var s = new BashSim.Sessao({ tty: opt.tty !== false });
  s.k.semTeclado = true;
  if (opt.setup) rodarSetup(s, opt.setup);
  var entrada = opt.stdinLinhas ? opt.stdinLinhas.slice() : null;
  s.iniciarScript(arquivo, codigo, args || [], opt.stdin === undefined ? null : opt.stdin);
  s.k.rodarSync(function () { return entrada && entrada.length ? entrada.shift() : null; });
  var partes = s.k.tirarSaida(), out = "", err = "", texto = "";
  partes.forEach(function (c) { var t = BashSim.semCor(c.t); texto += t; if (c.s === "err" || c.s === "prompt") err += t; else out += t; });
  return { texto: texto, out: out, err: err, status: s.main ? s.main.status : 0, sessao: s };
}

module.exports = { rodarSessao: rodarSessao, rodarScript: rodarScript, rodarSetup: rodarSetup };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

/*
  gitsim.js — um Git simulado para o terminal do Guia Git (assets/bashsim.js).

  O repositório vive inteiro no sistema de arquivos fictício do bashsim, dentro de ".git":
    HEAD, config, refs/heads/*, refs/tags/*, refs/remotes/*, logs/ (reflog), ORIG_HEAD, MERGE_HEAD…
    objects/xx/yyyy… — blobs, trees, commits e tags com o SHA-1 de verdade
                       (o conteúdo fica guardado sem compressão, num formato de texto próprio);
    index           — a área de preparo (formato de texto próprio: "modo hash estágio\tcaminho").
  Com a autora Ana Souza <ana@exemplo.com> e o relógio fixo do simulador
  (15/10/2026 10:30 −0300), os hashes saem iguais aos do Git real do laboratório.
  As mensagens imitam o Git 2.53 do Ubuntu 26.04 em pt_BR (que é só parcialmente traduzido).
*/
(function (global) {
  "use strict";

  function instalar(B) {
    if (!B || B.EXT.git && B.EXT.git.gitsim) return;
    var I = B._internos, mkF = I.mkF, mkD = I.mkD, utf8bytes = I.utf8bytes, UID = 1000;

    /* ---------------- SHA-1 ---------------- */
    function sha1(bytes) {
      var n = bytes.length, l = n * 8, tot = ((n + 9 + 63) >> 6) << 6;
      var b = new Uint8Array(tot); b.set(bytes); b[n] = 0x80;
      var hi = Math.floor(l / 4294967296), lo = l >>> 0;
      b[tot - 8] = hi >>> 24; b[tot - 7] = hi >>> 16 & 255; b[tot - 6] = hi >>> 8 & 255; b[tot - 5] = hi & 255;
      b[tot - 4] = lo >>> 24; b[tot - 3] = lo >>> 16 & 255; b[tot - 2] = lo >>> 8 & 255; b[tot - 1] = lo & 255;
      var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0, w = new Int32Array(80);
      for (var o = 0; o < tot; o += 64) {
        for (var i = 0; i < 16; i++) w[i] = b[o + 4 * i] << 24 | b[o + 4 * i + 1] << 16 | b[o + 4 * i + 2] << 8 | b[o + 4 * i + 3];
        for (i = 16; i < 80; i++) { var x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = x << 1 | x >>> 31; }
        var a = h0, bb = h1, c = h2, d = h3, e = h4;
        for (i = 0; i < 80; i++) {
          var f, k;
          if (i < 20) { f = bb & c | ~bb & d; k = 0x5a827999; } else if (i < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
          else if (i < 60) { f = bb & c | bb & d | c & d; k = 0x8f1bbcdc; } else { f = bb ^ c ^ d; k = 0xca62c1d6; }
          var t = (a << 5 | a >>> 27) + f + e + k + w[i] | 0;
          e = d; d = c; c = bb << 30 | bb >>> 2; bb = a; a = t;
        }
        h0 = h0 + a | 0; h1 = h1 + bb | 0; h2 = h2 + c | 0; h3 = h3 + d | 0; h4 = h4 + e | 0;
      }
      return [h0, h1, h2, h3, h4].map(function (v) { return ("00000000" + (v >>> 0).toString(16)).slice(-8); }).join("");
    }
    function hexBytes(h) { var r = []; for (var i = 0; i < 40; i += 2) r.push(parseInt(h.substr(i, 2), 16)); return r; }
    var ZERO = "0000000000000000000000000000000000000000";

    /* ---------------- objetos ---------------- */
    // blob: {type:"blob", data:string}; tree: {type:"tree", ents:[{mode,name,hash}]};
    // commit: {type:"commit", tree, parents[], author, committer, msg}; tag: {type:"tag", object, otype, tag, tagger, msg}
    function corpoTexto(o) {
      if (o.type === "blob") return o.data;
      if (o.type === "commit") {
        var s = "tree " + o.tree + "\n";
        o.parents.forEach(function (p) { s += "parent " + p + "\n"; });
        return s + "author " + o.author + "\ncommitter " + o.committer + "\n\n" + o.msg;
      }
      if (o.type === "tag") return "object " + o.object + "\ntype " + o.otype + "\ntag " + o.tag + "\ntagger " + o.tagger + "\n\n" + o.msg;
      return null;
    }
    function bytesObjeto(o) {
      var corpo;
      if (o.type === "tree") {
        corpo = [];
        o.ents.forEach(function (e) {
          var m = utf8bytes((e.mode === "040000" ? "40000" : e.mode) + " " + e.name);
          for (var i = 0; i < m.length; i++) corpo.push(m[i]);
          corpo.push(0);
          var hb = hexBytes(e.hash); for (i = 0; i < 20; i++) corpo.push(hb[i]);
        });
      } else corpo = o.type === "blob" && o.bytes ? o.bytes : utf8bytes(corpoTexto(o));
      var cab = utf8bytes(o.type + " " + corpo.length);
      cab.push(0);
      var r = new Uint8Array(cab.length + corpo.length); r.set(cab); r.set(corpo, cab.length);
      return r;
    }
    function hashObjeto(o) { return sha1(bytesObjeto(o)); }
    function serializar(o) {
      if (o.type === "tree") return "tree\n" + o.ents.map(function (e) { return e.mode + " " + e.hash + "\t" + e.name; }).join("\n");
      return o.type + "\n" + corpoTexto(o);
    }
    function desserializar(s) {
      var i = s.indexOf("\n"), tipo = s.slice(0, i), corpo = s.slice(i + 1);
      if (tipo === "blob") return { type: "blob", data: corpo };
      if (tipo === "tree") return { type: "tree", ents: corpo ? corpo.split("\n").map(function (l) { var m = /^(\d+) ([0-9a-f]{40})\t(.*)$/.exec(l); return { mode: m[1], hash: m[2], name: m[3] }; }) : [] };
      var j = corpo.indexOf("\n\n"), cab = j < 0 ? corpo : corpo.slice(0, j), msg = j < 0 ? "" : corpo.slice(j + 2), o = { type: tipo, msg: msg, parents: [] };
      cab.split("\n").forEach(function (l) {
        var k = l.indexOf(" "), ch = l.slice(0, k), v = l.slice(k + 1);
        if (ch === "parent") o.parents.push(v); else if (ch === "type") o.otype = v; else o[ch] = v;
      });
      return o;
    }

    /* ---------------- sistema de arquivos ---------------- */
    function noDe(sh, abs) { var r = sh.resolver(abs, true); return r.no || null; }
    function lerTxt(sh, abs) { var n = noDe(sh, abs); return n && n.t === "f" ? (n.d == null ? "" : n.d) : null; }
    function mkdirP(sh, abs) {
      var partes = abs.split("/").filter(Boolean), atual = sh.fs;
      for (var i = 0; i < partes.length; i++) {
        var f = atual.c[partes[i]];
        if (!f || f.t !== "d") { f = mkD(UID, 509, sh.k.clock); atual.c[partes[i]] = f; atual.mt = sh.k.clock; }
        atual = f;
      }
      return atual;
    }
    function escreverTxt(sh, abs, txt, modo) {
      var i = abs.lastIndexOf("/"), pai = mkdirP(sh, abs.slice(0, i)), nome = abs.slice(i + 1), n = pai.c[nome];
      if (n && n.t === "f") { n.d = txt; delete n.z; n.mt = n.ct = sh.k.clock; if (modo != null) n.m = modo; }
      else { pai.c[nome] = mkF(UID, modo != null ? modo : 436, txt, sh.k.clock); pai.mt = sh.k.clock; }
    }
    function apagar(sh, abs) {
      var i = abs.lastIndexOf("/"), pai = noDe(sh, abs.slice(0, i) || "/");
      if (pai && pai.t === "d" && pai.c[abs.slice(i + 1)]) { delete pai.c[abs.slice(i + 1)]; pai.mt = sh.k.clock; return true; }
      return false;
    }
    function relativo(de, para) { // caminho de "de" (pasta) até "para"
      if (de === para) return ".";
      var a = de.split("/").filter(Boolean), b = para.split("/").filter(Boolean), i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      var r = [];
      for (var j = i; j < a.length; j++) r.push("..");
      return r.concat(b.slice(i)).join("/") || ".";
    }

    /* ---------------- datas ---------------- */
    var DIAS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MESES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function d2(n) { return (n < 10 ? "0" : "") + n; }
    function tzMin(tz) { var m = /^([+-])(\d\d)(\d\d)$/.exec(tz); return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0; }
    function partesData(ts, tz) { var d = new Date((ts + tzMin(tz) * 60) * 1000); return { Y: d.getUTCFullYear(), M: d.getUTCMonth(), D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), w: d.getUTCDay() }; }
    function dataPadrao(ts, tz) { var p = partesData(ts, tz); return DIAS_EN[p.w] + " " + MESES_EN[p.M] + " " + p.D + " " + d2(p.h) + ":" + d2(p.m) + ":" + d2(p.s) + " " + p.Y + " " + tz; }
    function dataIso(ts, tz) { var p = partesData(ts, tz); return p.Y + "-" + d2(p.M + 1) + "-" + d2(p.D) + " " + d2(p.h) + ":" + d2(p.m) + ":" + d2(p.s) + " " + tz; }
    function dataCurta(ts, tz) { var p = partesData(ts, tz); return p.Y + "-" + d2(p.M + 1) + "-" + d2(p.D); }
    function parseIdent(s) { var m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(s || ""); return m ? { nome: m[1], email: m[2], ts: +m[3], tz: m[4] } : { nome: "", email: "", ts: 0, tz: "+0000" }; }
    function dataRelativa(ts, agora) {
      var d = agora - ts;
      if (d < 0) return "in the future";
      if (d < 90) return d + " second" + (d === 1 ? "" : "s") + " ago";
      d = Math.round(d / 60); if (d < 90) return d + " minute" + (d === 1 ? "" : "s") + " ago";
      d = Math.round(d / 60); if (d < 36) return d + " hour" + (d === 1 ? "" : "s") + " ago";
      d = Math.round(d / 24); if (d < 14) return d + " day" + (d === 1 ? "" : "s") + " ago";
      if (d < 70) { var w = Math.round(d / 7); return w + " week" + (w === 1 ? "" : "s") + " ago"; }
      if (d < 365) { var mm = Math.round(d / 30); return mm + " month" + (mm === 1 ? "" : "s") + " ago"; }
      var y = Math.round(d / 365); return y + " year" + (y === 1 ? "" : "s") + " ago";
    }

    /* ---------------- config ---------------- */
    function parseConfig(txt) {
      var ents = [], sec = "";
      (txt || "").split("\n").forEach(function (l) {
        var t = l.trim(), m;
        if (!t || t[0] === "#" || t[0] === ";") return;
        if ((m = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/.exec(t))) {
          sec = m[1].toLowerCase() + (m[2] !== undefined ? "." + m[2].replace(/\\(.)/g, "$1") : "");
          t = m[3]; if (!t) return;
        }
        if ((m = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(t))) {
          var v = m[2] === undefined ? "true" : m[2].replace(/\s+[#;].*$/, "").trim();
          if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\(.)/g, function (x, c) { return c === "n" ? "\n" : c === "t" ? "\t" : c; });
          ents.push({ k: sec + "." + m[1].toLowerCase(), v: v });
        }
      });
      return ents;
    }
    function chaveNorm(k) { var i = k.indexOf("."), j = k.lastIndexOf("."); if (i < 0) return null; return k.slice(0, i).toLowerCase() + k.slice(i, j + 1) + k.slice(j + 1).toLowerCase(); }
    function valorConfigTxt(v) { return /^\s|\s$|[#;"\\]/.test(v) ? "\"" + v.replace(/(["\\])/g, "\\$1") + "\"" : v; }
    // grava/remove uma chave num arquivo de config (mantendo o resto do texto)
    function gravarConfig(txt, chave, valor, opts) {
      opts = opts || {};
      var i = chave.indexOf("."), j = chave.lastIndexOf("."), secao = chave.slice(0, i), sub = i === j ? null : chave.slice(i + 1, j), nome = chave.slice(j + 1);
      var linhas = (txt || "").split("\n"); if (linhas[linhas.length - 1] === "") linhas.pop();
      var secAtual = null, ultLinhaSec = -1, achou = false, alvo = (secao.toLowerCase() + (sub !== null ? "." + sub : ""));
      var res = [];
      for (var n = 0; n < linhas.length; n++) {
        var l = linhas[n], t = l.trim(), m;
        if ((m = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(t))) { secAtual = m[1].toLowerCase() + (m[2] !== undefined ? "." + m[2] : ""); res.push(l); if (secAtual === alvo) ultLinhaSec = res.length - 1; continue; }
        if (secAtual === alvo && (m = /^([A-Za-z][A-Za-z0-9-]*)\s*(=|$)/.exec(t)) && m[1].toLowerCase() === nome.toLowerCase()) {
          if (valor === null) { achou = true; continue; }
          if (!achou || opts.todos) { res.push("\t" + nome + " = " + valorConfigTxt(valor)); achou = true; ultLinhaSec = res.length - 1; continue; }
        }
        res.push(l);
        if (secAtual === alvo && t) ultLinhaSec = res.length - 1;
      }
      if (valor !== null && !achou) {
        var nova = "\t" + nome + " = " + valorConfigTxt(valor);
        if (ultLinhaSec >= 0) res.splice(ultLinhaSec + 1, 0, nova);
        else { res.push("[" + secao + (sub !== null ? " \"" + sub + "\"" : "") + "]"); res.push(nova); }
      }
      // remove seções vazias depois de --unset
      if (valor === null) {
        var limpo = [];
        for (var q = 0; q < res.length; q++) {
          if (/^\s*\[/.test(res[q]) && (q + 1 >= res.length || /^\s*\[/.test(res[q + 1]))) {
            var mm = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(res[q].trim());
            if (mm && (mm[1].toLowerCase() + (mm[2] !== undefined ? "." + mm[2] : "")) === alvo) continue;
          }
          limpo.push(res[q]);
        }
        res = limpo;
      }
      return { txt: res.length ? res.join("\n") + "\n" : "", achou: achou };
    }

    /* ---------------- .gitignore ---------------- */
    function globRe(p) { // padrão do fnmatch (com FNM_PATHNAME) → regex
      var r = "", i = 0;
      while (i < p.length) {
        var c = p[i];
        if (c === "*") {
          if (p[i + 1] === "*") {
            var antes = i === 0 || p[i - 1] === "/", depois = p[i + 2] === "/" || i + 2 === p.length;
            if (antes && depois) { if (p[i + 2] === "/") { r += "(?:.*/)?"; i += 3; } else { r += ".*"; i += 2; } continue; }
          }
          r += "[^/]*"; i++;
        } else if (c === "?") { r += "[^/]"; i++; }
        else if (c === "[") {
          var j = i + 1; if (p[j] === "!" || p[j] === "^") j++; if (p[j] === "]") j++;
          while (j < p.length && p[j] !== "]") j++;
          if (j >= p.length) { r += "\\["; i++; continue; }
          var cls = p.slice(i + 1, j); if (cls[0] === "!") cls = "^" + cls.slice(1);
          r += "[" + cls.replace(/\\/g, "\\\\") + "]"; i = j + 1;
        } else if (c === "\\" && i + 1 < p.length) { r += p[i + 1].replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); i += 2; }
        else { r += c.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); i++; }
      }
      return r;
    }
    function compilarIgnore(txt, base, origem) { // base: pasta relativa à raiz ("" ou "a/b/")
      var regras = [];
      (txt || "").split("\n").forEach(function (l, n) {
        var orig = l;
        l = l.replace(/(^|[^\\])\s+$/, "$1");
        if (!l || l[0] === "#") return;
        var neg = false;
        if (l[0] === "!") { neg = true; l = l.slice(1); } else if (l[0] === "\\" && (l[1] === "!" || l[1] === "#")) l = l.slice(1);
        var soDir = false; if (/\/$/.test(l)) { soDir = true; l = l.replace(/\/+$/, ""); }
        var ancorado = l.indexOf("/") >= 0; if (l[0] === "/") l = l.slice(1);
        var re = new RegExp("^" + (ancorado ? "" : "(?:.*/)?") + globRe(l) + "$");
        regras.push({ re: re, neg: neg, soDir: soDir, base: base, origem: origem, linha: n + 1, texto: orig.replace(/\s+$/, "") });
      });
      return regras;
    }

    /* ---------------- diff (Myers) ---------------- */
    function separarLinhas(txt) {
      if (txt === "") return { l: [], semFim: false };
      var l = txt.split("\n"), semFim = l[l.length - 1] !== "";
      if (!semFim) l.pop();
      return { l: l, semFim: semFim };
    }
    function myers(a, b) { // devolve lista de operações: [" ",i,j] / ["-",i] / ["+",j]
      var n = a.length, m = b.length, max = n + m, v = new Int32Array(2 * max + 2), trace = [];
      var off = max + 1, x, y, d, k;
      for (d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (k = -d; k <= d; k += 2) {
          if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1]; else x = v[off + k - 1] + 1;
          y = x - k;
          while (x < n && y < m && a[x] === b[y]) { x++; y++; }
          v[off + k] = x;
          if (x >= n && y >= m) return voltar(trace, d);
        }
      }
      return voltar(trace, max);
      function voltar(trace, dfim) {
        var ops = [], x = n, y = m;
        for (var d = dfim; d > 0; d--) {
          var vv = trace[d], k = x - y, pk;
          if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) pk = k + 1; else pk = k - 1;
          var px = vv[off + pk], py = px - pk;
          while (x > px && y > py) { ops.push([" ", x - 1, y - 1]); x--; y--; }
          if (x === px) ops.push(["+", y - 1]); else ops.push(["-", x - 1]);
          x = px; y = py;
        }
        while (x > 0 && y > 0) { ops.push([" ", x - 1, y - 1]); x--; y--; }
        return ops.reverse();
      }
    }
    // marca mudanças (vetores de bool) e "compacta" como o xdiff: grupos descem o máximo possível
    function mudancas(a, b) {
      var ops = myers(a, b), ca = new Array(a.length).fill(false), cb = new Array(b.length).fill(false);
      ops.forEach(function (o) { if (o[0] === "-") ca[o[1]] = true; else if (o[0] === "+") cb[o[1]] = true; });
      compactar(a, ca); compactar(b, cb);
      return { ca: ca, cb: cb };
    }
    function compactar(l, c) {
      var i = 0, n = l.length;
      while (i < n) {
        if (!c[i]) { i++; continue; }
        var ini = i; while (i < n && c[i]) i++;
        var fim = i; // [ini, fim)
        var mudou = true;
        while (mudou) {
          mudou = false;
          while (fim < n && !c[fim] && l[ini] === l[fim]) { c[ini] = false; c[fim] = true; ini++; fim++; mudou = true; while (fim < n && c[fim]) fim++; }
        }
        i = fim;
      }
    }
    function hunks(a, b, ctx) {
      var mc = mudancas(a, b), ca = mc.ca, cb = mc.cb, linhas = [], i = 0, j = 0;
      // alinha as duas sequências: percorre as linhas iguais (não marcadas) em paralelo
      while (i < a.length || j < b.length) {
        if (i < a.length && ca[i]) { linhas.push({ t: "-", i: i, j: j }); i++; continue; }
        if (j < b.length && cb[j]) { linhas.push({ t: "+", i: i, j: j }); j++; continue; }
        linhas.push({ t: " ", i: i, j: j }); i++; j++;
      }
      var res = [], k = 0;
      // agrupa
      var muds = []; linhas.forEach(function (x, idx) { if (x.t !== " ") muds.push(idx); });
      if (!muds.length) return res;
      var grupos = [], g = [muds[0], muds[0]];
      for (k = 1; k < muds.length; k++) { if (muds[k] - g[1] - 1 > 2 * ctx) { grupos.push(g); g = [muds[k], muds[k]]; } else g[1] = muds[k]; }
      grupos.push(g);
      grupos.forEach(function (gr) {
        var ini = Math.max(0, gr[0] - ctx), fim = Math.min(linhas.length - 1, gr[1] + ctx), corpo = linhas.slice(ini, fim + 1);
        var s1 = corpo[0].i, s2 = corpo[0].j, c1 = 0, c2 = 0;
        corpo.forEach(function (x) { if (x.t !== "+") c1++; if (x.t !== "-") c2++; });
        res.push({ s1: s1, c1: c1, s2: s2, c2: c2, linhas: corpo });
      });
      return res;
    }
    function funcLinha(a, ate) {
      for (var i = ate - 1; i >= 0; i--) { var l = a[i]; if (/^[A-Za-z_$]/.test(l)) { var r = l; var bs = utf8bytes(r); if (bs.length > 80) r = decodUtf8(bs.slice(0, 80)); return r.replace(/\s+$/, ""); } }
      return "";
    }
    function decodUtf8(bs) { try { return decodeURIComponent(bs.map(function (x) { return "%" + (x < 16 ? "0" : "") + x.toString(16); }).join("")); } catch (e) { return String.fromCharCode.apply(null, bs.slice(0, -1)); } }
    function palavras(old, neu) { // --word-diff=plain: [-apagado-]{+novo+}
      var A = old.match(/\s+|\S+/g) || [], Bt = neu.match(/\s+|\S+/g) || [], ops = myers(A, Bt), out = "", del = "", ins = "";
      function solta() { if (del) out += "[-" + del + "-]"; if (ins) out += "{+" + ins + "+}"; del = ins = ""; }
      ops.forEach(function (o) { if (o[0] === "-") del += A[o[1]]; else if (o[0] === "+") ins += Bt[o[1]]; else { solta(); out += A[o[1]]; } });
      solta();
      return out;
    }
    function diffUnificado(ta, tb, ctx, porPalavra) {
      var A = separarLinhas(ta), Bl = separarLinhas(tb), a = A.l, b = Bl.l;
      // a última linha sem \n é diferente da mesma linha com \n
      var a2 = a.slice(), b2 = b.slice();
      if (A.semFim && a2.length) a2[a2.length - 1] += "\u0000";
      if (Bl.semFim && b2.length) b2[b2.length - 1] += "\u0000";
      var hs = hunks(a2, b2, ctx), out = "";
      hs.forEach(function (h) {
        var cab = "@@ -" + (h.c1 === 0 ? h.s1 : h.s1 + 1) + (h.c1 !== 1 ? "," + h.c1 : "") + " +" + (h.c2 === 0 ? h.s2 : h.s2 + 1) + (h.c2 !== 1 ? "," + h.c2 : "") + " @@";
        var fn = funcLinha(a, h.s1);
        out += cab + (fn ? " " + fn : "") + "\n";
        if (porPalavra) {
          var k = 0, L = h.linhas;
          while (k < L.length) {
            if (L[k].t === " ") { out += a2[L[k].i].replace(/\u0000$/, "") + "\n"; k++; continue; }
            var del = [], ins = [];
            while (k < L.length && L[k].t !== " ") { if (L[k].t === "-") del.push(a2[L[k].i].replace(/\u0000$/, "")); else ins.push(b2[L[k].j].replace(/\u0000$/, "")); k++; }
            out += palavras(del.join("\n"), ins.join("\n")) + "\n";
          }
          return;
        }
        h.linhas.forEach(function (x) {
          var txt = x.t === "+" ? b2[x.j] : a2[x.i];
          var sem = txt.slice(-1) === "\u0000";
          out += x.t + (sem ? txt.slice(0, -1) : txt) + "\n" + (sem ? "\\ No newline at end of file\n" : "");
        });
      });
      return { txt: out, add: contar(hs, "+"), del: contar(hs, "-") };
      function contar(hs, t) { var n = 0; hs.forEach(function (h) { h.linhas.forEach(function (x) { if (x.t === t) n++; }); }); return n; }
    }
    function contarMudancas(ta, tb) { var d = diffUnificado(ta, tb, 0); return { add: d.add, del: d.del }; }
    function binario(txt) { return txt.indexOf("\u0000") >= 0; }

    /* ---------------- o repositório ---------------- */
    function achar(sh) {
      var env = sh.valor("GIT_DIR");
      var p = sh.cwd;
      while (true) {
        var g = noDe(sh, (p === "/" ? "" : p) + "/.git");
        if (g && g.t === "d" && g.c.HEAD) return new Repo(sh, (p === "/" ? "" : p) + "/.git", p);
        var gb = noDe(sh, p);
        if (gb && gb.t === "d" && gb.c.HEAD && gb.c.objects && gb.c.refs && /\.git$/.test(p)) return new Repo(sh, p, null);
        if (p === "/") return null;
        p = p.slice(0, p.lastIndexOf("/")) || "/";
      }
    }
    function Repo(sh, gitdir, raiz) { this.sh = sh; this.g = gitdir; this.raiz = raiz; this.cache = {}; }
    var R = Repo.prototype;
    R.arq = function (rel) { return lerTxt(this.sh, this.g + "/" + rel); };
    R.gravar = function (rel, txt) { escreverTxt(this.sh, this.g + "/" + rel, txt, 436); };
    R.apagarArq = function (rel) { return apagar(this.sh, this.g + "/" + rel); };
    R.existe = function (rel) { return !!noDe(this.sh, this.g + "/" + rel); };
    // objetos
    R.ler = function (h) {
      if (!h) return null;
      if (this.cache[h]) return this.cache[h];
      var t = this.arq("objects/" + h.slice(0, 2) + "/" + h.slice(2));
      if (t == null) return null;
      var o = desserializar(t); o.hash = h; this.cache[h] = o; return o;
    };
    R.escreverObj = function (o) {
      var h = hashObjeto(o), cam = "objects/" + h.slice(0, 2) + "/" + h.slice(2);
      if (!this.existe(cam)) { var n = this.g + "/" + cam; escreverTxt(this.sh, n, serializar(o), 292); }
      o.hash = h; this.cache[h] = o;
      return h;
    };
    R.todosObjetos = function () {
      var od = noDe(this.sh, this.g + "/objects"), r = [];
      if (!od) return r;
      Object.keys(od.c).forEach(function (d) { if (/^[0-9a-f]{2}$/.test(d) && od.c[d].t === "d") Object.keys(od.c[d].c).forEach(function (f) { r.push(d + f); }); });
      return r.sort();
    };
    R.abrev = function (h, n) {
      n = n || 7;
      var todos = this._todos || (this._todos = this.todosObjetos());
      while (n < 40) {
        var p = h.slice(0, n), c = 0;
        for (var i = 0; i < todos.length; i++) if (todos[i].slice(0, n) === p) c++;
        if (c <= 1) return p;
        n++;
      }
      return h;
    };
    // refs
    R.lerRef = function (nome) { // nome completo (refs/heads/x ou HEAD); devolve {simb} ou {hash} ou null
      var t = this.arq(nome);
      if (t == null) {
        var pk = this.packed(); if (pk[nome]) return { hash: pk[nome] };
        return null;
      }
      t = t.replace(/\n$/, "");
      if (/^ref: /.test(t)) return { simb: t.slice(5) };
      return { hash: t };
    };
    R.packed = function () { var t = this.arq("packed-refs"), r = {}; (t || "").split("\n").forEach(function (l) { var m = /^([0-9a-f]{40}) (.*)$/.exec(l); if (m) r[m[2]] = m[1]; }); return r; };
    R.resolverRef = function (nome) { var v = this.lerRef(nome), n = 0; while (v && v.simb && n++ < 5) v = this.lerRef(v.simb); return v && v.hash || null; };
    R.headRef = function () { var v = this.lerRef("HEAD"); return v && v.simb ? v.simb : null; }; // refs/heads/main ou null (destacado)
    R.branchAtual = function () { var r = this.headRef(); return r && r.indexOf("refs/heads/") === 0 ? r.slice(11) : null; };
    R.head = function () { return this.resolverRef("HEAD"); };
    R.gravarRef = function (nome, hash, msgLog, antigo) {
      if (antigo === undefined) antigo = this.resolverRef(nome) || ZERO;
      this.gravar(nome, hash + "\n");
      if (msgLog !== null && msgLog !== undefined) this.logar(nome, antigo, hash, msgLog);
    };
    R.ident = function (tipo) {
      var sh = this.sh, env = tipo === "c" ? "GIT_COMMITTER_" : "GIT_AUTHOR_";
      var nome = sh.valor(env + "NAME") || this.config("user.name"), email = sh.valor(env + "EMAIL") || this.config("user.email");
      var ts = Math.floor(sh.k.clock / 1000), tz = "-0300", dv = sh.valor(env + "DATE");
      if (dv) { var m = /^@?(\d+)(?: ([+-]\d{4}))?$/.exec(dv.trim()); if (m) { ts = +m[1]; if (m[2]) tz = m[2]; } }
      if (nome == null || email == null) return null;
      return nome + " <" + email + "> " + ts + " " + tz;
    };
    R.logar = function (ref, antigo, novo, msg) {
      var id = this.ident("c") || "Ana Souza <ana@exemplo.com> " + Math.floor(this.sh.k.clock / 1000) + " -0300";
      var linha = antigo + " " + novo + " " + id + "\t" + msg + "\n";
      var refs = [ref];
      if (ref !== "HEAD" && this.headRef() === ref) refs.push("HEAD");
      var self = this;
      refs.forEach(function (r) { if (r.indexOf("refs/tags/") === 0) return; var t = self.arq("logs/" + r) || ""; self.gravar("logs/" + r, t + linha); });
    };
    R.reflog = function (ref) { var t = this.arq("logs/" + ref) || ""; return t.split("\n").filter(Boolean).map(function (l) { var m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.*?> \d+ [+-]\d{4})\t(.*)$/.exec(l); return m ? { old: m[1], neu: m[2], id: m[3], msg: m[4] } : null; }).filter(Boolean).reverse(); };
    R.listarRefs = function (prefixo) {
      var r = {}, self = this, pk = this.packed();
      Object.keys(pk).forEach(function (k) { if (k.indexOf(prefixo) === 0) r[k] = pk[k]; });
      (function andar(rel) {
        var n = noDe(self.sh, self.g + "/" + rel);
        if (!n || n.t !== "d") return;
        Object.keys(n.c).forEach(function (k) { var c = n.c[k], s = rel + "/" + k; if (c.t === "d") andar(s); else { var v = self.lerRef(s); if (v) r[s] = v.simb ? self.resolverRef(s) : v.hash; } });
      })(prefixo.replace(/\/$/, ""));
      return Object.keys(r).sort().map(function (k) { return { nome: k, hash: r[k] }; });
    };
    R.config = function (chave) { var t = this.configTodas().filter(function (e) { return e.k === chave.toLowerCase().replace(/^([^.]*\.)(.*\.)?/, function (m) { return m; }) || e.k.toLowerCase() === chave.toLowerCase(); }); return t.length ? t[t.length - 1].v : null; };
    var configExtra = []; // "git -c chave=valor"
    R.configTodas = function () { return configGlobal(this.sh).concat(parseConfig(this.arq("config")), configExtra); };
    function configGlobal(sh) { var h = sh.valor("HOME") || "/home/ana"; return parseConfig(lerTxt(sh, h + "/.gitconfig")); }
    function configSemRepo(sh, chave) { var t = configGlobal(sh).filter(function (e) { return e.k.toLowerCase() === chave.toLowerCase(); }); return t.length ? t[t.length - 1].v : null; }

    // índice: [{mode, hash, stage, path}] ordenado por caminho (bytes) e estágio
    R.lerIndice = function () {
      var t = this.arq("index"); if (!t) return [];
      return t.split("\n").filter(Boolean).map(function (l) { var m = /^(\d+) ([0-9a-f]{40}) (\d)\t(.*)$/.exec(l); return { mode: m[1], hash: m[2], stage: +m[3], path: m[4] }; });
    };
    R.gravarIndice = function (ents) {
      ents.sort(function (a, b) { return cmpCam(a.path, b.path) || a.stage - b.stage; });
      this.gravar("index", ents.map(function (e) { return e.mode + " " + e.hash + " " + e.stage + "\t" + e.path; }).join("\n") + (ents.length ? "\n" : ""));
    };
    function cmpCam(a, b) { var x = utf8bytes(a), y = utf8bytes(b); for (var i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; }
    // árvore → mapa plano {caminho: {mode, hash}}
    R.arvorePlana = function (treeHash, pref, out) {
      out = out || {}; pref = pref || "";
      var t = this.ler(treeHash); if (!t) return out;
      var self = this;
      t.ents.forEach(function (e) { if (e.mode === "40000" || e.mode === "040000") self.arvorePlana(e.hash, pref + e.name + "/", out); else out[pref + e.name] = { mode: e.mode, hash: e.hash }; });
      return out;
    };
    R.arvoreDe = function (commitHash) { if (!commitHash) return {}; var c = this.ler(commitHash); if (c && c.type === "tag") c = this.ler(this.descascar(commitHash)); return c ? this.arvorePlana(c.tree) : {}; };
    R.descascar = function (h) { var o = this.ler(h), n = 0; while (o && o.type === "tag" && n++ < 10) { h = o.object; o = this.ler(h); } return h; };
    // grava árvores a partir do índice (estágio 0)
    R.escreverArvore = function (ents) {
      var raiz = { dirs: {}, arqs: [] }, self = this;
      ents.forEach(function (e) {
        if (e.stage) return;
        var partes = e.path.split("/"), no = raiz;
        for (var i = 0; i < partes.length - 1; i++) no = no.dirs[partes[i]] || (no.dirs[partes[i]] = { dirs: {}, arqs: [] });
        no.arqs.push({ mode: e.mode, name: partes[partes.length - 1], hash: e.hash });
      });
      function gravarNo(no) {
        var lista = no.arqs.map(function (a) { return { mode: a.mode, name: a.name, hash: a.hash, chave: a.name }; });
        Object.keys(no.dirs).forEach(function (d) { lista.push({ mode: "40000", name: d, hash: gravarNo(no.dirs[d]), chave: d + "/" }); });
        lista.sort(function (a, b) { return cmpCam(a.chave, b.chave); });
        return self.escreverObj({ type: "tree", ents: lista.map(function (x) { return { mode: x.mode, name: x.name, hash: x.hash }; }) });
      }
      return gravarNo(raiz);
    };
    // pasta de trabalho
    R.absDe = function (rel) { return this.raiz + "/" + rel; };
    R.relCwd = function (rel) { return relativo(this.sh.cwd, this.absDe(rel)); };
    R.modoNo = function (n) { return n.t === "l" ? "120000" : (n.m & 64 ? "100755" : "100644"); };
    R.conteudoNo = function (n) { return n.t === "l" ? n.alvo : (n.d == null ? new Array((n.z || 0) + 1).join("\u0000") : n.d); };
    R.hashArquivo = function (n) {
      var txt = this.conteudoNo(n);
      if (n._gh && n._gd === txt) return n._gh;
      var h = hashObjeto({ type: "blob", data: txt }); n._gh = h; n._gd = txt; return h;
    };
    R.regrasIgnore = function () {
      if (this._regras) return this._regras;
      var regras = [], self = this;
      var ex = this.config("core.excludesfile");
      if (ex) { var h = this.sh.valor("HOME") || "/home/ana"; regras = regras.concat(compilarIgnore(lerTxt(this.sh, ex.replace(/^~/, h)), "", ex)); }
      regras = regras.concat(compilarIgnore(this.arq("info/exclude"), "", ".git/info/exclude"));
      this._regras = regras; return regras;
    };
    // está ignorado? (rel = caminho a partir da raiz; dir = é pasta). Devolve a regra ou null.
    R.ignorado = function (rel, dir) {
      var partes = rel.split("/"), self = this;
      // uma pasta-mãe ignorada ignora tudo dentro
      for (var i = 1; i < partes.length; i++) { var r0 = this.regraIgnore(partes.slice(0, i).join("/"), true); if (r0 && !r0.neg) return r0; }
      var r = this.regraIgnore(rel, dir);
      return r && !r.neg ? r : null;
    };
    R.regraIgnore = function (rel, dir) {
      var regras = this.regrasIgnore().slice(), partes = rel.split("/"), self = this;
      // .gitignore de cada pasta-mãe (mais perto = maior prioridade = vem depois)
      for (var i = 0; i < partes.length; i++) {
        var base = partes.slice(0, i).join("/") + (i ? "/" : "");
        var arq = this.raiz + "/" + base + ".gitignore", n = noDe(this.sh, arq);
        if (n && n.t === "f") {
          var cache = this._ign || (this._ign = {});
          if (!cache[arq] || cache[arq].d !== n.d) cache[arq] = { d: n.d, r: compilarIgnore(n.d, base, base + ".gitignore") };
          regras = regras.concat(cache[arq].r);
        }
      }
      for (var k = regras.length - 1; k >= 0; k--) {
        var g = regras[k];
        if (rel.indexOf(g.base) !== 0) continue;
        if (g.soDir && !dir) continue;
        if (g.re.test(rel.slice(g.base.length))) return g;
      }
      return null;
    };
    // lista arquivos da pasta de trabalho: {caminho: no}; com ignorados separados
    R.arquivos = function (incluirIgn) {
      var res = {}, ign = {}, self = this, rz = noDe(this.sh, this.raiz);
      (function andar(no, pref) {
        Object.keys(no.c).forEach(function (k) {
          if (k === ".git" && !pref) return;
          var c = no.c[k], rel = pref + k;
          if (c.t === "d") {
            if (c.c[".git"] && c.c[".git"].t === "d") { res[rel + "/"] = c; return; } // repositório dentro
            andar(c, rel + "/");
          } else if (c.t === "f" || c.t === "l") res[rel] = c;
        });
      })(rz, "");
      return res;
    };
    R.limparCache = function () { this._regras = null; this._todos = null; };

    /* ---------------- revisões ---------------- */
    R.resolverNome = function (nome) {
      if (/^[0-9a-f]{40}$/.test(nome) && this.ler(nome)) return nome;
      if (nome === "HEAD" || nome === "@") return this.head();
      if (/^(ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD)$/.test(nome)) { var t = this.arq(nome); return t ? t.slice(0, 40) : null; }
      var cands = ["refs/" + nome, "refs/tags/" + nome, "refs/heads/" + nome, "refs/remotes/" + nome, "refs/remotes/" + nome + "/HEAD"];
      if (nome.indexOf("refs/") === 0) cands.unshift(nome);
      for (var i = 0; i < cands.length; i++) { var h = this.resolverRef(cands[i]); if (h) return h; }
      if (/^[0-9a-f]{4,39}$/.test(nome)) {
        var todos = this.todosObjetos().filter(function (x) { return x.indexOf(nome) === 0; });
        if (todos.length === 1) return todos[0];
        if (todos.length > 1) return { ambiguo: true };
      }
      return null;
    };
    R.rev = function (spec) { // HEAD~2, main^, abc123, v1.0^{}, HEAD@{1}, ...
      var m = /^(.*?)((?:[~^]\d*|\^\{[a-z]*\}|@\{\d+\})*)$/.exec(spec), base = m[1], suf = m[2];
      if (base === "" && suf) base = "HEAD";
      var h;
      var mr = /^(.*)@\{(\d+)\}/.exec(spec);
      if (mr) {
        var ref = mr[1] === "" || mr[1] === "HEAD" ? "HEAD" : "refs/heads/" + mr[1];
        var rl = this.reflog(ref), n = +mr[2];
        if (n >= rl.length) return null;
        h = rl[n].neu; suf = spec.slice(mr[0].length);
      } else {
        h = this.resolverNome(base);
        if (!h || h.ambiguo) return h;
      }
      var re = /\^\{[a-z]*\}|[~^]\d*/g, p;
      while ((p = re.exec(suf))) {
        var s = p[0];
        if (s === "^{}" || s === "^{commit}" || s === "^{tree}") {
          h = this.descascar(h);
          if (s === "^{tree}") { var c0 = this.ler(h); if (!c0 || c0.type !== "commit") return null; h = c0.tree; }
          continue;
        }
        h = this.descascar(h);
        var c = this.ler(h); if (!c || c.type !== "commit") return null;
        if (s[0] === "^") { var k = s.length > 1 ? +s.slice(1) : 1; if (k === 0) continue; h = c.parents[k - 1]; if (!h) return null; }
        else { var nn = s.length > 1 ? +s.slice(1) : 1; for (var q = 0; q < nn; q++) { c = this.ler(h); if (!c || !c.parents.length) return null; h = c.parents[0]; } }
      }
      return h;
    };
    R.commitDe = function (spec) { var h = this.rev(spec); if (!h || h.ambiguo) return null; h = this.descascar(h); var o = this.ler(h); return o && o.type === "commit" ? h : null; };
    // ancestrais (ordem por data, desempate como o git: ordem de inserção)
    R.ancestrais = function (inicio) {
      var vistos = {}, fila = inicio.slice(), res = [];
      while (fila.length) { var h = fila.shift(); if (!h || vistos[h]) continue; vistos[h] = 1; res.push(h); var c = this.ler(h); if (c) fila = fila.concat(c.parents); }
      return vistos;
    };
    R.mergeBase = function (a, b) {
      var aa = this.ancestrais([a]), cand = [], self = this, vistos = {}, fila = [b];
      while (fila.length) { var h = fila.shift(); if (vistos[h]) continue; vistos[h] = 1; if (aa[h]) { cand.push(h); continue; } var c = this.ler(h); if (c) fila = fila.concat(c.parents); }
      // remove candidatos que são ancestrais de outros
      return cand.filter(function (x) { return !cand.some(function (y) { return y !== x && self.ancestrais([y])[x]; }); })[0] || null;
    };
    R.ehAncestral = function (a, b) { return !!this.ancestrais([b])[a]; };
    // lista de commits como o "git log" (ordem por data do committer, depois ordem de descoberta)
    R.revList = function (incl, excl, opt) {
      opt = opt || {};
      var fora = excl.length ? this.ancestrais(excl) : {}, self = this, vistos = {}, fila = [], res = [], seq = 0;
      function por(h) { if (!h || vistos[h] || fora[h]) return; vistos[h] = 1; var c = self.ler(h); fila.push({ h: h, ts: parseIdent(c.committer).ts, seq: seq++ }); }
      incl.forEach(por);
      while (fila.length) {
        var mi = 0; for (var i = 1; i < fila.length; i++) if (fila[i].ts > fila[mi].ts || (fila[i].ts === fila[mi].ts && fila[i].seq < fila[mi].seq)) mi = i;
        var x = fila.splice(mi, 1)[0], c = self.ler(x.h);
        res.push(x.h);
        (opt.firstParent ? c.parents.slice(0, 1) : c.parents).forEach(por);
      }
      if (opt.topo) res = ordemTopo(this, res);
      return res;
    };
    function ordemTopo(repo, lista) { // pais sempre depois dos filhos (como --topo-order, que o --graph liga)
      var em = {}, filhos = {}, res = [], pos = {};
      lista.forEach(function (h, i) { em[h] = 1; pos[h] = i; });
      var indeg = {}; lista.forEach(function (h) { indeg[h] = 0; });
      lista.forEach(function (h) { repo.ler(h).parents.forEach(function (p) { if (em[p]) indeg[p]++; }); });
      var pilha = lista.filter(function (h) { return indeg[h] === 0; }).reverse();
      while (pilha.length) {
        var h = pilha.pop(); res.push(h);
        var ps = repo.ler(h).parents.filter(function (p) { return em[p]; });
        for (var i = 0; i < ps.length; i++) { indeg[ps[i]]--; if (indeg[ps[i]] === 0) pilha.push(ps[i]); }
      }
      return res;
    }

    /* ---------------- saída ---------------- */
    function GitErro(msg, st) { this.msg = msg; this.st = st === undefined ? 128 : st; }
    function fatal(msg) { throw new GitErro("fatal: " + msg + "\n", 128); }
    function plural(n, um, varios) { return n + " " + (n === 1 ? um : varios); }

    // diff entre dois mapas planos {caminho: {mode, hash}} (ou funções de conteúdo)
    // devolve lista ordenada de {tipo: A/M/D/R, de, para, a:{mode,hash}, b:{mode,hash}}
    function compararMapas(A, B, renomes) {
      var todos = {}, lista = [];
      Object.keys(A).forEach(function (k) { todos[k] = 1; }); Object.keys(B).forEach(function (k) { todos[k] = 1; });
      Object.keys(todos).sort(cmpCam).forEach(function (k) {
        var a = A[k], b = B[k];
        if (a && b) { if (a.hash !== b.hash || a.mode !== b.mode) lista.push({ tipo: "M", de: k, para: k, a: a, b: b }); }
        else if (a) lista.push({ tipo: "D", de: k, para: k, a: a });
        else lista.push({ tipo: "A", de: k, para: k, b: b });
      });
      if (renomes) {
        var dels = lista.filter(function (x) { return x.tipo === "D"; }), adds = lista.filter(function (x) { return x.tipo === "A"; });
        adds.forEach(function (ad) {
          for (var i = 0; i < dels.length; i++) {
            var d = dels[i];
            if (!d.usado && d.a.hash === ad.b.hash) { d.usado = true; ad.tipo = "R"; ad.de = d.de; ad.a = d.a; ad.sim = 100; break; }
          }
        });
        if (typeof renomes === "function") adds.forEach(function (ad) {
          if (ad.tipo !== "A") return;
          var melhor = null, ms = 0;
          dels.forEach(function (d) { if (d.usado) return; var s = renomes(d.a.hash, ad.b.hash); if (s >= 50 && s > ms) { ms = s; melhor = d; } });
          if (melhor) { melhor.usado = true; ad.tipo = "R"; ad.de = melhor.de; ad.a = melhor.a; ad.sim = ms; }
        });
        lista = lista.filter(function (x) { return !(x.tipo === "D" && x.usado); });
        lista.sort(function (x, y) { return cmpCam(x.para, y.para); });
      }
      return lista;
    }
    R.similaridade = function (ha, hb) { // aproximação do score de renomeação do git (por bytes de linhas iguais)
      var a = this.ler(ha), b = this.ler(hb); if (!a || !b) return 0;
      var ta = a.data, tb = b.data, la = utf8bytes(ta).length, lb = utf8bytes(tb).length;
      if (!la && !lb) return 100;
      var maior = Math.max(la, lb), menor = Math.min(la, lb);
      if (menor * 100 < maior * 50) return 0;
      var cont = {}, igual = 0;
      separarLinhas(ta).l.forEach(function (l) { cont[l] = (cont[l] || 0) + 1; });
      separarLinhas(tb).l.forEach(function (l) { if (cont[l]) { cont[l]--; igual += utf8bytes(l).length + 1; } });
      return Math.floor(igual * 100 / maior);
    };
    R.textoBlob = function (h) { var o = this.ler(h); return o ? o.data : ""; };
    // patch no formato do git
    R.patch = function (mud, opt) {
      opt = opt || {};
      var self = this, out = "", ctx = opt.ctx != null ? opt.ctx : 3;
      mud.forEach(function (m) {
        var de = (opt.pref ? opt.pref : "") + m.de, para = (opt.pref ? opt.pref : "") + m.para;
        var ta = m.a ? (m.a.texto != null ? m.a.texto : self.textoBlob(m.a.hash)) : "", tb = m.b ? (m.b.texto != null ? m.b.texto : self.textoBlob(m.b.hash)) : "";
        out += "diff --git a/" + de + " b/" + para + "\n";
        var ha = m.a ? self.abrev(m.a.hash) : "0000000", hb = m.b ? self.abrev(m.b.hash) : "0000000";
        if (m.tipo === "A") out += "new file mode " + m.b.mode + "\nindex 0000000.." + hb + "\n";
        else if (m.tipo === "D") out += "deleted file mode " + m.a.mode + "\nindex " + ha + "..0000000\n";
        else if (m.tipo === "R") {
          out += "similarity index " + m.sim + "%\nrename from " + de + "\nrename to " + para + "\n";
          if (m.a.hash === m.b.hash) return;
          out += "index " + ha + ".." + hb + (m.a.mode === m.b.mode ? " " + m.a.mode : "") + "\n";
        } else {
          if (m.a.mode !== m.b.mode) { out += "old mode " + m.a.mode + "\nnew mode " + m.b.mode + "\n"; if (m.a.hash === m.b.hash) return; out += "index " + ha + ".." + hb + "\n"; }
          else out += "index " + ha + ".." + hb + " " + m.a.mode + "\n";
        }
        if (binario(ta) || binario(tb)) { out += "Binary files " + (m.a ? "a/" + de : "/dev/null") + " and " + (m.b ? "b/" + para : "/dev/null") + " differ\n"; return; }
        if (ta === tb) return;
        out += "--- " + (m.tipo === "A" ? "/dev/null" : "a/" + de) + "\n+++ " + (m.tipo === "D" ? "/dev/null" : "b/" + para) + "\n";
        out += diffUnificado(ta, tb, ctx, opt.palavras).txt;
      });
      return out;
    };
    R.numstat = function (m) {
      var ta = m.a ? (m.a.texto != null ? m.a.texto : this.textoBlob(m.a.hash)) : "", tb = m.b ? (m.b.texto != null ? m.b.texto : this.textoBlob(m.b.hash)) : "";
      if (binario(ta) || binario(tb)) return { bin: true, add: 0, del: 0, ta: utf8bytes(ta).length, tb: utf8bytes(tb).length };
      return contarMudancas(ta, tb);
    };
    function nomeStat(m) {
      if (m.tipo !== "R") return m.para;
      // a/{x => y}/b
      var a = m.de, b = m.para, pre = 0, suf = 0;
      var i = 0; while (i < a.length && i < b.length && a[i] === b[i]) { if (a[i] === "/") pre = i + 1; i++; }
      var j = 0; while (j < a.length - pre && j < b.length - pre && a[a.length - 1 - j] === b[b.length - 1 - j]) { if (a[a.length - 1 - j] === "/") suf = j + 1; j++; }
      if (!pre && !suf) return a + " => " + b;
      return a.slice(0, pre) + "{" + a.slice(pre, a.length - suf) + " => " + b.slice(pre, b.length - suf) + "}" + a.slice(a.length - suf);
    }
    R.diffstat = function (mud, opt) {
      opt = opt || {};
      var self = this, linhas = [], adds = 0, dels = 0;
      var itens = mud.map(function (m) { var n = self.numstat(m); adds += n.add; dels += n.del; return { nome: nomeStat(m), n: n, m: m }; });
      if (!itens.length) return "";
      var largNome = 0, maxMud = 0;
      itens.forEach(function (x) { largNome = Math.max(largNome, larg(x.nome)); maxMud = Math.max(maxMud, x.n.add + x.n.del); });
      var largNum = String(maxMud).length;
      itens.forEach(function (x) { if (x.n.bin) largNum = Math.max(largNum, 3); });
      var total = 80, larguraNomes = Math.min(largNome, total - 1 - largNum - 6);
      var largGraf = total - (Math.max(largNome, 0) + 3 + largNum + 1) - 1;
      if (largGraf > 40 && maxMud > 40) largGraf = Math.max(40, largGraf);
      var out = "";
      itens.forEach(function (x) {
        var nome = x.nome;
        out += " " + nome + rep(" ", largNome - larg(nome)) + " | ";
        if (x.n.bin) { out += "Bin " + x.n.ta + " -> " + x.n.tb + " bytes\n"; return; }
        var a = x.n.add, d = x.n.del, tot = a + d;
        out += rep(" ", largNum - String(tot).length) + tot;
        if (tot) {
          if (maxMud > largGraf) { var na = escala(a, maxMud, largGraf), nd = escala(d, maxMud, largGraf); a = na; d = nd; }
          out += " " + rep("+", a) + rep("-", d);
        }
        out += "\n";
      });
      out += resumoStat(itens.length, adds, dels) + "\n";
      return out;
      function escala(v, max, w) { if (!v) return 0; var r = Math.floor((v * w + max / 2) / max); return r < 1 ? 1 : r; }
    };
    function larg(s) { return s.length; }
    function rep(s, n) { var r = ""; while (n-- > 0) r += s; return r; }
    function resumoStat(arqs, adds, dels) {
      var s = " " + arqs + " file" + (arqs === 1 ? "" : "s") + " changed";
      if (adds || !dels) s += ", " + adds + " insertion" + (adds === 1 ? "" : "s") + "(+)";
      if (dels || !adds) s += ", " + dels + " deletion" + (dels === 1 ? "" : "s") + "(-)";
      return s;
    }
    R.resumoCriacao = function (mud) { // " create mode 100644 x" etc.
      var out = "";
      mud.forEach(function (m) {
        if (m.tipo === "A") out += " create mode " + m.b.mode + " " + m.para + "\n";
        else if (m.tipo === "D") out += " delete mode " + m.a.mode + " " + m.de + "\n";
        else if (m.tipo === "R") out += " rename " + nomeStat(m) + " (" + m.sim + "%)\n";
        else if (m.a.mode !== m.b.mode) out += " mode change " + m.a.mode + " => " + m.b.mode + " " + m.para + "\n";
      });
      return out;
    };
    R.shortstat = function (mud) { var self = this, a = 0, d = 0; mud.forEach(function (m) { var n = self.numstat(m); a += n.add; d += n.del; }); return resumoStat(mud.length, a, d) + "\n"; };

    /* ---------------- estado (status) ---------------- */
    R.estado = function () {
      var self = this, idx = this.lerIndice(), head = this.head(), H = this.arvoreDe(head);
      var I0 = {}, conf = {};
      idx.forEach(function (e) { if (e.stage === 0) I0[e.path] = { mode: e.mode, hash: e.hash }; else conf[e.path] = conf[e.path] || []; if (e.stage) conf[e.path][e.stage] = e; });
      var W = this.arquivos(), WM = {};
      Object.keys(W).forEach(function (k) { if (!/\/$/.test(k)) WM[k] = W[k]; });
      var preparado = compararMapas(H, I0, function (a, b) { return self.similaridade(a, b); }).filter(function (m) { return !conf[m.para] && !conf[m.de]; });
      var naoPrep = [];
      Object.keys(I0).sort(cmpCam).forEach(function (k) {
        var n = WM[k];
        if (!n) { naoPrep.push({ tipo: "D", de: k, para: k, a: I0[k] }); return; }
        var h = self.hashArquivo(n), md = self.modoNo(n);
        if (h !== I0[k].hash || md !== I0[k].mode) naoPrep.push({ tipo: "M", de: k, para: k, a: I0[k], b: { mode: md, hash: h, texto: self.conteudoNo(n) } });
      });
      var naoRastr = [], ignorados = [];
      Object.keys(W).sort(cmpCam).forEach(function (k) {
        if (I0[k] || conf[k]) return;
        var dir = /\/$/.test(k), rel = dir ? k.slice(0, -1) : k;
        if (self.ignorado(rel, dir)) ignorados.push(k); else naoRastr.push(k);
      });
      return { idx: idx, I0: I0, H: H, head: head, conf: conf, preparado: preparado, naoPrep: naoPrep, naoRastr: naoRastr, ignorados: ignorados, W: WM };
    };
    // agrupa não rastreados por pasta (como o status: "novo/")
    R.agruparNaoRastr = function (lista, I0, todos) {
      var rastrDirs = {};
      Object.keys(I0).forEach(function (k) { var p = k.split("/"); for (var i = 1; i < p.length; i++) rastrDirs[p.slice(0, i).join("/") + "/"] = 1; });
      var res = [], vistos = {};
      lista.forEach(function (k) {
        if (todos) { res.push(k); return; }
        var p = k.split("/"), alvo = k;
        for (var i = 1; i < p.length; i++) { var d = p.slice(0, i).join("/") + "/"; if (!rastrDirs[d]) { alvo = d; break; } }
        if (!vistos[alvo]) { vistos[alvo] = 1; res.push(alvo); }
      });
      return res;
    };
    R.ignoradosAgrupados = function (ign, I0) {
      // pasta ignorada inteira aparece como "pasta/"
      var self = this, res = [], vistos = {};
      ign.forEach(function (k) {
        var p = k.replace(/\/$/, "").split("/"), alvo = k;
        for (var i = 1; i < p.length; i++) { var d = p.slice(0, i).join("/"); if (self.regraIgnore(d, true) && !self.regraIgnore(d, true).neg) { alvo = d + "/"; break; } }
        if (alvo === k) { // pasta só com ignorados (e sem nada rastreado nem não rastreado dentro): "pasta/"
          var pp = k.split("/");
          for (var j = 1; j < pp.length; j++) {
            var dir = pp.slice(0, j).join("/") + "/";
            var dentro = Object.keys(self.arquivos()).filter(function (x) { return x.indexOf(dir) === 0; });
            if (dentro.every(function (x) { return ign.indexOf(x) >= 0; }) && !Object.keys(I0).some(function (x) { return x.indexOf(dir) === 0; })) { alvo = dir; break; }
          }
        }
        if (!vistos[alvo]) { vistos[alvo] = 1; res.push(alvo); }
      });
      return res;
    };

    /* ---------------- escrever na pasta de trabalho ---------------- */
    R.escreverArquivo = function (rel, ent) {
      var o = this.ler(ent.hash), abs = this.absDe(rel), txt = o ? o.data : "";
      var pai = abs.slice(0, abs.lastIndexOf("/")), sh = this.sh;
      // se no caminho há um arquivo onde deveria haver pasta, apaga
      var r = sh.resolver(abs, false);
      if (r.no && r.no.t === "d") apagar(sh, abs);
      if (ent.mode === "120000") { apagar(sh, abs); var pd = mkdirP(sh, pai); pd.c[abs.slice(abs.lastIndexOf("/") + 1)] = { t: "l", alvo: txt, m: 511, u: UID, g: UID, mt: sh.k.clock, ct: sh.k.clock, at: sh.k.clock, ino: 0, nl: 1 }; return; }
      escreverTxt(sh, abs, txt, ent.mode === "100755" ? 509 : 436);
    };
    R.apagarArquivo = function (rel) {
      var abs = this.absDe(rel), sh = this.sh;
      apagar(sh, abs);
      // remove pastas que ficaram vazias
      var p = rel.split("/"); p.pop();
      while (p.length) { var d = noDe(sh, this.absDe(p.join("/"))); if (d && d.t === "d" && !Object.keys(d.c).length) apagar(sh, this.absDe(p.join("/"))); else break; p.pop(); }
    };
    // troca a pasta de trabalho + índice de uma árvore para outra (checkout). Devolve lista de conflitos ou null
    R.trocarArvore = function (deMapa, paraMapa, opt) {
      opt = opt || {};
      var st = this.estado(), self = this, problemas = [], sobrescritos = [];
      var mud = compararMapas(deMapa, paraMapa, false);
      // arquivos locais modificados que seriam perdidos
      if (!opt.forcar) {
        var sujo = {};
        st.naoPrep.forEach(function (m) { sujo[m.para] = 1; });
        st.preparado.forEach(function (m) { sujo[m.para] = 1; sujo[m.de] = 1; });
        mud.forEach(function (m) {
          var k = m.para;
          if (sujo[k]) {
            // se o índice já tem exatamente o conteúdo de destino, tudo bem
            var noIdx = st.I0[k], noW = st.W[k];
            var destino = paraMapa[k];
            var wh = noW ? self.hashArquivo(noW) : null;
            if (destino && noIdx && noIdx.hash === destino.hash && wh === destino.hash) return;
            if (!destino && !noIdx && !noW) return;
            problemas.push(k);
          } else if (m.tipo === "A" && st.W[k] && !st.I0[k]) {
            if (self.hashArquivo(st.W[k]) !== m.b.hash) sobrescritos.push(k);
          }
        });
        if (problemas.length || sobrescritos.length) return { local: problemas, naoRastr: sobrescritos };
      }
      // aplica: índice = paraMapa, mas mantém mudanças preparadas em arquivos não afetados
      var novoIdx = {};
      Object.keys(st.I0).forEach(function (k) { novoIdx[k] = st.I0[k]; });
      mud.forEach(function (m) {
        if (m.tipo === "D") { delete novoIdx[m.de]; self.apagarArquivo(m.de); }
        else { novoIdx[m.para] = m.b; self.escreverArquivo(m.para, m.b); }
      });
      if (opt.forcar) {
        Object.keys(novoIdx).forEach(function (k) { if (!paraMapa[k]) { delete novoIdx[k]; self.apagarArquivo(k); } });
        Object.keys(paraMapa).forEach(function (k) { novoIdx[k] = paraMapa[k]; var n = noDe(self.sh, self.absDe(k)); if (!n || self.hashArquivo(n) !== paraMapa[k].hash) self.escreverArquivo(k, paraMapa[k]); });
      }
      this.gravarIndice(Object.keys(novoIdx).map(function (k) { return { mode: novoIdx[k].mode, hash: novoIdx[k].hash, stage: 0, path: k }; }));
      return null;
    };
    function erroTroca(r, acao) {
      var s = "";
      if (r.local.length) s += "error: Your local changes to the following files would be overwritten by " + acao + ":\n" + r.local.map(function (k) { return "\t" + k + "\n"; }).join("") + "Please commit your changes or stash them before you " + (acao === "checkout" ? "switch branches" : acao) + ".\n";
      if (r.naoRastr.length) s += "error: The following untracked working tree files would be overwritten by " + acao + ":\n" + r.naoRastr.map(function (k) { return "\t" + k + "\n"; }).join("") + "Please move or remove them before you " + (acao === "checkout" ? "switch branches" : acao) + ".\n";
      return s + "Aborting\n";
    }

    /* =================================================================
       Os comandos
       ================================================================= */
    var CMDS = {};
    function opcoes(args, spec) {
      // spec: {"-m": "valor", "--message": "-m", "-a": true, ...}; devolve {o:{}, ops:[], erro}
      var o = {}, ops = [], fimOp = false;
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (fimOp || a === "-" || a[0] !== "-") { ops.push(a); continue; }
        if (a === "--") { fimOp = true; o["--"] = ops.length; continue; }
        if (a.slice(0, 2) === "--") {
          var eq = a.indexOf("="), nome = eq > 0 ? a.slice(0, eq) : a, val = eq > 0 ? a.slice(eq + 1) : undefined;
          var s = spec[nome];
          if (s === undefined) {
            var cands = Object.keys(spec).filter(function (k) { return k.indexOf(nome) === 0 && k.slice(0, 2) === "--"; });
            if (cands.length === 1) { nome = cands[0]; s = spec[nome]; }
            else if (/^--no-/.test(nome) && spec["--" + nome.slice(5)] !== undefined) { o[spec["--" + nome.slice(5)] && typeof spec["--" + nome.slice(5)] === "string" && spec["--" + nome.slice(5)][0] === "-" ? spec["--" + nome.slice(5)] : "--" + nome.slice(5)] = false; continue; }
            else return { erro: "unknown option `" + a.slice(2).replace(/=.*/, "") + "'" };
          }
          var alvo = nome;
          if (typeof s === "string" && s[0] === "-") { alvo = s; s = spec[s]; }
          if (s === "valor") { if (val === undefined) { if (i + 1 >= args.length) return { erro: "option `" + nome.slice(2) + "' requires a value" }; val = args[++i]; } addV(alvo, val); }
          else if (s === "opcional") o[alvo] = val === undefined ? true : val;
          else o[alvo] = true;
          continue;
        }
        // curtas agrupadas
        for (var j = 1; j < a.length; j++) {
          var c = "-" + a[j], sc = spec[c];
          if (/^-[0-9]$/.test(c) && spec["-N"]) { var num = a.slice(j); o["-n"] = num; j = a.length; break; }
          if (sc === undefined) return { erro: "unknown switch `" + a[j] + "'" };
          var al = c; if (typeof sc === "string" && sc[0] === "-") { al = sc; sc = spec[sc]; }
          if (sc === "valor") { var v = a.slice(j + 1); if (!v) { if (i + 1 >= args.length) return { erro: "switch `" + a[j] + "' requires a value" }; v = args[++i]; } addV(al, v); break; }
          else if (sc === "opcional") { var v2 = a.slice(j + 1); o[al] = v2 || true; break; }
          else o[al] = true;
        }
      }
      return { o: o, ops: ops };
      function addV(k, v) { if (o[k] === undefined) o[k] = v; else if (Array.isArray(o[k])) o[k].push(v); else o[k] = [o[k], v]; if (k === "-m" && !Array.isArray(o[k])) o[k] = [v]; }
    }
    function lista(v) { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }
    function precisaRepo(io) { var r = achar(io.sh); if (!r) naoRepo(io.sh); return r; }
    function naoRepo(sh) { fatal("not a git repository (or any of the parent directories): .git"); }
    function precisaArvore(repo) { if (!repo.raiz) fatal("this operation must be run in a work tree"); }
    // caminhos dados pelo usuário → relativos à raiz do repositório
    function pathspec(repo, p) {
      var abs = repo.sh.abs(p);
      if (abs === repo.raiz) return "";
      if (abs.indexOf(repo.raiz + "/") !== 0) fatal(q(p) + ": '" + p + "' is outside repository at '" + repo.raiz + "'");
      return abs.slice(repo.raiz.length + 1);
    }
    function q(s) { return "'" + s + "'"; }
    function casaSpec(spec, k) { // spec relativo à raiz ("" = tudo); aceita glob
      if (spec === "") return true;
      if (/[*?[]/.test(spec)) { var re = new RegExp("^" + globRe(spec).replace(/\[\^\/\]\*/g, ".*") + "(/.*)?$"); return re.test(k); }
      return k === spec || k.indexOf(spec.replace(/\/$/, "") + "/") === 0;
    }

    B.EXT.git = function* (args, io) {
      var sh = io.sh;
      var a = args.slice(1), dirC = null;
      // opções globais
      while (a.length && a[0][0] === "-") {
        if (a[0] === "-C") { dirC = a[1]; a.splice(0, 2); continue; }
        if (a[0] === "--version") { io.out("git version 2.53.0\n"); return 0; }
        if (a[0] === "--help" || a[0] === "-h") { a = ["help"]; break; }
        if (a[0] === "--no-pager" || a[0] === "-P" || a[0] === "--paginate" || a[0] === "-p") { a.shift(); continue; }
        if (a[0] === "-c") { var kv = a[1] || "", ie = kv.indexOf("="); configExtra.push({ k: chaveNorm(ie < 0 ? kv : kv.slice(0, ie)) ? (ie < 0 ? kv : kv.slice(0, ie)).toLowerCase() : kv, v: ie < 0 ? "true" : kv.slice(ie + 1) }); a.splice(0, 2); continue; }
        io.err("unknown option: " + a[0] + "\n" + USO); return 129;
      }
      if (!a.length) { io.out(USO + "\n" + AJUDA); return 1; }
      var cwdAntes = sh.cwd;
      var extraAntes = configExtra.length;
      if (dirC) { var nd = noDe(sh, sh.abs(dirC)); if (!nd || nd.t !== "d") { io.err("fatal: cannot change to '" + dirC + "': Arquivo ou diretório inexistente\n"); return 128; } sh.cwd = sh.abs(dirC); }
      var nome = a[0], al = { co: "checkout", br: "branch", ci: "commit", st: "status" };
      // apelidos da config
      var cmd = CMDS[nome];
      try {
        if (!cmd) {
          var alias = configSemRepo(sh, "alias." + nome);
          if (alias) { var partes = alias.split(/\s+/); a = partes.concat(a.slice(1)); cmd = CMDS[a[0]]; nome = a[0]; }
        }
        if (!cmd) {
          if (NAO_FEITOS[nome]) { io.err("(simulador) o comando \"git " + nome + "\" não existe neste simulador. Use o laboratório (o Git de verdade) para ele.\n"); return 1; }
          io.err("git: '" + nome + "' não é um comando git. Veja 'git --help'.\n" + sugestao(nome)); return 1;
        }
        if (a.length === 2 && a[1] === "-h" && global.GITSIM_AJUDA && global.GITSIM_AJUDA[nome]) { io.out(global.GITSIM_AJUDA[nome]); return 129; }
        var r = cmd(a.slice(1), io, sh);
        if (r && typeof r.next === "function") r = yield* r;
        return r || 0;
      } catch (e) {
        if (e instanceof GitErro) { io.err(e.msg); return e.st; }
        throw e;
      } finally { if (dirC) sh.cwd = cwdAntes; configExtra.length = 0; }
    };
    B.EXT.git.gitsim = true;
    var USO = "usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]\n           [--exec-path[=<path>]] [--html-path] [--man-path] [--info-path]\n           [-p | --paginate | -P | --no-pager] [--no-replace-objects] [--no-lazy-fetch]\n           [--no-optional-locks] [--no-advice] [--bare] [--git-dir=<path>]\n           [--work-tree=<path>] [--namespace=<name>] [--config-env=<name>=<envvar>]\n           <command> [<args>]\n";
    var AJUDA = "These are common Git commands used in various situations:\n\nstart a working area (see also: git help tutorial)\n   clone      Clone a repository into a new directory\n   init       Create an empty Git repository or reinitialize an existing one\n\nwork on the current change (see also: git help everyday)\n   add        Add file contents to the index\n   mv         Move or rename a file, a directory, or a symlink\n   restore    Restore working tree files\n   rm         Remove files from the working tree and from the index\n\nexamine the history and state (see also: git help revisions)\n   bisect     Use binary search to find the commit that introduced a bug\n   diff       Show changes between commits, commit and working tree, etc\n   grep       Print lines matching a pattern\n   log        Show commit logs\n   show       Show various types of objects\n   status     Show the working tree status\n\ngrow, mark and tweak your common history\n   backfill   Download missing objects in a partial clone\n   branch     List, create, or delete branches\n   commit     Record changes to the repository\n   merge      Join two or more development histories together\n   rebase     Reapply commits on top of another base tip\n   reset      Set `HEAD` or the index to a known state\n   switch     Switch branches\n   tag        Create, list, delete or verify tags\n\ncollaborate (see also: git help workflows)\n   fetch      Download objects and refs from another repository\n   pull       Fetch from and integrate with another repository or a local branch\n   push       Update remote refs along with associated objects\n\n'git help -a' and 'git help -g' list available subcommands and some\nconcept guides. See 'git help <command>' or 'git help <concept>'\nto read about a specific subcommand or concept.\nSee 'git help git' for an overview of the system.\n";
    var NAO_FEITOS = { "filter-branch": 1, "gc": 1, "fsck": 1, "worktree": 1, "submodule": 1, "send-email": 1, "svn": 1, "p4": 1, "gui": 1, "gitk": 1, "instaweb": 1, "daemon": 1, "bundle": 1, "archive": 1, "notes": 1, "replace": 1, "sparse-checkout": 1, "maintenance": 1, "range-diff": 1, "format-patch": 1, "am": 1, "apply": 1, "request-pull": 1, "difftool": 1, "mergetool": 1, "citool": 1, "prune": 1, "repack": 1, "pack-objects": 1, "count-objects": 1, "whatchanged": 1, "rerere": 1, "lfs": 1, "credential": 1, "for-each-ref": 1, "update-ref": 1, "symbolic-ref": 1, "ls-remote": 1, "show-ref": 1, "verify-commit": 1, "verify-tag": 1, "backfill": 1, "hook": 1, "range": 1, "scalar": 1, "maint": 1 };
    var TODOS_NOMES = "add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential credential-cache credential-store daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects gc get-tar-commit-id grep hash-object help hook http-backend http-fetch http-push imap-send index-pack init init-db instaweb interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-octopus merge-one-file merge-ours merge-recursive merge-resolve merge-subtree merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd remote-ftp remote-ftps remote-http remote-https repack replace replay repo request-pull rerere reset restore rev-list rev-parse revert rm send-pack sh-i18n sh-prompt sh-setup shell shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree".split(" ");
    var COMUNS = "add backfill bisect branch clone commit diff fetch grep init log merge mv pull push rebase reset restore rm status switch tag".split(" "); // "show" fica de fora: assim sai igual ao lab (git sw → switch, show)
    function levenshtein(s1, s2, w, s, a, d) { // a mesma conta do git (levenshtein.c)
      var r0 = [], r1 = [], r2 = [], i, j;
      for (j = 0; j <= s2.length; j++) r1[j] = j * a;
      for (i = 0; i < s1.length; i++) {
        r2 = []; r2[0] = (i + 1) * d;
        for (j = 0; j < s2.length; j++) {
          r2[j + 1] = r1[j] + s * (s1[i] !== s2[j] ? 1 : 0);
          if (i > 0 && j > 0 && s1[i - 1] === s2[j] && s1[i] === s2[j - 1] && r2[j + 1] > r0[j - 1] + w) r2[j + 1] = r0[j - 1] + w;
          if (r2[j + 1] > r1[j + 1] + d) r2[j + 1] = r1[j + 1] + d;
          if (r2[j + 1] > r2[j] + a) r2[j + 1] = r2[j] + a;
        }
        r0 = r1; r1 = r2;
      }
      return r1[s2.length];
    }
    function sugestao(nome) {
      var cands = TODOS_NOMES.map(function (n) { return { n: n, len: COMUNS.indexOf(n) >= 0 && n.indexOf(nome) === 0 ? 0 : levenshtein(nome, n, 0, 2, 1, 3) + 1 }; });
      cands.sort(function (x, y) { return x.len - y.len || (x.n < y.n ? -1 : 1); });
      var n = 0; while (n < cands.length && !cands[n].len) n++;
      if (n >= cands.length) return "";
      var pref = cands.slice(0, n).sort(function (x, y) { return x.n < y.n ? 1 : -1; }), melhor = cands[n].len;
      var lst = pref.concat(cands.slice(n).filter(function (c) { return c.len === melhor; }));
      if (!(melhor < 7)) return "";
      return (lst.length === 1 ? "\nThe most similar command is\n" : "\nThe most similar commands are\n") + lst.map(function (x) { return "\t" + x.n + "\n"; }).join("");
    }

    /* ---------- init ---------- */
    CMDS.init = function (args, io, sh) {
      var g = opcoes(args, { "-q": true, "--quiet": "-q", "-b": "valor", "--initial-branch": "-b", "--bare": true });
      if (g.erro) fatal(g.erro);
      var alvo = g.ops[0] ? sh.abs(g.ops[0]) : sh.cwd;
      mkdirP(sh, alvo);
      var gitdir = g.o["--bare"] ? alvo : alvo + "/.git";
      var existia = noDe(sh, gitdir + "/HEAD");
      if (existia) {
        if (!g.o["-q"]) io.out("Reinitialized existing Git repository in " + gitdir + "/\n");
        return 0;
      }
      var ramo = g.o["-b"] || configSemRepo(sh, "init.defaultBranch");
      var dica = !ramo;
      ramo = ramo || "master";
      var T = function (rel, txt) { escreverTxt(sh, gitdir + "/" + rel, txt, 436); };
      T("HEAD", "ref: refs/heads/" + ramo + "\n");
      T("config", "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = " + (g.o["--bare"] ? "true" : "false") + "\n" + (g.o["--bare"] ? "" : "\tlogallrefupdates = true\n"));
      T("description", "Unnamed repository; edit this file 'description' to name the repository.\n");
      mkdirP(sh, gitdir + "/hooks");
      T("info/exclude", "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to use them):\n# *.[oa]\n# *~\n");
      mkdirP(sh, gitdir + "/objects/info"); mkdirP(sh, gitdir + "/objects/pack");
      mkdirP(sh, gitdir + "/refs/heads"); mkdirP(sh, gitdir + "/refs/tags");
      if (dica && !g.o["-q"]) io.err("hint: Using 'master' as the name for the initial branch. This default branch name\nhint: will change to \"main\" in Git 3.0. To configure the initial branch name\nhint: to use in all of your new repositories, which will suppress this warning,\nhint: call:\nhint:\nhint: \tgit config --global init.defaultBranch <name>\nhint:\nhint: Names commonly chosen instead of 'master' are 'main', 'trunk' and\nhint: 'development'. The just-created branch can be renamed via this command:\nhint:\nhint: \tgit branch -m <name>\nhint:\nhint: Disable this message with \"git config set advice.defaultBranchName false\"\n");
      if (!g.o["-q"]) io.out("Repositório vazio Git inicializado em  " + gitdir + "/\n");
      return 0;
    };

    /* ---------- config ---------- */
    CMDS.config = function (args, io, sh) {
      var g = opcoes(args, { "--global": true, "--local": true, "--system": true, "--list": true, "-l": "--list", "--unset": true, "--unset-all": true, "--get": true, "--show-origin": true, "--add": true, "--replace-all": true, "-e": true, "--edit": "-e", "--name-only": true, "--get-all": true, "--bool": true, "--int": true, "--type": "valor", "--file": "valor", "-f": "--file" });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var o = g.o, ops = g.ops, home = sh.valor("HOME") || "/home/ana";
      var sub = null;
      if (ops[0] === "list" || ops[0] === "get" || ops[0] === "set" || ops[0] === "unset") { sub = ops.shift(); }
      if (sub === "list") o["--list"] = true; else if (sub === "get") o["--get"] = true; else if (sub === "unset") o["--unset"] = true;
      var repo = achar(sh), arqLocal = repo ? repo.g + "/config" : null;
      var arqGlobal = home + "/.gitconfig";
      function ents(onde) {
        if (onde === "global") return parseConfig(lerTxt(sh, arqGlobal)).map(function (e) { e.o = "file:" + relOrig(arqGlobal); return e; });
        if (onde === "local") return repo ? parseConfig(lerTxt(sh, arqLocal)).map(function (e) { e.o = "file:.git/config"; return e; }) : [];
        return [];
      }
      function relOrig(p) { return p.indexOf(home + "/") === 0 ? p.replace(home, "/home/ana") : p; }
      var escopo = o["--global"] ? "global" : o["--system"] ? "system" : o["--local"] ? "local" : null;
      if (o["--list"]) {
        if (escopo === "local" && !repo) fatal("--local can only be used inside a git repository");
        var lst = escopo ? ents(escopo) : ents("global").concat(ents("local"));
        if (escopo === "global" && lerTxt(sh, arqGlobal) == null) fatal("unable to read config file '" + arqGlobal + "': Arquivo ou diretório inexistente");
        lst.forEach(function (e) { io.out((o["--show-origin"] ? e.o + "\t" : "") + e.k + (o["--name-only"] ? "" : "=" + e.v) + "\n"); });
        return 0;
      }
      if (!ops.length) { io.err("error: no action specified\n"); return 129; }
      var chave = ops[0];
      if (!/^[A-Za-z0-9-]+(\..*)?\.[A-Za-z][A-Za-z0-9-]*$/.test(chave)) {
        if (chave.indexOf(".") < 0) { io.err("error: key does not contain a section: " + chave + "\n"); return 2; }
        io.err("error: invalid key: " + chave + "\n"); return 1;
      }
      var k = chave.toLowerCase();
      var kn = function (e) { var i = e.k.indexOf("."), j = e.k.lastIndexOf("."); var a1 = e.k.slice(0, i), b1 = e.k.slice(j + 1); var i2 = k.indexOf("."), j2 = k.lastIndexOf("."); return a1 === k.slice(0, i2) && b1 === k.slice(j2 + 1) && e.k.slice(i + 1, j) === chave.slice(i2 + 1, j2); };
      if (o["--unset"] || o["--unset-all"]) {
        var arqU = escopo === "global" ? arqGlobal : arqLocal;
        if (!arqU) fatal("not in a git directory");
        var rU = gravarConfig(lerTxt(sh, arqU), chave, null);
        if (!rU.achou) return 5;
        escreverTxt(sh, arqU, rU.txt, 420); return 0;
      }
      if (ops.length === 1 || o["--get"] || o["--get-all"]) {
        var todas = escopo ? ents(escopo) : ents("global").concat(ents("local"));
        var achadas = todas.filter(kn);
        if (!achadas.length) return 1;
        if (o["--get-all"]) achadas.forEach(function (e) { io.out((o["--show-origin"] ? e.o + "\t" : "") + e.v + "\n"); });
        else { var ul = achadas[achadas.length - 1]; io.out((o["--show-origin"] ? ul.o + "\t" : "") + ul.v + "\n"); }
        return 0;
      }
      if (ops.length > 2) { io.err("error: wrong number of arguments, should be from 1 to 2\n"); return 129; }
      var arq = escopo === "global" ? arqGlobal : arqLocal;
      if (!arq) fatal("not in a git directory");
      var r = gravarConfig(lerTxt(sh, arq), chave, ops[1], {});
      escreverTxt(sh, arq, r.txt, escopo === "global" ? 420 : 436);
      if (repo) repo.limparCache();
      return 0;
    };

    /* ---------- add ---------- */
    CMDS.add = CMDS.stage = function (args, io, sh) {
      var g = opcoes(args, { "-A": true, "--all": "-A", "-u": true, "--update": "-u", "-f": true, "--force": "-f", "-v": true, "--verbose": "-v", "-n": true, "--dry-run": "-n", "-p": true, "--patch": "-p", "-i": true, "--interactive": "-i", "--ignore-removal": true, "-N": true, "--intent-to-add": "-N" });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var o = g.o;
      if (o["-p"] || o["-i"]) {
        var stP = repo.estado(), spP = g.ops.map(function (p) { return pathspec(repo, p); });
        if (!stP.naoPrep.some(function (m) { return !spP.length || spP.some(function (x) { return casaSpec(x, m.para); }); })) { io.err("No changes.\n"); return 0; }
        io.err("(simulador) o modo interativo (git add -p/-i) não existe aqui; adicione os arquivos inteiros.\n"); return 1; }
      if (!g.ops.length && !o["-A"] && !o["-u"]) { io.err("Nada especificado, nada adicionado.\nhint: Maybe you wanted to say 'git add .'?\nhint: Disable this message with \"git config set advice.addEmptyPathspec false\"\n"); return 0; }
      var specs = g.ops.length ? g.ops.map(function (p) { return pathspec(repo, p); }) : [""];
      var st = repo.estado(), idx = {}, W = st.W;
      st.idx.forEach(function (e) { if (!e.stage) idx[e.path] = e; });
      var conflitos = st.conf;
      var ignoradosPedidos = [], casou = {}, saida = "";
      // arquivos da pasta de trabalho
      Object.keys(W).sort(cmpCam).forEach(function (k) {
        var s = null; specs.forEach(function (sp, i) { if (casaSpec(sp, k)) { s = i; casou[i] = 1; } });
        if (s === null) return;
        var rastr = !!idx[k] || !!conflitos[k];
        if (!rastr) {
          if (o["-u"]) return;
          if (repo.ignorado(k, false) && !o["-f"]) {
            if (specs[s] === k) ignoradosPedidos.push(g.ops[s]);
            return;
          }
        }
        var n = W[k], h = repo.hashArquivo(n), md = repo.modoNo(n);
        if (idx[k] && idx[k].hash === h && idx[k].mode === md && !conflitos[k]) return;
        if (!o["-n"]) { repo.escreverObj({ type: "blob", data: repo.conteudoNo(n) }); idx[k] = { mode: md, hash: h, stage: 0, path: k }; }
        if (conflitos[k]) delete conflitos[k];
        if (o["-v"] || o["-n"]) saida += "add '" + k + "'\n";
      });
      // remoções (git add . / -A / -u incluem arquivos apagados)
      Object.keys(idx).forEach(function (k) {
        if (W[k]) return;
        var s = null; specs.forEach(function (sp, i) { if (casaSpec(sp, k)) { s = i; casou[i] = 1; } });
        if (s === null || o["--ignore-removal"]) return;
        if (!o["-n"]) delete idx[k];
        if (o["-v"] || o["-n"]) saida += "remove '" + k + "'\n";
      });
      Object.keys(conflitos).forEach(function (k) {
        if (W[k]) return;
        specs.forEach(function (sp, i) { if (casaSpec(sp, k)) { casou[i] = 1; delete conflitos[k]; } });
      });
      for (var i = 0; i < specs.length; i++) {
        if (!casou[i] && ignoradosPedidos.indexOf(g.ops[i]) < 0) {
          // pasta só com arquivos ignorados?
          if (g.ops[i] !== undefined) {
            var ab = sh.abs(g.ops[i]), nn = noDe(sh, ab);
            if (nn && nn.t === "d") continue;
            io.err("fatal: pathspec '" + g.ops[i] + "' não encontrou nenhum arquivo\n"); return 128;
          }
        }
      }
      io.out(saida);
      if (!o["-n"]) {
        var novos = Object.keys(idx).map(function (k) { return idx[k]; });
        Object.keys(conflitos).forEach(function (k) { conflitos[k].forEach(function (e) { if (e) novos.push(e); }); });
        repo.gravarIndice(novos);
      }
      if (ignoradosPedidos.length) {
        io.err("Os caminhos a seguir são ignorados por um dos seus arquivos .gitignore:\n" + ignoradosPedidos.join("\n") + "\nhint: Use -f if you really want to add them.\nhint: Disable this message with \"git config set advice.addIgnoredFile false\"\n");
        return 1;
      }
      return 0;
    };

    /* ---------- status ---------- */
    CMDS.status = function (args, io, sh) {
      var g = opcoes(args, { "-s": true, "--short": "-s", "-b": true, "--branch": "-b", "--porcelain": "opcional", "--ignored": "opcional", "-u": "opcional", "--untracked-files": "-u", "-v": true, "--long": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var o = g.o, st = repo.estado(), curto = o["-s"] || o["--porcelain"];
      var uModo = o["-u"] === true ? "all" : o["-u"] || "normal";
      var specs = g.ops.map(function (p) { return pathspec(repo, p); });
      function filtra(k) { return !specs.length || specs.some(function (s) { return casaSpec(s, k); }); }
      var nr = uModo === "no" ? [] : repo.agruparNaoRastr(st.naoRastr, st.I0, uModo === "all").filter(filtra);
      var ign = o["--ignored"] ? repo.ignoradosAgrupados(st.ignorados, st.I0).filter(filtra) : [];
      var conf = Object.keys(st.conf).sort(cmpCam).filter(filtra);
      var prep = st.preparado.filter(function (m) { return filtra(m.para) || filtra(m.de); }), nprep = st.naoPrep.filter(function (m) { return filtra(m.para); });
      var rel = function (k) { return repo.relCwd(k.replace(/\/$/, "")) + (/\/$/.test(k) ? "/" : ""); };
      var ramo = repo.branchAtual(), up = ramo ? upstream(repo, ramo) : null;
      if (curto) {
        var out = "";
        if (o["-b"]) {
          out += "## " + (ramo ? (st.head ? ramo : "No commits yet on " + ramo) : "HEAD (no branch)");
          if (up && st.head) { var ab = aFrente(repo, st.head, up.hash); out += "..." + up.nome; if (up.sumiu) out += " [gone]"; else if (ab.a || ab.b) out += " [" + (ab.a ? "ahead " + ab.a : "") + (ab.a && ab.b ? ", " : "") + (ab.b ? "behind " + ab.b : "") + "]"; }
          out += "\n";
        }
        var linhas = {};
        prep.forEach(function (m) { linhas[m.para] = { x: m.tipo, y: " ", m: m }; });
        nprep.forEach(function (m) { var l = linhas[m.para] || (linhas[m.para] = { x: " ", y: " ", m: m }); l.y = m.tipo; });
        var CONF = { "123": "UU", "23": "AA", "13": "UD", "12": "DU", "3": "UA", "2": "AU", "1": "DD" };
        conf.forEach(function (k) { var e = st.conf[k], s = (e[1] ? "1" : "") + (e[2] ? "2" : "") + (e[3] ? "3" : ""); var c = { "123": "UU", "23": "AA", "13": "UD", "12": "DU", "3": "UA", "2": "AU", "1": "DD" }[s]; c = s === "13" ? "DU" : s === "12" ? "UD" : c; linhas[k] = { x: c[0], y: c[1], m: { de: k, para: k } }; });
        Object.keys(linhas).sort(cmpCam).forEach(function (k) { var l = linhas[k]; out += l.x + l.y + " " + (l.m.tipo === "R" && l.x === "R" ? rel(l.m.de) + " -> " : "") + rel(k) + "\n"; });
        nr.forEach(function (k) { out += "?? " + rel(k) + "\n"; });
        ign.forEach(function (k) { out += "!! " + rel(k) + "\n"; });
        io.out(out);
        return 0;
      }
      var s = "";
      var estado = estadoEspecial(repo);
      if (ramo) s += "No ramo " + ramo + "\n";
      else { var det = descricaoDestacada(repo); s += det + "\n"; }
      if (estado.rebase) s += estado.rebase;
      if (estado.bisect) s += estado.bisect;
      if (up && st.head) s += textoUpstream(repo, st.head, up);
      if (!st.head) s += "\nNo commits yet\n";
      if (estado.merge) s += conf.length ? "Você tem caminhos não mesclados.\n  (fixar conflitos e executar \"git commit\")\n  (use \"git merge --abort\" to abort the merge)\n" : "Todos os conflitos foram corrigidos mas você continua mesclando.\n  (use  \"git commit\" para concluir a mesclagem)\n";
      if (estado.cherry) s += estado.cherry;
      if (estado.revert) s += estado.revert;
      if (!st.head) s += "\n";
      else if (estado.merge || estado.cherry || estado.revert) s += "\n";
      var LBL = { A: "new file:   ", M: "modified:   ", D: "deleted:    ", R: "renamed:    " };
      if (prep.length) {
        s += "Mudanças a serem submetidas:\n" + (estado.merge || estado.cherry ? "" : st.head ? "  (use \"git restore --staged <file>...\" to unstage)\n" : "  (utilize \"git rm --cached <arquivo>...\" para não apresentar)\n");
        prep.forEach(function (m) { s += "\t" + LBL[m.tipo] + (m.tipo === "R" ? rel(m.de) + " -> " : "") + rel(m.para) + "\n"; });
        s += "\n";
      }
      if (conf.length) {
        var temDelC = conf.some(function (k) { var e = st.conf[k]; return !e[2] || !e[3]; });
        s += "Caminhos não mesclados:\n" + (estado.merge || estado.cherry ? "" : st.head ? "  (use \"git restore --staged <file>...\" to unstage)\n" : "  (utilize \"git rm --cached <arquivo>...\" para não apresentar)\n") + (temDelC ? "  (use \"git add/rm <file>...\" as appropriate to mark resolution)\n" : "  (usar \"git add <arquivo>...\" para marcar resolução)\n");
        conf.forEach(function (k) {
          var e = st.conf[k], c = (e[1] ? "1" : "") + (e[2] ? "2" : "") + (e[3] ? "3" : "");
          var L0 = { "123": "ambos modificados:", "23": "ambos adicionaram:", "13": "excluídos por nós:", "12": "excluídos por eles:", "3": "adicionado por:", "2": "adicionados por nós:", "1": "ambos excluídos:" }[c], L = L0 + rep(" ", 21 - L0.length);
          s += "\t" + L + rel(k) + "\n";
        });
        s += "\n";
      }
      if (nprep.length) {
        var temDel = nprep.some(function (m) { return m.tipo === "D"; });
        s += "Changes not staged for commit:\n  (utilize \"git " + (temDel ? "add/rm" : "add") + " <arquivo>...\" para atualizar o que será submetido)\n  (use \"git restore <file>...\" to discard changes in working directory)\n";
        nprep.forEach(function (m) { s += "\t" + LBL[m.tipo] + rel(m.para) + "\n"; });
        s += "\n";
      }
      if (nr.length) {
        s += "Arquivos não monitorados:\n  (utilize \"git add <arquivo>...\" para incluir o que será submetido)\n";
        nr.forEach(function (k) { s += "\t" + rel(k) + "\n"; });
        s += "\n";
      }
      if (ign.length) {
        s += "Arquivos ignorados:\n  (utilize \"git add -f <arquivo>...\" para incluir o que será submetido)\n";
        ign.forEach(function (k) { s += "\t" + rel(k) + "\n"; });
        s += "\n";
      }
      if (!prep.length) {
        if (nprep.length || conf.length) s += "nenhuma modificação adicionada à submissão (utilize \"git add\" e/ou \"git commit -a\")\n";
        else if (nr.length) s += "nada adicionado ao envio mas arquivos não registrados estão presentes (use \"git add\" to registrar)\n";
        else if (!st.head) s += "nada para enviar (crie/copie arquivos e use \"git add\" para registrar)\n";
        else if (uModo === "no") s += "nada a submeter (utilize -u para mostrar arquivos não rastreados)\n";
        else s += "nothing to commit, working tree clean\n";
      }
      io.out(s);
      return 0;
    };
    function estadoEspecial(repo) {
      var r = {};
      if (repo.existe("MERGE_HEAD")) r.merge = true;
      if (repo.existe("CHERRY_PICK_HEAD")) { var h = repo.arq("CHERRY_PICK_HEAD").slice(0, 40); r.cherry = "You are currently cherry-picking commit " + repo.abrev(h) + ".\n" + (Object.keys(repo.estado().conf).length ? "  (fix conflicts and run \"git cherry-pick --continue\")\n" : "  (all conflicts fixed: run \"git cherry-pick --continue\")\n") + "  (use \"git cherry-pick --skip\" to skip this patch)\n  (use \"git cherry-pick --abort\" to cancel the cherry-pick operation)\n"; }
      if (repo.existe("REVERT_HEAD")) { var h2 = repo.arq("REVERT_HEAD").slice(0, 40); r.revert = "You are currently reverting commit " + repo.abrev(h2) + ".\n" + (Object.keys(repo.estado().conf).length ? "  (fix conflicts and run \"git revert --continue\")\n" : "  (all conflicts fixed: run \"git revert --continue\")\n") + "  (use \"git revert --skip\" to skip this patch)\n  (use \"git revert --abort\" to cancel the revert operation)\n"; }
      if (repo.existe("BISECT_START")) { var bs = repo.arq("BISECT_START").replace(/\n$/, ""); r.bisect = "You are currently bisecting, started from branch '" + bs + "'.\n  (use \"git bisect reset\" para voltar ao ramo original)\n\n"; }
      var rb = repo.arq("rebase-merge/head-name");
      if (rb != null) {
        var onto = repo.arq("rebase-merge/onto").trim(), ramo = rb.trim().replace(/^refs\/heads\//, "");
        var feitos = (repo.arq("rebase-merge/done") || "").split("\n").filter(Boolean), resto = (repo.arq("rebase-merge/git-rebase-todo") || "").split("\n").filter(Boolean);
        var s = "Last command" + (feitos.length > 1 ? "s" : "") + " done (" + feitos.length + " command" + (feitos.length > 1 ? "s" : "") + " done):\n";
        feitos.slice(-2).forEach(function (l) { s += "   " + l + "\n"; });
        if (resto.length) { s += "Next command" + (resto.length > 1 ? "s" : "") + " to do (" + resto.length + " remaining command" + (resto.length > 1 ? "s" : "") + "):\n"; resto.slice(0, 2).forEach(function (l) { s += "   " + l.replace(/^(\w+) ([0-9a-f]{40})$/, function (m, c, h) { return c + " " + repo.abrev(h) + " # " + assunto(repo.ler(h).msg); }) + "\n"; }); s += "  (use \"git rebase --edit-todo\" to view and edit)\n"; }
        else s += "No commands remaining.\n";
        var conf = Object.keys(repo.estado().conf).length;
        if (!conf && repo.existe("rebase-merge/amend")) s += "You are currently editing a commit while rebasing branch '" + ramo + "' on '" + repo.abrev(onto) + "'.\n  (utilize \"git commit --amend\" para emendar a atual submissão)\n  (use \"git rebase --continue\" assim que você estiver satisfeitos com as mudanças)\n\n";
        else s += "You are currently rebasing branch '" + ramo + "' on '" + repo.abrev(onto) + "'.\n" + (conf ? "  (corrija os conflitos e então rode \"git rebase --continue\")\n  (use \"git rebase --skip\" para ignorar este patch)\n  (use \"git rebase --abort\" para verificar o ramo original)\n" : "  (todos os conflitos foram corrigidos: execute \"git rebase --continue\")\n") + "\n";
        r.rebase = s;
      }
      return r;
    }
    function descricaoDestacada(repo) {
      var rb = repo.arq("rebase-merge/onto");
      if (rb != null) return "interactive rebase in progress; onto " + repo.abrev(rb.trim());
      var h = repo.head(), rl = repo.reflog("HEAD");
      for (var i = 0; i < rl.length; i++) {
        var m = /^checkout: moving from .* to (.*)$/.exec(rl[i].msg);
        if (m) {
          var alvo = m[1], ehRef = ["refs/heads/", "refs/tags/", "refs/remotes/"].some(function (p) { return repo.resolverRef(p + alvo); });
          var nome = ehRef ? alvo : repo.abrev(rl[i].neu);
          return (rl[i].neu === h ? "HEAD detached at " : "HEAD detached from ") + nome;
        }
      }
      return "HEAD detached at " + repo.abrev(h);
    }
    function upstream(repo, ramo) {
      var remoto = repo.config("branch." + ramo + ".remote"), merge = repo.config("branch." + ramo + ".merge");
      if (!remoto || !merge) return null;
      var nome = remoto === "." ? merge.replace(/^refs\/heads\//, "") : remoto + "/" + merge.replace(/^refs\/heads\//, "");
      var h = repo.resolverRef(remoto === "." ? merge : "refs/remotes/" + nome);
      return { nome: nome, hash: h, sumiu: !h };
    }
    function aFrente(repo, a, b) {
      var A = repo.ancestrais([a]), Bb = repo.ancestrais([b]), na = 0, nb = 0;
      Object.keys(A).forEach(function (h) { if (!Bb[h]) na++; }); Object.keys(Bb).forEach(function (h) { if (!A[h]) nb++; });
      return { a: na, b: nb };
    }
    function textoUpstream(repo, head, up) {
      if (up.sumiu) return "Your branch is based on '" + up.nome + "', but the upstream is gone.\n  (use \"git branch --unset-upstream\" to fixup)\n";
      var ab = aFrente(repo, head, up.hash);
      if (!ab.a && !ab.b) return "Your branch is up to date with '" + up.nome + "'.\n\n";
      if (ab.a && !ab.b) return "Seu ramo está à frente de '" + up.nome + "' por " + plural(ab.a, "submissão", "submissões") + ".\n  (use \"git push\" to publish your local commits)\n\n";
      if (!ab.a && ab.b) return "Seu ramo está atrás de '" + up.nome + "' em " + plural(ab.b, "submissão", "submissões") + ", e pode ser avançado.\n  (use \"git pull\" to update your local branch)\n\n";
      return (ab.a + ab.b > 1 ? "O seu branch e '" : "O seu ramo e '") + up.nome + "' divergiram-se,\ne cada um tem " + ab.a + " e " + ab.b + (ab.a + ab.b > 1 ? " submissões" : " submissão") + ", respectivamente.\n  (use \"git pull\" if you want to integrate the remote branch with yours)\n\n";
    }

    /* ---------- commit ---------- */
    function limparMsg(m, modo) {
      var l = m.split("\n").map(function (x) { return x.replace(/\s+$/, ""); });
      if (modo === "strip") l = l.filter(function (x) { return x[0] !== "#"; });
      var r = [], vazio = false;
      l.forEach(function (x) { if (x === "") { vazio = true; return; } if (vazio && r.length) r.push(""); vazio = false; r.push(x); });
      return r.length ? r.join("\n") + "\n" : "";
    }
    CMDS.commit = function (args, io, sh) {
      var g = opcoes(args, { "-m": "valor", "--message": "-m", "-a": true, "--all": "-a", "--amend": true, "--no-edit": true, "-q": true, "--quiet": "-q", "--allow-empty": true, "--allow-empty-message": true, "-v": true, "-F": "valor", "--file": "-F", "-C": "valor", "--reuse-message": "-C", "--author": "valor", "-s": true, "--signoff": "-s", "-n": true, "--no-verify": "-n", "--dry-run": true, "-e": true, "--edit": "-e" });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var o = g.o, head = repo.head(), ramo = repo.branchAtual();
      var emMerge = repo.existe("MERGE_HEAD"), emCP = repo.existe("CHERRY_PICK_HEAD"), emRev = repo.existe("REVERT_HEAD");
      if (o["-a"] && g.ops.length) fatal("paths '" + g.ops.join(" ") + " ...' with -a does not make sense");
      if (emMerge && o["--amend"]) { io.err("fatal: You are in the middle of a merge -- cannot amend.\n"); return 128; }
      var st0 = repo.estado();
      if (Object.keys(st0.conf).length) {
        io.err("error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n");
        io.out(Object.keys(st0.conf).sort(cmpCam).map(function (k) { return "U\t" + k + "\n"; }).join("")); return 128;
      }
      if (o["-a"]) { var r0 = CMDS.add(["-u"], { sh: sh, out: function () {}, err: function () {} }, sh); }
      if (g.ops.length) {
        // commit só destes caminhos: prepara e usa índice temporário
        var specs = g.ops.map(function (p) { return pathspec(repo, p); }), stt = repo.estado(), casouAlgum = false;
        var I = {}; stt.idx.forEach(function (e) { if (!e.stage) I[e.path] = e; });
        var base = repo.arvoreDe(head), novo = {};
        Object.keys(base).forEach(function (k) { novo[k] = { mode: base[k].mode, hash: base[k].hash, stage: 0, path: k }; });
        Object.keys(stt.W).concat(Object.keys(I)).forEach(function (k) {
          if (!specs.some(function (s) { return casaSpec(s, k); })) return;
          if (!I[k] && !base[k]) return;
          casouAlgum = true;
          var n = stt.W[k];
          if (!n) { delete novo[k]; delete I[k]; return; }
          var h = repo.escreverObj({ type: "blob", data: repo.conteudoNo(n) }), e = { mode: repo.modoNo(n), hash: h, stage: 0, path: k };
          novo[k] = e; I[k] = e;
        });
        if (!casouAlgum) { io.err("error: pathspec '" + g.ops[0] + "' did not match any file(s) known to git\n"); return 1; }
        repo.gravarIndice(Object.keys(I).map(function (k) { return I[k]; }));
        var arvore = repo.escreverArvore(Object.keys(novo).map(function (k) { return novo[k]; }));
        return fazerCommit(arvore);
      }
      var idx = repo.lerIndice();
      return fazerCommit(repo.escreverArvore(idx));

      function fazerCommit(arvore) {
        var autor = repo.ident("a"), comitente = repo.ident("c");
        if (!autor || !comitente) {
          io.err("Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email \"you@example.com\"\n  git config --global user.name \"Your Name\"\n\nto set your account's default identity.\nOmit --global to set the identity only in this repository.\n\nfatal: unable to auto-detect email address (got 'ana@notebook.(none)')\n");
          return 128;
        }
        var pais = head ? [head] : [], antigo = null;
        if (o["--amend"]) {
          if (!head) fatal("You have nothing to amend.");
          antigo = repo.ler(head); pais = antigo.parents.slice();
          if (!o["--author"]) { var ia = parseIdent(antigo.author); autor = antigo.author; }
        }
        if (emMerge) pais.push(repo.arq("MERGE_HEAD").slice(0, 40));
        if (o["--author"]) { var ma = /^(.*) <(.*)>$/.exec(o["--author"]); if (!ma) fatal("--author '" + o["--author"] + "' is not 'Name <email>' and matches no existing author"); autor = ma[1] + " <" + ma[2] + "> " + autor.split("> ")[1]; }
        var msg = null;
        if (o["-m"]) msg = lista(o["-m"]).map(function (x) { return limparMsg(x, "whitespace").replace(/\n$/, ""); }).filter(function (x) { return x !== ""; }).join("\n\n");
        else if (o["-F"]) { var tf = lerTxt(sh, sh.abs(o["-F"])); if (tf == null) fatal("could not read log file '" + o["-F"] + "': Arquivo ou diretório inexistente"); msg = tf; }
        else if (o["-C"]) { var hc = repo.commitDe(o["-C"]); if (!hc) fatal("could not lookup commit '" + o["-C"] + "'"); msg = repo.ler(hc).msg; }
        else if (o["--amend"] && (o["--no-edit"] || true)) { if (!o["--no-edit"] && !o["-m"]) { /* sem editor no simulador: mantém a mensagem */ } msg = antigo.msg; }
        else if (emMerge || emCP || emRev) { msg = repo.arq("MERGE_MSG") || ""; if (!o["--no-edit"]) msg = msg.split("\n").filter(function (l) { return l[0] !== "#"; }).join("\n"); }
        else if (o["--no-edit"]) msg = "";
        var semMsg = msg === null; if (semMsg) msg = "x"; // sem editor: só reclama depois de conferir se há o que commitar
        if (o["-s"]) msg = limparMsg(msg, "whitespace").replace(/\n$/, "") + "\n\nSigned-off-by: " + comitente.split(">")[0] + ">";
        msg = limparMsg(msg, o["-m"] || o["--no-edit"] ? "whitespace" : "strip");
        if (!msg && !o["--allow-empty-message"]) { io.err("Aborting commit due to empty commit message.\n"); return 1; }
        var arvorePai = head ? repo.ler(o["--amend"] ? (pais[0] || null) || head : head) : null;
        var treePai = o["--amend"] ? (antigo.parents[0] ? repo.ler(antigo.parents[0]).tree : null) : (head ? repo.ler(head).tree : null);
        if (!o["--amend"] && !emMerge && !o["--allow-empty"] && treePai === arvore || (!head && !o["--allow-empty"] && !repo.lerIndice().length)) {
          if (!o["-q"] || true) {
            var stt2 = repo.estado();
            var s = "";
            if (ramo) s += "No ramo " + ramo + "\n"; else s += descricaoDestacada(repo) + "\n";
            var up = ramo ? upstream(repo, ramo) : null;
            if (up && head) s += textoUpstream(repo, head, up).replace(/\n\n$/, "\n");
            if (!head) s += "\nNo commits yet\n\n";
            var LBL = { M: "modified:   ", D: "deleted:    " };
            if (stt2.naoPrep.length) {
              var temDel = stt2.naoPrep.some(function (m) { return m.tipo === "D"; });
              s += "Changes not staged for commit:\n  (utilize \"git " + (temDel ? "add/rm" : "add") + " <arquivo>...\" para atualizar o que será submetido)\n  (use \"git restore <file>...\" to discard changes in working directory)\n";
              stt2.naoPrep.forEach(function (m) { s += "\t" + LBL[m.tipo] + repo.relCwd(m.para) + "\n"; });
              s += "\n";
            }
            var nr = repo.agruparNaoRastr(stt2.naoRastr, stt2.I0);
            if (nr.length) { s += "Arquivos não monitorados:\n  (utilize \"git add <arquivo>...\" para incluir o que será submetido)\n"; nr.forEach(function (k) { s += "\t" + repo.relCwd(k.replace(/\/$/, "")) + (/\/$/.test(k) ? "/" : "") + "\n"; }); s += "\n"; }
            if (stt2.naoPrep.length) s += "nenhuma modificação adicionada à submissão (utilize \"git add\" e/ou \"git commit -a\")\n";
            else if (nr.length) s += "nada adicionado ao envio mas arquivos não registrados estão presentes (use \"git add\" to registrar)\n";
            else if (!head) s += "nada para enviar (crie/copie arquivos e use \"git add\" para registrar)\n";
            else s += "nothing to commit, working tree clean\n";
            io.out(s);
          }
          return 1;
        }
        if (semMsg) { io.err("(simulador) aqui não há editor de texto para escrever a mensagem do commit: use git commit -m \"mensagem\".\n"); return 1; }
        var c = { type: "commit", tree: arvore, parents: pais, author: autor, committer: comitente, msg: msg };
        var h = repo.escreverObj(c);
        var primeira = msg.split("\n")[0];
        var tipoLog = o["--amend"] ? "commit (amend)" : emMerge ? "commit (merge)" : emCP ? "commit (cherry-pick)" : !head ? "commit (initial)" : "commit";
        var refAlvo = repo.headRef() || "HEAD";
        if (refAlvo === "HEAD") { repo.gravar("HEAD", h + "\n"); repo.logar("HEAD", head || ZERO, h, tipoLog + ": " + primeira); }
        else repo.gravarRef(refAlvo, h, tipoLog + ": " + primeira, head || ZERO);
        ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE"].forEach(function (f) { repo.apagarArq(f); });
        if (o["-q"]) return 0;
        var mud = compararMapas(treePai ? repo.arvorePlana(treePai) : {}, repo.arvorePlana(arvore), function (a, b) { return repo.similaridade(a, b); });
        var cab = "[" + (ramo || "HEAD destacada") + (pais.length === 0 ? " (root-commit)" : "") + " " + repo.abrev(h) + "] " + primeira + "\n";
        if (o["--amend"]) cab += " Date: " + dataPadrao(parseIdent(autor).ts, parseIdent(autor).tz) + "\n";
        io.out(cab + (pais.length > 1 ? "" : (mud.length ? repo.shortstat(mud) : " 0 files changed\n") + repo.resumoCriacao(mud)));
        return 0;
      }
    };

    // "git commit" sem -m: abre o editor (GIT_EDITOR / core.editor). No simulador só funcionam editores
    // de linha de comando (sed, true, :) — os de tela (nano, vim) dão a mensagem "(simulador)".
    var commitDireto = CMDS.commit;
    CMDS.commit = function (args, io, sh) {
      var temMsg = args.some(function (a) { return /^(-m|--message|-F|--file|-C|--reuse-message|--no-edit)(=|$)|^-[a-zA-Z]*[mFC]/.test(a); });
      var repo0 = achar(sh);
      if (temMsg || !repo0 || args.indexOf("-h") >= 0 || args.indexOf("--dry-run") >= 0) return commitDireto(args, io, sh);
      var ed = sh.valor("GIT_EDITOR") || repo0.config("core.editor") || sh.valor("VISUAL") || sh.valor("EDITOR");
      if (!ed || /^(nano|vim?|code|gedit|emacs)\b/.test(ed)) return commitDireto(args, io, sh); // dá a mensagem "(simulador)" (ou mantém a do --amend)
      return (function* () {
        var emMerge = repo0.existe("MERGE_HEAD"), amend = args.indexOf("--amend") >= 0;
        var base = emMerge ? (repo0.arq("MERGE_MSG") || "") : amend && repo0.head() ? repo0.ler(repo0.head()).msg : "";
        repo0.gravar("COMMIT_EDITMSG", base + (emMerge ? "# Please enter a commit message to explain why this merge is necessary,\n# especially if it merges an updated upstream into a topic branch.\n#\n" : "\n") + "# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n#\n");
        yield* rodarEditor(repo0, sh, ed, repo0.g + "/COMMIT_EDITMSG");
        return commitDireto(args.concat(["-F", repo0.g + "/COMMIT_EDITMSG"]), io, sh);
      })();
    };

    /* ---------- log / show ---------- */
    function formatarCommit(repo, h, opt) {
      var c = repo.ler(h), s = "", au = parseIdent(c.author), co = parseIdent(c.committer);
      var deco = opt.decorate ? decoracao(repo, h, opt.decoCompleta) : "";
      if (opt.oneline) {
        s += (opt.abbrev === false ? h : repo.abrev(h)) + (deco ? " (" + deco + ")" : "") + " " + assunto(c.msg) + "\n";
      } else if (opt.format != null) {
        if (opt.format === "") return "";
        s += formatoLivre(repo, h, c, opt.format, opt) + (opt.tformat ? "\n" : "");
      } else {
        s += "commit " + h + (deco ? " (" + deco + ")" : "") + "\n";
        if (c.parents.length > 1) s += "Merge: " + c.parents.map(function (p) { return repo.abrev(p); }).join(" ") + "\n";
        s += "Author: " + au.nome + " <" + au.email + ">\n";
        if (opt.fuller) s += "AuthorDate: " + dataPadrao(au.ts, au.tz) + "\nCommit:     " + co.nome + " <" + co.email + ">\nCommitDate: " + dataPadrao(co.ts, co.tz) + "\n";
        else if (opt.pretty === "full") s += "Commit: " + co.nome + " <" + co.email + ">\n";
        else if (opt.pretty !== "short") s += "Date:   " + (opt.dataRel ? dataRelativa(au.ts, Math.floor(repo.sh.k.clock / 1000)) : fmtData(au.ts, au.tz, opt.dataFmt, Math.floor(repo.sh.k.clock / 1000))) + "\n";
        s += "\n" + (opt.pretty === "short" ? assunto(c.msg) : c.msg.replace(/\n$/, "")).split("\n").map(function (l) { return "    " + expandirTabs(l); }).join("\n") + "\n";
      }
      return s;
    }
    // datas do --since/--until (o "approxidate" do git, no essencial). Devolve segundos ou null
    function dataAprox(t, agora) {
      t = t.trim().toLowerCase(); var m, dia = 86400;
      var base = new Date((agora - 3 * 3600) * 1000), hh = base.getUTCHours(), mi = base.getUTCMinutes(), ss = base.getUTCSeconds();
      if (t === "now" || t === "today") return t === "now" ? agora : agora - (hh * 3600 + mi * 60 + ss) + (hh * 3600 + mi * 60 + ss);
      if (t === "yesterday") return agora - dia;
      if ((m = /^(\d+)\.?\s*(second|minute|hour|day|week|month|year)s?(\.|\s)*(ago)?$/.exec(t))) { var n = +m[1], u = { second: 1, minute: 60, hour: 3600, day: dia, week: 7 * dia, month: 30 * dia, year: 365 * dia }[m[2]]; return agora - n * u; }
      if ((m = /^(\d{4})-(\d\d)-(\d\d)(?:[ t](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(t))) {
        var H = m[4] !== undefined ? +m[4] : hh, M = m[5] !== undefined ? +m[5] : mi, S = m[6] !== undefined ? +m[6] : (m[4] !== undefined ? 0 : ss);
        return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], H, M, S) / 1000) + 3 * 3600;
      }
      if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return Math.floor(Date.UTC(+m[3], +m[1] - 1, +m[2], hh, mi, ss) / 1000) + 3 * 3600;
      return null;
    }
    function expandirTabs(l) { if (l.indexOf("\t") < 0) return l; var r = ""; for (var i = 0; i < l.length; i++) { if (l[i] === "\t") { do r += " "; while (r.length % 8); } else r += l[i]; } return r; }
    function assunto(msg) { return msg.split(/\n[ \t]*\n/)[0].replace(/\n$/, "").split("\n").map(function (x) { return x.trim(); }).join(" "); }
    var DIAS_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"], DIAS_PT_L = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
    var MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"], MESES_PT_L = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
    // --date=MODO (o strftime do format: usa o locale pt_BR, como no lab)
    function fmtData(ts, tz, modo, agora) {
      var p = partesData(ts, tz);
      switch (modo || "default") {
        case "short": return dataCurta(ts, tz);
        case "iso": case "iso8601": return dataIso(ts, tz);
        case "iso-strict": case "iso8601-strict": return p.Y + "-" + d2(p.M + 1) + "-" + d2(p.D) + "T" + d2(p.h) + ":" + d2(p.m) + ":" + d2(p.s) + tz.slice(0, 3) + ":" + tz.slice(3);
        case "relative": return dataRelativa(ts, agora);
        case "rfc": case "rfc2822": return DIAS_EN[p.w] + ", " + p.D + " " + MESES_EN[p.M] + " " + p.Y + " " + d2(p.h) + ":" + d2(p.m) + ":" + d2(p.s) + " " + tz;
        case "raw": return ts + " " + tz;
        case "unix": return String(ts);
        case "local": return dataPadrao(ts, tz).replace(/ [+-]\d{4}$/, "");
        case "human": if (Math.abs(agora - ts) < 12 * 3600) return dataRelativa(ts, agora); var pa = partesData(agora, tz); return pa.Y === p.Y ? DIAS_EN[p.w] + " " + MESES_EN[p.M] + " " + p.D + " " + d2(p.h) + ":" + d2(p.m) : DIAS_EN[p.w] + " " + MESES_EN[p.M] + " " + p.D + " " + p.Y;
        default:
          if (/^format(-local)?:/.test(modo)) return modo.replace(/^format(-local)?:/, "").replace(/%([a-zA-Z%])/g, function (m, k) {
            switch (k) {
              case "d": return d2(p.D); case "e": return (p.D < 10 ? " " : "") + p.D; case "m": return d2(p.M + 1); case "Y": return String(p.Y); case "y": return d2(p.Y % 100);
              case "H": return d2(p.h); case "M": return d2(p.m); case "S": return d2(p.s); case "I": return d2(p.h % 12 || 12); case "p": return p.h < 12 ? "" : "";
              case "a": return DIAS_PT[p.w]; case "A": return DIAS_PT_L[p.w]; case "b": case "h": return MESES_PT[p.M]; case "B": return MESES_PT_L[p.M];
              case "z": return tz; case "Z": return ""; case "j": var ini = Date.UTC(p.Y, 0, 1), atual = Date.UTC(p.Y, p.M, p.D); return ("00" + (Math.round((atual - ini) / 864e5) + 1)).slice(-3);
              case "F": return p.Y + "-" + d2(p.M + 1) + "-" + d2(p.D); case "T": return d2(p.h) + ":" + d2(p.m) + ":" + d2(p.s); case "R": return d2(p.h) + ":" + d2(p.m);
              case "s": return String(ts); case "%": return "%";
              default: return m;
            }
          });
          return dataPadrao(ts, tz);
      }
    }
    function formatoLivre(repo, h, c, f, opt) {
      opt = opt || {};
      var au = parseIdent(c.author), co = parseIdent(c.committer), agora = Math.floor(repo.sh.k.clock / 1000), pendente = null;
      var re = /%(<\((\d+)(?:,(trunc|ltrunc|mtrunc))?\)|>\((\d+)(?:,(trunc|ltrunc|mtrunc))?\)|><\((\d+)\)|H|h|T|t|P|p|an|ae|al|aN|aE|ad|ar|as|at|ai|aI|cn|ce|cd|cr|cs|ct|ci|cI|s|f|b|B|n|d|D|N|%|x[0-9a-fA-F]{2}|C\([^)]*\)|Creset|Cred|Cgreen|Cblue|C)/g;
      return f.replace(re, function (m, k, nE, tE, nD, tD, nC) {
        if (nE !== undefined) { pendente = { n: +nE, lado: "e", t: tE }; return ""; }
        if (nD !== undefined) { pendente = { n: +nD, lado: "d", t: tD }; return ""; }
        if (nC !== undefined) { pendente = { n: +nC, lado: "c" }; return ""; }
        var v = valor(k);
        if (pendente && !/^C/.test(k)) {
          var pd = pendente; pendente = null;
          if (v.length > pd.n && pd.t) v = pd.t === "ltrunc" ? ".." + v.slice(v.length - pd.n + 2) : pd.t === "mtrunc" ? v.slice(0, Math.ceil((pd.n - 2) / 2)) + ".." + v.slice(v.length - Math.floor((pd.n - 2) / 2)) : v.slice(0, pd.n - 2) + "..";
          var falta = pd.n - v.length;
          if (falta > 0) v = pd.lado === "e" ? v + rep(" ", falta) : pd.lado === "d" ? rep(" ", falta) + v : rep(" ", Math.floor(falta / 2)) + v + rep(" ", Math.ceil(falta / 2));
        }
        return v;
      });
      function valor(k) {
        switch (k) {
          case "H": return h; case "h": return repo.abrev(h); case "T": return c.tree; case "t": return repo.abrev(c.tree);
          case "P": return c.parents.join(" "); case "p": return c.parents.map(function (p) { return repo.abrev(p); }).join(" ");
          case "an": case "aN": return au.nome; case "ae": case "aE": return au.email; case "al": return au.email.split("@")[0];
          case "ad": return fmtData(au.ts, au.tz, opt.dataFmt, agora); case "ar": return dataRelativa(au.ts, agora);
          case "as": return dataCurta(au.ts, au.tz); case "at": return String(au.ts); case "ai": return dataIso(au.ts, au.tz); case "aI": return fmtData(au.ts, au.tz, "iso-strict");
          case "cn": return co.nome; case "ce": return co.email; case "cd": return fmtData(co.ts, co.tz, opt.dataFmt, agora); case "cr": return dataRelativa(co.ts, agora);
          case "cs": return dataCurta(co.ts, co.tz); case "ct": return String(co.ts); case "ci": return dataIso(co.ts, co.tz); case "cI": return fmtData(co.ts, co.tz, "iso-strict");
          case "s": return assunto(c.msg); case "f": return assunto(c.msg).replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
          case "b": var i0 = c.msg.search(/\n[ \t]*\n/); return i0 < 0 ? "" : c.msg.slice(i0).replace(/^\n[ \t]*\n/, ""); case "B": return c.msg;
          case "n": return "\n"; case "%": return "%"; case "N": return "";
          case "d": var d = decoracao(repo, h); return d ? " (" + d + ")" : ""; case "D": return decoracao(repo, h);
          default: if (/^x/.test(k)) return String.fromCharCode(parseInt(k.slice(1), 16)); return "";
        }
      }
    }
    function decoracao(repo, h, completo) {
      var partes = [], hr = repo.headRef(), headH = repo.head();
      var ramos = repo.listarRefs("refs/heads/"), remotos = repo.listarRefs("refs/remotes/"), tags = repo.listarRefs("refs/tags/");
      if (headH === h && !hr) partes.push("HEAD");
      ramos.forEach(function (r) { if (r.hash === h) { var n = r.nome.slice(11); if (hr === r.nome) partes.unshift("HEAD -> " + n); else partes.push(n); } });
      var remotosP = [];
      remotos.forEach(function (r) { if (/\/HEAD$/.test(r.nome)) return; if (r.hash === h) remotosP.push(r.nome.slice(13)); });
      remotos.forEach(function (r) { if (/\/HEAD$/.test(r.nome) && r.hash === h) remotosP.push(r.nome.slice(13)); });
      var tg = []; tags.forEach(function (t) { if (repo.descascar(t.hash) === h) tg.push("tag: " + t.nome.slice(10)); });
      tg.reverse();
      // ordem do git: HEAD -> ramo, tags, ramos locais, remotos (em ordem alfabética das refs, tags por último antes? segue o lab)
      var cab = partes.filter(function (p) { return /^HEAD/.test(p); }), locais = partes.filter(function (p) { return !/^HEAD/.test(p); });
      var res = cab.concat(tg, remotosP, locais);
      if (completo) res = res.map(function (x) { return x.replace(/^HEAD -> /, "HEAD -> refs/heads/").replace(/^tag: /, "tag: refs/tags/").replace(/^(?!HEAD|tag: |refs\/)(.*)$/, function (m0) { return (locais.indexOf(m0) >= 0 ? "refs/heads/" : "refs/remotes/") + m0; }); });
      return res.join(", ");
    }
    // log.decorate=auto: decora quando a saída é um terminal (no .try), não quando vai para pipe/arquivo
    function decorarAuto(repo, io) { var v = repo.config("log.decorate"); if (v === "false" || v === "no") return false; if (v === "true" || v === "short" || v === "full") return true; return !!(io.tty && io.tty()); }
    function parseLogArgs(repo, args, padraoShow) {
      var o = { n: -1, oneline: false, graph: false, all: false, patch: false, stat: false, revs: [], paths: [], decorate: null, reverse: false, nameOnly: false, nameStatus: false, firstParent: false, grep: [], author: [], format: null };
      var fimRevs = false;
      for (var i = 0; i < args.length; i++) {
        var a = args[i], m;
        if (fimRevs) { o.paths.push(a); continue; }
        if (a === "--") { fimRevs = true; continue; }
        if (a === "--oneline") { o.oneline = true; o.format = null; }
        else if (a === "--graph") o.graph = true;
        else if (a === "--all") o.all = true;
        else if (a === "-p" || a === "-u" || a === "--patch") o.patch = true;
        else if (a === "--stat") o.stat = true;
        else if (a === "--shortstat") o.shortstat = true;
        else if (a === "--name-only") o.nameOnly = true;
        else if (a === "--name-status") o.nameStatus = true;
        else if (a === "--decorate" || a === "--decorate=short") o.decorate = true;
        else if (a === "--decorate=full") { o.decorate = true; o.decoCompleta = true; }
        else if (a === "--decorate=no") o.decorate = false;
        else if (a === "--no-decorate") o.decorate = false;
        else if (a === "--reverse") o.reverse = true;
        else if (a === "--first-parent") o.firstParent = true;
        else if (a === "--abbrev-commit" || a === "--no-abbrev-commit") {}
        else if (a === "--merges") o.merges = true;
        else if (a === "--no-merges") o.noMerges = true;
        else if (a === "-s" || a === "--no-patch") o.noPatch = true;
        else if (a === "--fuller" || a === "--pretty=fuller" || a === "--format=fuller") o.fuller = true;
        else if (a === "--pretty=oneline" || a === "--format=oneline") { o.oneline = true; o.abbrev = false; }
        else if ((m = /^--(?:pretty|format)=(short|full|medium)$/.exec(a))) o.pretty = m[1];
        else if (a === "--pretty") {}
        else if (a === "--relative-date" || a === "--date=relative") o.dataRel = true;
        else if ((m = /^--(?:pretty|format)=(?:format:|tformat:)?(.*)$/.exec(a))) { o.format = m[1]; o.tformat = !/^--pretty=format:/.test(a); o.oneline = false; }
        else if (a === "-n" || a === "--max-count") o.n = +args[++i];
        else if ((m = /^(?:-n|--max-count=)(\d+)$/.exec(a)) || (m = /^-(\d+)$/.exec(a))) o.n = +m[1];
        else if ((m = /^--grep=(.*)$/.exec(a))) o.grep.push(m[1]);
        else if (a === "--grep") o.grep.push(args[++i]);
        else if ((m = /^--author=(.*)$/.exec(a))) o.author.push(m[1]);
        else if ((m = /^-S(.+)$/.exec(a))) o.pickaxe = m[1];
        else if (a === "-S") o.pickaxe = args[++i];
        else if ((m = /^-G(.+)$/.exec(a))) o.pickaxeRe = m[1];
        else if (a === "-G") o.pickaxeRe = args[++i];
        else if (a === "-i" || a === "--regexp-ignore-case") o.ic = true;
        else if (a === "-E" || a === "--extended-regexp" || a === "-F" || a === "--fixed-strings") { if (a[1] === "F" || a === "--fixed-strings") o.fixo = true; }
        else if (a === "--all-match" || a === "--invert-grep") o[a === "--all-match" ? "allMatch" : "invertGrep"] = true;
        else if (a === "-g" || a === "--walk-reflogs") o.reflog = true;
        else if ((m = /^--(since|after|until|before)=(.*)$/.exec(a))) o[m[1] === "since" || m[1] === "after" ? "since" : "until"] = m[2];
        else if (/^--(since|after|until|before)$/.test(a)) o[/since|after/.test(a) ? "since" : "until"] = args[++i];
        else if ((m = /^--author$/.exec(a))) o.author.push(args[++i]);
        else if ((m = /^--date=(.*)$/.exec(a))) o.dataFmt = m[1];
        else if (/^-[MC]\d*%?$|^--find-renames|^--find-copies|^--no-renames$/.test(a)) {}
        else if (a === "--follow" || a === "--color=never" || a === "--no-color" || a === "--date-order" || a === "--topo-order") { if (a === "--topo-order") o.topo = true; }
        else if (a[0] === "-") return { erro: a };
        else o.revs.push(a);
      }
      return o;
    }
    // separa revisões e caminhos (sem "--"): o que não é revisão e existe como arquivo vira caminho
    function separarRevs(repo, o, io) {
      var revs = [];
      for (var i = 0; i < o.revs.length; i++) {
        var r = o.revs[i], m;
        if ((m = /^(.*?)\.\.(\.?)(.*)$/.exec(r))) { revs.push({ excl: m[1] || "HEAD", incl: m[3] || "HEAD", tres: !!m[2] }); continue; }
        if (r[0] === "^") { revs.push({ excl: r.slice(1) }); continue; }
        var h = repo.rev(r);
        if (h && !h.ambiguo) { revs.push({ incl: r }); continue; }
        if (repo.raiz && noDe(repo.sh, repo.sh.abs(r))) { o.paths = o.paths.concat(o.revs.slice(i)); break; }
        if (h && h.ambiguo) fatal("ambiguous argument '" + r + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'");
        fatal("ambiguous argument '" + r + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'");
      }
      return revs;
    }
    function mudancasCommit(repo, h, comPai) {
      var c = repo.ler(h), pai = comPai !== undefined ? comPai : c.parents[0];
      return compararMapas(pai ? repo.arvoreDe(pai) : {}, repo.arvorePlana(c.tree), function (a, b) { return repo.similaridade(a, b); });
    }
    function corpoDiffCommit(repo, h, o, mud) {
      var s = "";
      if (o.nameOnly) mud.forEach(function (m) { s += m.para + "\n"; });
      else if (o.nameStatus) mud.forEach(function (m) { s += (m.tipo === "R" ? "R" + ("00" + m.sim).slice(-3) + "\t" + m.de + "\t" : m.tipo + "\t") + m.para + "\n"; });
      if (o.stat) s += repo.diffstat(mud);
      else if (o.shortstat) s += repo.shortstat(mud);
      if (o.patch) { if (o.stat && s) s += "\n"; s += repo.patch(mud); }
      return s;
    }
    CMDS.log = function (args, io, sh) {
      var repo = precisaRepo(io);
      var o = parseLogArgs(repo, args);
      if (o.erro) fatal("unrecognized argument: " + o.erro);
      var revs = separarRevs(repo, o, io), incl = [], excl = [];
      revs.forEach(function (r) {
        if (r.tres) { var a1 = repo.commitDe(r.excl), b1 = repo.commitDe(r.incl); incl.push(a1, b1); var mb = repo.mergeBase(a1, b1); if (mb) excl.push(mb); return; }
        if (r.incl) { var h = repo.commitDe(r.incl); if (!h) { var ob = repo.rev(r.incl); if (ob && !ob.ambiguo && repo.ler(ob) && repo.ler(ob).type !== "commit") { r.soArvore = true; return; } fatal("bad revision '" + r.incl + "'"); } incl.push(h); }
        if (r.excl) { var e = repo.commitDe(r.excl); if (!e) fatal("bad revision '" + r.excl + "'"); excl.push(e); }
      });
      if (o.all) { repo.listarRefs("refs/").forEach(function (r) { var hh = repo.descascar(r.hash); if (repo.ler(hh) && repo.ler(hh).type === "commit") incl.push(hh); }); if (repo.head()) incl.push(repo.head()); }
      if (revs.length && revs.every(function (r) { return r.soArvore; })) return 0; // git log ÁRVORE: não mostra nada
      if (!revs.some(function (r) { return r.incl; }) && !o.all) {
        var hd = repo.head();
        if (!hd) { var rb = repo.branchAtual(); fatal("your current branch '" + rb + "' does not have any commits yet"); }
        incl.push(hd);
      }
      var specs = o.paths.map(function (p) { return pathspec(repo, p); });
      var lista = repo.revList(incl, excl, { firstParent: o.firstParent, topo: o.graph || o.topo });
      var agoraS = Math.floor(sh.k.clock / 1000), desde = o.since ? dataAprox(o.since, agoraS) : null, ate = o.until ? dataAprox(o.until, agoraS) : null;
      if ((o.since && desde === null) || (o.until && ate === null)) { /* data que não entendemos: o git ignora em silêncio */ }
      var flags = o.ic ? "i" : "";
      function reTxt(p) { return new RegExp(o.fixo ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : p, flags + "m"); }
      if (o.reflog) {
        var rl = repo.reflog("HEAD"), outR = "";
        if (o.n >= 0) rl = rl.slice(0, o.n);
        rl.forEach(function (e, i) {
          var cc = repo.ler(e.neu);
          if (o.oneline) outR += repo.abrev(e.neu) + " HEAD@{" + i + "}: " + e.msg + "\n";
          else { var idr = parseIdent(e.id + ""); outR += (i ? "\n" : "") + "commit " + e.neu + "\nReflog: HEAD@{" + i + "} (" + e.id.replace(/ \d+ [+-]\d{4}$/, "") + ")\nReflog message: " + e.msg + "\n" + formatarCommit(repo, e.neu, {}).replace(/^commit .*\n/, "").replace(/^Merge: .*\n/, ""); }
        });
        io.out(outR); return 0;
      }
      lista = lista.filter(function (h) {
        var c = repo.ler(h), cts = parseIdent(c.committer).ts;
        if (desde !== null && cts < desde) return false;
        if (ate !== null && cts > ate) return false;
        if (o.merges && c.parents.length < 2) return false;
        if (o.noMerges && c.parents.length > 1) return false;
        if (o.grep.length) { var casaG = o.allMatch ? o.grep.every(function (g) { return reTxt(g).test(c.msg); }) : o.grep.some(function (g) { return reTxt(g).test(c.msg); }); if (o.invertGrep) casaG = !casaG; if (!casaG) return false; }
        if (o.author.length && !o.author.some(function (g) { return reTxt(g).test(c.author.replace(/ \d+ [+-]\d{4}$/, "")); })) return false;
        if (specs.length) {
          if (c.parents.length > 1) return false;
          var mud = mudancasCommit(repo, h);
          if (!mud.some(function (m) { return specs.some(function (s) { return casaSpec(s, m.para) || casaSpec(s, m.de); }); })) return false;
        }
        if (o.pickaxeRe) { var muG = mudancasCommit(repo, h), achouG = false, reG = new RegExp(o.pickaxeRe, flags);
          muG.forEach(function (m) { var ta = m.a ? repo.textoBlob(m.a.hash) : "", tb = m.b ? repo.textoBlob(m.b.hash) : ""; diffUnificado(ta, tb, 0).txt.split("\n").forEach(function (l) { if (/^[-+]/.test(l) && reG.test(l.slice(1))) achouG = true; }); });
          if (!achouG) return false; }
        if (o.pickaxe) { var mu = mudancasCommit(repo, h), achou = false; mu.forEach(function (m) { var ta = m.a ? repo.textoBlob(m.a.hash) : "", tb = m.b ? repo.textoBlob(m.b.hash) : ""; if (ta.split(o.pickaxe).length !== tb.split(o.pickaxe).length) achou = true; }); if (!achou) return false; }
        return true;
      });
      var listaToda = lista.slice();
      if (o.n >= 0) lista = lista.slice(0, o.n);
      if (o.reverse) lista.reverse();
      var opt = { oneline: o.oneline, decorate: o.decorate === true || (o.decorate === null && decorarAuto(repo, io)), format: o.format, tformat: o.tformat, abbrev: o.abbrev, fuller: o.fuller, dataRel: o.dataRel, dataFmt: o.dataFmt, pretty: o.pretty, decoCompleta: o.decoCompleta };
      var temCorpo = o.patch || o.stat || o.shortstat || o.nameOnly || o.nameStatus;
      if (o.graph) { io.out(desenharGrafo(repo, lista, listaToda, opt, o, specs)); return 0; }
      var out = "";
      lista.forEach(function (h, i) {
        var c = repo.ler(h), cab = formatarCommit(repo, h, opt);
        if (i > 0 && !o.oneline && o.format == null) out += "\n";
        out += cab;
        if (temCorpo && c.parents.length < 2) {
          var mud = mudancasCommit(repo, h);
          if (specs.length) mud = mud.filter(function (m) { return specs.some(function (s) { return casaSpec(s, m.para); }); });
          var corpo = corpoDiffCommit(repo, h, o, mud);
          if (corpo) out += (o.oneline ? "" : o.format != null ? "\n" : (o.stat && o.patch ? "---\n" : "\n")) + corpo;
        }
      });
      io.out(out);
      return 0;
    };
    // desenho do --graph: porte do graph.c do Git (colunas, mapping, estados PADDING/COMMIT/POST_MERGE/COLLAPSING)
    function Grafo(paisDe) {
      this.paisDe = paisDe; this.columns = []; this.newColumns = []; this.mapping = []; this.oldMapping = []; this.mappingSize = 0;
      this.state = "PADDING"; this.prevState = "PADDING"; this.commitIndex = 0; this.prevCommitIndex = 0; this.numParents = 0;
      this.width = 0; this.mergeLayout = 0; this.edgesAdded = 0; this.prevEdgesAdded = 0; this.commit = null; this.parents = [];
    }
    var GP = Grafo.prototype;
    GP.mudarEstado = function (s) { this.prevState = this.state; this.state = s; };
    GP.update = function (h) {
      this.commit = h; this.parents = this.paisDe(h); this.numParents = this.parents.length;
      this.prevCommitIndex = this.commitIndex;
      this.updateColumns();
      if (this.state !== "PADDING") this.state = "SKIP"; else this.state = "COMMIT";
    };
    GP.updateColumns = function () {
      this.columns = this.newColumns; this.newColumns = [];
      var maxNew = this.columns.length + this.numParents, i, self = this;
      this.mappingSize = 2 * maxNew; this.mapping = []; for (i = 0; i < this.mappingSize; i++) this.mapping[i] = -1;
      this.width = 0; this.prevEdgesAdded = this.edgesAdded; this.edgesAdded = 0;
      var visto = false;
      for (i = 0; i <= this.columns.length; i++) {
        var cc;
        if (i === this.columns.length) { if (visto) break; cc = this.commit; } else cc = this.columns[i];
        if (cc === this.commit) {
          visto = true; this.commitIndex = i; this.mergeLayout = -1;
          this.parents.forEach(function (p) { self.inserir(p, i); });
          if (!this.numParents) this.width += 2;
        } else this.inserir(cc, -1);
      }
      while (this.mappingSize > 1 && this.mapping[this.mappingSize - 1] < 0) this.mappingSize--;
    };
    GP.inserir = function (c, idx) {
      var i = this.newColumns.indexOf(c), mi;
      if (i < 0) { i = this.newColumns.length; this.newColumns.push(c); }
      if (this.numParents > 1 && idx > -1 && this.mergeLayout === -1) {
        var dist = idx - i, shift = dist > 1 ? 2 * dist - 3 : 1;
        this.mergeLayout = dist > 0 ? 0 : 1;
        this.edgesAdded = this.numParents + this.mergeLayout - 2;
        mi = this.width + (this.mergeLayout - 1) * shift;
        this.width += 2 * this.mergeLayout;
      } else if (this.edgesAdded > 0 && i === this.mapping[this.width - 2]) { mi = this.width - 2; this.edgesAdded = -1; }
      else { mi = this.width; this.width += 2; }
      this.mapping[mi] = i;
    };
    GP.mapeamentoCerto = function () { for (var i = 0; i < this.mappingSize; i++) { var t = this.mapping[i]; if (t < 0) continue; if (t === (i >> 1)) continue; return false; } return true; };
    GP.terminado = function () { return this.state === "PADDING"; };
    GP.pad = function (l) { while (l.length < this.width) l += " "; return l; };
    GP.proxima = function () { // devolve {txt, commit}
      var l = "", i, mostrou = false, self = this;
      switch (this.state) {
        case "PADDING": for (i = 0; i < this.newColumns.length; i++) l += "| "; break;
        case "SKIP": l = "..."; this.mudarEstado("COMMIT"); break;
        case "COMMIT": {
          var visto = false;
          for (i = 0; i <= this.columns.length; i++) {
            var cc;
            if (i === this.columns.length) { if (visto) break; cc = this.commit; } else cc = this.columns[i];
            if (cc === this.commit) { visto = true; l += "*"; if (this.numParents > 2) l += octopus(this); }
            else if (visto && this.edgesAdded > 1) l += "\\";
            else if (visto && this.edgesAdded === 1) l += (this.prevState === "POST_MERGE" && this.prevEdgesAdded > 0 && this.prevCommitIndex < i) ? "\\" : "|";
            else if (this.prevState === "COLLAPSING" && this.oldMapping[2 * i + 1] === i && this.mapping[2 * i] < i) l += "/";
            else l += "|";
            l += " ";
          }
          mostrou = true;
          if (this.numParents > 1) this.mudarEstado("POST_MERGE");
          else if (this.mapeamentoCerto()) this.mudarEstado("PADDING");
          else this.mudarEstado("COLLAPSING");
          break;
        }
        case "POST_MERGE": {
          var visto2 = false, primeiro = this.parents[0], colPai = null, CH = ["/", "|", "\\"];
          for (i = 0; i <= this.columns.length; i++) {
            var c2;
            if (i === this.columns.length) { if (visto2) break; c2 = this.commit; } else c2 = this.columns[i];
            if (c2 === this.commit) {
              var idx = this.mergeLayout; visto2 = true;
              for (var j = 0; j < this.numParents; j++) {
                l += CH[idx];
                if (idx === 2) { if (this.edgesAdded > 0 || j < this.numParents - 1) l += " "; } else idx++;
              }
              if (this.edgesAdded === 0) l += " ";
            } else if (visto2) { l += (this.edgesAdded > 0 ? "\\" : "|") + " "; }
            else { l += "|"; if (this.mergeLayout !== 0 || i !== this.commitIndex - 1) l += colPai ? "_" : " "; }
            if (c2 === primeiro) colPai = c2;
          }
          if (this.mapeamentoCerto()) this.mudarEstado("PADDING"); else this.mudarEstado("COLLAPSING");
          break;
        }
        case "COLLAPSING": {
          var usouHoriz = false, he = -1, het = -1, tmp = this.mapping; this.mapping = this.oldMapping; this.oldMapping = tmp;
          for (i = 0; i < this.mappingSize; i++) this.mapping[i] = -1;
          for (i = 0; i < this.mappingSize; i++) {
            var t = this.oldMapping[i];
            if (t === undefined || t < 0) continue;
            if (t * 2 === i) this.mapping[i] = t;
            else if (!(this.mapping[i - 1] >= 0)) {
              this.mapping[i - 1] = t;
              if (he === -1) { he = i; het = t; for (var q = t * 2 + 3; q < i - 2; q += 2) this.mapping[q] = t; }
            } else if (this.mapping[i - 1] === t) { /* junta com a linha da esquerda */ }
            else {
              this.mapping[i - 2] = t;
              if (he === -1) { het = t; he = i - 1; for (var q2 = t * 2 + 3; q2 < i - 2; q2 += 2) this.mapping[q2] = t; }
            }
          }
          this.oldMapping = this.mapping.slice();
          if (!(this.mapping[this.mappingSize - 1] >= 0)) this.mappingSize--;
          for (i = 0; i < this.mappingSize; i++) {
            var tg = this.mapping[i];
            if (!(tg >= 0)) l += " ";
            else if (tg * 2 === i) l += "|";
            else if (tg === het && i !== he - 1) { if (i !== tg * 2 + 3) this.mapping[i] = -1; usouHoriz = true; l += "_"; }
            else { if (usouHoriz && i < he) this.mapping[i] = -1; l += "/"; }
          }
          if (this.mapeamentoCerto()) this.mudarEstado("PADDING");
          break;
        }
      }
      return { txt: this.pad(l), commit: mostrou };
    };
    function octopus(g) { var s = "", n = g.numParents - 2; for (var i = 0; i < n; i++) s += i === n - 1 ? "." : "-"; return s; }
    GP.separador = function () {
      if (this.state !== "COMMIT") return this.proxima().txt;
      var l = ""; for (var i = 0; i < this.columns.length; i++) l += "| ";
      this.prevState = "PADDING";
      return this.pad(l);
    };
    function desenharGrafo(repo, lista, listaToda, opt, o, specs) {
      var dentro = {}; listaToda.forEach(function (h) { dentro[h] = 1; });
      var g = new Grafo(function (h) { var ps = repo.ler(h).parents; if (o.firstParent) ps = ps.slice(0, 1); return ps.filter(function (p) { return dentro[p]; }); });
      var out = "", umaLinha = o.oneline || o.format != null, mostrouUm = false;
      lista.forEach(function (h) {
        var c = repo.ler(h);
        g.update(h);
        if (!umaLinha && mostrouUm) out += g.separador() + "\n";
        mostrouUm = true;
        while (true) { var r = g.proxima(); out += r.txt; if (r.commit) break; out += "\n"; }
        var texto = formatarCommit(repo, h, opt), linhas = texto.replace(/\n$/, "").split("\n");
        linhas.forEach(function (l, n) { out += (n ? g.proxima().txt : "") + l + "\n"; });
        var temCorpo = (o.patch || o.stat || o.shortstat || o.nameOnly || o.nameStatus) && c.parents.length < 2;
        if (temCorpo) {
          var mud = mudancasCommit(repo, h);
          if (specs.length) mud = mud.filter(function (m) { return specs.some(function (s) { return casaSpec(s, m.para); }); });
          var corpo = corpoDiffCommit(repo, h, o, mud);
          if (corpo) {
            if (!umaLinha) out += g.proxima().txt + (o.stat && o.patch ? "---" : "") + "\n";
            corpo.replace(/\n$/, "").split("\n").forEach(function (l) { out += g.proxima().txt + l + "\n"; });
          }
        }
        while (!g.terminado()) out += g.proxima().txt + "\n";
      });
      return out;
    }
    CMDS.show = function (args, io, sh) {
      var repo = precisaRepo(io);
      var o = parseLogArgs(repo, args);
      if (o.erro) fatal("unrecognized argument: " + o.erro);
      var alvos = o.revs.length ? o.revs : ["HEAD"], out = "";
      alvos.forEach(function (r, idx) {
        var mc = /^([^:]*):(.*)$/.exec(r);
        if (mc) { // HEAD:arquivo
          var base = mc[1] === "" ? null : repo.commitDe(mc[1] || "HEAD");
          var mapa = mc[1] === "" ? (function () { var m = {}; repo.lerIndice().forEach(function (e) { if (!e.stage) m[e.path] = e; }); return m; })() : repo.arvoreDe(base);
          var cam = mc[2].replace(/^\.\//, function () { return repo.relCwd("") === "." ? "" : ""; });
          if (/^\.\//.test(mc[2])) { var pre = relativo(repo.raiz, repo.sh.cwd); cam = (pre === "." ? "" : pre + "/") + mc[2].slice(2); }
          if (!base && mc[1] !== "") fatal("invalid object name '" + mc[1] + "'.");
          var e = mapa[cam];
          if (!e) {
            var dirs = Object.keys(mapa).filter(function (k) { return k.indexOf(cam + "/") === 0 || cam === ""; });
            if (dirs.length) { out += "tree " + r + "\n\n"; var vistos = {}; dirs.forEach(function (k) { var resto = cam ? k.slice(cam.length + 1) : k, n = resto.split("/")[0] + (resto.indexOf("/") >= 0 ? "/" : ""); if (!vistos[n]) { vistos[n] = 1; out += n + "\n"; } }); return; }
            var noW = noDe(sh, repo.absDe(cam));
            if (noW) fatal("path '" + cam + "' exists on disk, but not in '" + mc[1] + "'");
            fatal("path '" + cam + "' does not exist in '" + mc[1] + "'");
          }
          out += repo.textoBlob(e.hash); return;
        }
        var h = repo.rev(r);
        if (!h || h.ambiguo) fatal("ambiguous argument '" + r + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'");
        var obj = repo.ler(h);
        if (obj.type === "tag") {
          var tg = parseIdent(obj.tagger);
          out += "tag " + obj.tag + "\nTagger: " + tg.nome + " <" + tg.email + ">\nDate:   " + dataPadrao(tg.ts, tg.tz) + "\n\n" + obj.msg + "\n";
          h = repo.descascar(h); obj = repo.ler(h);
        }
        if (obj.type === "blob") { out += obj.data; return; }
        if (obj.type === "tree") { out += "tree " + r + "\n\n" + obj.ents.map(function (e) { return e.name + (e.mode === "40000" ? "/" : ""); }).join("\n") + "\n"; return; }
        if (idx > 0 && !o.oneline) out += "\n";
        out += formatarCommit(repo, h, { oneline: o.oneline, decorate: o.decorate === true || (o.decorate === null && decorarAuto(repo, io)), format: o.format, tformat: o.tformat, fuller: o.fuller, dataFmt: o.dataFmt, pretty: o.pretty, decoCompleta: o.decoCompleta });
        var c = obj;
        if (o.noPatch) return;
        if (c.parents.length > 1 && !o.stat && !o.nameOnly && !o.nameStatus) { out += "\n"; return; }
        var mud = c.parents.length > 1 ? [] : mudancasCommit(repo, h);
        if (o.paths.length) { var specs = o.paths.map(function (p) { return pathspec(repo, p); }); mud = mud.filter(function (m) { return specs.some(function (s) { return casaSpec(s, m.para); }); }); }
        if (!o.stat && !o.nameOnly && !o.nameStatus && !o.shortstat) o.patch = true;
        var corpo = corpoDiffCommit(repo, h, o, mud);
        if (corpo) out += (o.oneline || o.format === "" ? "" : "\n") + corpo;
      });
      io.out(out);
      return 0;
    };

    /* ---------- diff ---------- */
    CMDS.diff = function (args, io, sh) {
      var repo = precisaRepo(io);
      var o = { staged: false, stat: false, nameOnly: false, nameStatus: false, revs: [], paths: [], ctx: 3, shortstat: false, quiet: false, exitCode: false, wordDiff: false };
      var fim = false;
      for (var i = 0; i < args.length; i++) {
        var a = args[i], m;
        if (fim) { o.paths.push(a); continue; }
        if (a === "--") { fim = true; continue; }
        if (a === "--staged" || a === "--cached") o.staged = true;
        else if (a === "--stat") o.stat = true;
        else if (a === "--shortstat") o.shortstat = true;
        else if (a === "--name-only") o.nameOnly = true;
        else if (a === "--name-status") o.nameStatus = true;
        else if (a === "--quiet") o.quiet = true;
        else if (a === "--exit-code") o.exitCode = true;
        else if (a === "--color=never" || a === "--no-color" || a === "--color" || a === "--color=always") {}
        else if ((m = /^-U(\d+)$/.exec(a)) || (m = /^--unified=(\d+)$/.exec(a))) o.ctx = +m[1];
        else if (a === "--word-diff" || a === "--word-diff=plain") o.wordDiff = true;
        else if (a[0] === "-") { io.err("error: invalid option: " + a + "\n"); return 129; }
        else o.revs.push(a);
      }
      // separa revisões de caminhos
      var revs = [];
      for (i = 0; i < o.revs.length; i++) {
        var r = o.revs[i], mm = /^(.*?)\.\.(\.?)(.*)$/.exec(r);
        if (mm) { var x = repo.commitDe(mm[1] || "HEAD"), y = repo.commitDe(mm[3] || "HEAD"); if (!x || !y) fatal("ambiguous argument '" + r + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'"); if (mm[2]) x = repo.mergeBase(x, y); revs.push(x, y); continue; }
        var h = repo.commitDe(r);
        if (h) { revs.push(h); continue; }
        if (repo.raiz && noDe(sh, sh.abs(r))) { o.paths = o.paths.concat(o.revs.slice(i)); break; }
        if (repo.raiz && repo.lerIndice().some(function (e) { return e.path === pathspec(repo, r); })) { o.paths = o.paths.concat(o.revs.slice(i)); break; }
        fatal("ambiguous argument '" + r + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'");
      }
      var specs = o.paths.map(function (p) { return pathspec(repo, p); });
      var A, Bm;
      var idxMapa = function () { var mp = {}; repo.lerIndice().forEach(function (e) { if (!e.stage) mp[e.path] = { mode: e.mode, hash: e.hash }; }); return mp; };
      var conflitos = [];
      if (revs.length >= 2) { A = repo.arvoreDe(revs[0]); Bm = repo.arvoreDe(revs[1]); }
      else if (revs.length === 1 && o.staged) { A = repo.arvoreDe(revs[0]); Bm = idxMapa(); }
      else if (o.staged) { A = repo.arvoreDe(repo.head()); Bm = idxMapa(); }
      else {
        precisaArvore(repo);
        var st = repo.estado();
        A = revs.length === 1 ? repo.arvoreDe(revs[0]) : st.I0;
        Bm = {};
        var base = revs.length === 1 ? Object.keys(A).concat(Object.keys(st.I0)) : Object.keys(A);
        base.forEach(function (k) { var n = st.W[k]; if (n) { var hh = repo.hashArquivo(n); Bm[k] = { mode: repo.modoNo(n), hash: hh, texto: repo.conteudoNo(n) }; if (A[k] && A[k].hash === hh && A[k].mode === Bm[k].mode) Bm[k] = A[k]; } });
        if (revs.length === 0) conflitos = Object.keys(st.conf).sort(cmpCam);
      }
      var mud = compararMapas(A, Bm, false).filter(function (m) { return !specs.length || specs.some(function (s) { return casaSpec(s, m.para); }); });
      mud = mud.filter(function (m) { return conflitos.indexOf(m.para) < 0; });
      if (o.quiet) return mud.length ? 1 : 0;
      var out = "";
      var semCC = "";
      conflitos.forEach(function (k) { if (!specs.length || specs.some(function (s) { return casaSpec(s, k); })) { var e0 = st.conf[k]; if (e0[2] && e0[3] && st.W[k]) out += combinadoConflito(repo, st, k); else semCC += "* Unmerged path " + k + "\n"; } });
      if (o.nameOnly) mud.forEach(function (m) { out += repo.relCwd(m.para) + "\n"; });
      else if (o.nameStatus) mud.forEach(function (m) { out += m.tipo + "\t" + repo.relCwd(m.para) + "\n"; });
      else if (o.stat) out += repo.diffstat(mud);
      else if (o.shortstat) out += mud.length ? repo.shortstat(mud) : "";
      else out += repo.patch(mud, { ctx: o.ctx, palavras: o.wordDiff });
      out += semCC;
      io.out(out);
      return o.exitCode && mud.length ? 1 : 0;
    };
    function combinadoConflito(repo, st, k) {
      var n = st.W[k]; if (!n) return "* Unmerged path " + k + "\n";
      // diff --cc simplificado: mostra o arquivo com marcadores
      var e = st.conf[k], ours = e[2] ? repo.textoBlob(e[2].hash) : "", theirs = e[3] ? repo.textoBlob(e[3].hash) : "", w = repo.conteudoNo(n);
      var lo = separarLinhas(ours).l, lt = separarLinhas(theirs).l, lw = separarLinhas(w).l;
      var s = "diff --cc " + k + "\nindex " + repo.abrev(e[2] ? e[2].hash : ZERO) + "," + repo.abrev(e[3] ? e[3].hash : ZERO) + "..0000000\n--- a/" + k + "\n+++ b/" + k + "\n";
      var mo = mudancas(lo, lw), mt = mudancas(lt, lw);
      s += "@@@ -1," + lo.length + " -1," + lt.length + " +1," + lw.length + " @@@\n";
      lw.forEach(function (l, i) { s += (mo.cb[i] ? "+" : " ") + (mt.cb[i] ? "+" : " ") + l + "\n"; });
      return s;
    }

    /* ---------- restore / checkout de arquivos ---------- */
    CMDS.restore = function (args, io, sh) {
      var g = opcoes(args, { "-S": true, "--staged": "-S", "-W": true, "--worktree": "-W", "-s": "valor", "--source": "-s", "-q": true, "--quiet": "-q", "--ours": true, "--theirs": true, "-p": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      if (!g.ops.length) fatal("you must specify path(s) to restore");
      var staged = !!g.o["-S"], work = !!g.o["-W"] || !staged;
      var src = g.o["-s"];
      return restaurar(repo, io, sh, g.ops, { staged: staged, work: work, fonte: src !== undefined ? src : (staged ? "HEAD" : null), ours: g.o["--ours"], theirs: g.o["--theirs"] });
    };
    function restaurar(repo, io, sh, caminhos, opt) {
      var specs = caminhos.map(function (p) { return pathspec(repo, p); });
      var idx = repo.lerIndice(), I0 = {}, conf = {};
      idx.forEach(function (e) { if (!e.stage) I0[e.path] = e; else (conf[e.path] = conf[e.path] || [])[e.stage] = e; });
      var fonte;
      if (opt.fonte) {
        var hf = repo.commitDe(opt.fonte);
        if (!hf) { if (opt.fonte === "HEAD" && !repo.head()) fonte = {}; else fatal("could not resolve " + opt.fonte); }
        else fonte = repo.arvoreDe(hf);
      } else fonte = I0;
      var st = 0, novoIdx = {}, mexeu = false;
      Object.keys(I0).forEach(function (k) { novoIdx[k] = I0[k]; });
      for (var i = 0; i < specs.length; i++) {
        var sp = specs[i], casou = false;
        var cands = {};
        Object.keys(fonte).forEach(function (k) { if (casaSpec(sp, k)) cands[k] = 1; });
        if (opt.staged || opt.fonte) Object.keys(I0).forEach(function (k) { if (casaSpec(sp, k)) cands[k] = 1; });
        Object.keys(conf).forEach(function (k) { if (casaSpec(sp, k)) cands[k] = 1; });
        Object.keys(cands).sort(cmpCam).forEach(function (k) {
          casou = true;
          if (conf[k] && opt.work && !opt.staged) {
            var lado = opt.ours ? 2 : opt.theirs ? 3 : 0;
            if (!lado) { io.err("error: path '" + k + "' is unmerged\n"); st = 1; return; }
            var e = conf[k][lado]; if (e) repo.escreverArquivo(k, e); return;
          }
          var ent = fonte[k];
          if (opt.staged) { if (ent) novoIdx[k] = { mode: ent.mode, hash: ent.hash, stage: 0, path: k }; else delete novoIdx[k]; mexeu = true; }
          if (opt.work) { if (ent) repo.escreverArquivo(k, ent); else if (noDe(sh, repo.absDe(k))) repo.apagarArquivo(k); }
        });
        if (!casou) { io.err("error: pathspec '" + caminhos[i] + "' did not match any file(s) known to git\n"); st = 1; }
      }
      if (mexeu) { var lst = Object.keys(novoIdx).map(function (k) { return novoIdx[k]; }); Object.keys(conf).forEach(function (k) { if (!novoIdx[k]) conf[k].forEach(function (e) { if (e) lst.push(e); }); }); repo.gravarIndice(lst); }
      return st;
    }

    /* ---------- rm / mv ---------- */
    CMDS.rm = function (args, io, sh) {
      var g = opcoes(args, { "--cached": true, "-r": true, "-f": true, "--force": "-f", "-q": true, "--quiet": "-q", "-n": true, "--dry-run": "-n" });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      if (!g.ops.length) { io.err("usage: git rm [-f | --force] [-n] [-r] [--cached] [--ignore-unmatch]\n              [--quiet] [--pathspec-from-file=<file> [--pathspec-file-nul]]\n              [--] [<pathspec>...]\n\n    -n, --[no-]dry-run    dry run\n    -q, --[no-]quiet      do not list removed files\n    --[no-]cached         only remove from the index\n    -f, --[no-]force      override the up-to-date check\n    -r                    allow recursive removal\n    --[no-]ignore-unmatch exit with a zero status even if nothing matched\n    --[no-]sparse         allow updating entries outside of the sparse-checkout cone\n    --[no-]pathspec-from-file <file>\n                          read pathspec from file\n    --[no-]pathspec-file-nul\n                          with --pathspec-from-file, pathspec elements are separated with NUL character\n\n"); return 129; }
      var st = repo.estado(), idx = {}, alvos = [], confE = [];
      st.idx.forEach(function (e) { if (!e.stage) idx[e.path] = e; else { confE.push(e); if (!idx[e.path]) idx[e.path] = { mode: e.mode, hash: e.hash, stage: 0, path: e.path, conflito: true }; } });
      for (var i = 0; i < g.ops.length; i++) {
        var sp = pathspec(repo, g.ops[i]), achou = Object.keys(idx).filter(function (k) { return casaSpec(sp, k); });
        if (!achou.length) { io.err("fatal: pathspec '" + g.ops[i] + "' não encontrou nenhum arquivo\n"); return 128; }
        if (achou.some(function (k) { return k !== sp; }) && !/[*?[]/.test(sp) && !g.o["-r"]) { io.err("fatal: not removing '" + g.ops[i] + "' recursively without -r\n"); return 128; }
        alvos = alvos.concat(achou);
      }
      if (!g.o["-f"]) {
        var prepS = {}, nprepS = {};
        st.preparado.forEach(function (m) { prepS[m.para] = 1; }); st.naoPrep.forEach(function (m) { if (m.tipo === "M") nprepS[m.para] = 1; });
        var ambos = alvos.filter(function (k) { return prepS[k] && nprepS[k]; }), soP = alvos.filter(function (k) { return prepS[k] && !nprepS[k] && st.H[k]; }), soW = alvos.filter(function (k) { return nprepS[k] && !prepS[k]; });
        var novosP = alvos.filter(function (k) { return prepS[k] && !st.H[k] && !nprepS[k]; });
        if (ambos.length && !g.o["--cached"]) { io.err("error: the following file" + (ambos.length > 1 ? "s have" : " has") + " staged content different from both the\nfile and the HEAD:\n" + ambos.map(function (k) { return "    " + k + "\n"; }).join("") + "(use -f to force removal)\n"); return 1; }
        if (!g.o["--cached"] && (soP.length || novosP.length)) { var l1 = soP.concat(novosP); io.err("error: the following file" + (l1.length > 1 ? "s have" : " has") + " changes staged in the index:\n" + l1.map(function (k) { return "    " + k + "\n"; }).join("") + "(use --cached to keep the file, or -f to force removal)\n"); return 1; }
        if (!g.o["--cached"] && soW.length) { io.err("error: the following file" + (soW.length > 1 ? "s have" : " has") + " local modifications:\n" + soW.map(function (k) { return "    " + k + "\n"; }).join("") + "(use --cached to keep the file, or -f to force removal)\n"); return 1; }
      }
      var out = "";
      alvos.forEach(function (k) {
        if (!g.o["-q"]) out += "rm '" + k + "'\n";
        if (g.o["-n"]) return;
        delete idx[k];
        if (!g.o["--cached"]) repo.apagarArquivo(k);
      });
      io.out(out);
      if (!g.o["-n"]) repo.gravarIndice(Object.keys(idx).filter(function (k) { return !idx[k].conflito; }).map(function (k) { return idx[k]; }).concat(confE.filter(function (e) { return idx[e.path]; })));
      return 0;
    };
    CMDS.mv = function (args, io, sh) {
      var g = opcoes(args, { "-f": true, "--force": "-f", "-v": true, "-n": true, "-k": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      if (g.ops.length < 2) { io.err("usage: git mv [-v] [-f] [-n] [-k] <source> <destination>\n   or: git mv [-v] [-f] [-n] [-k] <source>... <destination-directory>\n\n    -v, --[no-]verbose    be verbose\n    -n, --[no-]dry-run    dry run\n    -f, --[no-]force      force move/rename even if target exists\n    -k                    skip move/rename errors\n    --[no-]sparse         allow updating entries outside of the sparse-checkout cone\n\n"); return 129; }
      var idx = {}; repo.lerIndice().forEach(function (e) { if (!e.stage) idx[e.path] = e; });
      var destino = g.ops[g.ops.length - 1], fontes = g.ops.slice(0, -1);
      var dn = noDe(sh, sh.abs(destino)), ehDir = dn && dn.t === "d";
      if (fontes.length > 1 && !ehDir) fatal("destination '" + destino + "' is not a directory");
      var out = "";
      for (var i = 0; i < fontes.length; i++) {
        var f = fontes[i], rf = pathspec(repo, f), nf = noDe(sh, sh.abs(f));
        var rd = ehDir ? pathspec(repo, destino.replace(/\/$/, "") + "/" + f.replace(/\/$/, "").split("/").pop()) : pathspec(repo, destino);
        if (!nf) fatal("bad source, source=" + rf + ", destination=" + rd);
        var dentro = Object.keys(idx).filter(function (k) { return k === rf || k.indexOf(rf + "/") === 0; });
        if (!dentro.length) fatal("not under version control, source=" + rf + ", destination=" + rd);
        var nd2 = noDe(sh, repo.absDe(rd));
        if (nd2 && !g.o["-f"]) fatal("destination exists, source=" + rf + ", destination=" + rd);
        if (g.o["-v"] || g.o["-n"]) out += "Checking rename of '" + rf + "' to '" + rd + "'\nRenaming " + rf + " to " + rd + "\n";
        if (g.o["-n"]) continue;
        // move no sistema de arquivos
        var r = sh.resolver(sh.abs(f), false), pp = sh.paiDe(repo.absDe(rd));
        if (!pp.pai) fatal("renaming '" + rf + "' failed: Arquivo ou diretório inexistente");
        pp.pai.c[pp.nome] = r.no; delete r.pai.c[r.nome];
        dentro.forEach(function (k) { var e = idx[k]; delete idx[k]; var nk = rd + k.slice(rf.length); idx[nk] = { mode: e.mode, hash: e.hash, stage: 0, path: nk }; });
      }
      io.out(out);
      repo.gravarIndice(Object.keys(idx).map(function (k) { return idx[k]; }));
      return 0;
    };

    /* ---------- branch ---------- */
    function nomeRefValido(n) { return !(!n || /^-|\.\.|[\s~^:?*\[\\]|@\{|\/\/|\/$|\.lock$|^\.|\/\.|\.$/.test(n) || n === "@" || n === "HEAD"); }
    CMDS.branch = function (args, io, sh) {
      var g = opcoes(args, { "-d": true, "--delete": "-d", "-D": true, "-m": true, "--move": "-m", "-M": true, "-c": true, "--copy": "-c", "-a": true, "--all": "-a", "-r": true, "--remotes": "-r", "-v": true, "--verbose": "-v", "-vv": true, "-f": true, "--force": "-f", "--list": true, "-l": "--list", "--show-current": true, "--merged": "opcional", "--no-merged": "opcional", "-u": "valor", "--set-upstream-to": "-u", "--unset-upstream": true, "-t": true, "--track": "-t", "--contains": "opcional", "-q": true, "--quiet": "-q" });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io), o = g.o, ops = g.ops, atual = repo.branchAtual(), head = repo.head();
      var vv = args.filter(function (x) { return x === "-vv"; }).length || args.filter(function (x) { return /^-[a-z]*v[a-z]*v/.test(x); }).length;
      if (o["--show-current"]) { if (atual) io.out(atual + "\n"); return 0; }
      if (o["-d"] || o["-D"]) {
        if (!ops.length) fatal("branch name required");
        var st = 0;
        ops.forEach(function (n) {
          var ref = (o["-r"] ? "refs/remotes/" : "refs/heads/") + n, h = repo.resolverRef(ref);
          if (!h) { io.err("error: " + (o["-r"] ? "remote-tracking branch" : "branch") + " '" + n + "' not found\n"); st = 1; return; }
          if (!o["-r"] && n === atual) { io.err("error: cannot delete branch '" + n + "' used by worktree at '" + repo.raiz + "'\n"); st = 1; return; }
          if (!o["-r"] && !o["-D"] && !(o["-d"] && o["-f"])) {
            var up = upstream(repo, n), base = up && up.hash ? up.hash : head;
            if (!base || !repo.ehAncestral(h, base)) { io.err("error: the branch '" + n + "' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D " + n + "'\nhint: Disable this message with \"git config set advice.forceDeleteBranch false\"\n"); st = 1; return; }
          }
          repo.apagarArq(ref); repo.apagarArq("logs/" + ref);
          if (!o["-r"]) { var cfg = repo.arq("config"); ["remote", "merge"].forEach(function (k) { cfg = gravarConfig(cfg, "branch." + n + "." + k, null).txt; }); repo.gravar("config", cfg); }
          io.out("Deleted " + (o["-r"] ? "remote-tracking branch" : "branch") + " " + n + " (was " + repo.abrev(h) + ").\n");
        });
        return st;
      }
      if (o["-m"] || o["-M"] || o["-c"]) {
        var velho, novo;
        if (ops.length === 1) { velho = atual; novo = ops[0]; } else { velho = ops[0]; novo = ops[1]; }
        if (!velho) fatal("cannot rename the current branch while not on any");
        var hv = repo.resolverRef("refs/heads/" + velho);
        if (!hv && !(velho === atual && !head)) { fatal("no branch named '" + velho + "'"); }
        if (!nomeRefValido(novo)) fatal("'" + novo + "' is not a valid branch name");
        if (repo.resolverRef("refs/heads/" + novo) && !o["-M"] && novo !== velho) fatal("a branch named '" + novo + "' already exists");
        if (hv) {
          var logTxt = repo.arq("logs/refs/heads/" + velho);
          if (!o["-c"]) { repo.apagarArq("refs/heads/" + velho); repo.apagarArq("logs/refs/heads/" + velho); }
          if (logTxt != null) repo.gravar("logs/refs/heads/" + novo, logTxt);
          repo.gravarRef("refs/heads/" + novo, hv, (o["-c"] ? "Branch: copied refs/heads/" : "Branch: renamed refs/heads/") + velho + " to refs/heads/" + novo, hv);
        }
        if (!o["-c"] && velho === atual) repo.gravar("HEAD", "ref: refs/heads/" + novo + "\n");
        return 0;
      }
      if (o["-u"] !== undefined) {
        var ramoU = ops[0] || atual, alvoU = o["-u"];
        var hU = repo.resolverRef("refs/remotes/" + alvoU), mU = /^([^/]+)\/(.*)$/.exec(alvoU);
        if (!hU || !mU) { if (repo.resolverRef("refs/heads/" + alvoU)) mU = [null, ".", alvoU]; else fatal("the requested upstream branch '" + alvoU + "' does not exist\nhint: \nhint: If you are planning on basing your work on an upstream\nhint: branch that already exists at the remote, you may need to\nhint: run \"git fetch\" to retrieve it.\nhint: \nhint: If you are planning to push out a new local branch that\nhint: will track its remote counterpart, you may want to use\nhint: \"git push -u\" to set the upstream config as you push.\nhint: Disable this message with \"git config set advice.setUpstreamFailure false\""); }
        definirUpstream(repo, ramoU, mU[1], mU[2]);
        io.out("branch '" + ramoU + "' set up to track '" + alvoU + "'.\n");
        return 0;
      }
      if (o["--unset-upstream"]) { var cfgu = repo.arq("config"); ["remote", "merge"].forEach(function (k) { cfgu = gravarConfig(cfgu, "branch." + (ops[0] || atual) + "." + k, null).txt; }); repo.gravar("config", cfgu); return 0; }
      if (ops.length && !o["--list"] && !o["--merged"] && !o["--no-merged"] && !o["--contains"]) {
        var nomeN = ops[0], de = ops[1] || "HEAD";
        if (!nomeRefValido(nomeN)) fatal("'" + nomeN + "' is not a valid branch name");
        if (repo.resolverRef("refs/heads/" + nomeN) && !o["-f"]) fatal("a branch named '" + nomeN + "' already exists");
        var hb = repo.commitDe(de);
        if (!hb) { if (de === "HEAD") fatal("not a valid object name: '" + (atual || "HEAD") + "'"); fatal("not a valid object name: '" + de + "'"); }
        repo.gravarRef("refs/heads/" + nomeN, hb, "branch: Created from " + de, ZERO);
        var mr = /^([^/]+)\/(.+)$/.exec(de);
        if (mr && repo.resolverRef("refs/remotes/" + de)) { definirUpstream(repo, nomeN, mr[1], mr[2]); io.out("branch '" + nomeN + "' set up to track '" + de + "'.\n"); }
        return 0;
      }
      // listar
      var linhas = [], locais = repo.listarRefs("refs/heads/"), remotos = repo.listarRefs("refs/remotes/");
      var filtroM = o["--merged"] !== undefined ? repo.commitDe(o["--merged"] === true ? "HEAD" : o["--merged"]) : null, filtroNM = o["--no-merged"] !== undefined ? repo.commitDe(o["--no-merged"] === true ? "HEAD" : o["--no-merged"]) : null;
      var filtroC = o["--contains"] !== undefined ? repo.commitDe(o["--contains"] === true ? "HEAD" : o["--contains"]) : null;
      var mostrarLocais = !o["-r"], mostrarRem = o["-r"] || o["-a"];
      var itens = [];
      if (!atual && head && mostrarLocais) itens.push({ nome: "(" + descricaoDestacada(repo) + ")", hash: head, atual: true, ref: null });
      if (mostrarLocais) locais.forEach(function (r) { itens.push({ nome: r.nome.slice(11), hash: r.hash, atual: r.nome.slice(11) === atual, ref: r.nome }); });
      if (mostrarRem) remotos.forEach(function (r) {
        var n = r.nome.slice(13), t = repo.lerRef(r.nome);
        itens.push({ nome: (o["-a"] ? "remotes/" : "") + n, hash: r.hash, remoto: true, simb: t && t.simb ? t.simb.replace(/^refs\/remotes\//, "") : null });
      });
      itens = itens.filter(function (x) {
        if (filtroM && !repo.ehAncestral(x.hash, filtroM)) return false;
        if (filtroNM && repo.ehAncestral(x.hash, filtroNM)) return false;
        if (filtroC && !repo.ehAncestral(filtroC, x.hash)) return false;
        if (ops.length && (o["--list"])) return ops.some(function (p) { return new RegExp("^" + globRe(p) + "$").test(x.nome); });
        return true;
      });
      var larg0 = 0; itens.forEach(function (x) { if (!x.simb) larg0 = Math.max(larg0, x.nome.length); });
      var out = "";
      itens.forEach(function (x) {
        var pre = x.atual ? "* " : "  ";
        if (x.simb) { out += pre + x.nome + " -> " + x.simb + "\n"; return; }
        if (o["-v"]) {
          var c = repo.ler(x.hash), info = "";
          if (!x.remoto && x.ref) {
            var up = upstream(repo, x.nome);
            if (up) { var ab = up.hash ? aFrente(repo, x.hash, up.hash) : null; var tr = up.sumiu ? "gone" : ab.a && ab.b ? "ahead " + ab.a + ", behind " + ab.b : ab.a ? "ahead " + ab.a : ab.b ? "behind " + ab.b : ""; if (vv) info = "[" + up.nome + (tr ? ": " + tr : "") + "] "; else if (tr) info = "[" + tr + "] "; }
          }
          out += pre + x.nome + rep(" ", larg0 - x.nome.length) + " " + repo.abrev(x.hash) + " " + info + c.msg.split("\n")[0] + "\n";
        } else out += pre + x.nome + "\n";
      });
      io.out(out);
      return 0;
    };
    function definirUpstream(repo, ramo, remoto, ref) {
      var cfg = repo.arq("config");
      cfg = gravarConfig(cfg, "branch." + ramo + ".remote", remoto).txt;
      cfg = gravarConfig(cfg, "branch." + ramo + ".merge", "refs/heads/" + ref).txt;
      repo.gravar("config", cfg);
    }

    /* ---------- switch / checkout ---------- */
    function trocarPara(repo, io, alvo, opt) {
      // alvo: {ramo} ou {hash, nome}
      var head = repo.head(), atualRef = repo.headRef();
      var destHash = alvo.ramo ? repo.resolverRef("refs/heads/" + alvo.ramo) : alvo.hash;
      var de = repo.arvoreDe(head), para = repo.arvoreDe(destHash);
      if (head !== destHash || opt.forcar) {
        var r = repo.trocarArvore(de, para, { forcar: opt.forcar });
        if (r) { io.err(erroTroca(r, "checkout")); return 1; }
      }
      var nomeDe = repo.branchAtual() || head;
      var nomePara = alvo.ramo || alvo.nome;
      if (alvo.ramo) repo.gravar("HEAD", "ref: refs/heads/" + alvo.ramo + "\n");
      else repo.gravar("HEAD", destHash + "\n");
      repo.logar("HEAD", head || ZERO, destHash, "checkout: moving from " + (nomeDe || "HEAD") + " to " + nomePara);
      // mensagens
      var s = "", e = "", s2 = "";
      var st = repo.estado();
      var mods = st.naoPrep.concat(st.preparado.filter(function (m) { return !st.naoPrep.some(function (x) { return x.para === m.para; }); })).sort(function (a, b) { return cmpCam(a.para, b.para); });
      mods.forEach(function (m) { s += (m.tipo === "R" ? "A" : m.tipo) + "\t" + m.para + "\n"; });
      if (alvo.ramo) {
        if (atualRef === "refs/heads/" + alvo.ramo) e += "Already on '" + alvo.ramo + "'\n";
        else e += (opt.novo ? "Switched to a new branch '" : "Switched to branch '") + alvo.ramo + "'\n";
        var up = upstream(repo, alvo.ramo);
        if (up && destHash && !opt.novo) s2 += textoUpstream(repo, destHash, up).replace(/\n\n$/, "\n");
      } else {
        if (!atualRef && head === destHash) e += "HEAD is now at " + repo.abrev(destHash) + " " + repo.ler(destHash).msg.split("\n")[0] + "\n";
        else {
          if (!atualRef && head && head !== destHash) e += "Previous HEAD position was " + repo.abrev(head) + " " + repo.ler(head).msg.split("\n")[0] + "\n";
          if (opt.avisoDestacado) e += "Note: switching to '" + alvo.nome + "'.\n\nYou are in 'detached HEAD' state. You can look around, make experimental\nchanges and commit them, and you can discard any commits you make in this\nstate without impacting any branches by switching back to a branch.\n\nIf you want to create a new branch to retain commits you create, you may\ndo so (now or later) by using -c with the switch command. Example:\n\n  git switch -c <new-branch-name>\n\nOr undo this operation with:\n\n  git switch -\n\nTurn off this advice by setting config variable advice.detachedHead to false\n\n";
          e += "HEAD is now at " + repo.abrev(destHash) + " " + repo.ler(destHash).msg.split("\n")[0] + "\n";
        }
      }
      if (atualRef === null && head && alvo.ramo) {
        // saindo de HEAD destacado: avisa commits perdidos
        var perdidos = repo.revList([head], repo.listarRefs("refs/").map(function (x) { return repo.descascar(x.hash); }), {});
        if (perdidos.length) {
          e = "Warning: you are leaving " + plural(perdidos.length, "commit", "commits") + " behind, not connected to\nany of your branches:\n\n" + perdidos.slice(0, 5).map(function (h) { return "  " + repo.abrev(h) + " " + repo.ler(h).msg.split("\n")[0] + "\n"; }).join("") + (perdidos.length > 5 ? " ... and " + (perdidos.length - 5) + " more.\n" : "") + "\nIf you want to keep " + (perdidos.length === 1 ? "it" : "them") + " by creating a new branch, this may be a good time\nto do so with:\n\n git branch <new-branch-name> " + repo.abrev(head) + "\n\n" + e;
        } else if (head !== destHash) e = "Previous HEAD position was " + repo.abrev(head) + " " + repo.ler(head).msg.split("\n")[0] + "\n" + e;
      }
      io.err(e); io.out(s); io.out(s2);
      return 0;
    }
    function ramoAnterior(repo) {
      var rl = repo.reflog("HEAD");
      for (var i = 0; i < rl.length; i++) { var m = /^checkout: moving from (.*) to .*$/.exec(rl[i].msg); if (m) return m[1]; }
      return null;
    }
    function ioQuieto(io, sh) { return { sh: sh, out: function () {}, err: function (t) { if (/^(error|fatal|warning|hint|Please|Aborting|\t)/m.test(t) && !/^(Switched|Already on|HEAD is now|Previous HEAD|Note: switching)/.test(t)) io.err(t); }, tty: function () { return false; } }; }
    CMDS.switch = function (args, io, sh) {
      if (args.some(function (a) { return a === "-q" || a === "--quiet" || /^-[a-zA-Z]*q[a-zA-Z]*$/.test(a); })) io = ioQuieto(io, sh);
      var g = opcoes(args, { "-c": "valor", "--create": "-c", "-C": "valor", "--force-create": "-C", "-d": true, "--detach": "-d", "-f": true, "--force": "-f", "--discard-changes": "-f", "--orphan": "valor", "-t": true, "--track": "-t", "--no-track": true, "-q": true, "--quiet": "-q", "--guess": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var o = g.o, ops = g.ops;
      var emOp = repo.existe("MERGE_HEAD") ? ["merging", "merge"] : repo.existe("CHERRY_PICK_HEAD") ? ["cherry-picking", "cherry-pick"] : repo.existe("REVERT_HEAD") ? ["reverting", "revert"] : repo.existe("rebase-merge") ? ["rebasing", "rebase"] : null;
      if (emOp) fatal("cannot switch branch while " + emOp[0] + "\nConsider \"git " + emOp[1] + " --quit\" or \"git worktree add\".");
      if (o["--orphan"]) {
        var r0 = repo.trocarArvore(repo.arvoreDe(repo.head()), {}, { forcar: true });
        repo.gravar("HEAD", "ref: refs/heads/" + o["--orphan"] + "\n"); repo.gravarIndice([]);
        io.err("Switched to a new branch '" + o["--orphan"] + "'\n"); return 0;
      }
      var novo = o["-c"] || o["-C"];
      if (novo) {
        if (!nomeRefValido(novo)) fatal("'" + novo + "' is not a valid branch name");
        if (repo.resolverRef("refs/heads/" + novo) && !o["-C"]) fatal("a branch named '" + novo + "' already exists");
        var de = ops[0] || "HEAD", h = repo.commitDe(de);
        if (!h) { if (de === "HEAD") { repo.gravar("HEAD", "ref: refs/heads/" + novo + "\n"); io.err("Switched to a new branch '" + novo + "'\n"); return 0; } fatal("invalid reference: " + de); }
        var dest = repo.arvoreDe(h);
        if (h !== repo.head()) { var rr = repo.trocarArvore(repo.arvoreDe(repo.head()), dest, { forcar: o["-f"] }); if (rr) { io.err(erroTroca(rr, "checkout")); return 1; } }
        repo.gravarRef("refs/heads/" + novo, h, "branch: Created from " + de, ZERO);
        var mr = /^([^/]+)\/(.+)$/.exec(de), extra = "";
        if (mr && repo.resolverRef("refs/remotes/" + de) && !o["--no-track"]) { definirUpstream(repo, novo, mr[1], mr[2]); extra = "branch '" + novo + "' set up to track '" + de + "'.\n"; }
        var rt2 = trocarPara(repo, io, { ramo: novo }, { novo: true, forcar: o["-f"] });
        io.out(extra);
        return rt2;
      }
      if (!ops.length) fatal("missing branch or commit argument");
      var alvo = ops[0] === "-" ? ramoAnterior(repo) : ops[0];
      if (!alvo) fatal("invalid reference: @{-1}");
      if (o["-d"]) { var hd = repo.commitDe(alvo); if (!hd) fatal("invalid reference: " + alvo); return trocarPara(repo, io, { hash: hd, nome: alvo }, { forcar: o["-f"] }); }
      if (repo.resolverRef("refs/heads/" + alvo)) return trocarPara(repo, io, { ramo: alvo }, { forcar: o["-f"] });
      // existe no remoto? cria o ramo rastreando
      var remotos = repo.listarRefs("refs/remotes/").filter(function (r) { return r.nome.replace(/^refs\/remotes\/[^/]+\//, "") === alvo && !/\/HEAD$/.test(r.nome); });
      if (remotos.length === 1) {
        var rn = remotos[0].nome.slice(13);
        var dest2 = repo.arvoreDe(remotos[0].hash);
        var r2 = repo.trocarArvore(repo.arvoreDe(repo.head()), dest2, { forcar: o["-f"] }); if (r2) { io.err(erroTroca(r2, "checkout")); return 1; }
        repo.gravarRef("refs/heads/" + alvo, remotos[0].hash, "branch: Created from " + rn, ZERO);
        var mm = /^([^/]+)\/(.+)$/.exec(rn); definirUpstream(repo, alvo, mm[1], mm[2]);
        var rt = trocarPara(repo, io, { ramo: alvo }, { novo: true });
        io.out("branch '" + alvo + "' set up to track '" + rn + "'.\n");
        return rt;
      }
      if (repo.commitDe(alvo)) fatal("a branch is expected, got " + (repo.resolverRef("refs/tags/" + alvo) ? "tag '" + alvo + "'" : repo.resolverRef("refs/remotes/" + alvo) ? "remote branch '" + alvo + "'" : "commit '" + alvo + "'") + "\nhint: If you want to detach HEAD at the commit, try again with the --detach option.\nhint: Disable this message with \"git config set advice.suggestDetachingHead false\"");
      fatal("invalid reference: " + alvo);
    };
    CMDS.checkout = function (args, io, sh) {
      if (args.some(function (a) { return a === "-q" || a === "--quiet"; })) io = ioQuieto(io, sh);
      var g = opcoes(args, { "-b": "valor", "-B": "valor", "-f": true, "--force": "-f", "-q": true, "--quiet": "-q", "--detach": true, "-t": true, "--track": "-t", "--ours": true, "--theirs": true, "--orphan": "valor", "-p": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var o = g.o, ops = g.ops, sep = o["--"];
      var trocaRamo = !(sep !== undefined || o["--ours"] || o["--theirs"]) && (o["-b"] || o["-B"] || o["--orphan"] || (ops.length === 1 && ((ops[0] === "-" && ramoAnterior(repo)) || repo.commitDe(ops[0]) || repo.listarRefs("refs/remotes/").some(function (r) { return r.nome.replace(/^refs\/remotes\/[^/]+\//, "") === ops[0]; }))));
      if (trocaRamo) { var unm = {}; repo.lerIndice().forEach(function (e) { if (e.stage) unm[e.path] = 1; }); if (Object.keys(unm).length) { io.err("error: you need to resolve your current index first\n" + Object.keys(unm).sort(cmpCam).map(function (k) { return k + ": needs merge\n"; }).join("")); return 1; } }
      if (o["-b"] || o["-B"]) { var aa = ["-" + (o["-b"] ? "c" : "C"), o["-b"] || o["-B"]].concat(ops); if (o["-f"]) aa.push("-f"); return CMDS.switch(aa, io, sh); }
      if (o["--orphan"]) return CMDS.switch(["--orphan", o["--orphan"]], io, sh);
      if (sep !== undefined || o["--ours"] || o["--theirs"]) {
        var rv = sep ? ops.slice(0, sep) : [], cams = sep !== undefined ? ops.slice(sep) : ops;
        if (!cams.length) { io.err("fatal: you must specify path(s) to restore\n"); return 128; }
        var r = checkoutArquivos(repo, io, sh, rv[0], cams, o, false, sep !== undefined);
        return r;
      }
      if (!ops.length) { var stt = repo.estado(); var s = ""; stt.naoPrep.forEach(function (m) { s += m.tipo + "\t" + m.para + "\n"; }); io.out(s); var up = repo.branchAtual() && upstream(repo, repo.branchAtual()); if (up && repo.head()) io.out(textoUpstream(repo, repo.head(), up).replace(/\n\n$/, "\n")); return 0; }
      var alvo = ops[0] === "-" ? (ramoAnterior(repo) || "-") : ops[0];
      if (ops.length === 1 && repo.resolverRef("refs/heads/" + alvo) && !o["--detach"]) return trocarPara(repo, io, { ramo: alvo }, { forcar: o["-f"] });
      if (ops.length === 1) {
        var remotos = repo.listarRefs("refs/remotes/").filter(function (r) { return r.nome.replace(/^refs\/remotes\/[^/]+\//, "") === alvo && !/\/HEAD$/.test(r.nome); });
        if (remotos.length === 1 && !o["--detach"]) return CMDS.switch([alvo], io, sh);
        var h = repo.commitDe(alvo);
        if (h) return trocarPara(repo, io, { hash: h, nome: alvo }, { forcar: o["-f"], avisoDestacado: true });
      }
      var hh = repo.commitDe(ops[0]);
      if (hh && ops.length > 1) return checkoutArquivos(repo, io, sh, ops[0], ops.slice(1), o);
      return checkoutArquivos(repo, io, sh, null, ops, o, true);
    };
    function checkoutArquivos(repo, io, sh, rev, cams, o, adivinhou, comSep) {
      var specs = cams.map(function (p) { return pathspec(repo, p); });
      if (rev) {
        var h = repo.commitDe(rev); if (!h) fatal("invalid reference: " + rev);
        var T = repo.arvoreDe(h), idx = {}, st = 0;
        repo.lerIndice().forEach(function (e) { idx[e.path] = e; });
        for (var i = 0; i < specs.length; i++) {
          var achou = Object.keys(T).filter(function (k) { return casaSpec(specs[i], k); });
          if (!achou.length) { io.err("error: pathspec '" + cams[i] + "' did not match any file(s) known to git\n"); st = 1; continue; }
          achou.forEach(function (k) { idx[k] = { mode: T[k].mode, hash: T[k].hash, stage: 0, path: k }; repo.escreverArquivo(k, T[k]); });
        }
        repo.gravarIndice(Object.keys(idx).map(function (k) { return idx[k]; }));
        if (!st && !comSep) io.err("Updated " + plural(contarCasados(T, specs), "path", "paths") + " from " + repo.abrev(repo.ler(h).tree) + "\n");
        return st;
      }
      var I0 = {}; repo.lerIndice().forEach(function (e) { if (!e.stage) I0[e.path] = e; });
      var conf = repo.estado().conf, total = 0, st2 = 0;
      for (var j = 0; j < specs.length; j++) {
        var lst = Object.keys(I0).concat(Object.keys(conf)).filter(function (k) { return casaSpec(specs[j], k); });
        if (!lst.length) {
          if (adivinhou && cams.length === 1) { io.err("error: pathspec '" + cams[j] + "' did not match any file(s) known to git\n"); return 1; }
          io.err("error: pathspec '" + cams[j] + "' did not match any file(s) known to git\n"); st2 = 1; continue;
        }
        lst.forEach(function (k) {
          if (conf[k]) { var lado = o["--ours"] ? 2 : o["--theirs"] ? 3 : 0; if (!lado) { io.err("error: path '" + k + "' is unmerged\n"); st2 = 1; return; } if (conf[k][lado]) repo.escreverArquivo(k, conf[k][lado]); total++; return; }
          var n = noDe(sh, repo.absDe(k));
          if (!n || repo.hashArquivo(n) !== I0[k].hash) { repo.escreverArquivo(k, I0[k]); }
          total++;
        });
      }
      if (!st2 && !comSep) io.err("Updated " + plural(total, "path", "paths") + " from the index\n");
      return st2;
    }
    function contarCasados(T, specs) { return Object.keys(T).filter(function (k) { return specs.some(function (s) { return casaSpec(s, k); }); }).length; }

    /* ---------- merge ---------- */
    function merge3(base, ours, theirs, rotOurs, rotTheirs) {
      // devolve {txt, conflitos}
      var b = separarLinhas(base).l, o = separarLinhas(ours).l, t = separarLinhas(theirs).l;
      var semFimO = separarLinhas(ours).semFim, semFimT = separarLinhas(theirs).semFim;
      function blocos(x) { // blocos de mudança base→x: [{b0,b1,x0,x1}]
        var mc = mudancas(b, x), res = [], i = 0, j = 0, cur = null;
        while (i < b.length || j < x.length) {
          if (i < b.length && mc.ca[i]) { if (!cur) cur = { b0: i, b1: i, x0: j, x1: j }; cur.b1 = ++i; continue; }
          if (j < x.length && mc.cb[j]) { if (!cur) cur = { b0: i, b1: i, x0: j, x1: j }; cur.x1 = ++j; continue; }
          if (cur) { res.push(cur); cur = null; }
          i++; j++;
        }
        if (cur) res.push(cur);
        return res;
      }
      var bo = blocos(o), bt = blocos(t);
      // percorre a base juntando blocos que se sobrepõem
      var todos = bo.map(function (x) { return { lado: "o", h: x }; }).concat(bt.map(function (x) { return { lado: "t", h: x }; }));
      todos.sort(function (x, y) { return x.h.b0 - y.h.b0 || x.h.b1 - y.h.b1; });
      var grupos = [];
      todos.forEach(function (x) {
        var g = grupos[grupos.length - 1];
        if (g && (x.h.b0 < g.b1 || (x.h.b0 === g.b1 && (x.h.b0 === x.h.b1 || g.b0 === g.b1) && x.h.b0 === g.b0) || x.h.b0 === g.b0)) { g.itens.push(x); g.b1 = Math.max(g.b1, x.h.b1); }
        else grupos.push({ b0: x.h.b0, b1: x.h.b1, itens: [x] });
      });
      function mapear(lado, pos) { // posição na base → posição no lado (fora de blocos)
        var lst = lado === "o" ? bo : bt, d = 0;
        for (var i = 0; i < lst.length; i++) { if (lst[i].b1 <= pos && lst[i].b0 < pos || (lst[i].b1 <= pos && lst[i].b0 === lst[i].b1 && lst[i].b0 < pos)) d += (lst[i].x1 - lst[i].x0) - (lst[i].b1 - lst[i].b0); else if (lst[i].b0 === lst[i].b1 && lst[i].b0 === pos) {} }
        return pos + d;
      }
      function trecho(lado, b0, b1) {
        var lst = lado === "o" ? bo : bt, arr = lado === "o" ? o : t;
        var ini = posLado(lst, b0, true), fim = posLado(lst, b1, false);
        return arr.slice(ini, fim);
      }
      function posLado(lst, pos, inicio) {
        var d = 0;
        for (var i = 0; i < lst.length; i++) {
          var h = lst[i];
          if (h.b1 < pos || (h.b1 === pos && !(inicio && h.b0 === pos))) d += (h.x1 - h.x0) - (h.b1 - h.b0);
          else if (h.b0 < pos && h.b1 > pos) return inicio ? h.x0 : h.x1;
          else if (!inicio && h.b0 === pos && h.b1 === pos) d += (h.x1 - h.x0);
        }
        return pos + d;
      }
      var res = [], pos = 0, conflitos = 0;
      grupos.forEach(function (g) {
        for (var i = pos; i < g.b0; i++) res.push(b[i]);
        var lados = {}; g.itens.forEach(function (x) { lados[x.lado] = 1; });
        var to = trecho("o", g.b0, g.b1), tt = trecho("t", g.b0, g.b1);
        if (lados.o && !lados.t) res = res.concat(to);
        else if (lados.t && !lados.o) res = res.concat(tt);
        else if (to.join("\n") === tt.join("\n")) res = res.concat(to);
        else { conflitos++; res.push("<<<<<<< " + rotOurs); res = res.concat(to); res.push("======="); res = res.concat(tt); res.push(">>>>>>> " + rotTheirs); }
        pos = g.b1;
      });
      for (var i = pos; i < b.length; i++) res.push(b[i]);
      var txt = res.length ? res.join("\n") + "\n" : "";
      if (!conflitos && res.length) { var ultimoO = o.length && res[res.length - 1] === o[o.length - 1], semF = (ours === theirs) ? semFimO : (theirs === base ? semFimO : ours === base ? semFimT : semFimO && semFimT); if (semF) txt = txt.slice(0, -1); }
      return { txt: txt, conflitos: conflitos };
    }
    // merge de árvores; devolve {mapa, conflitos:[{path, tipo, ents}], msgs:[]}
    R.mesclarArvores = function (baseH, oursH, theirsH, rotO, rotT) {
      var self = this, B0 = baseH ? this.arvoreDe(baseH) : {}, O = this.arvoreDe(oursH), T = this.arvoreDe(theirsH);
      var todos = {}, res = {}, conflitos = [], msgs = [];
      [B0, O, T].forEach(function (m) { Object.keys(m).forEach(function (k) { todos[k] = 1; }); });
      Object.keys(todos).sort(cmpCam).forEach(function (k) {
        var b = B0[k], o = O[k], t = T[k], hb = b && b.hash, ho = o && o.hash, ht = t && t.hash;
        if (ho === ht && (o && t ? o.mode === t.mode : true)) { if (o) res[k] = o; return; }
        if (ho === hb && (!o || !b || o.mode === b.mode)) { if (t) res[k] = t; return; }
        if (ht === hb && (!t || !b || t.mode === b.mode)) { if (o) res[k] = o; return; }
        // os dois mudaram
        if (o && t) {
          var m = merge3(b ? self.textoBlob(b.hash) : "", self.textoBlob(o.hash), self.textoBlob(t.hash), rotO, rotT);
          msgs.push("Mesclagem automática de " + k + "\n");
          if (m.conflitos) { conflitos.push({ path: k, tipo: b ? "content" : "add/add", ents: [b, o, t], txt: m.txt }); msgs.push("CONFLITO (" + (b ? "conteúdo" : "adicionar/adicionar") + "): conflito de mesclagem em " + k + "\n"); return; }
          var h = self.escreverObj({ type: "blob", data: m.txt });
          res[k] = { mode: o.mode, hash: h };
          return;
        }
        // apagado de um lado, modificado do outro
        if (!o) { conflitos.push({ path: k, tipo: "modify/delete", ents: [b, null, t] }); msgs.push("CONFLICT (modify/delete): " + k + " deleted in " + rotO + " and modified in " + rotT + ".  Version " + rotT + " of " + k + " left in tree.\n"); return; }
        conflitos.push({ path: k, tipo: "modify/delete", ents: [b, o, null] }); msgs.push("CONFLICT (modify/delete): " + k + " deleted in " + rotT + " and modified in " + rotO + ".  Version " + rotO + " of " + k + " left in tree.\n");
      });
      return { mapa: res, conflitos: conflitos, msgs: msgs };
    };
    // aplica o resultado de um merge na pasta e no índice
    R.aplicarMesclagem = function (oursH, r) {
      var self = this, O = this.arvoreDe(oursH), idx = [];
      var conflitoP = {}; r.conflitos.forEach(function (c) { conflitoP[c.path] = c; });
      Object.keys(r.mapa).forEach(function (k) { idx.push({ mode: r.mapa[k].mode, hash: r.mapa[k].hash, stage: 0, path: k }); });
      // pasta: o que mudou de O para o resultado
      Object.keys(O).forEach(function (k) { if (!r.mapa[k] && !conflitoP[k]) self.apagarArquivo(k); });
      Object.keys(r.mapa).forEach(function (k) { if (!O[k] || O[k].hash !== r.mapa[k].hash || O[k].mode !== r.mapa[k].mode) self.escreverArquivo(k, r.mapa[k]); });
      r.conflitos.forEach(function (c) {
        c.ents.forEach(function (e, i) { if (e) idx.push({ mode: e.mode, hash: e.hash, stage: i + 1, path: c.path }); });
        if (c.txt != null) escreverTxt(self.sh, self.absDe(c.path), c.txt, 436);
        else { var e = c.ents[1] || c.ents[2]; self.escreverArquivo(c.path, e); }
      });
      this.gravarIndice(idx);
    };
    CMDS.merge = function (args, io, sh) {
      var g = opcoes(args, { "--no-ff": true, "--ff": true, "--ff-only": true, "-m": "valor", "--message": "-m", "--abort": true, "--continue": true, "--no-edit": true, "--edit": true, "-e": "--edit", "--squash": true, "-q": true, "--quiet": "-q", "--no-commit": true, "--stat": true, "--allow-unrelated-histories": true, "-s": "valor", "-X": "valor", "--strategy": "-s", "-v": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var o = g.o, head = repo.head(), ramo = repo.branchAtual();
      if (o["--abort"]) {
        if (!repo.existe("MERGE_HEAD")) fatal("There is no merge to abort (MERGE_HEAD missing).");
        var orig = repo.arq("ORIG_HEAD").slice(0, 40);
        repo.trocarArvore(repo.arvoreDe(head), repo.arvoreDe(orig), { forcar: true });
        ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"].forEach(function (f) { repo.apagarArq(f); });
        return 0;
      }
      if (o["--continue"]) {
        if (!repo.existe("MERGE_HEAD")) fatal("There is no merge in progress (MERGE_HEAD missing).");
        return CMDS.commit(["--no-edit"], io, sh);
      }
      if (repo.existe("MERGE_HEAD")) {
        if (Object.keys(repo.estado().conf).length) { io.err("error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n"); return 128; }
        io.err("fatal: You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.\n"); return 128;
      }
      if (!g.ops.length) {
        var up0 = ramo && upstream(repo, ramo);
        if (!up0) fatal("No remote for the current branch.");
        g.ops = [up0.nome];
      }
      var nomeT = g.ops[0], ht = repo.commitDe(nomeT);
      if (!ht) { io.err("merge: " + nomeT + " - not something we can merge\n"); return 1; }
      if (!head) { // ramo sem commits: só aponta
        repo.trocarArvore({}, repo.arvoreDe(ht), {});
        repo.gravarRef(repo.headRef(), ht, "merge " + nomeT + ": Fast-forward", ZERO); return 0;
      }
      if (repo.ehAncestral(ht, head)) { io.out("Already up to date.\n"); return 0; }
      var base = repo.mergeBase(head, ht);
      if (!base && !o["--allow-unrelated-histories"]) fatal("refusing to merge unrelated histories");
      var ff = base === head;
      if (o["--ff-only"] && !ff) { io.err("hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with \"git config set advice.diverging false\"\nfatal: Not possible to fast-forward, aborting.\n"); return 128; }
      // checa mudanças locais que seriam sobrescritas
      var st = repo.estado();
      if (st.preparado.length && !ff) { io.err("error: Your local changes to the following files would be overwritten by merge:\n" + st.preparado.map(function (m) { return "\t" + m.para + "\n"; }).join("") + "Please commit your changes or stash them before you merge.\nAborting\n"); return 2; }
      var rotuloT = nomeT;
      if (ff && !o["--no-ff"] && !o["--squash"]) {
        var r = repo.trocarArvore(repo.arvoreDe(head), repo.arvoreDe(ht), {});
        if (r) { io.out("Updating " + repo.abrev(head) + ".." + repo.abrev(ht) + "\n"); io.err(erroTroca(r, "merge")); return 1; }
        repo.gravar("ORIG_HEAD", head + "\n");
        var refA = repo.headRef();
        if (refA) repo.gravarRef(refA, ht, "merge " + nomeT + ": Fast-forward", head); else { repo.gravar("HEAD", ht + "\n"); repo.logar("HEAD", head, ht, "merge " + nomeT + ": Fast-forward"); }
        var mud = compararMapas(repo.arvoreDe(head), repo.arvoreDe(ht), function (a, b) { return repo.similaridade(a, b); });
        if (!o["-q"]) io.out("Updating " + repo.abrev(head) + ".." + repo.abrev(ht) + "\nFast-forward\n" + repo.diffstat(mud) + repo.resumoCriacao(mud));
        return 0;
      }
      if (ff && o["--squash"]) {
        var rq = repo.trocarArvore(repo.arvoreDe(head), repo.arvoreDe(ht), {});
        if (rq) { io.out("Updating " + repo.abrev(head) + ".." + repo.abrev(ht) + "\n"); io.err(erroTroca(rq, "merge")); return 1; }
        var mudQ = compararMapas(repo.arvoreDe(head), repo.arvoreDe(ht), function (a, b) { return repo.similaridade(a, b); });
        repo.gravar("SQUASH_MSG", "Squashed commit of the following:\n\n" + repo.revList([ht], [head], {}).map(function (h) { return formatarCommit(repo, h, {}); }).join("\n"));
        io.out("Updating " + repo.abrev(head) + ".." + repo.abrev(ht) + "\nFast-forward\nSquash commit -- not updating HEAD\n" + repo.diffstat(mudQ) + repo.resumoCriacao(mudQ));
        return 0;
      }
      // mesclagem de 3 vias
      var res = repo.mesclarArvores(base, head, ht, "HEAD", rotuloT);
      // arquivos não rastreados que seriam sobrescritos / mudanças locais em arquivos afetados
      var O = repo.arvoreDe(head), afetados = [];
      Object.keys(res.mapa).forEach(function (k) { if (!O[k] || O[k].hash !== res.mapa[k].hash) afetados.push(k); });
      res.conflitos.forEach(function (c) { afetados.push(c.path); });
      var sujos = st.naoPrep.map(function (m) { return m.para; }).filter(function (k) { return afetados.indexOf(k) >= 0; });
      if (sujos.length) { io.err("error: Your local changes to the following files would be overwritten by merge:\n" + sujos.map(function (k) { return "\t" + k + "\n"; }).join("") + "Please commit your changes or stash them before you merge.\nAborting\n"); return 2; }
      var naoR = afetados.filter(function (k) { return !O[k] && st.W[k]; });
      if (naoR.length) { io.err("error: The following untracked working tree files would be overwritten by merge:\n" + naoR.map(function (k) { return "\t" + k + "\n"; }).join("") + "Please move or remove them before you merge.\nAborting\n"); return 2; }
      var msg = o["-m"] ? lista(o["-m"]).join("\n\n") : "Merge branch '" + nomeT + "'" + (ramo && ramo !== "main" && ramo !== "master" ? " into " + ramo : "");
      if (/^[0-9a-f]{4,40}$/.test(nomeT) && !repo.resolverRef("refs/heads/" + nomeT)) msg = o["-m"] ? msg : "Merge commit '" + nomeT + "'" + (ramo && ramo !== "main" && ramo !== "master" ? " into " + ramo : "");
      else if (repo.resolverRef("refs/remotes/" + nomeT) && !repo.resolverRef("refs/heads/" + nomeT) && !o["-m"]) msg = "Merge remote-tracking branch '" + nomeT + "'" + (ramo && ramo !== "main" && ramo !== "master" ? " into " + ramo : "");
      else if (repo.resolverRef("refs/tags/" + nomeT) && !o["-m"]) msg = "Merge tag '" + nomeT + "'" + (ramo && ramo !== "main" && ramo !== "master" ? " into " + ramo : "");
      repo.gravar("ORIG_HEAD", head + "\n");
      repo.aplicarMesclagem(head, res);
      var saidaMsgs = res.msgs.join("");
      if (res.conflitos.length) {
        repo.gravar("MERGE_HEAD", ht + "\n"); repo.gravar("MERGE_MODE", o["--no-ff"] ? "no-ff" : "");
        repo.gravar("MERGE_MSG", msg + "\n\n# Conflicts:\n" + res.conflitos.map(function (c) { return "#\t" + c.path + "\n"; }).join(""));
        io.out(saidaMsgs + "Automatic merge failed; fix conflicts and then commit the result.\n");
        return 1;
      }
      if (o["--squash"]) { io.out(saidaMsgs + "Squash commit -- not updating HEAD\nAutomatic merge went well; stopped before committing as requested\n"); repo.gravar("SQUASH_MSG", "Squashed commit of the following:\n"); return 0; }
      if (o["--no-commit"]) { repo.gravar("MERGE_HEAD", ht + "\n"); repo.gravar("MERGE_MSG", msg + "\n"); io.out(saidaMsgs + "Automatic merge went well; stopped before committing as requested\n"); return 0; }
      var arvore = repo.escreverArvore(repo.lerIndice());
      var c = { type: "commit", tree: arvore, parents: [head, ht], author: repo.ident("a"), committer: repo.ident("c"), msg: limparMsg(msg, "whitespace") };
      if (!c.author) { io.err("Committer identity unknown\n\n*** Please tell me who you are.\n"); return 128; }
      var hm = repo.escreverObj(c), refM = repo.headRef();
      if (refM) repo.gravarRef(refM, hm, "merge " + nomeT + ": Merge made by the 'ort' strategy.", head); else { repo.gravar("HEAD", hm + "\n"); repo.logar("HEAD", head, hm, "merge " + nomeT + ": Merge made by the 'ort' strategy."); }
      var mud2 = compararMapas(repo.arvoreDe(head), repo.arvorePlana(arvore), function (a, b) { return repo.similaridade(a, b); });
      if (!o["-q"]) io.out(saidaMsgs + "Merge made by the 'ort' strategy.\n" + repo.diffstat(mud2) + repo.resumoCriacao(mud2));
      return 0;
    };

    /* ---------- tag ---------- */
    CMDS.tag = function (args, io, sh) {
      var g = opcoes(args, { "-a": true, "--annotate": "-a", "-m": "valor", "--message": "-m", "-d": true, "--delete": "-d", "-l": true, "--list": "-l", "-f": true, "--force": "-f", "-n": "opcional", "-s": true, "--sort": "valor", "--contains": "valor", "--points-at": "valor", "--merged": "opcional" });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io), o = g.o, ops = g.ops;
      if (o["-d"]) {
        var st = 0;
        ops.forEach(function (n) { var h = repo.resolverRef("refs/tags/" + n); if (!h) { io.err("error: tag '" + n + "' not found.\n"); st = 1; return; } repo.apagarArq("refs/tags/" + n); io.out("Deleted tag '" + n + "' (was " + repo.abrev(h) + ")\n"); });
        return st;
      }
      if (!ops.length || o["-l"]) {
        var tags = repo.listarRefs("refs/tags/");
        if (ops.length) tags = tags.filter(function (t) { return ops.some(function (p) { return new RegExp("^" + globRe(p) + "$").test(t.nome.slice(10)); }); });
        if (o["--contains"]) { var hc0 = repo.commitDe(o["--contains"]); tags = tags.filter(function (t) { return hc0 && repo.ehAncestral(hc0, repo.descascar(t.hash)); }); }
        if (o["--points-at"]) { var hp0 = repo.rev(o["--points-at"]); tags = tags.filter(function (t) { return repo.descascar(t.hash) === repo.descascar(hp0); }); }
        if (!o["--sort"] && repo.config("tag.sort")) o["--sort"] = repo.config("tag.sort");
        if (o["--sort"]) {
          var srt = lista(o["--sort"]).slice(-1)[0], inv = srt[0] === "-"; if (inv) srt = srt.slice(1);
          var cmpV = function (a, b) { var x = a.split(/(\d+)/), y = b.split(/(\d+)/); for (var i = 0; i < Math.max(x.length, y.length); i++) { var p = x[i] || "", q = y[i] || ""; if (p === q) continue; if (/^\d+$/.test(p) && /^\d+$/.test(q)) return +p - +q; return p < q ? -1 : 1; } return 0; };
          if (/^(v|version):refname$/.test(srt)) tags.sort(function (a, b) { return cmpV(a.nome.slice(10), b.nome.slice(10)); });
          else if (srt === "refname") tags.sort(function (a, b) { return cmpCam(a.nome, b.nome); });
          else if (/date$/.test(srt)) tags.sort(function (a, b) { var oa = repo.ler(a.hash), ob = repo.ler(b.hash); var ta = parseIdent(oa.tagger || oa.committer).ts, tb = parseIdent(ob.tagger || ob.committer).ts; return ta - tb; });
          if (inv) tags.reverse();
        }
        var out = "";
        tags.forEach(function (t) {
          var n = t.nome.slice(10);
          if (o["-n"] !== undefined) { var ob = repo.ler(t.hash), msg = ob.type === "tag" ? ob.msg : repo.ler(repo.descascar(t.hash)).msg; out += n + rep(" ", Math.max(1, 16 - n.length)) + msg.split("\n")[0] + "\n"; }
          else out += n + "\n";
        });
        io.out(out); return 0;
      }
      var nome = ops[0], alvo = ops[1] || "HEAD";
      if (!nomeRefValido(nome)) fatal("'" + nome + "' is not a valid tag name.");
      var h = repo.rev(alvo);
      if (!h || h.ambiguo) { if (alvo === "HEAD") fatal("Failed to resolve 'HEAD' as a valid ref."); fatal("Failed to resolve '" + alvo + "' as a valid ref."); }
      var existente = repo.resolverRef("refs/tags/" + nome);
      if (existente && !o["-f"]) fatal("tag '" + nome + "' already exists");
      if (o["-a"] || o["-m"] !== undefined || o["-s"]) {
        if (o["-m"] === undefined) { io.err("(simulador) aqui não há editor de texto para a mensagem da tag: use git tag -a " + nome + " -m \"mensagem\".\n"); return 1; }
        var tagger = repo.ident("c");
        var ob2 = repo.ler(h);
        var to = { type: "tag", object: h, otype: ob2.type, tag: nome, tagger: tagger, msg: limparMsg(lista(o["-m"]).join("\n\n"), "whitespace") };
        h = repo.escreverObj(to);
      }
      repo.gravar("refs/tags/" + nome, h + "\n");
      if (existente && existente !== h) io.out("Updated tag '" + nome + "' (was " + repo.abrev(existente) + ")\n");
      return 0;
    };

    /* ---------- reset ---------- */
    CMDS.reset = function (args, io, sh) {
      var g = opcoes(args, { "--soft": true, "--mixed": true, "--hard": true, "--merge": true, "--keep": true, "-q": true, "--quiet": "-q", "-p": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io), o = g.o, ops = g.ops, head = repo.head(), sep = o["--"];
      var rev = "HEAD", cams = [];
      if (sep !== undefined) { rev = ops.slice(0, sep)[0] || "HEAD"; cams = ops.slice(sep); }
      else if (ops.length) {
        if (repo.commitDe(ops[0])) { rev = ops[0]; cams = ops.slice(1); }
        else {
          cams = ops;
          var k0 = repo.raiz ? pathspec(repo, ops[0]) : ops[0];
          if (!noDe(sh, sh.abs(ops[0])) && !repo.lerIndice().some(function (e) { return casaSpec(k0, e.path); }) && !repo.arvoreDe(repo.head())[k0]) fatal("ambiguous argument '" + ops[0] + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'");
        }
      }
      if (cams.length) {
        if (o["--hard"] || o["--soft"]) fatal("Cannot do " + (o["--hard"] ? "hard" : "soft") + " reset with paths.");
        var specs = cams.map(function (p) { return pathspec(repo, p); }), hc = repo.commitDe(rev);
        if (!hc && head) fatal("ambiguous argument '" + rev + "'");
        var T = repo.arvoreDe(hc), idx = {};
        repo.lerIndice().forEach(function (e) { idx[e.path] = e; });
        Object.keys(idx).concat(Object.keys(T)).forEach(function (k) { if (!specs.some(function (s) { return casaSpec(s, k); })) return; if (T[k]) idx[k] = { mode: T[k].mode, hash: T[k].hash, stage: 0, path: k }; else delete idx[k]; });
        repo.gravarIndice(Object.keys(idx).map(function (k) { return idx[k]; }));
        if (!o["-q"]) mostrarNaoPrep(repo, io);
        return 0;
      }
      var h = repo.commitDe(rev);
      if (!h) fatal("ambiguous argument '" + rev + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'");
      var modo = o["--soft"] ? "soft" : o["--hard"] ? "hard" : "mixed";
      if (head) repo.gravar("ORIG_HEAD", head + "\n");
      if (modo === "hard") repo.trocarArvore(repo.arvoreDe(head), repo.arvoreDe(h), { forcar: true });
      else if (modo === "mixed") { var T2 = repo.arvoreDe(h); repo.gravarIndice(Object.keys(T2).map(function (k) { return { mode: T2[k].mode, hash: T2[k].hash, stage: 0, path: k }; })); }
      var ref = repo.headRef();
      var msgLog = "reset: moving to " + rev;
      if (ref) repo.gravarRef(ref, h, msgLog, head || ZERO); else { repo.gravar("HEAD", h + "\n"); repo.logar("HEAD", head || ZERO, h, msgLog); }
      ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE"].forEach(function (f) { repo.apagarArq(f); });
      if (o["-q"]) return 0;
      if (modo === "hard") io.out("HEAD is now at " + repo.abrev(h) + " " + repo.ler(h).msg.split("\n")[0] + "\n");
      else if (modo === "mixed") mostrarNaoPrep(repo, io);
      return 0;
    };
    function mostrarNaoPrep(repo, io) {
      var st = repo.estado();
      if (st.naoPrep.length) io.out("Unstaged changes after reset:\n" + st.naoPrep.map(function (m) { return m.tipo + "\t" + m.para + "\n"; }).join(""));
    }

    /* ---------- revert / cherry-pick ---------- */
    function aplicarCommit(repo, io, sh, h, modo, opt) {
      // modo: "revert" | "cherry-pick"
      var c = repo.ler(h), head = repo.head(), ramo = repo.branchAtual();
      if (c.parents.length > 1 && !opt.mainline) { io.err("error: commit " + h + " is a merge but no -m option was given.\nfatal: " + (modo === "revert" ? "revert" : "cherry-pick") + " failed\n"); return 128; }
      var pai = c.parents[(opt.mainline || 1) - 1] || null;
      var st = repo.estado();
      if (st.preparado.length || st.naoPrep.length) {
        var acao = modo === "revert" ? "revert" : "cherry-pick";
        io.err("error: your local changes would be overwritten by " + acao + ".\nhint: commit your changes or stash them to proceed.\nfatal: " + acao + " failed\n"); return 128;
      }
      var titulo = c.msg.split("\n")[0], curto = repo.abrev(h);
      var res = modo === "revert" ? repo.mesclarArvores(h, head, pai, "HEAD", "parent of " + curto + " (" + titulo + ")") : repo.mesclarArvores(pai, head, h, "HEAD", curto + " (" + titulo + ")");
      var msg = modo === "revert" ? "Revert \"" + titulo + "\"\n\nThis reverts commit " + h + ".\n" : c.msg;
      if (modo === "cherry-pick" && opt.x) msg = msg.replace(/\n$/, "") + "\n\n(cherry picked from commit " + h + ")\n";
      repo.gravar("ORIG_HEAD", head + "\n");
      repo.aplicarMesclagem(head, res);
      if (res.conflitos.length) {
        repo.gravar(modo === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD", h + "\n");
        repo.gravar("MERGE_MSG", msg + "\n# Conflicts:\n" + res.conflitos.map(function (x) { return "#\t" + x.path + "\n"; }).join(""));
        var acao2 = modo === "revert" ? "revert" : "cherry-pick";
        io.out(res.msgs.join(""));
        io.err("error: não foi possível " + (modo === "revert" ? "reverter" : "aplicar") + " " + curto + "... " + titulo + "\nhint: After resolving the conflicts, mark them with\nhint: \"git add/rm <pathspec>\", then run\nhint: \"git " + acao2 + " --continue\".\nhint: You can instead skip this commit with \"git " + acao2 + " --skip\".\nhint: To abort and get back to the state before \"git " + acao2 + "\",\nhint: run \"git " + acao2 + " --abort\".\nhint: Disable this message with \"git config set advice.mergeConflict false\"\n");
        return 1;
      }
      if (opt.noCommit) return 0;
      var arvore = repo.escreverArvore(repo.lerIndice());
      if (arvore === repo.ler(head).tree && !opt.allowEmpty) {
        io.out("No ramo " + ramo + "\nnothing to commit, working tree clean\n");
        io.err("The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git cherry-pick --skip'\n");
        return 1;
      }
      var novo = { type: "commit", tree: arvore, parents: [head], author: modo === "revert" ? repo.ident("a") : c.author, committer: repo.ident("c"), msg: msg };
      var hn = repo.escreverObj(novo), ref = repo.headRef();
      var logMsg = (modo === "revert" ? "revert: " : "cherry-pick: ") + msg.split("\n")[0];
      if (ref) repo.gravarRef(ref, hn, logMsg, head); else { repo.gravar("HEAD", hn + "\n"); repo.logar("HEAD", head, hn, logMsg); }
      var mud = compararMapas(repo.arvoreDe(head), repo.arvorePlana(arvore), function (a, b) { return repo.similaridade(a, b); });
      var cab = "[" + (ramo || "HEAD destacada") + " " + repo.abrev(hn) + "] " + msg.split("\n")[0] + "\n";
      var au = parseIdent(modo === "cherry-pick" ? c.author : novo.author); cab += " Date: " + dataPadrao(au.ts, au.tz) + "\n";
      io.out(res.msgs.join("") + cab + repo.shortstat(mud) + repo.resumoCriacao(mud));
      return 0;
    }
    function continuarSequencia(repo, io, sh, modo, acao) {
      var arq = modo === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD";
      if (acao === "--abort") {
        if (!repo.existe(arq)) { io.err("error: Nenhum cherry-pick ou revert em progresso\nfatal: " + modo + " failed\n"); return 128; }
        var orig = repo.arq("ORIG_HEAD").slice(0, 40);
        repo.trocarArvore(repo.arvoreDe(repo.head()), repo.arvoreDe(orig), { forcar: true });
        [arq, "MERGE_MSG"].forEach(function (f) { repo.apagarArq(f); });
        return 0;
      }
      if (acao === "--skip") { if (!repo.existe(arq)) { io.err("error: no " + modo + " in progress\nfatal: " + modo + " failed\n"); return 128; } repo.trocarArvore(repo.arvoreDe(repo.head()), repo.arvoreDe(repo.head()), { forcar: true }); [arq, "MERGE_MSG"].forEach(function (f) { repo.apagarArq(f); }); return 0; }
      if (!repo.existe(arq)) { io.err("error: no " + modo + " in progress\nfatal: " + modo + " failed\n"); return 128; }
      if (Object.keys(repo.estado().conf).length) { io.err("error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n"); return 128; }
      var h = repo.arq(arq).slice(0, 40), c = repo.ler(h), head = repo.head(), ramo = repo.branchAtual();
      var msg = (repo.arq("MERGE_MSG") || "").split("\n").filter(function (l) { return l[0] !== "#"; }).join("\n");
      msg = limparMsg(msg, "strip");
      var arvore = repo.escreverArvore(repo.lerIndice());
      var novo = { type: "commit", tree: arvore, parents: [head], author: modo === "revert" ? repo.ident("a") : c.author, committer: repo.ident("c"), msg: msg };
      var hn = repo.escreverObj(novo), ref = repo.headRef();
      if (ref) repo.gravarRef(ref, hn, (modo === "revert" ? "revert: " : "cherry-pick: ") + msg.split("\n")[0], head);
      [arq, "MERGE_MSG"].forEach(function (f) { repo.apagarArq(f); });
      var mud = compararMapas(repo.arvoreDe(head), repo.arvorePlana(arvore), function (a, b) { return repo.similaridade(a, b); });
      io.out("[" + (ramo || "HEAD destacada") + " " + repo.abrev(hn) + "] " + msg.split("\n")[0] + "\n" + (modo === "cherry-pick" ? " Date: " + dataPadrao(parseIdent(c.author).ts, parseIdent(c.author).tz) + "\n" : "") + repo.shortstat(mud) + repo.resumoCriacao(mud));
      return 0;
    }
    CMDS.revert = function (args, io, sh) {
      var g = opcoes(args, { "--no-edit": true, "--edit": true, "-n": true, "--no-commit": "-n", "--abort": true, "--continue": true, "--skip": true, "-m": "valor", "--mainline": "-m" });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      if (g.o["--abort"] || g.o["--continue"] || g.o["--skip"]) return continuarSequencia(repo, io, sh, "revert", g.o["--abort"] ? "--abort" : g.o["--skip"] ? "--skip" : "--continue");
      if (!g.ops.length) { io.err("usage: git revert [--[no-]edit] [-n] [-m <parent-number>] [-s] [-S[<keyid>]] <commit>...\n   or: git revert (--continue | --skip | --abort | --quit)\n"); return 129; }
      var st = 0;
      for (var i = 0; i < g.ops.length; i++) {
        var h = repo.commitDe(g.ops[i]);
        if (!h) { io.err("fatal: bad revision '" + g.ops[i] + "'\n"); return 128; }
        st = aplicarCommit(repo, io, sh, h, "revert", { noCommit: g.o["-n"], mainline: g.o["-m"] ? +g.o["-m"] : 0 });
        if (st) return st;
      }
      return 0;
    };
    CMDS["cherry-pick"] = function (args, io, sh) {
      var g = opcoes(args, { "--no-edit": true, "-e": true, "-n": true, "--no-commit": "-n", "--abort": true, "--continue": true, "--skip": true, "-x": true, "-m": "valor", "--mainline": "-m", "--allow-empty": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      if (g.o["--abort"] || g.o["--continue"] || g.o["--skip"]) return continuarSequencia(repo, io, sh, "cherry-pick", g.o["--abort"] ? "--abort" : g.o["--skip"] ? "--skip" : "--continue");
      if (!g.ops.length) { io.err("usage: git cherry-pick [--edit] [-n] [-m <parent-number>] [-s] [-x] [--ff]\n                       [-S[<keyid>]] <commit>...\n   or: git cherry-pick (--continue | --skip | --abort | --quit)\n"); return 129; }
      var lista0 = [];
      g.ops.forEach(function (r) { var m = /^(.*)\.\.(.*)$/.exec(r); if (m) { lista0 = lista0.concat(repo.revList([repo.commitDe(m[2] || "HEAD")], [repo.commitDe(m[1])], {}).reverse()); } else { var h = repo.commitDe(r); if (!h) fatal("bad revision '" + r + "'"); lista0.push(h); } });
      for (var i = 0; i < lista0.length; i++) { var st = aplicarCommit(repo, io, sh, lista0[i], "cherry-pick", { noCommit: g.o["-n"], x: g.o["-x"], mainline: g.o["-m"] ? +g.o["-m"] : 0, allowEmpty: g.o["--allow-empty"] }); if (st) return st; }
      return 0;
    };

    /* ---------- stash ---------- */
    function listaStash(repo) { return repo.reflog("refs/stash"); }
    CMDS.stash = function (args, io, sh) {
      var repo = precisaRepo(io); precisaArvore(repo);
      var sub = args[0] && args[0][0] !== "-" ? args[0] : "push", resto = args[0] && args[0][0] !== "-" ? args.slice(1) : args;
      var stl = listaStash(repo), ramo = repo.branchAtual() || "(no branch)", head = repo.head();
      function ref(n) { var m = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(n || "stash@{0}"); return m ? +(m[1] || m[2]) : -1; }
      if (sub === "list") { io.out(stl.map(function (e, i) { return "stash@{" + i + "}: " + e.msg + "\n"; }).join("")); return 0; }
      if (sub === "push" || sub === "save") {
        var g = opcoes(resto, { "-m": "valor", "--message": "-m", "-u": true, "--include-untracked": "-u", "-k": true, "--keep-index": "-k", "-q": true, "--quiet": "-q", "-a": true, "--all": "-a", "-p": true, "--staged": "-S", "-S": true });
        if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
        if (!head) { io.err("You do not have the initial commit yet\n"); return 1; }
        var st = repo.estado();
        var naoR = g.o["-u"] ? st.naoRastr.filter(function (k) { return !/\/$/.test(k); }) : [];
        if (g.o["-u"]) { // inclui arquivos dentro de pastas não rastreadas
          naoR = []; Object.keys(st.W).forEach(function (k) { if (!st.I0[k] && !repo.ignorado(k, false)) naoR.push(k); });
        }
        if (!st.preparado.length && !st.naoPrep.length && !naoR.length) { io.out("No local changes to save\n"); return 0; }
        var msgU = sub === "save" ? g.ops.join(" ") : g.o["-m"];
        var cH = repo.ler(head), titulo = repo.abrev(head) + " " + cH.msg.split("\n")[0];
        var ident = repo.ident("c");
        // commit do índice
        var arvIdx = repo.escreverArvore(repo.lerIndice());
        var cIdx = repo.escreverObj({ type: "commit", tree: arvIdx, parents: [head], author: ident, committer: ident, msg: "index on " + ramo + ": " + titulo + "\n" });
        // árvore da pasta: índice + mudanças não preparadas
        var mapa = {}; repo.lerIndice().forEach(function (e) { if (!e.stage) mapa[e.path] = e; });
        st.naoPrep.forEach(function (m) { if (m.tipo === "D") delete mapa[m.para]; else { var h = repo.escreverObj({ type: "blob", data: m.b.texto }); mapa[m.para] = { mode: m.b.mode, hash: h, stage: 0, path: m.para }; } });
        var arvW = repo.escreverArvore(Object.keys(mapa).map(function (k) { return mapa[k]; }));
        var pais = [head, cIdx];
        if (g.o["-u"] || g.o["-a"]) { // com -u o git sempre cria o commit dos não rastreados (mesmo vazio)
          var ents = naoR.map(function (k) { var n = st.W[k]; return { mode: repo.modoNo(n), hash: repo.escreverObj({ type: "blob", data: repo.conteudoNo(n) }), stage: 0, path: k }; });
          var arvU = repo.escreverArvore(ents);
          pais.push(repo.escreverObj({ type: "commit", tree: arvU, parents: [], author: ident, committer: ident, msg: "untracked files on " + ramo + ": " + titulo + "\n" }));
        }
        var msgW = msgU ? "On " + ramo + ": " + msgU : "WIP on " + ramo + ": " + titulo;
        var cW = repo.escreverObj({ type: "commit", tree: arvW, parents: pais, author: ident, committer: ident, msg: msgW });
        var antigo = repo.resolverRef("refs/stash") || ZERO;
        repo.gravar("refs/stash", cW + "\n");
        var t = repo.arq("logs/refs/stash") || "";
        repo.gravar("logs/refs/stash", t + antigo + " " + cW + " " + ident + "\t" + msgW + "\n");
        // limpa a pasta
        var keep = g.o["-k"];
        var H = repo.arvoreDe(head);
        repo.trocarArvore(repo.arvoreDe(head), H, { forcar: true });
        if (keep) { repo.lerIndice(); }
        naoR.forEach(function (k) { repo.apagarArquivo(k); });
        if (!g.o["-q"]) io.out("Saved working directory and index state " + msgW + "\n");
        return 0;
      }
      if (sub === "pop" || sub === "apply" || sub === "drop" || sub === "show" || sub === "branch") {
        var g2 = opcoes(resto, { "--index": true, "-q": true, "-p": true, "--patch": "-p", "--stat": true });
        var nomeRamo = sub === "branch" ? g2.ops.shift() : null;
        var n = ref(g2.ops[0]);
        if (!stl.length) { if (sub === "show") { io.err("error: No stash entries found.\n"); return 1; } io.err("No stash entries found.\n"); return 1; }
        if (n < 0 || n >= stl.length) { io.err("error: " + (g2.ops[0] || "stash@{0}") + " is not a valid reference\n"); return 1; }
        var e = stl[n], cW2 = repo.ler(e.neu), nomeE = "stash@{" + n + "}";
        if (sub === "show") {
          var mud = compararMapas(repo.arvoreDe(cW2.parents[0]), repo.arvorePlana(cW2.tree), false);
          io.out(g2.o["-p"] ? repo.patch(mud) : repo.diffstat(mud)); return 0;
        }
        var nomeDrop = g2.ops[0] ? nomeE : "refs/stash@{" + n + "}";
        if (sub === "drop") { soltarStash(repo, n); io.out("Dropped " + nomeDrop + " (" + e.neu + ")\n"); return 0; }
        if (sub === "branch") {
          var rr = CMDS.switch(["-c", nomeRamo, cW2.parents[0]], io, sh); if (rr) return rr;
          sub = "pop";
        }
        // aplica: merge 3 vias (base = pai do stash, ours = HEAD, theirs = árvore do stash)
        var st2 = repo.estado(), head2 = repo.head();
        var baseS = cW2.parents[0];
        var res = repo.mesclarArvores(baseS, head2, e.neu, "Updated upstream", "Stashed changes");
        var O = repo.arvoreDe(head2), afet = [];
        Object.keys(res.mapa).forEach(function (k) { if (!O[k] || O[k].hash !== res.mapa[k].hash) afet.push(k); });
        res.conflitos.forEach(function (c) { afet.push(c.path); });
        var sujos = st2.naoPrep.concat(st2.preparado).map(function (m) { return m.para; }).filter(function (k) { return afet.indexOf(k) >= 0; });
        if (sujos.length) { io.err("error: Your local changes to the following files would be overwritten by merge:\n" + sujos.map(function (k) { return "\t" + k + "\n"; }).join("") + "Please commit your changes or stash them before you merge.\nAborting\n"); io.out("On branch " + ramo + "\n"); return 1; }
        // aplica mantendo o índice atual (o stash vira mudança não preparada, como no git sem --index)
        var idxAntes = {}; repo.lerIndice().forEach(function (x) { idxAntes[x.path + "\u0000" + x.stage] = x; });
        repo.aplicarMesclagem(head2, res);
        // o git apply sem --index: arquivos novos ficam preparados; os modificados ficam só na pasta
        var novoIdx = [], H2 = repo.arvoreDe(head2), confP = {};
        res.conflitos.forEach(function (c) { confP[c.path] = 1; });
        repo.lerIndice().forEach(function (x) {
          if (x.stage) { novoIdx.push(x); return; }
          var antes = idxAntes[x.path + "\u00000"];
          if (g2.o["--index"]) { novoIdx.push(x); return; }
          if (!H2[x.path] && !antes) { novoIdx.push(x); return; } // arquivo novo: fica preparado
          if (antes) novoIdx.push(antes); else if (H2[x.path]) novoIdx.push({ mode: H2[x.path].mode, hash: H2[x.path].hash, stage: 0, path: x.path });
        });
        Object.keys(idxAntes).forEach(function (k) { var x = idxAntes[k]; if (!x.stage && !novoIdx.some(function (y) { return y.path === x.path; }) && res.mapa[x.path]) {} });
        if (!res.conflitos.length) repo.gravarIndice(novoIdx);
        // não rastreados
        if (cW2.parents[2]) { var U = repo.arvoreDe(cW2.parents[2]); Object.keys(U).forEach(function (k) { repo.escreverArquivo(k, U[k]); }); }
        if (res.conflitos.length) {
          io.out(res.msgs.join(""));
          io.err("On branch " + ramo + "\n");
          var stc = repo.estado();
          io.out(textoStatusCurtoLongo(repo, stc));
          io.out("The stash entry is kept in case you need it again.\n");
          return 1;
        }
        io.out(res.msgs.join(""));
        // mostra o status
        CMDS.status([], io, sh);
        if (sub === "pop") { soltarStash(repo, n); io.out("Dropped " + nomeDrop + " (" + e.neu + ")\n"); }
        return 0;
      }
      if (sub === "clear") { repo.apagarArq("refs/stash"); repo.apagarArq("logs/refs/stash"); return 0; }
      io.err("error: unknown subcommand: `" + sub + "'\nusage: git stash list [<log-options>]\n   or: git stash show [-u | --include-untracked | --only-untracked] [<diff-options>] [<stash>]\n   or: git stash drop [-q | --quiet] [<stash>]\n   or: git stash pop [--index] [-q | --quiet] [<stash>]\n   or: git stash apply [--index] [-q | --quiet] [<stash>]\n   or: git stash branch <branchname> [<stash>]\n   or: git stash [push [-p | --patch] [-S | --staged] [-k | --[no-]keep-index] [-q | --quiet]\n                 [-u | --include-untracked] [-a | --all] [(-m | --message) <message>]\n                 [--pathspec-from-file=<file> [--pathspec-file-nul]]\n                 [--] [<pathspec>...]]\n   or: git stash save [-p | --patch] [-S | --staged] [-k | --[no-]keep-index] [-q | --quiet]\n                 [-u | --include-untracked] [-a | --all] [<message>]\n   or: git stash clear\n   or: git stash create [<message>]\n   or: git stash store [(-m | --message) <message>] [-q | --quiet] <commit>\n");
      return 129;
    };
    function textoStatusCurtoLongo(repo, st) { return ""; }
    function soltarStash(repo, n) {
      var t = (repo.arq("logs/refs/stash") || "").split("\n").filter(Boolean);
      var idx = t.length - 1 - n; t.splice(idx, 1);
      if (!t.length) { repo.apagarArq("refs/stash"); repo.apagarArq("logs/refs/stash"); return; }
      // refaz os "antigos" encadeados
      var ult = t[t.length - 1].split(" ")[1];
      repo.gravar("logs/refs/stash", t.join("\n") + "\n");
      repo.gravar("refs/stash", ult + "\n");
    }

    /* ---------- clean ---------- */
    CMDS.clean = function (args, io, sh) {
      var g = opcoes(args, { "-n": true, "--dry-run": "-n", "-f": true, "--force": "-f", "-d": true, "-x": true, "-X": true, "-q": true, "--quiet": "-q", "-i": true, "--interactive": "-i", "-e": "valor", "--exclude": "-e" });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var o = g.o;
      if (!o["-n"] && !o["-f"] && !o["-i"]) { io.err("fatal: clean.requireForce is true and -f not given: refusing to clean\n"); return 128; }
      if (o["-i"]) { io.err("(simulador) o modo interativo (git clean -i) faz perguntas num menu, que não existe aqui; use git clean -n para ver o que seria apagado e git clean -f para apagar.\n"); return 1; }
      var exclui = lista(o["-e"]).map(function (p) { return compilarIgnore(p, "", "-e")[0]; }).filter(Boolean);
      var st = repo.estado(), specs = g.ops.map(function (p) { return pathspec(repo, p); });
      var cands = [];
      var lst = o["-x"] ? st.naoRastr.concat(st.ignorados) : o["-X"] ? st.ignorados : st.naoRastr;
      lst = lst.slice().sort(cmpCam);
      var grupos = o["-d"] ? repo.agruparNaoRastr(lst, st.I0) : lst.filter(function (k) { var p = k.split("/"); for (var i = 1; i < p.length; i++) { if (!Object.keys(st.I0).some(function (x) { return x.indexOf(p.slice(0, i).join("/") + "/") === 0; })) return false; } return true; });
      if (!o["-d"] && !o["-x"]) {
        // sem -d, arquivos dentro de pastas rastreadas aparecem; pastas não rastreadas são puladas
      }
      grupos = grupos.filter(function (k) { return !specs.length || specs.some(function (s) { return casaSpec(s, k.replace(/\/$/, "")); }); });
      grupos = grupos.filter(function (k) { var kk = k.replace(/\/$/, ""); return !exclui.some(function (r) { return (!r.soDir || /\/$/.test(k)) && r.re.test(kk); }); });
      var out = "";
      grupos.forEach(function (k) {
        var r = repo.relCwd(k.replace(/\/$/, "")) + (/\/$/.test(k) ? "/" : "");
        if (o["-n"]) out += "Would remove " + r + "\n";
        else { if (!o["-q"]) out += "Removing " + r + "\n"; var abs = repo.absDe(k.replace(/\/$/, "")); apagar(sh, abs); }
      });
      io.out(out);
      return 0;
    };

    /* ---------- reflog ---------- */
    CMDS.reflog = function (args, io, sh) {
      var repo = precisaRepo(io);
      var sub = args[0] === "show" || args[0] === "expire" || args[0] === "delete" ? args.shift() : "show";
      if (sub !== "show") { io.err("(simulador) git reflog " + sub + " não existe aqui.\n"); return 1; }
      var alvo = args.filter(function (a) { return a[0] !== "-"; })[0] || "HEAD", n = -1;
      args.forEach(function (a, i) { var m = /^-n?(\d+)$/.exec(a); if (m) n = +m[1]; });
      var ref = alvo === "HEAD" ? "HEAD" : repo.resolverRef("refs/heads/" + alvo) ? "refs/heads/" + alvo : alvo;
      var rl = repo.reflog(ref), out = "";
      if (!rl.length && !repo.head()) { io.err("fatal: your current branch '" + repo.branchAtual() + "' does not have any commits yet\n"); return 128; }
      if (n >= 0) rl = rl.slice(0, n);
      rl.forEach(function (e, i) { out += repo.abrev(e.neu) + " " + alvo + "@{" + i + "}: " + e.msg + "\n"; });
      io.out(out); return 0;
    };

    /* ---------- rev-parse / cat-file / hash-object / ls-files / write-tree ---------- */
    CMDS["rev-parse"] = function (args, io, sh) {
      var repo = achar(sh), out = "", st = 0;
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a === "--is-inside-work-tree") { if (!repo) naoRepo(sh); out += (repo.raiz ? "true" : "false") + "\n"; continue; }
        if (!repo) naoRepo(sh);
        if (a === "--show-toplevel") { out += repo.raiz + "\n"; continue; }
        if (a === "--git-dir") { out += (repo.g === sh.cwd + "/.git" ? ".git" : repo.g) + "\n"; continue; }
        if (a === "--abbrev-ref") { var r = args[++i]; out += (r === "HEAD" ? (repo.branchAtual() || "HEAD") : r) + "\n"; continue; }
        if (a === "--short") { var r2 = args[++i] || "HEAD", h2 = repo.rev(r2); if (!h2) { io.err("fatal: Needed a single revision\n"); return 128; } out += repo.abrev(h2) + "\n"; continue; }
        if (a === "--verify") continue;
        var h = repo.rev(a);
        if (!h || h.ambiguo) { io.out(out); io.err(a + "\nfatal: ambiguous argument '" + a + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n"); return 128; }
        out += h + "\n";
      }
      io.out(out); return st;
    };
    CMDS["cat-file"] = function (args, io, sh) {
      var repo = precisaRepo(io);
      var modo = args[0], alvo = args[1];
      if (!alvo) { io.err("usage: git cat-file <type> <object>\n   or: git cat-file (-e | -p | -t | -s) <object>\n"); return 129; }
      var h = /^([^:]+):(.+)$/.test(alvo) ? (function () { var m = /^([^:]+):(.+)$/.exec(alvo), T = repo.arvoreDe(repo.commitDe(m[1])); return T[m[2]] ? T[m[2]].hash : null; })() : repo.rev(alvo);
      if (!h || h.ambiguo) { if (modo === "-e") return 1; fatal("Not a valid object name " + alvo); }
      var o = repo.ler(h);
      if (modo === "-e") return 0;
      if (modo === "-t") { io.out(o.type + "\n"); return 0; }
      if (modo === "-s") { var bo = bytesObjeto(o), z = 0; while (bo[z] !== 0) z++; io.out((bo.length - z - 1) + "\n"); return 0; }
      if (modo === "-p" || modo === o.type) {
        if (o.type === "tree") io.out(o.ents.map(function (e) { var m = e.mode === "40000" ? "040000" : e.mode; return m + " " + (m === "040000" ? "tree" : m === "160000" ? "commit" : "blob") + " " + e.hash + "\t" + e.name + "\n"; }).join(""));
        else io.out(corpoTexto(o));
        return 0;
      }
      fatal("invalid object type \"" + modo + "\"");
    };
    CMDS["hash-object"] = function (args, io, sh) {
      var w = args.indexOf("-w") >= 0, arqs = args.filter(function (a) { return a[0] !== "-"; }), usaStdin = args.indexOf("--stdin") >= 0;
      var repo = w ? precisaRepo(io) : achar(sh), out = "";
      var proc = function (txt) { var o = { type: "blob", data: txt }; out += (w ? repo.escreverObj(o) : hashObjeto(o)) + "\n"; };
      if (usaStdin) { var t = sh.k.lerTudoSync ? "" : ""; return (function* () { proc(yield* io.stdin()); io.out(out); return 0; })(); }
      for (var i = 0; i < arqs.length; i++) { var tx = lerTxt(sh, sh.abs(arqs[i])); if (tx == null) fatal("could not open '" + arqs[i] + "' for reading: Arquivo ou diretório inexistente"); proc(tx); }
      io.out(out); return 0;
    };
    CMDS["ls-files"] = function (args, io, sh) {
      var repo = precisaRepo(io), out = "", s = args.indexOf("-s") >= 0 || args.indexOf("--stage") >= 0;
      var outros = args.indexOf("-o") >= 0 || args.indexOf("--others") >= 0, ign = args.indexOf("-i") >= 0 || args.indexOf("--ignored") >= 0;
      if (outros) { var st = repo.estado(); (ign ? st.ignorados : st.naoRastr).forEach(function (k) { if (/\/$/.test(k)) Object.keys(st.W).filter(function (x) { return x.indexOf(k) === 0; }).forEach(function (x) { out += repo.relCwd(x) + "\n"; }); else out += repo.relCwd(k) + "\n"; }); io.out(out); return 0; }
      var pref = relativo(repo.raiz, sh.cwd); pref = pref === "." ? "" : pref + "/";
      repo.lerIndice().forEach(function (e) { if (pref && e.path.indexOf(pref) !== 0) return; out += (s ? e.mode + " " + e.hash + " " + e.stage + "\t" : "") + repo.relCwd(e.path) + "\n"; });
      io.out(out); return 0;
    };
    CMDS["ls-tree"] = function (args, io, sh) {
      var repo = precisaRepo(io), r = args.indexOf("-r") >= 0, nomes = args.indexOf("--name-only") >= 0, alvo = args.filter(function (a) { return a[0] !== "-"; })[0];
      if (!alvo) { io.err("usage: git ls-tree [<options>] <tree-ish> [<path>...]\n"); return 129; }
      var h = repo.rev(alvo); if (!h) fatal("Not a valid object name " + alvo);
      h = repo.descascar(h); var o = repo.ler(h); if (o.type === "commit") o = repo.ler(o.tree);
      var out = "";
      (function andar(t, pref) {
        t.ents.forEach(function (e) {
          var dir = e.mode === "40000";
          if (dir && r) { andar(repo.ler(e.hash), pref + e.name + "/"); return; }
          out += nomes ? pref + e.name + "\n" : (dir ? "040000 tree " : e.mode + " blob ") + e.hash + "\t" + pref + e.name + "\n";
        });
      })(o, "");
      io.out(out); return 0;
    };
    CMDS["check-ignore"] = function (args, io, sh) {
      var repo = precisaRepo(io), v = false, q = false, n = false, cams = [];
      args.forEach(function (a) { if (a === "-v" || a === "--verbose") v = true; else if (a === "-q" || a === "--quiet") q = true; else if (a === "-n" || a === "--non-matching") n = true; else if (a !== "--") cams.push(a); });
      if (!cams.length) { io.err("fatal: no path specified\n"); return 128; }
      var achou = false, out = "";
      cams.forEach(function (c) {
        var k = pathspec(repo, c), no = noDe(sh, repo.absDe(k)), dir = !!(no && no.t === "d");
        var rastr = repo.lerIndice().some(function (e) { return e.path === k; });
        var regra = rastr ? null : (function () { var p = k.split("/"); for (var i = 1; i < p.length; i++) { var r0 = repo.regraIgnore(p.slice(0, i).join("/"), true); if (r0 && !r0.neg) return r0; } return repo.regraIgnore(k, dir); })();
        if (regra && (!regra.neg || v)) { if (!regra.neg) achou = true; out += v ? regra.origem + ":" + regra.linha + ":" + regra.texto + "\t" + c + "\n" : (regra.neg ? "" : c + "\n"); }
        else if (n && v) out += "::\t" + c + "\n";
      });
      if (!q) io.out(out);
      return achou ? 0 : 1;
    };
    CMDS["write-tree"] = function (args, io, sh) { var repo = precisaRepo(io); io.out(repo.escreverArvore(repo.lerIndice()) + "\n"); return 0; };
    CMDS["merge-base"] = function (args, io, sh) { var repo = precisaRepo(io); var a = repo.commitDe(args[0]), b = repo.commitDe(args[1]); var m = a && b ? repo.mergeBase(a, b) : null; if (!m) return 1; io.out(m + "\n"); return 0; };
    CMDS["rev-list"] = function (args, io, sh) {
      var repo = precisaRepo(io), cnt = args.indexOf("--count") >= 0, incl = [], excl = [];
      args.filter(function (a) { return a[0] !== "-"; }).forEach(function (r) { var m = /^(.*)\.\.(.*)$/.exec(r); if (m) { excl.push(repo.commitDe(m[1] || "HEAD")); incl.push(repo.commitDe(m[2] || "HEAD")); } else if (r[0] === "^") excl.push(repo.commitDe(r.slice(1))); else { var h = repo.commitDe(r); if (!h) fatal("ambiguous argument '" + r + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'"); incl.push(h); } });
      if (args.indexOf("--all") >= 0) repo.listarRefs("refs/heads/").forEach(function (x) { incl.push(x.hash); });
      var l = repo.revList(incl, excl, {});
      io.out(cnt ? l.length + "\n" : l.map(function (h) { return h + "\n"; }).join("")); return 0;
    };

    /* ---------- remotos: o "GitHub" do simulador ----------
       Os repositórios do "servidor" ficam num sistema de arquivos escondido (sh.k.github), fora da
       árvore que a Ana vê: /repos/DONO/REPO.git (bare). O Bruno mora no mesmo lugar (/home/bruno). */
    function raizGithub(k) {
      if (!k.github) {
        var r = mkD(0, 493, k.clock);
        r.c.repos = mkD(UID, 509, k.clock); r.c.home = mkD(0, 493, k.clock); r.c.tmp = mkD(UID, 1023, k.clock);
        r.c.dev = mkD(0, 493, k.clock); r.c.dev.c["null"] = { t: "c", dev: "null", m: 438, u: 0, g: 0, mt: k.clock, ct: k.clock, at: k.clock, ino: 1, nl: 1 };
        ["usr", "bin", "sbin", "lib", "etc"].forEach(function (d) { if (k.fs && k.fs.c[d]) r.c[d] = k.fs.c[d]; }); // os programas são os mesmos da máquina da Ana
        var b = mkD(UID, 488, k.clock); r.c.home.c.bruno = b;
        b.c[".gitconfig"] = mkF(UID, 420, "[user]\n\tname = Bruno Lima\n\temail = bruno@exemplo.com\n[init]\n\tdefaultBranch = main\n", k.clock);
        k.github = r;
      }
      return k.github;
    }
    function shServidor(sh) { var s = Object.create(sh); s.fs = raizGithub(sh.k); s.cwd = "/"; return s; }
    var RE_GH = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
    // abre o repositório de uma URL (GitHub do simulador ou caminho local). Devolve Repo ou null
    function abrirUrl(sh, url) {
      var m = RE_GH.exec(url);
      if (m) { var s = shServidor(sh), p = "/repos/" + m[1] + "/" + m[2] + ".git", n = noDe(s, p); return n && n.t === "d" && n.c.HEAD ? new Repo(s, p, null) : null; }
      if (/^(git@|ssh:\/\/)/.test(url)) return { ssh: true };
      if (/^[a-z]+:\/\//.test(url) && !/^file:\/\//.test(url)) return { semRede: true };
      var abs = sh.abs(url.replace(/^file:\/\//, ""));
      var n2 = noDe(sh, abs); if (!n2 || n2.t !== "d") return null;
      if (n2.c[".git"] && n2.c[".git"].t === "d" && n2.c[".git"].c.HEAD) return new Repo(sh, abs + "/.git", abs);
      if (n2.c.HEAD && n2.c.objects && n2.c.refs) return new Repo(sh, abs, null);
      return null;
    }
    function urlExibicao(url) { return url.replace(/\/+$/, "").replace(/\.git$/, ""); }
    function erroUrl(io, url, r) {
      if (r && r.ssh) { io.err("ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n"); return 128; }
      if (r && r.semRede) { io.err("fatal: unable to access '" + url + "/': Could not resolve host: " + url.replace(/^[a-z]+:\/\/([^/]+).*$/, "$1") + "\n"); return 128; }
      if (RE_GH.test(url)) { io.err("remote: Repository not found.\nfatal: repository '" + url.replace(/\/?$/, "/") + "' not found\n"); return 128; }
      io.err("fatal: '" + url + "' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n"); return 128;
    }
    function copiarObjetos(de, para) {
      de.todosObjetos().forEach(function (h) {
        var cam = "objects/" + h.slice(0, 2) + "/" + h.slice(2);
        if (!para.existe(cam)) escreverTxt(para.sh, para.g + "/" + cam, de.arq(cam), 292);
      });
      para._todos = null;
    }
    function remotosConfig(repo) { var r = []; repo.configTodas().forEach(function (e) { var m = /^remote\.(.*)\.url$/.exec(e.k); if (m && r.indexOf(m[1]) < 0) r.push(m[1]); }); return r.sort(); }
    // remove ou renomeia uma seção inteira de .git/config
    function editarSecao(txt, secao, novaSecao) {
      var linhas = (txt || "").split("\n"), res = [], dentro = false;
      if (linhas[linhas.length - 1] === "") linhas.pop();
      linhas.forEach(function (l) {
        var m = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(l);
        if (m) { var nome = m[1].toLowerCase() + (m[2] !== undefined ? "." + m[2] : ""); dentro = nome === secao; if (dentro && novaSecao) { var i = novaSecao.indexOf("."); res.push("[" + novaSecao.slice(0, i) + " \"" + novaSecao.slice(i + 1) + "\"]"); return; } }
        if (dentro && !novaSecao) return;
        res.push(l);
      });
      return res.length ? res.join("\n") + "\n" : "";
    }
    function refsServidor(srv) { var r = {}; srv.listarRefs("refs/heads/").forEach(function (x) { r[x.nome] = x.hash; }); srv.listarRefs("refs/tags/").forEach(function (x) { r[x.nome] = x.hash; }); return r; }

    CMDS.remote = function (args, io, sh) {
      var repo = precisaRepo(io), sub = args[0], v = false;
      if (sub === "-v" || sub === "--verbose") { v = true; sub = args[1]; args = args.slice(1); }
      var nomes = remotosConfig(repo);
      if (!sub) {
        io.out(nomes.map(function (n) { return v ? n + "\t" + repo.config("remote." + n + ".url") + " (fetch)\n" + n + "\t" + (repo.config("remote." + n + ".pushurl") || repo.config("remote." + n + ".url")) + " (push)\n" : n + "\n"; }).join(""));
        return 0;
      }
      var a = args.slice(1), cfg = repo.arq("config");
      if (sub === "add") {
        var g = opcoes(a, { "-f": true, "-t": "valor", "-m": "valor", "--fetch": "-f" }); if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
        if (g.ops.length !== 2) { io.err("usage: git remote add [<options>] <name> <url>\n"); return 129; }
        var n = g.ops[0];
        if (nomes.indexOf(n) >= 0) { io.err("error: remote " + n + " already exists.\n"); return 3; }
        if (!nomeRefValido(n)) { io.err("error: '" + n + "' is not a valid remote name\n"); return 128; }
        cfg = gravarConfig(cfg, "remote." + n + ".url", g.ops[1]).txt;
        cfg = gravarConfig(cfg, "remote." + n + ".fetch", "+refs/heads/*:refs/remotes/" + n + "/*").txt;
        repo.gravar("config", cfg);
        if (g.o["-f"]) return CMDS.fetch([n], io, sh);
        return 0;
      }
      if (sub === "remove" || sub === "rm") {
        var n2 = a[0];
        if (!n2) { io.err("usage: git remote remove <name>\n"); return 129; }
        if (nomes.indexOf(n2) < 0) { io.err("error: No such remote: '" + n2 + "'\n"); return 2; }
        cfg = editarSecao(cfg, "remote." + n2);
        parseConfig(cfg).forEach(function (e) { var m = /^branch\.(.*)\.remote$/.exec(e.k); if (m && e.v === n2) { cfg = gravarConfig(cfg, "branch." + m[1] + ".remote", null).txt; cfg = gravarConfig(cfg, "branch." + m[1] + ".merge", null).txt; } });
        repo.gravar("config", cfg);
        apagarRefsRemoto(repo, n2);
        return 0;
      }
      if (sub === "rename") {
        var ve = a[0], nv = a[1];
        if (!ve || !nv) { io.err("usage: git remote rename [--[no-]progress] <old> <new>\n"); return 129; }
        if (nomes.indexOf(ve) < 0) { io.err("error: No such remote: '" + ve + "'\n"); return 2; }
        if (nomes.indexOf(nv) >= 0) { io.err("error: remote " + nv + " already exists.\n"); return 3; }
        cfg = editarSecao(cfg, "remote." + ve, "remote." + nv);
        cfg = gravarConfig(cfg, "remote." + nv + ".fetch", "+refs/heads/*:refs/remotes/" + nv + "/*").txt;
        parseConfig(cfg).forEach(function (e) { var m = /^branch\.(.*)\.remote$/.exec(e.k); if (m && e.v === ve) cfg = gravarConfig(cfg, "branch." + m[1] + ".remote", nv).txt; });
        repo.gravar("config", cfg);
        repo.listarRefs("refs/remotes/" + ve + "/").forEach(function (r) { var t = repo.lerRef(r.nome); repo.apagarArq(r.nome); repo.gravar(r.nome.replace("refs/remotes/" + ve + "/", "refs/remotes/" + nv + "/"), t && t.simb ? "ref: " + t.simb.replace("refs/remotes/" + ve + "/", "refs/remotes/" + nv + "/") + "\n" : r.hash + "\n"); });
        return 0;
      }
      if (sub === "get-url") { var u = repo.config("remote." + a[0] + ".url"); if (u === null) { io.err("error: No such remote '" + a[0] + "'\n"); return 2; } io.out(u + "\n"); return 0; }
      if (sub === "set-url") {
        if (nomes.indexOf(a[0]) < 0) { io.err("error: No such remote '" + a[0] + "'\n"); return 2; }
        repo.gravar("config", gravarConfig(cfg, "remote." + a[0] + ".url", a[1]).txt); return 0;
      }
      if (sub === "show") {
        var n3 = a[0];
        if (!n3) { io.out(nomes.map(function (x) { return x + "\n"; }).join("")); return 0; }
        if (nomes.indexOf(n3) < 0) { var r0 = abrirUrl(sh, n3); if (!r0 || r0.ssh || r0.semRede) return erroUrl(io, n3, r0); }
        var url = repo.config("remote." + n3 + ".url"), srv = abrirUrl(sh, url);
        if (!srv || srv.ssh || srv.semRede) return erroUrl(io, url, srv);
        var rs = refsServidor(srv), ramosS = Object.keys(rs).filter(function (k) { return k.indexOf("refs/heads/") === 0; }).map(function (k) { return k.slice(11); }).sort();
        var hs = srv.headRef(), s = "* remote " + n3 + "\n  Fetch URL: " + url + "\n  Push  URL: " + url + "\n  HEAD branch: " + (hs && srv.resolverRef(hs) ? hs.slice(11) : "(unknown)") + "\n";
        if (ramosS.length) {
          s += "  Remote branch" + (ramosS.length > 1 ? "es" : "") + ":\n";
          var lw = 0; ramosS.forEach(function (b) { lw = Math.max(lw, b.length); });
          ramosS.forEach(function (b) { s += "    " + b + rep(" ", lw - b.length) + " " + (repo.resolverRef("refs/remotes/" + n3 + "/" + b) ? "tracked" : "new (next fetch will store in remotes/" + n3 + ")") + "\n"; });
        }
        var locais = repo.listarRefs("refs/heads/").map(function (r) { return r.nome.slice(11); }).filter(function (b) { return repo.config("branch." + b + ".remote") === n3; });
        if (locais.length) {
          s += "  Local branch" + (locais.length > 1 ? "es" : "") + " configured for 'git pull':\n";
          var lw2 = 0; locais.forEach(function (b) { lw2 = Math.max(lw2, b.length); });
          locais.forEach(function (b) { s += "    " + b + rep(" ", lw2 - b.length) + " merges with remote " + repo.config("branch." + b + ".merge").replace(/^refs\/heads\//, "") + "\n"; });
        }
        var pushs = repo.listarRefs("refs/heads/").map(function (r) { return r.nome.slice(11); }).filter(function (b) { return rs["refs/heads/" + b]; });
        if (pushs.length) {
          s += "  Local ref" + (pushs.length > 1 ? "s" : "") + " configured for 'git push':\n";
          var lw3 = 0, lw4 = 0; pushs.forEach(function (b) { lw3 = Math.max(lw3, b.length); lw4 = Math.max(lw4, b.length); });
          pushs.forEach(function (b) {
            var lh = repo.resolverRef("refs/heads/" + b), rh = rs["refs/heads/" + b];
            var est = lh === rh ? "up to date" : repo.ehAncestral(rh, lh) ? "fast-forwardable" : srv.ler(lh) && srv.ehAncestral(lh, rh) ? "local out of date" : "local out of date";
            s += "    " + b + rep(" ", lw3 - b.length) + " pushes to " + b + rep(" ", lw4 - b.length) + " (" + est + ")\n";
          });
        }
        io.out(s); return 0;
      }
      if (sub === "prune") return CMDS.fetch(["--prune", a[0]], io, sh);
      io.err("error: unknown subcommand: `" + sub + "'\nusage: git remote [-v | --verbose]\n   or: git remote add [-t <branch>] [-m <master>] [-f] [--tags | --no-tags] [--mirror=<fetch|push>] <name> <url>\n   or: git remote rename [--[no-]progress] <old> <new>\n   or: git remote remove <name>\n   or: git remote set-head <name> (-a | --auto | -d | --delete | <branch>)\n   or: git remote [-v | --verbose] show [-n] <name>\n   or: git remote prune [-n | --dry-run] <name>\n   or: git remote [-v | --verbose] update [-p | --prune] [(<group> | <remote>)...]\n   or: git remote set-branches [--add] <name> <branch>...\n   or: git remote get-url [--push] [--all] <name>\n   or: git remote set-url [--push] <name> <newurl> [<oldurl>]\n   or: git remote set-url --add <name> <newurl>\n   or: git remote set-url --delete <name> <url>\n");
      return 129;
    };
    function apagarRefsRemoto(repo, n) {
      repo.listarRefs("refs/remotes/" + n + "/").forEach(function (r) { repo.apagarArq(r.nome); repo.apagarArq("logs/" + r.nome); });
      var hn = repo.lerRef("refs/remotes/" + n + "/HEAD"); if (hn) repo.apagarArq("refs/remotes/" + n + "/HEAD");
      apagar(repo.sh, repo.g + "/refs/remotes/" + n);
    }

    CMDS.clone = function (args, io, sh) {
      var g = opcoes(args, { "-q": true, "--quiet": "-q", "-b": "valor", "--branch": "-b", "--bare": true, "--depth": "valor", "-o": "valor", "--origin": "-o", "--single-branch": true, "--no-checkout": true, "-n": "--no-checkout", "--recurse-submodules": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      if (!g.ops.length) { io.err("fatal: You must specify a repository to clone.\n\nusage: git clone [<options>] [--] <repo> [<dir>]\n"); return 129; }
      var url = g.ops[0], nomeR = g.o["-o"] || "origin";
      var dir = g.ops[1] || url.replace(/\/+$/, "").replace(/\.git$/, "").replace(/^.*[\/:]/, "") + (g.o["--bare"] ? ".git" : "");
      var absD = sh.abs(dir), nd = noDe(sh, absD);
      if (nd && (nd.t !== "d" || Object.keys(nd.c).length)) { io.err("fatal: destination path '" + dir + "' already exists and is not an empty directory.\n"); return 128; }
      var srv = abrirUrl(sh, url);
      if (!g.o["-q"]) io.err("Cloning into " + (g.o["--bare"] ? "bare repository " : "") + "'" + dir + "'...\n");
      if (!srv || srv.ssh || srv.semRede) {
        if (srv && srv.ssh) return erroUrl(io, url, srv);
        if (!RE_GH.test(url) && !(srv && srv.semRede)) { io.err("fatal: repository '" + url + "' does not exist\n"); return 128; }
        return erroUrl(io, url, srv);
      }
      var ehUrlLocal = !RE_GH.test(url) && !/^file:/.test(url);
      var urlCfg = ehUrlLocal ? sh.abs(url).replace(/\/\.git$/, "") : url;
      if (ehUrlLocal) urlCfg = url[0] === "/" ? url : sh.abs(url);
      // cria o repositório
      var r = CMDS.init(g.o["--bare"] ? ["-q", "--bare", dir] : ["-q", dir], { sh: sh, out: function () {}, err: function () {} }, sh);
      var cwd0 = sh.cwd;
      var repo = new Repo(sh, g.o["--bare"] ? absD : absD + "/.git", g.o["--bare"] ? null : absD);
      var cfg = repo.arq("config");
      if (!g.o["--bare"]) {
        cfg = gravarConfig(cfg, "remote." + nomeR + ".url", ehUrlLocal ? urlCfg : url).txt;
        cfg = gravarConfig(cfg, "remote." + nomeR + ".fetch", "+refs/heads/*:refs/remotes/" + nomeR + "/*").txt;
      }
      copiarObjetos(srv, repo);
      var rs = refsServidor(srv), hsRef = srv.headRef(), hs = hsRef && srv.resolverRef(hsRef);
      var vazio = !Object.keys(rs).length;
      var ramo = g.o["-b"] || (hsRef ? hsRef.slice(11) : "main");
      if (g.o["-b"] && !rs["refs/heads/" + ramo] && !rs["refs/tags/" + ramo]) { io.err("warning: Could not find remote branch " + ramo + " to clone.\nfatal: Remote branch " + ramo + " not found in upstream origin\n"); apagar(sh, absD); return 128; }
      Object.keys(rs).forEach(function (k) {
        if (g.o["--bare"]) { repo.gravar(k, rs[k] + "\n"); return; }
        if (k.indexOf("refs/heads/") === 0) repo.gravarRef("refs/remotes/" + nomeR + "/" + k.slice(11), rs[k], "clone: from " + urlCfg, ZERO);
        else repo.gravar(k, rs[k] + "\n");
      });
      if (vazio) { repo.gravar("HEAD", "ref: refs/heads/" + ramo + "\n"); if (!g.o["--bare"]) { cfg = gravarConfig(cfg, "branch." + ramo + ".remote", nomeR).txt; cfg = gravarConfig(cfg, "branch." + ramo + ".merge", "refs/heads/" + ramo).txt; } repo.gravar("config", cfg); io.err("warning: You appear to have cloned an empty repository.\n"); return 0; }
      if (g.o["--bare"]) { repo.gravar("HEAD", "ref: refs/heads/" + ramo + "\n"); return 0; }
      if (hsRef && hs) repo.gravar("refs/remotes/" + nomeR + "/HEAD", "ref: refs/remotes/" + nomeR + "/" + hsRef.slice(11) + "\n");
      var hRamo = rs["refs/heads/" + ramo] || rs["refs/tags/" + ramo];
      if (rs["refs/heads/" + ramo]) {
        repo.gravarRef("refs/heads/" + ramo, hRamo, "clone: from " + urlCfg, ZERO);
        repo.gravar("HEAD", "ref: refs/heads/" + ramo + "\n");
        cfg = gravarConfig(cfg, "branch." + ramo + ".remote", nomeR).txt;
        cfg = gravarConfig(cfg, "branch." + ramo + ".merge", "refs/heads/" + ramo).txt;
      } else repo.gravar("HEAD", repo.descascar(hRamo) + "\n");
      repo.gravar("config", cfg);
      repo.logar("HEAD", ZERO, repo.descascar(hRamo), "clone: from " + urlCfg);
      if (ehUrlLocal && !g.o["-q"]) io.err("done.\n");
      if (!g.o["--no-checkout"]) {
        var T = repo.arvoreDe(repo.descascar(hRamo));
        Object.keys(T).forEach(function (k) { repo.escreverArquivo(k, T[k]); });
        repo.gravarIndice(Object.keys(T).map(function (k) { return { mode: T[k].mode, hash: T[k].hash, stage: 0, path: k }; }));
      }
      return 0;
    };

    // fetch: traz objetos e atualiza refs/remotes/NOME/*. Devolve {linhas, erro}
    function buscar(repo, io, sh, nomeR, opt) {
      opt = opt || {};
      var url = repo.config("remote." + nomeR + ".url"), urlReal = url || nomeR;
      var srv = abrirUrl(sh, urlReal);
      if (!srv || srv.ssh || srv.semRede) return { st: erroUrl(io, urlReal, srv) };
      copiarObjetos(srv, repo);
      var rs = refsServidor(srv), linhas = [], fetchHead = [];
      Object.keys(rs).sort(function (a, b) { var ta = a.indexOf("refs/tags/") === 0, tb = b.indexOf("refs/tags/") === 0; return ta - tb || cmpCam(a, b); }).forEach(function (k) {
        var h = rs[k];
        if (k.indexOf("refs/heads/") === 0) {
          var b = k.slice(11);
          fetchHead.push(h + "\t\tbranch '" + b + "' of " + urlExibicao(urlReal));
          if (!url) return;
          var loc = "refs/remotes/" + nomeR + "/" + b, antigo = repo.resolverRef(loc);
          if (antigo === h) return;
          if (!antigo) { linhas.push(" * [new branch]      " + pad(b, 10) + " -> " + nomeR + "/" + b); repo.gravarRef(loc, h, "fetch: storing head", ZERO); }
          else if (repo.ehAncestral(antigo, h)) { linhas.push("   " + repo.abrev(antigo) + ".." + repo.abrev(h) + "  " + pad(b, 10) + " -> " + nomeR + "/" + b); repo.gravarRef(loc, h, "fetch: fast-forward", antigo); }
          else { linhas.push(" + " + repo.abrev(antigo) + "..." + repo.abrev(h) + " " + pad(b, 10) + " -> " + nomeR + "/" + b + "  (forced update)"); repo.gravarRef(loc, h, "fetch: forced-update", antigo); }
        } else if (k.indexOf("refs/tags/") === 0 && !opt.semTags) {
          var t = k.slice(10);
          if (repo.resolverRef(k)) return;
          linhas.push(" * [new tag]         " + pad(t, 10) + " -> " + t); repo.gravar(k, h + "\n");
        }
      });
      if (opt.prune && url) repo.listarRefs("refs/remotes/" + nomeR + "/").forEach(function (r) { var b = r.nome.slice(("refs/remotes/" + nomeR + "/").length); if (b === "HEAD") return; if (!rs["refs/heads/" + b]) { linhas.push(" - [deleted]         " + pad("(none)", 10) + " -> " + nomeR + "/" + b); repo.apagarArq(r.nome); repo.apagarArq("logs/" + r.nome); } });
      repo.gravar("FETCH_HEAD", fetchHead.join("\n") + (fetchHead.length ? "\n" : ""));
      var hsRef = srv.headRef();
      if (url && hsRef && srv.resolverRef(hsRef) && !repo.lerRef("refs/remotes/" + nomeR + "/HEAD") && repo.resolverRef("refs/remotes/" + nomeR + "/" + hsRef.slice(11))) repo.gravar("refs/remotes/" + nomeR + "/HEAD", "ref: refs/remotes/" + nomeR + "/" + hsRef.slice(11) + "\n");
      return { st: 0, linhas: linhas, url: urlReal, rs: rs, srv: srv };
    }
    function pad(s, n) { while (s.length < n) s += " "; return s; }
    CMDS.fetch = function (args, io, sh) {
      var g = opcoes(args, { "--all": true, "--prune": true, "-p": "--prune", "-q": true, "--quiet": "-q", "--tags": true, "-t": "--tags", "-v": true, "--dry-run": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io), nomes = remotosConfig(repo);
      var alvos = g.o["--all"] ? nomes : [g.ops[0] || (repo.branchAtual() && repo.config("branch." + repo.branchAtual() + ".remote")) || "origin"];
      if (!g.ops[0] && !g.o["--all"] && !nomes.length) { io.err("fatal: No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.\n"); return 128; }
      for (var i = 0; i < alvos.length; i++) {
        var r = buscar(repo, io, sh, alvos[i], { prune: g.o["--prune"] });
        if (r.st) return r.st;
        if (r.linhas.length && !g.o["-q"]) io.err("From " + urlExibicao(r.url) + "\n" + r.linhas.join("\n") + "\n");
      }
      return 0;
    };

    function hintDivergente() {
      return "hint: You have divergent branches and need to specify how to reconcile them.\nhint: You can do so by running one of the following commands sometime before\nhint: your next pull:\nhint:\nhint:   git config pull.rebase false  # merge\nhint:   git config pull.rebase true   # rebase\nhint:   git config pull.ff only       # fast-forward only\nhint:\nhint: You can replace \"git config\" with \"git config --global\" to set a default\nhint: preference for all repositories. You can also pass --rebase, --no-rebase,\nhint: or --ff-only on the command line to override the configured default per\nhint: invocation.\nfatal: Need to specify how to reconcile divergent branches.\n";
    }
    CMDS.pull = function (args, io, sh) {
      var g = opcoes(args, { "--rebase": "opcional", "-r": "--rebase", "--no-rebase": true, "--ff-only": true, "--ff": true, "--no-ff": true, "-q": true, "--quiet": "-q", "--no-edit": true, "--edit": true, "--allow-unrelated-histories": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var ramo = repo.branchAtual(), nomeR = g.ops[0], ramoR = g.ops[1];
      if (!nomeR) {
        if (!ramo) { io.err("You are not currently on a branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\n"); return 1; }
        nomeR = repo.config("branch." + ramo + ".remote");
        if (!nomeR) {
          if (!remotosConfig(repo).length) { io.err("fatal: No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.\n"); return 128; }
          io.err("There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=origin/<branch> " + ramo + "\n\n"); return 1;
        }
        ramoR = repo.config("branch." + ramo + ".merge").replace(/^refs\/heads\//, "");
      }
      var r = buscar(repo, io, sh, nomeR, {});
      if (r.st) return r.st;
      if (r.linhas.length && !g.o["-q"]) io.err("From " + urlExibicao(r.url) + "\n" + r.linhas.join("\n") + "\n");
      if (!ramoR) ramoR = ramo;
      var ht = r.rs["refs/heads/" + ramoR];
      if (!ht) { io.err("fatal: couldn't find remote ref " + ramoR + "\n"); return 1; }
      var head = repo.head();
      if (!head) { return CMDS.merge([ht], io, sh); }
      if (repo.ehAncestral(ht, head)) { io.out("Already up to date.\n"); return 0; }
      var ff = repo.ehAncestral(head, ht);
      var rebase = g.o["--rebase"] !== undefined && g.o["--rebase"] !== false ? true : g.o["--no-rebase"] ? false : null;
      if (rebase === null) { var pr = repo.config("pull.rebase"); if (pr !== null) rebase = pr === "true" || pr === "merges" || pr === "interactive"; }
      var soFF = g.o["--ff-only"] || (rebase === null && repo.config("pull.ff") === "only");
      if (!ff && soFF) { io.err("hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with \"git config set advice.diverging false\"\nfatal: Not possible to fast-forward, aborting.\n"); return 128; }
      if (!ff && rebase === null) { io.err(hintDivergente()); return 128; }
      var rotulo = (r.url === nomeR || !repo.config("remote." + nomeR + ".url")) ? ramoR : nomeR + "/" + ramoR;
      if (rebase && !ff) return CMDS.rebase([ht], io, sh); // gerador: o EXT.git roda
      var msg = "Merge branch '" + ramoR + "' of " + urlExibicao(r.url) + (ramo !== "main" && ramo !== "master" ? " into " + ramo : "");
      var aa = [ht, "-m", msg]; if (g.o["--no-ff"]) aa.push("--no-ff"); if (g.o["-q"]) aa.push("-q");
      return CMDS.merge(aa, io, sh);
    };

    CMDS.push = function (args, io, sh) {
      var g = opcoes(args, { "-u": true, "--set-upstream": "-u", "-f": true, "--force": "-f", "--force-with-lease": "opcional", "--all": true, "--tags": true, "-d": true, "--delete": "-d", "-q": true, "--quiet": "-q", "-v": true, "--dry-run": true, "-n": "--dry-run", "--no-verify": true, "--follow-tags": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io), ramo = repo.branchAtual(), nomes = remotosConfig(repo);
      var nomeR = g.ops[0], specs = g.ops.slice(1);
      if (!nomeR) {
        nomeR = ramo && repo.config("branch." + ramo + ".remote");
        if (!nomeR) {
          if (!nomes.length) { io.err("fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>\n\n"); return 128; }
          if (nomes.length === 1 || nomes.indexOf("origin") >= 0) nomeR = nomes.indexOf("origin") >= 0 ? "origin" : nomes[0];
        }
      }
      var url = repo.config("remote." + nomeR + ".url"), urlReal = url || nomeR;
      if (!specs.length && !g.o["--all"] && !g.o["--tags"]) {
        if (!ramo) { io.err("fatal: You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    git push " + nomeR + " HEAD:<name-of-remote-branch>\n\n"); return 128; }
        var upR = repo.config("branch." + ramo + ".remote"), upM = repo.config("branch." + ramo + ".merge");
        if (!g.o["-u"] && (!upR || !upM) && url) { io.err("fatal: The current branch " + ramo + " has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream " + nomeR + " " + ramo + "\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n\n"); return 128; }
        specs = [ramo + ":" + (upM && upR === nomeR ? upM.replace(/^refs\/heads\//, "") : ramo)];
      }
      var srv = abrirUrl(sh, urlReal);
      if (!srv || srv.ssh || srv.semRede) return erroUrl(io, urlReal, srv);
      if (g.o["--all"]) specs = repo.listarRefs("refs/heads/").map(function (r) { return r.nome.slice(11); });
      var itens = [];
      specs.forEach(function (sp) {
        var forca = sp[0] === "+"; if (forca) sp = sp.slice(1);
        var i = sp.indexOf(":"), src = i < 0 ? sp : sp.slice(0, i), dst = i < 0 ? sp : sp.slice(i + 1);
        if (g.o["-d"]) { itens.push({ del: true, dst: "refs/heads/" + src, nome: src }); return; }
        if (src === "" ) { itens.push({ del: true, dst: "refs/heads/" + dst, nome: dst }); return; }
        if (src === "HEAD") src = ramo || "HEAD";
        var ehTag = !repo.resolverRef("refs/heads/" + src) && repo.resolverRef("refs/tags/" + src);
        var h = ehTag ? repo.resolverRef("refs/tags/" + src) : repo.resolverRef("refs/heads/" + src) || repo.commitDe(src);
        if (!h) { itens.push({ erro: "error: src refspec " + src + " does not match any" }); return; }
        if (dst === "HEAD") dst = ramo;
        itens.push({ h: h, src: src, dst: (ehTag ? "refs/tags/" : "refs/heads/") + dst.replace(/^refs\/(heads|tags)\//, ""), nome: dst.replace(/^refs\/(heads|tags)\//, ""), tag: ehTag, forca: forca || g.o["-f"] || g.o["--force-with-lease"] !== undefined });
      });
      if (g.o["--tags"] || g.o["--follow-tags"]) repo.listarRefs("refs/tags/").forEach(function (t) { itens.push({ h: t.hash, src: t.nome.slice(10), dst: t.nome, nome: t.nome.slice(10), tag: true }); });
      var erros = itens.filter(function (x) { return x.erro; });
      if (erros.length) { io.err(erros.map(function (x) { return x.erro + "\n"; }).join("") + "error: failed to push some refs to '" + urlReal + "'\n"); return 1; }
      var linhas = [], rejeitado = null, rs = refsServidor(srv), avisoPR = [];
      if (!g.o["--dry-run"]) copiarObjetos(repo, srv);
      itens.forEach(function (x) {
        var antigo = rs[x.dst], seta = x.src === x.nome || x.del ? x.nome : x.src + " -> " + x.nome;
        if (x.del) {
          if (!antigo) { linhas.push(" ! [remote rejected] " + x.nome + " (remote ref does not exist)"); rejeitado = rejeitado || "del"; return; }
          linhas.push(" - [deleted]         " + x.nome); if (!g.o["--dry-run"]) { srv.apagarArq(x.dst); if (url) { repo.apagarArq("refs/remotes/" + nomeR + "/" + x.nome); repo.apagarArq("logs/refs/remotes/" + nomeR + "/" + x.nome); } } return;
        }
        var desc = x.src + " -> " + x.nome;
        if (antigo === x.h) { if (g.o["-v"]) linhas.push(" = [up to date]      " + desc); x.igual = true; return; }
        if (!antigo) {
          linhas.push(" * [new " + (x.tag ? "tag" : "branch") + "]" + (x.tag ? "         " : "      ") + desc);
          if (!x.tag && srv.headRef() !== x.dst) avisoPR.push(x.nome);
        } else if (x.tag) { if (!x.forca) { linhas.push(" ! [rejected]        " + desc + " (already exists)"); rejeitado = rejeitado || "tag"; return; } linhas.push(" + " + repo.abrev(antigo) + "..." + repo.abrev(x.h) + " " + desc + " (forced update)"); }
        else if (repo.ler(antigo) && repo.ehAncestral(antigo, x.h)) linhas.push("   " + repo.abrev(antigo) + ".." + repo.abrev(x.h) + "  " + desc);
        else if (x.forca) {
          var lease = g.o["--force-with-lease"];
          if (lease !== undefined) { var esperado = repo.resolverRef("refs/remotes/" + nomeR + "/" + x.nome); if (esperado !== antigo) { linhas.push(" ! [rejected]        " + desc + " (stale info)"); rejeitado = rejeitado || "stale"; return; } }
          linhas.push(" + " + srv.abrev(antigo) + "..." + repo.abrev(x.h) + " " + desc + " (forced update)");
        } else { var temLocal = !!repo.ler(antigo); linhas.push(" ! [rejected]        " + desc + (temLocal ? " (non-fast-forward)" : " (fetch first)")); rejeitado = rejeitado || (temLocal ? "nff" : "fetch"); return; }
        if (!g.o["--dry-run"]) {
          srv.gravar(x.dst, x.h + "\n");
          if (url && !x.tag) repo.gravarRef("refs/remotes/" + nomeR + "/" + x.nome, x.h, "update by push", repo.resolverRef("refs/remotes/" + nomeR + "/" + x.nome) || ZERO);
        }
      });
      var todosIguais = itens.length && itens.every(function (x) { return x.igual; });
      if (todosIguais && !rejeitado) { io.err("Everything up-to-date\n"); }
      else {
        var s = "";
        if (avisoPR.length && RE_GH.test(urlReal) && !g.o["--dry-run"]) {
          var m = RE_GH.exec(urlReal);
          avisoPR.forEach(function (b) { s += "remote: \nremote: Create a pull request for '" + b + "' on GitHub by visiting:        \nremote:      https://github.com/" + m[1] + "/" + m[2] + "/pull/new/" + b + "        \nremote: \n"; });
        }
        if (!g.o["-q"] || rejeitado) s += "To " + urlReal + "\n" + linhas.join("\n") + (linhas.length ? "\n" : "");
        if (rejeitado) {
          s += "error: failed to push some refs to '" + urlReal + "'\n";
          if (rejeitado === "fetch") s += "hint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n";
          else if (rejeitado === "nff") s += "hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes,\nhint: use 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n";
          else if (rejeitado === "tag") s += "hint: Updates were rejected because the tag already exists in the remote.\n";
        }
        io.err(s);
      }
      if (g.o["-u"] && !rejeitado && url) {
        var quieto = g.o["-q"];
        var out = "";
        itens.forEach(function (x) { if (x.del || x.tag || x.erro || !repo.resolverRef("refs/heads/" + x.src)) return; definirUpstream(repo, x.src, nomeR, x.nome); if (!quieto) out += "branch '" + x.src + "' set up to track '" + nomeR + "/" + x.nome + "'.\n"; });
        io.out(out);
      }
      return rejeitado ? 1 : 0;
    };
    CMDS["ls-remote"] = function (args, io, sh) {
      var repo = achar(sh), alvo = args.filter(function (a) { return a[0] !== "-"; })[0] || "origin";
      var url = repo && repo.config("remote." + alvo + ".url") || alvo, srv = abrirUrl(sh, url);
      if (!srv || srv.ssh || srv.semRede) return erroUrl(io, url, srv);
      var out = "", hr = srv.headRef(), hh = hr && srv.resolverRef(hr);
      if (hh) out += hh + "\tHEAD\n";
      srv.listarRefs("refs/").forEach(function (r) { out += r.hash + "\t" + r.nome + "\n"; var o = srv.ler(r.hash); if (o && o.type === "tag") out += o.object + "\t" + r.nome + "^{}\n"; });
      io.out(out); return 0;
    };

    /* o comando "github" (só para o data-setup das missões): o lado do site, igual ao ~/guia-git-lab/github */
    B.EXT.github = function* (args, io) {
      var sh = io.sh, sub = args[1], alvo = args[2];
      var raiz = raizGithub(sh.k), srvSh = shServidor(sh);
      function valida(a) { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a || "")) { io.err("github: use DONO/REPO (ex.: ana-souza/receitas)\n"); return false; } return true; }
      if (sub === "novo") {
        if (!valida(alvo)) return 2;
        var p = "/repos/" + alvo.replace(/\.git$/, "") + ".git";
        if (noDe(srvSh, p)) { io.err("github: " + alvo + " já existe\n"); return 1; }
        CMDS.init(["-q", "--bare", "-b", "main", p], { sh: srvSh, out: function () {}, err: function () {} }, srvSh);
        io.out("criado: https://github.com/" + alvo.replace(/\.git$/, "") + ".git\n"); return 0;
      }
      if (sub === "lista") { var out = ""; Object.keys(raiz.c.repos.c).sort().forEach(function (d) { Object.keys(raiz.c.repos.c[d].c).sort().forEach(function (r) { out += d + "/" + r.replace(/\.git$/, "") + "\n"; }); }); io.out(out); return 0; }
      if (sub === "apaga") { if (!valida(alvo)) return 2; apagar(srvSh, "/repos/" + alvo.replace(/\.git$/, "") + ".git"); io.out("apagado: " + alvo + "\n"); return 0; }
      if (sub === "log") {
        if (!valida(alvo)) return 2;
        var cw = srvSh.cwd; srvSh.cwd = "/repos/" + alvo.replace(/\.git$/, "") + ".git";
        try { var r0 = CMDS.log(["--oneline", "--graph", "--all", "--decorate"], { sh: srvSh, out: function (t) { io.out(t); }, err: function (t) { io.err(t); } }, srvSh); } catch (e) { if (e instanceof GitErro) { io.err(e.msg); return e.st; } throw e; } finally { srvSh.cwd = cw; }
        return 0;
      }
      if (sub === "login") { io.out("login: " + (alvo === "on" ? "on" : "off") + "\n(simulador) no terminal do guia o push nunca pede senha.\n"); return 0; }
      if (sub === "bruno") {
        var cmds = args.slice(2).join(" ");
        var n = sh.fork(); n.fs = raiz; n.cwd = "/home/bruno"; n.cwdLogico = "/home/bruno";
        ["HOME=/home/bruno", "PWD=/home/bruno", "USER=bruno", "LOGNAME=bruno"].forEach(function (x) { var i = x.indexOf("="); try { n.definirSimples(x.slice(0, i), x.slice(i + 1)); } catch (e) {} });
        var st = yield* n.rodarFonte("{ " + cmds + "\n} >/dev/null 2>&1\n", {});
        return st;
      }
      io.err("(simulador) github: use  github novo DONO/REPO  |  github bruno 'comandos'  |  github lista  |  github log DONO/REPO  |  github apaga DONO/REPO\n");
      return 2;
    };

    /* ---------- rebase (o -i funciona com GIT_SEQUENCE_EDITOR / GIT_EDITOR, como nas missões) ---------- */
    function rbArq(repo, n) { var t = repo.arq("rebase-merge/" + n); return t == null ? null : t.replace(/\n$/, ""); }
    function editorNulo(repo, sh) { var e = sh.valor("GIT_EDITOR") || repo.config("core.editor"); return e === "true" || e === ":"; }
    function rebaseSujo(repo) { var st = repo.estado(); return st.preparado.length || st.naoPrep.length; }
    function qsh(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
    // roda um editor (comando do shell) sobre um arquivo; devolve false se não há editor utilizável
    function* rodarEditor(repo, sh, cmd, arq) {
      if (!cmd || cmd === "nano" || cmd === "vim" || cmd === "vi" || cmd === "code" || /^nano\b|^vim?\b/.test(cmd)) return false;
      if (cmd === "true" || cmd === ":") return true;
      var n = sh.fork();
      yield* n.rodarFonte(cmd + " " + qsh(arq) + "\n", {});
      return true;
    }
    var AJUDA_TODO = "\n# Rebase {ONTO}\n#\n# Commands:\n# p, pick <commit> = use commit\n# r, reword <commit> = use commit, but edit the commit message\n# e, edit <commit> = use commit, but stop for amending\n# s, squash <commit> = use commit, but meld into previous commit\n# f, fixup [-C | -c] <commit> = like \"squash\" but keep only the previous\n#                    commit's log message, unless -C is used, in which case\n#                    keep only this commit's message; -c is same as -C but\n#                    opens the editor\n# x, exec <command> = run command (the rest of the line) using shell\n# b, break = stop here (continue rebase later with 'git rebase --continue')\n# d, drop <commit> = remove commit\n# l, label <label> = label current HEAD with a name\n# t, reset <label> = reset HEAD to a label\n# m, merge [-C <commit> | -c <commit>] <label> [# <oneline>]\n#         create a merge commit using the original merge commit's\n#         message (or the oneline, if no original merge commit was\n#         specified); use -c <commit> to reword the commit message\n# u, update-ref <ref> = track a placeholder for the <ref> to be updated\n#                       to this position in the new commits. The <ref> is\n#                       updated at the end of the rebase\n#\n# These lines can be re-ordered; they are executed from top to bottom.\n#\n# If you remove a line here THAT COMMIT WILL BE LOST.\n#\n# However, if you remove everything, the rebase will be aborted.\n#\n";
    CMDS.rebase = function* (args, io, sh) {
      var g = opcoes(args, { "--continue": true, "--abort": true, "--skip": true, "--quit": true, "--onto": "valor", "-i": true, "--interactive": "-i", "-q": true, "--quiet": "-q", "--autostash": true, "--edit-todo": true, "-m": true, "--merge": "-m", "--root": true, "--autosquash": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io); precisaArvore(repo);
      var o = g.o, emRebase = repo.existe("rebase-merge");
      if (o["--edit-todo"]) { io.err("(simulador) git rebase --edit-todo abre um editor de texto, que não existe aqui.\n"); return 1; }
      if (o["--abort"] || o["--quit"]) {
        if (!emRebase) { io.err("fatal: no rebase in progress\n"); return 128; }
        var ref = rbArq(repo, "head-name"), orig = rbArq(repo, "orig-head");
        if (o["--abort"]) {
          repo.trocarArvore(repo.arvoreDe(repo.head()), repo.arvoreDe(orig), { forcar: true });
          var hAntes = repo.head();
          if (ref && ref !== "detached HEAD") { repo.gravar("HEAD", "ref: " + ref + "\n"); repo.logar("HEAD", hAntes, orig, "rebase (abort): returning to " + ref); }
          else repo.gravar("HEAD", orig + "\n");
        }
        apagar(sh, repo.g + "/rebase-merge");
        return 0;
      }
      if (o["--continue"] || o["--skip"]) {
        if (!emRebase) { io.err("fatal: no rebase in progress\n"); return 128; }
        var st = repo.estado(), conf = Object.keys(st.conf).sort(cmpCam);
        if (o["--skip"]) { repo.trocarArvore(repo.arvoreDe(repo.head()), repo.arvoreDe(repo.head()), { forcar: true }); repo.apagarArq("rebase-merge/stopped-sha"); repo.apagarArq("rebase-merge/amend"); return yield* seguirRebase(repo, io, sh); }
        if (conf.length) { io.err(conf.map(function (k) { return k + ": needs merge\n"; }).join("") + "You must edit all merge conflicts and then\nmark them as resolved using git add\n"); return 1; }
        var parado = rbArq(repo, "stopped-sha"), emenda = rbArq(repo, "amend");
        if (parado && !emenda) {
          var c = repo.ler(parado), head = repo.head(), arv = repo.escreverArvore(repo.lerIndice());
          if (arv !== repo.ler(head).tree) {
            var acaoP = rbArq(repo, "stopped-action") || "pick", msgP = c.msg, paisP = [head], baseMsg = null;
            if (acaoP === "squash" || acaoP === "fixup") { var ant = repo.ler(head); paisP = ant.parents.slice(); msgP = acaoP === "fixup" ? ant.msg : ant.msg.replace(/\n$/, "") + "\n\n" + c.msg; }
            var novo = { type: "commit", tree: arv, parents: paisP, author: (acaoP === "squash" || acaoP === "fixup") ? repo.ler(head).author : c.author, committer: repo.ident("c"), msg: msgP };
            var hn = repo.escreverObj(novo);
            repo.gravar("HEAD", hn + "\n"); repo.logar("HEAD", head, hn, "rebase (continue): " + assunto(msgP));
            var mud = compararMapas(repo.arvoreDe(paisP[0]), repo.arvorePlana(arv), function (a, b) { return repo.similaridade(a, b); });
            io.out("[detached HEAD " + repo.abrev(hn) + "] " + assunto(msgP) + "\n" + repo.shortstat(mud) + repo.resumoCriacao(mud));
          }
        } else if (!emenda && rebaseSujo(repo)) { io.err("error: you have staged changes in your working tree\n"); return 1; }
        repo.apagarArq("rebase-merge/stopped-sha"); repo.apagarArq("rebase-merge/amend");
        return yield* seguirRebase(repo, io, sh);
      }
      if (emRebase) { io.err("fatal: It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.  If that is the\ncase, please try\n\tgit rebase (--continue | --abort | --skip)\nIf that is not the case, please\n\trm -fr \"" + repo.g + "/rebase-merge\"\nand run me again.  I am stopping in case you still have something\nvaluable there.\n\n"); return 128; }
      var ramo = repo.branchAtual(), upNome = g.ops[0];
      if (g.ops[1]) { var rs = CMDS.switch([g.ops[1]], { sh: sh, out: function () {}, err: function () {}, tty: function () { return false; } }, sh); if (rs) return rs; ramo = repo.branchAtual(); }
      if (!upNome) {
        var up = ramo && upstream(repo, ramo);
        if (!up) { io.err("There is no tracking information for the current branch.\nPlease specify which branch you want to rebase against.\nSee git-rebase(1) for details.\n\n    git rebase '<branch>'\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=<remote>/<branch> " + ramo + "\n\n"); return 1; }
        upNome = up.nome;
      }
      var ontoNome = o["--onto"] || upNome, onto = repo.commitDe(ontoNome), upH = repo.commitDe(upNome);
      if (!upH) { io.err("fatal: invalid upstream '" + upNome + "'\n"); return 128; }
      if (!onto) { io.err("fatal: Does not point to a valid commit '" + ontoNome + "'\n"); return 128; }
      if (rebaseSujo(repo)) { io.err("error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.\n"); return 1; }
      var head = repo.head();
      var commits = repo.revList([head], [upH], {}).reverse().filter(function (h) { return repo.ler(h).parents.length < 2; });
      var refNome = ramo ? "refs/heads/" + ramo : "detached HEAD";
      if (!o["-i"] && repo.ehAncestral(onto, head) && !o["--onto"]) { io.out("Current branch " + (ramo || "HEAD") + " is up to date.\n"); return 0; }
      var todo = commits.map(function (h) { return "pick " + repo.abrev(h) + " " + assunto(repo.ler(h).msg); });
      mkdirP(sh, repo.g + "/rebase-merge");
      if (o["-i"]) {
        var ed = sh.valor("GIT_SEQUENCE_EDITOR") || repo.config("sequence.editor") || sh.valor("GIT_EDITOR") || repo.config("core.editor");
        var arqTodo = repo.g + "/rebase-merge/git-rebase-todo";
        var n0 = commits.length;
        repo.gravar("rebase-merge/git-rebase-todo", todo.join("\n") + "\n" + AJUDA_TODO.replace("{ONTO}", repo.abrev(upH) + ".." + repo.abrev(head) + " onto " + repo.abrev(onto) + " (" + n0 + " command" + (n0 === 1 ? "" : "s") + ")"));
        var ok = yield* rodarEditor(repo, sh, ed, arqTodo);
        if (!ok) { apagar(sh, repo.g + "/rebase-merge"); io.err("(simulador) o rebase interativo (git rebase -i) abre um editor de texto, que não existe aqui. Nas missões, use GIT_SEQUENCE_EDITOR (por exemplo GIT_SEQUENCE_EDITOR='sed -i 2s/^pick/squash/' git rebase -i main).\n"); return 1; }
        var editado = (repo.arq("rebase-merge/git-rebase-todo") || "").split("\n").filter(function (l) { return l.trim() && l.trim()[0] !== "#"; });
        if (!editado.length) { apagar(sh, repo.g + "/rebase-merge"); io.out("Nothing to do\n"); return 1; }
        var ABR = { p: "pick", r: "reword", e: "edit", s: "squash", f: "fixup", d: "drop", x: "exec", b: "break" };
        todo = [];
        for (var q = 0; q < editado.length; q++) {
          var pt = editado[q].trim().split(/\s+/), ac = ABR[pt[0]] || pt[0];
          if (ac === "fixup" && /^-[cC]$/.test(pt[1])) { ac = "fixupC"; pt.splice(1, 1); }
          if (["pick", "reword", "edit", "squash", "fixup", "fixupC", "drop", "break", "exec"].indexOf(ac) < 0) { apagar(sh, repo.g + "/rebase-merge"); io.err("error: invalid command '" + pt[0] + "'\nYou can fix this with 'git rebase --edit-todo' and then run 'git rebase --continue'.\nOr you can abort the rebase with 'git rebase --abort'.\n"); return 1; }
          if (ac === "exec") { todo.push("exec " + editado[q].trim().replace(/^\S+\s+/, "")); continue; }
          if (ac === "break") { todo.push("break"); continue; }
          var hc = repo.commitDe(pt[1]);
          if (!hc) { apagar(sh, repo.g + "/rebase-merge"); io.err("error: invalid line " + (q + 1) + ": " + editado[q] + "\n"); return 1; }
          todo.push(ac + " " + hc);
        }
      } else todo = commits.map(function (h) { return "pick " + h; });
      repo.gravar("ORIG_HEAD", head + "\n");
      repo.gravar("rebase-merge/head-name", refNome + "\n");
      repo.gravar("rebase-merge/onto", onto + "\n");
      repo.gravar("rebase-merge/orig-head", head + "\n");
      repo.gravar("rebase-merge/done", "");
      repo.gravar("rebase-merge/git-rebase-todo", todo.join("\n") + (todo.length ? "\n" : ""));
      repo.gravar("rebase-merge/end", todo.length + "\n");
      if (o["-i"]) repo.gravar("rebase-merge/interactive", "");
      repo.trocarArvore(repo.arvoreDe(head), repo.arvoreDe(onto), { forcar: true });
      repo.gravar("HEAD", onto + "\n");
      repo.logar("HEAD", head, onto, "rebase (start): checkout " + ontoNome);
      return yield* seguirRebase(repo, io, sh);
    };
    function* seguirRebase(repo, io, sh) {
      var todo = (rbArq(repo, "git-rebase-todo") || "").split("\n").filter(Boolean), feitos = (rbArq(repo, "done") || "").split("\n").filter(Boolean);
      var total = +(rbArq(repo, "end") || todo.length + feitos.length), interativo = repo.existe("rebase-merge/interactive");
      var edMsg = sh.valor("GIT_EDITOR") || repo.config("core.editor");
      while (todo.length) {
        var linha = todo.shift(), pt = linha.split(" "), acao = pt[0], h = pt[1];
        if (acao === "exec" || acao === "break") {
          feitos.push(linha); repo.gravar("rebase-merge/done", feitos.join("\n") + "\n"); repo.gravar("rebase-merge/git-rebase-todo", todo.join("\n") + (todo.length ? "\n" : ""));
          if (acao === "break") { io.err("Stopped at " + repo.abrev(repo.head()) + "...  " + assunto(repo.ler(repo.head()).msg) + "\n"); return 0; }
          io.out("Executing: " + linha.slice(5) + "\n"); var nx = sh.fork(); var stx = yield* nx.rodarFonte(linha.slice(5) + "\n", {}); if (stx) { io.err("warning: execution failed: " + linha.slice(5) + "\nYou can fix the problem, and then run\n\n  git rebase --continue\n\n\n"); return 1; }
          continue;
        }
        var c = repo.ler(h), head = repo.head();
        feitos.push((acao === "fixupC" ? "fixup -C" : acao) + " " + repo.abrev(h) + " # " + assunto(c.msg));
        repo.gravar("rebase-merge/done", feitos.join("\n") + "\n");
        repo.gravar("rebase-merge/git-rebase-todo", todo.join("\n") + (todo.length ? "\n" : ""));
        if (acao === "drop") continue;
        if ((acao === "pick" || acao === "edit") && c.parents[0] === head) {
          repo.trocarArvore(repo.arvoreDe(head), repo.arvoreDe(h), { forcar: true }); repo.gravar("HEAD", h + "\n"); repo.logar("HEAD", head, h, "rebase: fast-forward");
          if (acao === "edit") { io.err("Rebasing (" + feitos.length + "/" + total + ")\r"); repo.gravar("rebase-merge/stopped-sha", h + "\n"); repo.gravar("rebase-merge/amend", h + "\n"); io.err("Stopped at " + repo.abrev(h) + "...  # " + assunto(c.msg) + "\nYou can amend the commit now, with\n\n  git commit --amend \n\nOnce you are satisfied with your changes, run\n\n  git rebase --continue\n"); return 0; }
          continue;
        }
        io.err("Rebasing (" + feitos.length + "/" + total + ")\r");
        var pai = c.parents[0] || null;
        var res = repo.mesclarArvores(pai, head, h, "HEAD", repo.abrev(h) + " (" + assunto(c.msg) + ")");
        repo.aplicarMesclagem(head, res);
        if (res.conflitos.length) {
          repo.gravar("rebase-merge/stopped-sha", h + "\n"); repo.gravar("rebase-merge/stopped-action", acao + "\n");
          io.out(res.msgs.join(""));
          io.err("error: não foi possível aplicar " + repo.abrev(h) + "... " + assunto(c.msg) + "\nhint: Resolve all conflicts manually, mark them as resolved with\nhint: \"git add/rm <conflicted_files>\", then run \"git rebase --continue\".\nhint: You can instead skip this commit: run \"git rebase --skip\".\nhint: To abort and get back to the state before \"git rebase\", run \"git rebase --abort\".\nhint: Disable this message with \"git config set advice.mergeConflict false\"\nCould not apply " + repo.abrev(h) + "... # " + assunto(c.msg) + "\n");
          return 1;
        }
        io.out(res.msgs.join(""));
        var arv = repo.escreverArvore(repo.lerIndice());
        var msg = c.msg, pais = [head], autor = c.author;
        if (acao === "squash" || acao === "fixup" || acao === "fixupC") {
          var ant = repo.ler(head); pais = ant.parents.slice(); autor = acao === "fixupC" ? c.author : ant.author;
          if (acao === "fixup") msg = ant.msg; else if (acao === "fixupC") msg = c.msg;
          else {
            var arqM = repo.g + "/COMMIT_EDITMSG";
            repo.gravar("COMMIT_EDITMSG", "# This is a combination of 2 commits.\n# This is the 1st commit message:\n\n" + ant.msg + "\n# This is the commit message #2:\n\n" + c.msg + "\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n");
            var okS = yield* rodarEditor(repo, sh, edMsg, arqM);
            msg = limparMsg(repo.arq("COMMIT_EDITMSG") || "", "strip");
          }
        } else if (acao === "reword") {
          var arqR = repo.g + "/COMMIT_EDITMSG";
          repo.gravar("COMMIT_EDITMSG", c.msg + "\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n");
          yield* rodarEditor(repo, sh, edMsg, arqR);
          msg = limparMsg(repo.arq("COMMIT_EDITMSG") || "", "strip");
        } else if (arv === repo.ler(head).tree) continue; // já aplicado: o git descarta
        var hn = repo.escreverObj({ type: "commit", tree: arv, parents: pais, author: autor, committer: repo.ident("c"), msg: msg });
        repo.gravar("HEAD", hn + "\n"); repo.logar("HEAD", head, hn, "rebase (" + (acao === "fixupC" ? "fixup" : acao) + "): " + assunto(msg));
        if (acao === "reword" || acao === "squash") { var mudR = compararMapas(repo.arvoreDe(pais[0]), repo.arvorePlana(arv), function (a, b) { return repo.similaridade(a, b); }); var au = parseIdent(autor); io.out("[detached HEAD " + repo.abrev(hn) + "] " + assunto(msg) + "\n Date: " + dataPadrao(au.ts, au.tz) + "\n" + repo.shortstat(mudR) + repo.resumoCriacao(mudR)); }
        if (acao === "edit") {
          repo.gravar("rebase-merge/stopped-sha", hn + "\n"); repo.gravar("rebase-merge/amend", hn + "\n");
          io.err("Stopped at " + repo.abrev(h) + "...  # " + assunto(c.msg) + "\nYou can amend the commit now, with\n\n  git commit --amend \n\nOnce you are satisfied with your changes, run\n\n  git rebase --continue\n");
          return 0;
        }
      }
      var ref = rbArq(repo, "head-name"), onto = rbArq(repo, "onto"), fim = repo.head();
      if (ref && ref !== "detached HEAD") {
        repo.gravarRef(ref, fim, "rebase (finish): " + ref + " onto " + onto, rbArq(repo, "orig-head"));
        repo.gravar("HEAD", "ref: " + ref + "\n");
        repo.logar("HEAD", fim, fim, "rebase (finish): returning to " + ref);
      }
      apagar(repo.sh, repo.g + "/rebase-merge");
      io.err("Successfully rebased and updated " + (ref || "detached HEAD") + ".\n");
      return 0;
    }

    /* ---------- bisect ---------- */
    function bisectEstado(repo) {
      var ruim = repo.resolverRef("refs/bisect/bad"), bons = repo.listarRefs("refs/bisect/").filter(function (r) { return /^refs\/bisect\/good-/.test(r.nome); }).map(function (r) { return r.hash; });
      var pulados = repo.listarRefs("refs/bisect/").filter(function (r) { return /^refs\/bisect\/skip-/.test(r.nome); }).map(function (r) { return r.hash; });
      return { ruim: ruim, bons: bons, pulados: pulados };
    }
    function bisectLog(repo, txt) { repo.gravar("BISECT_LOG", (repo.arq("BISECT_LOG") || "") + txt); }
    function passosBisect(all) { if (all < 3) return 0; var n = 0; while ((1 << (n + 1)) <= all) n++; var e = 1 << n, x = all - e; return e < 3 * x ? n : n - 1; }
    // escolhe o próximo commit para testar; devolve {fim:hash} quando achou o primeiro ruim
    function bisectProximo(repo, io, sh, est) {
      var cands = repo.revList([est.ruim], est.bons, {});
      var pul = {}; est.pulados.forEach(function (h) { pul[h] = 1; });
      if (cands.length === 1 || cands.every(function (h) { return h === est.ruim || pul[h]; })) {
        var h = est.ruim;
        var c = formatarCommit(repo, h, {}), mud = mudancasCommit(repo, h);
        io.out(h + " is the first bad commit\n" + c + "\n" + repo.diffstat(mud));
        bisectLog(repo, "# first bad commit: [" + h + "] " + assunto(repo.ler(h).msg) + "\n");
        return { fim: h };
      }
      var dentro = {}; cands.forEach(function (h) { dentro[h] = 1; });
      var all = cands.length, melhor = null, melhorD = -1, alcance = 0, peso = {};
      // como o do_find_bisection do git: pesos calculados do mais antigo para o mais novo, em passadas
      // sobre a lista (do mais novo para o mais antigo); para no primeiro commit "quase no meio"
      cands.forEach(function (h) { var ps = repo.ler(h).parents.filter(function (p) { return dentro[p]; }); if (!ps.length) peso[h] = 1; });
      function meio(h) { var d = 2 * peso[h] - all; return d >= -1 && d <= 1 && h !== est.ruim && !pul[h]; }
      var achado = null;
      var faltam = cands.filter(function (h) { return !peso[h]; }).length;
      while (!achado && faltam) {
        var mudou = false;
        for (var q = 0; q < cands.length && !achado; q++) {
          var h = cands[q]; if (peso[h]) continue;
          var ps = repo.ler(h).parents.filter(function (p) { return dentro[p]; });
          if (ps.length === 1) { if (!peso[ps[0]]) continue; peso[h] = peso[ps[0]] + 1; }
          else { var anc = repo.ancestrais([h]), w = 0; Object.keys(anc).forEach(function (x) { if (dentro[x]) w++; }); peso[h] = w; }
          faltam--; mudou = true;
          if (meio(h)) achado = h;
        }
        if (!mudou) break;
      }
      if (achado) { melhor = achado; alcance = peso[achado]; }
      else cands.forEach(function (h) {
        if (h === est.ruim || pul[h]) return;
        var w = peso[h], d = Math.min(w, all - w);
        if (d > melhorD) { melhorD = d; melhor = h; alcance = w; }
      });
      var nr = all - alcance - 1, passos = passosBisect(all);
      var head = repo.head();
      repo.trocarArvore(repo.arvoreDe(head), repo.arvoreDe(melhor), { forcar: false });
      repo.gravar("HEAD", melhor + "\n"); repo.logar("HEAD", head, melhor, "checkout: moving from " + (repo.branchAtual() || head) + " to " + melhor);
      io.out("Bisecting: " + nr + " revision" + (nr === 1 ? "" : "s") + " left to test after this (roughly " + passos + " step" + (passos === 1 ? "" : "s") + ")\n[" + melhor + "] " + assunto(repo.ler(melhor).msg) + "\n");
      return { prox: melhor };
    }
    function bisectStatus(repo, io, est) {
      if (!est.ruim && !est.bons.length) { io.out("status: waiting for both good and bad commits\n"); bisectLog(repo, "# status: waiting for both good and bad commits\n"); return true; }
      if (!est.bons.length) { io.out("status: waiting for good commit(s), bad commit known\n"); bisectLog(repo, "# status: waiting for good commit(s), bad commit known\n"); return true; }
      if (!est.ruim) { var n = est.bons.length, t = "status: waiting for bad commit, " + n + " good commit" + (n === 1 ? "" : "s") + " known\n"; io.out(t); bisectLog(repo, "# " + t); return true; }
      return false;
    }
    function bisectMarcar(repo, io, tipo, h) {
      var c = repo.ler(h), lin = "# " + tipo + ": [" + h + "] " + assunto(c.msg) + "\ngit bisect " + tipo + " " + h + "\n";
      if (tipo === "bad") repo.gravar("refs/bisect/bad", h + "\n"); else repo.gravar("refs/bisect/" + tipo + "-" + h, h + "\n");
      bisectLog(repo, lin);
    }
    CMDS.bisect = function* (args, io, sh) {
      var repo = precisaRepo(io); precisaArvore(repo);
      var sub = args[0], a = args.slice(1), emBisect = repo.existe("BISECT_START");
      var TERMOS = { bad: "bad", new: "bad", good: "good", old: "good", skip: "skip" };
      if (sub === "start") {
        if (emBisect) { /* recomeça */ CMDS.bisect(["reset"], { sh: sh, out: function () {}, err: function () {} }, sh); }
        var st = repo.estado(); if (st.preparado.length || st.naoPrep.length) { /* o git deixa começar; o checkout pode falhar depois */ }
        repo.gravar("BISECT_START", (repo.branchAtual() || repo.head()) + "\n");
        repo.gravar("BISECT_LOG", "git bisect start\n");
        var revs = a.filter(function (x) { return x !== "--"; });
        if (revs.length) {
          var hb = repo.commitDe(revs[0]); if (!hb) { io.err("fatal: '" + revs[0] + "' does not appear to be a valid revision\n"); return 1; }
          bisectMarcar(repo, io, "bad", hb);
          for (var i = 1; i < revs.length; i++) { var hg = repo.commitDe(revs[i]); if (!hg) { io.err("fatal: '" + revs[i] + "' does not appear to be a valid revision\n"); return 1; } bisectMarcar(repo, io, "good", hg); }
          repo.gravar("BISECT_LOG", "git bisect start '" + revs.join("' '") + "'\n" + (repo.arq("BISECT_LOG") || "").replace(/^git bisect start\n/, ""));
        }
        var est = bisectEstado(repo);
        if (bisectStatus(repo, io, est)) return 0;
        bisectProximo(repo, io, sh, est); return 0;
      }
      if (sub === "reset") {
        if (!emBisect) { io.out("We are not bisecting.\n"); return 0; }
        var orig = repo.arq("BISECT_START").replace(/\n$/, ""), alvo = a[0] || orig;
        ["BISECT_START", "BISECT_LOG", "BISECT_TERMS", "BISECT_EXPECTED_REV", "BISECT_ANCESTORS_OK", "BISECT_NAMES", "BISECT_RUN"].forEach(function (f) { repo.apagarArq(f); });
        apagar(sh, repo.g + "/refs/bisect");
        if (repo.resolverRef("refs/heads/" + alvo)) return trocarPara(repo, io, { ramo: alvo }, {});
        var h = repo.commitDe(alvo); if (h) return trocarPara(repo, io, { hash: h, nome: alvo }, {});
        return 0;
      }
      if (sub === "log") { if (!emBisect) { io.err("error: We are not bisecting.\n"); return 1; } io.out(repo.arq("BISECT_LOG")); return 0; }
      if (TERMOS[sub]) {
        if (!emBisect) { io.err("You need to start by \"git bisect start\"\n\n"); return 1; }
        var tipo = TERMOS[sub], alvos = a.length ? a : ["HEAD"];
        for (var j = 0; j < alvos.length; j++) {
          var hh = repo.commitDe(alvos[j]); if (!hh) { io.err("fatal: Bad rev input: " + alvos[j] + "\n"); return 128; }
          var est0 = bisectEstado(repo);
          if ((tipo === "good" && est0.ruim === hh) || (tipo === "bad" && est0.bons.indexOf(hh) >= 0)) { bisectMarcar(repo, io, tipo, hh); io.out(hh + " was both good and bad\n"); return 1; }
          bisectMarcar(repo, io, tipo, hh);
        }
        var est2 = bisectEstado(repo);
        if (bisectStatus(repo, io, est2)) return 0;
        var r = bisectProximo(repo, io, sh, est2); return 0;
      }
      if (sub === "run") {
        if (!emBisect) { io.err("You need to start by \"git bisect start\"\n\n"); return 1; }
        if (!a.length) { io.err("error: bisect run failed: no command provided.\n"); return 1; }
        while (true) {
          var est3 = bisectEstado(repo);
          if (!est3.ruim || !est3.bons.length) { io.err("error: bisect run failed: no command provided.\n"); return 1; }
          io.out("running " + a.map(function (x) { return "'" + x + "'"; }).join(" ") + "\n");
          var n = sh.fork();
          var stc = yield* n.rodarFonte(a.map(qsh).join(" ") + "\n", {});
          if (stc >= 128 || stc < 0) { io.err("bisect run failed: exit code " + stc + " from '" + a.join(" ") + "' is < 0 or >= 128\n"); return 1; }
          var tp = stc === 0 ? "good" : stc === 125 ? "skip" : "bad";
          bisectMarcar(repo, io, tp, repo.head());
          var r2 = bisectProximo(repo, io, sh, bisectEstado(repo));
          if (r2.fim) { io.out("bisect found first bad commit\n"); return 0; }
        }
      }
      if (sub === "visualize" || sub === "view") return CMDS.log(["--oneline"], io, sh);
      io.err("error: unknown command: '" + (sub || "") + "'\n" + (global.GITSIM_AJUDA && global.GITSIM_AJUDA.bisect || "")); return 1;
    };

    /* ---------- blame ---------- */
    CMDS.blame = function (args, io, sh) {
      var g = opcoes(args, { "-L": "valor", "-s": true, "-e": true, "--show-email": "-e", "-l": true, "-w": true, "-M": true, "-C": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io), rev = null, cam;
      if (g.ops.length > 1) { rev = g.ops[0]; cam = g.ops[1]; } else cam = g.ops[0];
      if (!cam) { io.err((global.GITSIM_AJUDA && global.GITSIM_AJUDA.blame) || "usage: git blame [<options>] [<rev-opts>] [<rev>] [--] <file>\n"); return 129; }
      var k = pathspec(repo, cam), head = rev ? repo.commitDe(rev) : repo.head();
      if (!head) { io.err("fatal: no such ref: HEAD\n"); return 128; }
      var T = repo.arvoreDe(head), naoComitado = false, texto;
      if (!T[k]) { if (!rev && noDe(sh, repo.absDe(k))) { io.err("fatal: no such path '" + k + "' in HEAD\n"); return 128; } io.err("fatal: no such path " + k + " in " + (rev || "HEAD") + "\n"); return 128; }
      if (!rev) { var nw = noDe(sh, repo.absDe(k)); texto = nw ? repo.conteudoNo(nw) : repo.textoBlob(T[k].hash); } else texto = repo.textoBlob(T[k].hash);
      var linhas = separarLinhas(texto).l, donos = new Array(linhas.length);
      // linhas da pasta que não estão no HEAD: "Not Committed Yet"
      var pend = [];
      var tHead = separarLinhas(repo.textoBlob(T[k].hash)).l;
      if (!rev && texto !== repo.textoBlob(T[k].hash)) {
        var mc = mudancas(tHead, linhas), mapa = alinhar(mc, tHead.length, linhas.length);
        linhas.forEach(function (l, i) { if (mapa[i] < 0) donos[i] = { h: null, linha: i }; else pend.push({ i: i, j: mapa[i] }); });
      } else linhas.forEach(function (l, i) { pend.push({ i: i, j: i }); });
      // sobe na história: cada linha fica com o commit que a introduziu
      (function subir(h, caminho, itens) {
        if (!itens.length) return;
        var c = repo.ler(h), atual = separarLinhas(repo.textoBlob(repo.arvoreDe(h)[caminho].hash)).l;
        var resto = itens;
        for (var p = 0; p < c.parents.length && resto.length; p++) {
          var TP = repo.arvoreDe(c.parents[p]); if (!TP[caminho]) continue;
          var ant = separarLinhas(repo.textoBlob(TP[caminho].hash)).l, mc2 = mudancas(ant, atual), m2 = alinhar(mc2, ant.length, atual.length);
          var passam = [], ficam = [];
          resto.forEach(function (it) { if (m2[it.j] >= 0) passam.push({ i: it.i, j: m2[it.j] }); else ficam.push(it); });
          subir(c.parents[p], caminho, passam);
          resto = ficam;
        }
        resto.forEach(function (it) { donos[it.i] = { h: h, linha: it.j, raiz: !c.parents.length }; });
      })(head, k, pend);
      var L0 = 1, L1 = linhas.length;
      if (g.o["-L"]) { var mL = /^(\d+)(?:,(\+?)(\d+))?$/.exec(g.o["-L"]); if (mL) { L0 = +mL[1]; L1 = mL[3] ? (mL[2] ? L0 + +mL[3] - 1 : +mL[3]) : linhas.length; } if (L0 > linhas.length) { io.err("fatal: file " + k + " has only " + linhas.length + " line" + (linhas.length === 1 ? "" : "s") + "\n"); return 128; } }
      var largNome = 0, largNum = String(L1).length;
      for (var i = L0 - 1; i < L1; i++) { var d = donos[i], nome = d.h ? parseIdent(repo.ler(d.h).author).nome : "Not Committed Yet"; if (g.o["-e"]) nome = "<" + (d.h ? parseIdent(repo.ler(d.h).author).email : "not.committed.yet") + ">"; largNome = Math.max(largNome, nome.length); }
      var out = "";
      for (i = L0 - 1; i < L1; i++) {
        var dd = donos[i], id, nm, dt;
        if (dd.h) { var a2 = parseIdent(repo.ler(dd.h).author); id = (dd.raiz ? "^" + dd.h.slice(0, 7) : dd.h.slice(0, 8)); if (g.o["-l"]) id = (dd.raiz ? "^" : "") + dd.h; nm = g.o["-e"] ? "<" + a2.email + ">" : a2.nome; dt = dataIso(a2.ts, a2.tz); }
        else { id = g.o["-l"] ? ZERO : "00000000"; nm = g.o["-e"] ? "<not.committed.yet>" : "Not Committed Yet"; dt = dataIso(Math.floor(sh.k.clock / 1000), "-0300"); }
        var num = String(i + 1); while (num.length < largNum) num = " " + num;
        out += id + (g.o["-s"] ? " " + num + ") " : " (" + nm + rep(" ", largNome - nm.length) + " " + dt + " " + num + ") ") + linhas[i] + "\n";
      }
      io.out(out); return 0;
    };
    // mapa de linhas: índice em b → índice em a (ou -1 se a linha é nova)
    function alinhar(mc, na, nb) {
      var m = new Array(nb), i = 0, j = 0;
      while (i < na || j < nb) {
        if (i < na && mc.ca[i]) { i++; continue; }
        if (j < nb && mc.cb[j]) { m[j] = -1; j++; continue; }
        if (j < nb) m[j] = i; i++; j++;
      }
      return m;
    }

    /* ---------- grep ---------- */
    CMDS.grep = function (args, io, sh) {
      var g = opcoes(args, { "-n": true, "--line-number": "-n", "-i": true, "--ignore-case": "-i", "-c": true, "--count": "-c", "-l": true, "--files-with-matches": "-l", "-L": true, "-w": true, "--word-regexp": "-w", "-v": true, "--invert-match": "-v", "-e": "valor", "-E": true, "--extended-regexp": "-E", "-F": true, "--fixed-strings": "-F", "--cached": true, "-h": true, "-q": true, "--quiet": "-q", "-o": true });
      if (g.erro) { io.err("error: " + g.erro + "\n"); return 129; }
      var repo = precisaRepo(io), o = g.o, ops = g.ops.slice(), padroes = lista(o["-e"]);
      if (!padroes.length) { if (!ops.length) { io.err("fatal: no pattern given\n"); return 128; } padroes = [ops.shift()]; }
      var rev = null; if (ops.length && repo.commitDe(ops[0]) && !noDe(sh, sh.abs(ops[0]))) rev = ops.shift();
      var specs = ops.map(function (p) { return pathspec(repo, p); });
      var res = padroes.map(function (p) {
        var src = o["-F"] ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : o["-E"] ? p : p.replace(/\\([(){}|+?])/g, "\u0001$1").replace(/([(){}|+?])/g, "\\$1").replace(/\u0001(.)/g, "$1");
        if (o["-w"]) src = "(?:^|[^A-Za-z0-9_])(?:" + src + ")(?=$|[^A-Za-z0-9_])";
        return new RegExp(src, o["-i"] ? "i" : "");
      });
      var arqs = {};
      if (rev) { var T = repo.arvoreDe(repo.commitDe(rev)); Object.keys(T).forEach(function (k) { arqs[k] = repo.textoBlob(T[k].hash); }); }
      else if (o["--cached"]) repo.lerIndice().forEach(function (e) { if (!e.stage) arqs[e.path] = repo.textoBlob(e.hash); });
      else repo.lerIndice().forEach(function (e) { if (e.stage > 1) return; var n = noDe(sh, repo.absDe(e.path)); if (n && n.t === "f") arqs[e.path] = repo.conteudoNo(n); });
      var out = "", achou = false;
      Object.keys(arqs).sort(cmpCam).forEach(function (k) {
        if (specs.length && !specs.some(function (s) { return casaSpec(s, k); })) return;
        var txt = arqs[k]; if (binario(txt)) { if (res.some(function (r) { return r.test(txt); })) { out += "Binary file " + k + " matches\n"; achou = true; } return; }
        var nome = (rev ? rev + ":" : "") + repo.relCwd(k), cont = 0;
        separarLinhas(txt).l.forEach(function (l, i) {
          var casa = res.some(function (r) { return r.test(l); }); if (o["-v"]) casa = !casa;
          if (!casa) return;
          cont++; achou = true;
          if (!o["-c"] && !o["-l"] && !o["-L"]) out += (o["-h"] ? "" : nome + ":") + (o["-n"] ? (i + 1) + ":" : "") + l + "\n";
        });
        if (o["-c"] && cont) out += nome + ":" + cont + "\n";
        if (o["-l"] && cont) out += nome + "\n";
        if (o["-L"] && !cont) out += nome + "\n";
      });
      if (!o["-q"]) io.out(out);
      return achou ? 0 : 1;
    };

    /* ---------- describe / shortlog ---------- */
    CMDS.describe = function (args, io, sh) {
      var repo = precisaRepo(io), tags = false, always = false, abbrev = 7, rev = "HEAD";
      args.forEach(function (a) { var m; if (a === "--tags") tags = true; else if (a === "--always") always = true; else if ((m = /^--abbrev=(\d+)$/.exec(a))) abbrev = +m[1]; else if (a[0] !== "-") rev = a; });
      var h = repo.commitDe(rev); if (!h) { if (rev === "HEAD" && !repo.head()) fatal("No names found, cannot describe anything."); fatal("Not a valid object name " + rev); }
      var todas = repo.listarRefs("refs/tags/").map(function (t) { var o = repo.ler(t.hash); return { nome: t.nome.slice(10), alvo: repo.descascar(t.hash), anotada: o && o.type === "tag", ts: o && o.type === "tag" ? parseIdent(o.tagger).ts : 0 }; });
      var usar = todas.filter(function (t) { return tags || t.anotada; }), anc = repo.ancestrais([h]);
      var melhor = null;
      usar.forEach(function (t) {
        if (!anc[t.alvo]) return;
        var dist = repo.revList([h], [t.alvo], {}).length;
        if (!melhor || dist < melhor.dist || (dist === melhor.dist && t.ts > melhor.t.ts)) melhor = { t: t, dist: dist };
      });
      if (!melhor) {
        if (always) { io.out(repo.abrev(h) + "\n"); return 0; }
        if (!todas.length) fatal("No names found, cannot describe anything.");
        if (!tags && todas.some(function (t) { return anc[t.alvo]; })) fatal("No annotated tags can describe '" + h + "'.\nHowever, there were unannotated tags: try --tags.");
        fatal("No tags can describe '" + h + "'.\nTry --always, or create some tags.");
      }
      io.out(melhor.t.nome + (melhor.dist && abbrev ? "-" + melhor.dist + "-g" + repo.abrev(h, abbrev) : "") + "\n");
      return 0;
    };
    CMDS.shortlog = function (args, io, sh) {
      var repo = precisaRepo(io), so = false, num = false, email = false, revs = [];
      args.forEach(function (a) { if (/^-[sne]+$/.test(a)) { if (a.indexOf("s") >= 0) so = true; if (a.indexOf("n") >= 0) num = true; if (a.indexOf("e") >= 0) email = true; } else if (a === "--summary") so = true; else if (a === "--numbered") num = true; else if (a === "--email") email = true; else revs.push(a); });
      var h = repo.commitDe(revs[0] || "HEAD"); if (!h) { if (!revs.length) return 0; fatal("ambiguous argument '" + revs[0] + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'"); }
      var grupos = {}, ordem = [];
      repo.revList([h], [], {}).forEach(function (c) { var a = parseIdent(repo.ler(c).author), k = a.nome + (email ? " <" + a.email + ">" : ""); if (!grupos[k]) { grupos[k] = []; ordem.push(k); } grupos[k].push(assunto(repo.ler(c).msg)); });
      ordem.sort(function (x, y) { return num ? grupos[y].length - grupos[x].length || (x < y ? -1 : 1) : (x < y ? -1 : 1); });
      var out = "";
      ordem.forEach(function (k) {
        if (so) { var n = String(grupos[k].length); out += rep(" ", 6 - n.length) + n + "\t" + k + "\n"; }
        else { out += k + " (" + grupos[k].length + "):\n" + grupos[k].slice().reverse().map(function (m) { return "      " + m + "\n"; }).join("") + "\n"; }
      });
      io.out(out); return 0;
    };

    /* ---------- help ---------- */
    CMDS.help = function (args, io, sh) {
      if (!args.length || args[0] === "-a" || args[0] === "-g") { io.out(USO + "\n" + AJUDA); return 0; }
      io.err("(simulador) o manual do git " + args[0] + " não abre aqui. No seu computador, \"git help " + args[0] + "\" (ou \"git " + args[0] + " --help\") abre a página do manual.\n");
      return 0;
    };
    CMDS.version = function (args, io) { io.out("git version 2.53.0\n"); return 0; };

    /* ---------------- metas das missões (data-goal) ---------------- */
    // devolve true/false, ou undefined se a meta não é do Git
    function meta(sh, tipo, val) {
      var NOMES = { repo: 1, commits: 1, limpo: 1, preparado: 1, naopreparado: 1, rastreado: 1, ignorado: 1, branch: 1, semBranch: 1, head: 1, msg: 1, logre: 1, tag: 1, remoto: 1, conflito: 1, semconflito: 1, contem: 1, stash: 1 };
      if (!NOMES[tipo]) return undefined;
      var repo = achar(sh);
      if (tipo === "repo") return !!repo;
      if (!repo) return false;
      var head = repo.head();
      function rel(p) { try { return pathspec(repo, p); } catch (e) { return null; } }
      switch (tipo) {
        case "commits": return (head ? repo.revList([head], [], {}).length : 0) === +val;
        case "limpo": { if (!repo.raiz) return false; var st = repo.estado(); return !st.preparado.length && !st.naoPrep.length && !st.naoRastr.length && !Object.keys(st.conf).length; }
        case "preparado": { var st1 = repo.estado(), k1 = rel(val); return st1.preparado.some(function (m) { return m.para === k1 || m.de === k1; }); }
        case "naopreparado": { var st2 = repo.estado(), k2 = rel(val); return !!st2.conf[k2] || st2.naoPrep.some(function (m) { return m.para === k2; }); }
        case "rastreado": { var k3 = rel(val); return repo.lerIndice().some(function (e) { return e.path === k3; }); }
        case "ignorado": { var k4 = rel(val); if (k4 === null || repo.lerIndice().some(function (e) { return e.path === k4; })) return false; var n4 = noDe(sh, repo.absDe(k4)); return !!repo.ignorado(k4, !!(n4 && n4.t === "d")); }
        case "branch": return !!repo.resolverRef("refs/heads/" + val);
        case "semBranch": return !repo.resolverRef("refs/heads/" + val);
        case "head": return val === "destacado" ? !repo.headRef() : repo.branchAtual() === val;
        case "msg": return !!head && repo.ler(head).msg.indexOf(val) >= 0;
        case "logre": { if (!head) return false; var txt = repo.revList([head], [], {}).map(function (h) { return repo.abrev(h) + " " + repo.ler(h).msg.split("\n")[0]; }).join("\n"); return new RegExp(val, "m").test(txt); }
        case "tag": return !!repo.resolverRef("refs/tags/" + val);
        case "remoto": return repo.config("remote." + val + ".url") !== null;
        case "conflito": return repo.lerIndice().some(function (e) { return e.stage > 0; });
        case "semconflito": return !repo.lerIndice().some(function (e) { return e.stage > 0; }) && !repo.existe("MERGE_HEAD") && !repo.existe("CHERRY_PICK_HEAD") && !repo.existe("REVERT_HEAD") && !repo.existe("rebase-merge");
        case "contem": {
          var eq = val.indexOf("="), esq = val.slice(0, eq), texto = val.slice(eq + 1), dp = esq.indexOf(":");
          var hc = repo.commitDe(esq.slice(0, dp) || "HEAD"); if (!hc) return false;
          var e = repo.arvoreDe(hc)[esq.slice(dp + 1)];
          return !!e && repo.textoBlob(e.hash).indexOf(texto) >= 0;
        }
        case "stash": return repo.reflog("refs/stash").length === +val;
      }
      return false;
    }

    /* ---------- Tab no terminal: completa subcomandos, ramos, tags e remotos (como o git-completion do Ubuntu) ---------- */
    var SUBCOMANDOS = "add bisect blame branch checkout cherry-pick clean clone commit config diff fetch grep help init log merge mv pull push rebase reflog remote reset restore revert rm show stash status switch tag".split(" ");
    function completar(sh, antes, parcial) {
      var m = /(?:^|[;&|]\s*)git\s+((?:-\S+\s+)*)(\S+\s+)?((?:\S+\s+)*)$/.exec(antes);
      if (!/(^|[;&|]\s*)git\s/.test(antes)) return null;
      var pal = antes.replace(/^.*?\bgit\s+/, "").split(/\s+/).filter(Boolean);
      if (!pal.length) return SUBCOMANDOS.concat(alias()).filter(function (c) { return c.indexOf(parcial) === 0; }).sort();
      var sub = pal[0], resto = pal.slice(1).filter(function (x) { return x[0] !== "-"; });
      var repo = achar(sh); if (!repo) return null;
      function alias() { var r = []; try { configGlobal(sh).forEach(function (e) { var mm = /^alias\.(.*)$/.exec(e.k); if (mm) r.push(mm[1]); }); } catch (e) { /* */ } return r; }
      var ramos = repo.listarRefs("refs/heads/").map(function (r) { return r.nome.slice(11); });
      var tags = repo.listarRefs("refs/tags/").map(function (r) { return r.nome.slice(10); });
      var remotos = remotosConfig(repo), remRamos = repo.listarRefs("refs/remotes/").map(function (r) { return r.nome.slice(13); }).filter(function (x) { return !/\/HEAD$/.test(x); });
      var lista = null;
      if (sub === "switch" || sub === "merge" || sub === "rebase" || sub === "cherry-pick") lista = ramos.concat(sub === "switch" ? remRamos.map(function (x) { return x.replace(/^[^/]+\//, ""); }) : remRamos, sub === "switch" ? [] : tags);
      else if (sub === "branch" && /(^|\s)-[dDmM]\s/.test(antes + " ")) lista = ramos;
      else if (sub === "checkout" || sub === "log" || sub === "show" || sub === "diff" || sub === "reset" || sub === "revert" || sub === "tag" && resto.length) {
        lista = ramos.concat(tags, remRamos, ["HEAD"]).filter(function (x) { return x.indexOf(parcial) === 0; });
        if (!lista.length || /--\s/.test(antes)) return null; // nomes de arquivo
      }
      else if (sub === "push" || sub === "pull" || sub === "fetch") lista = resto.length ? ramos.concat(tags) : remotos;
      else if (sub === "stash" && !resto.length) lista = "apply branch clear drop list pop push show".split(" ");
      else if (sub === "remote" && !resto.length) lista = "add get-url remove rename set-url show".split(" ");
      else if (sub === "remote" && /^(remove|rm|rename|show|get-url|set-url)$/.test(resto[0]) && resto.length === 1) lista = remotos;
      else if (sub === "bisect" && !resto.length) lista = "bad good log reset run skip start".split(" ");
      if (!lista) return null;
      var vistos = {};
      return lista.filter(function (x) { if (vistos[x] || x.indexOf(parcial) !== 0) return false; vistos[x] = 1; return true; }).sort();
    }

    B.gitsim = { sha1: sha1, hashObjeto: hashObjeto, achar: achar, Repo: Repo, CMDS: CMDS, diffUnificado: diffUnificado, merge3: merge3, meta: meta, completar: completar };
  }

  if (global.BashSim) instalar(global.BashSim);
  else (global.BashSimExtras = global.BashSimExtras || []).push(instalar); // o bashsim.js chama ao carregar
  if (typeof module !== "undefined" && module.exports) module.exports = instalar;
})(typeof window !== "undefined" ? window : globalThis);

# Como escrever uma página do Guia Git

O guia é uma **escola**, estilo W3Schools, para quem **nunca usou Git** (e mal usou o terminal). **Uma aula = um assunto** (um comando ou uma ideia). O dono do projeto já reclamou de outro guia que juntava vários assuntos numa página. Nunca mostre um comando "seco":
- explique cada parte (anatomia: `git`, o subcomando, as opções, os argumentos);
- mostre a **saída real** do Git (laboratório, §5) e explique **linha por linha** o que ela diz — o `git status` e as dicas (`(use "git add <arquivo>..." …)`) são o melhor professor do Git;
- mostre **o estado antes e depois** (o que mudou na pasta, na área de preparo, no histórico); desenhe o histórico quando ajudar (o `git log --oneline --graph` real, ou um diagrama simples em `pre` com `A---B---C`);
- mostre o que acontece quando dá errado, com a mensagem **real** do Git, e como sair da situação;
- deixe o leitor praticar no terminal simulado do guia, que tem **um Git** de verdade imitado em JavaScript (§4).

Antes de tudo, leia o `RECURSOS.md`: onde trabalhar (VPS) e como.

## 0. O que o guia ensina
- **Git na linha de comando** (o Git do Ubuntu 26.04 — versão exata no `COMO-USAR.md` do lab), com as mensagens **em português** (o Git do leitor brasileiro sai em português quando o sistema está em pt_BR; diga numa nota que, com o sistema em inglês, as mensagens saem em inglês e mostre a equivalente quando for importante).
- **GitHub** no grupo "GitHub" e em "Trabalhando em Equipe": conta, repositório, SSH/token, Pages, fork, pull request, issues. O site do GitHub **não roda no lab**: descreva com cuidado o que o leitor vê (sem inventar nomes de botões que você não conferiu na documentação oficial docs.github.com/pt) e marque como ilustrativo.
- Comandos modernos primeiro (`git switch`, `git restore`); os antigos (`git checkout`, `git reset HEAD arquivo`) aparecem para o leitor reconhecer em tutoriais antigos.
- Branch padrão: **`main`** (o lab configura `init.defaultBranch=main`; explique numa nota, em `git-init.html`, que sem essa configuração o Git ainda pode criar `master` e mostra uma dica — mostre a dica real).

## 1. Esqueleto do arquivo
Igual ao Guia Bash (veja `~/guia-bash` no notebook, por exemplo `~/guia-bash/variaveis.html`), trocando:
- `<title>Git TEMA — descrição curta | Guia Git</title>`;
- `<h1>Git <span class="hl">TEMA</span></h1>`.

Menu, selo e Anterior/Próximo vêm de `assets/site.js` (`NIVEIS`). **Não mude a `NIVEIS`.** Links internos só para páginas que estão nela.

## 2. Ordem de uma aula
1. **Intro** (`p.intro`).
2. **"Você vai aprender"** (`div.note`, 3–5 itens).
3. **A ideia antes do comando**, com uma comparação do dia a dia (o "salvar como versão_final_2.docx", uma caixa de fotos com etiquetas, um caderno de rascunho × caderno passado a limpo).
4. **Do simples ao completo**, uma novidade por vez, com `dl.anatomy`.
5. **Toda saída explicada**, com anotações `«` nas linhas importantes. Mostre o `git status` depois de cada mudança importante.
6. **Experimente** (`.try`): **pelo menos um por aula** (exceto referência e páginas só de GitHub): uma missão no terminal simulado, com o repositório já preparado pelo `data-setup`.
7. **Formas diferentes** de fazer a mesma coisa + tabela "qual usar".
8. **Quando dá errado** (`div.cenario`): mensagem real → o que aconteceu → como confirmar → como resolver (incluindo os clássicos: `fatal: not a git repository`, `nothing to commit`, `Please tell me who you are`, conflito, push rejeitado, `detached HEAD`…).
9. **Referência** (`table.ref`).
10. **Exercícios** (3 ou mais: `.exercise` e `.mc`).
11. **Resumo**.

Páginas de **Projetos**: uma história passo a passo (a Ana versionando o site de receitas, trabalhando com o Bruno), com várias missões `.try` encadeadas. Páginas de **Referência**: tabelas.

## 3. Componentes

### Sessão de terminal (`pre.term`)
Como no Guia Bash: `$ ` = comando (vira `ana@notebook:~$`, e o prompt acompanha `cd` — use `data-cwd="~/receitas"` para começar numa pasta); `> ` logo depois de um comando = continuação; `«` = anotação; dentro de `<pre>`, `&lt;` `&gt;` `&amp;` (o Git usa muito `<arquivo>`: escreva `&lt;arquivo&gt;`).

Toda saída vem do laboratório (§5). Exemplo:
```html
<pre class="term" data-cwd="~/receitas">$ git status
No ramo main
Nenhum commit ainda
…
</pre>
```

### Arquivo (`pre.file`) e Anatomia (`dl.anatomy`)
Como no Guia Bash.

### Experimente no terminal (`.try`) — com Git
```html
<div class="try" data-setup="mkdir receitas;;cd receitas;;git init -q;;echo '# Receitas' &gt; README.md" data-goal="commits:1,limpo" data-solucao="git add README.md;;git commit -m 'Primeiro commit'">
<p class="try-task"><strong>Missão:</strong> faça o primeiro commit do README.md com a mensagem "Primeiro commit".</p>
</div>
```
- `data-setup`: comandos rodados antes (separados por `;;`), invisíveis para o leitor — use para montar o repositório da missão (commits, branches, um "servidor" remoto). O simulador é rápido: dá para fazer 10 commits no setup.
- `data-goal`: metas separadas por vírgula, **todas** precisam ser verdade (tabela abaixo).
- `data-solucao` (**obrigatório**): os comandos que cumprem a missão (`;;` entre eles).
- A missão **não** pode estar cumprida já pelo setup (o testador confere).
- O nome e o e-mail da Ana já estão configurados no simulador e no lab (`Ana Souza <ana@exemplo.com>`), e a data é fixa (15/10/2026 10:30, −03:00): por isso **os hashes dos commits saem iguais** no simulador e no lab. Mesmo assim, **prefira metas que não dependam de hash**.

### Metas (`data-goal`) — as do Guia Bash e as do Git
Valem todas as metas do Guia Bash (`dir: file: absent: contains: cwd: ran: out: outre: err: exit: …`, veja `~/guia-bash/CONTRIBUINDO.md` §4) **mais** as do Git, que olham o repositório da pasta atual:

| Meta | Verdade quando… |
| --- | --- |
| `repo` | a pasta atual está dentro de um repositório Git |
| `commits:N` | o branch atual tem exatamente N commits (`git rev-list --count HEAD`) |
| `limpo` | não há nada a commitar (`git status --porcelain` vazio) |
| `preparado:CAMINHO` | o arquivo está na área de preparo (staged) com mudanças |
| `naopreparado:CAMINHO` | o arquivo tem mudanças fora da área de preparo |
| `rastreado:CAMINHO` / `ignorado:CAMINHO` | o arquivo é rastreado / é ignorado pelo `.gitignore` |
| `branch:NOME` / `semBranch:NOME` | o branch existe / não existe |
| `head:NOME` | o branch atual é NOME (`head:destacado` = HEAD destacado) |
| `msg:TEXTO` | a mensagem do último commit (HEAD) contém o texto |
| `logre:REGEX` | a saída de `git log --oneline` (do HEAD) casa com a regex |
| `tag:NOME` | a tag existe |
| `remoto:NOME` | o remoto existe |
| `conflito` / `semconflito` | há (não há) um merge/rebase em andamento com conflito |
| `contem:REF=TEXTO` | o arquivo, na versão do commit REF (`HEAD:receita.txt`, `main:README.md`), contém o texto |
| `stash:N` | há N itens no stash |

**ATENÇÃO — caminhos das metas de arquivo (`file:`, `absent:`, `dir:`, `contains:`, `exec:`) são a partir de `~` (a pasta da Ana), NÃO da pasta atual:** depois de `cd receitas` no setup, escreva `contains:receitas/bolo.txt=…`. Um `absent:bolo.txt` (sem `receitas/`) é sempre verdade e deixa a missão passar sem o leitor fazer nada. As metas do Git (`preparado:`, `rastreado:`, `contem:` etc.) usam o repositório da pasta atual.

Use `\,` para uma vírgula dentro de uma meta. O agente do simulador pode acrescentar metas — **a lista oficial e o que cada uma faz exatamente fica na §4**.

### Outros blocos
`div.note/.tip/.warning/.cenario`, `ol.passo`, `div.table-wrap > table.ref`, `.exercise`, `.mc`, `figure`, `<span class="versao">git 2.23+</span>` (para comandos que não existem em Gits antigos: `switch`/`restore` são do 2.23).

## 4. O simulador (`assets/bashsim.js` + o Git simulado `assets/gitsim.js`)
> **Esta seção é mantida pelo agente do simulador.** Antes de escrever uma frase do tipo "no terminal do guia…", confira com as ferramentas dele (`tools/sim.js`).

O terminal do guia é o Bash simulado do Guia Bash (`assets/bashsim.js`) com **um Git imitado em JavaScript** (`assets/gitsim.js`, mais `assets/gitsim-ajuda.js` com os textos do `git COMANDO -h`). O `site.js` carrega os três sozinho quando a página tem um `.try`. O repositório vive de verdade no sistema de arquivos fictício, dentro de `.git` (`HEAD`, `config`, `refs/`, `logs/`, `objects/`, `index`, `MERGE_HEAD`, `rebase-merge/`…), com **blobs, árvores e commits com o SHA-1 real**: com a Ana (`Ana Souza <ana@exemplo.com>`, já no `~/.gitconfig`, igual ao lab) e a data fixa `1792071000 -0300` (15/10/2026 10:30), **os hashes saem iguais aos do lab** (`echo "# Receitas da Ana" > README.md` + `git commit -m "Cria o README"` → `700bbd5`).

A pasta da Ana no simulador é **igual ao modelo do lab** (`~/guia-git-lab/template`): `.bashrc`, `.profile`, `.bash_logout`, `.config/`, `.gitconfig` e as pastas padrão **vazias**. O `ls` imita o do Ubuntu 26.04 (uutils): ordem por bytes (`HEAD` antes de `config`, `Área de trabalho` por último) e meses em inglês no `ls -l`.

Ver uma sessão (na VPS): `node tools/sim.js --sem-tty 'mkdir r && cd r && git init' 'git status'` — `--sem-tty` é como o `lab -i`. Sem `--sem-tty` é como o terminal da página (que é um terminal: o `git log` mostra `(HEAD -> main)`, como o Git real com `log.decorate=auto`; com `| cat` ou `> arquivo`, não mostra).

### O que funciona
- **Básico:** `init` (`-b`, `--bare`, a dica do `master` quando não há `init.defaultBranch`), `config` (`--global`, `--list`, `--show-origin`, `--unset`, `--get`), `status` (longo, `-s`, `-b`, `--ignored`, `-u`), `add` (`.`, `-A`, `-u`, `-f`, `-n`, `-v`, pasta, `'*.txt'`), `commit` (`-m` várias vezes, `-a`, `-am`, `--amend`, `--no-edit`, `--allow-empty`, `-F`, `-C`, `--author`, `-s`, caminhos), `rm` (`--cached`, `-r`, `-f`, `-n`), `mv` (`-n`, `-v`, `-f`), `restore` (`--staged`, `--source`, `--ours/--theirs`), `.gitignore` (padrões, `!`, `/`, `**`, pastas; `.git/info/exclude`; `core.excludesFile`), `check-ignore` (`-v`).
- **Histórico:** `log` (`--oneline`, `--graph` — **o mesmo desenho do Git**, porte do `graph.c` —, `--all`, `-p`, `--stat`, `--shortstat`, `--name-only`, `--name-status`, `-n`/`-3`, `--decorate`, `--reverse`, `--first-parent`, `--merges`, `--no-merges`, `--grep`, `--author`, `-i`, `-S`, `-G`, `--since`/`--until` (`2026-10-14`, `2 days ago`, `yesterday`), `-g`, `--date=short|iso|iso-strict|relative|rfc|raw|human|format:%d/%m/%Y` (o `%b`/`%a` saem em português, como no lab), `--format`/`--pretty=format:` com `%h %H %s %b %an %ae %ad %ar %as %ai %ci %cr %cn %d %D %n %<(20)`…, `--pretty=short|full`, `--fuller`, `--decorate=full`, `A..B`, `A...B`, `-- arquivo`), `show` (commit, `HEAD~1`, `HEAD^2`, `HEAD:arquivo`, tag anotada, merge), `diff` (sem nada, `--staged`/`--cached`, `HEAD`, `A B`, `A..B`, `--stat`, `--name-only`, `--name-status`, `-U1`, `--word-diff`, `--quiet`, `--exit-code`, o `diff --cc` de conflito), `blame` (`-L`, `-e`, `-s`, linhas não commitadas), `grep` (`-n -c -l -i -w -v -e -E -F`, `--cached`, numa revisão), `reflog`, `rev-parse`, `cat-file -p/-t/-s`, `hash-object`, `ls-files`, `ls-tree`, `write-tree`, `rev-list --count`, `merge-base`.
- **Ramos:** `branch` (`-d -D -m -M -c -a -r -v -vv --merged --no-merged --contains --show-current -u --unset-upstream`), `switch` (`-c`, `-C`, `-`, `--detach`, `-q`, ramo que só existe no remoto), `checkout` (ramo, `-b`, commit → HEAD destacado com o aviso completo, `-- arquivo`, `--ours/--theirs`), `merge` (fast-forward, 3 vias "Merge made by the 'ort' strategy.", `--no-ff`, `--ff-only`, `--squash`, `--no-commit`, conflito com marcadores, `--abort`, `--continue`), `tag` (leve, `-a -m`, `-d`, `-l 'v1.*'`, `-n`), `rebase` (com conflito, `--continue/--skip/--abort`, `--onto`), `cherry-pick` (`-x`, `A..B`, conflito, `--continue/--abort/--skip`), `revert`, `reset` (`--soft`, `--mixed`, `--hard`, `reset arquivo`), `stash` (`push -m -u`, `save`, `list`, `show -p`, `pop`, `apply`, `drop`, `clear`, `branch`), `clean` (`-n -f -d -x -X -e PADRÃO`), `bisect` (`start/good/bad/skip/run/log/reset`, com a mesma escolha de commits do Git).
- **Remotos** com o "GitHub" do simulador (abaixo): `remote` (`add`, `-v`, `remove`, `rename`, `get-url`, `set-url`, `show`), `clone` (`-b`, `-o`, pasta, caminho local, repositório vazio, inexistente), `fetch` (`--all`, `--prune`; cria o `origin/HEAD`, como o 2.53), `pull` (fast-forward, "Already up to date.", o `fatal: Need to specify how to reconcile divergent branches.` quando divergem e não há `pull.rebase`, `--no-rebase` com conflito marcado pelo hash, `--rebase`, `--ff-only`), `push` (`-u`, `--set-upstream`, ramo novo com o aviso "Create a pull request…", rejeitado `(fetch first)`/`(non-fast-forward)`, `--force`, `--force-with-lease`, `--delete`, `--tags`, "Everything up-to-date"), `ls-remote`.
- **No terminal da página**: <kbd>Tab</kbd> completa subcomandos (`git sw` → `git switch`), ramos, tags e remotos (`git switch so` → `sobremesas`; `git push o` → `origin`), e os subcomandos de `stash`, `remote` e `bisect`. O `git log` no terminal mostra `(HEAD -> main, …)` (é um terminal, como o `lab -t`); com `| cat`, não.
- **`git -c chave=valor`**, `-C pasta`, `--version`, `git COMANDO -h` (o texto do lab), comando inexistente (a mensagem do Git com a sugestão: `git comit` → `commit`).
- **Editor:** só editores "de linha de comando". `GIT_EDITOR=true`, `GIT_EDITOR='sed -i …'` e `GIT_SEQUENCE_EDITOR='sed -i …'` funcionam: é assim que se faz **`git rebase -i`** numa missão (`GIT_SEQUENCE_EDITOR='sed -i 2s/^pick/squash/' git rebase -i main`; `pick reword edit squash fixup drop exec break`) e um `git commit` sem `-m`. Com o editor padrão da Ana (`nano`) ou `vim`, o simulador responde com uma linha `(simulador) …` (no `commit --amend` e no `git rebase --continue` ele mantém a mensagem, como se a Ana salvasse sem mudar). **No lab `-i` (sem terminal) o `git rebase --continue` falha** (`error: there was a problem with the editor 'nano'`): para colher a saída, use `GIT_EDITOR=true git rebase --continue` no lab, ou o `-t`. O `git merge` sem `-m` não abre editor no simulador nem no `lab -i` (num terminal de verdade, abre).

### O "GitHub" do simulador (missões com remotos)
URLs `https://github.com/DONO/REPO.git` (com ou sem `.git`) apontam para repositórios guardados **fora** da pasta da Ana (o leitor não os vê com `ls`). Os textos imitam o lab (mensagens `remote:` em inglês, `Repository not found`, o aviso de pull request). No **`data-setup`** existe o comando **`github`**, igual ao `~/guia-git-lab/github` do lab:

| No `data-setup` | O que faz |
| --- | --- |
| `github novo ana-souza/receitas` | cria o repositório vazio no GitHub (branch padrão `main`) |
| `github bruno 'COMANDOS'` | o Bruno (`Bruno Lima <bruno@exemplo.com>`, pasta `/home/bruno`, que a Ana não vê) roda comandos, com o mesmo GitHub e a mesma data fixa. Ex.: `github bruno 'git clone -q https://github.com/ana-souza/receitas.git &amp;&amp; cd receitas &amp;&amp; echo sal &gt;&gt; bolo.txt &amp;&amp; git commit -qam "Adiciona sal" &amp;&amp; git push -q'` |
| `github log ana-souza/receitas` / `github lista` / `github apaga DONO/REPO` | ver o histórico no servidor / listar / apagar |

Exemplo de missão de push: `data-setup="github novo ana-souza/receitas;;mkdir receitas;;cd receitas;;git init -q;;echo oi &gt; a.txt;;git add .;;git commit -qm um;;git remote add origin https://github.com/ana-souza/receitas.git"`, `data-goal="remoto:origin,err:[new branch],contem:origin/main:a.txt=oi"` (a saída do push vai para o stderr: use `err:`), `data-solucao="git push -u origin main"`. **Não há** SSH (`git@github.com:…` dá o `Connection refused` do lab), login/token (o push nunca pede senha: o `github login on` do lab não existe aqui), site, pull request, fork. Os hashes do Bruno também saem iguais aos do lab.

### Mensagens: o pt_BR **misturado** do Ubuntu
O Git 2.53 do Ubuntu 26.04 é traduzido só em parte (pegadinha 1 do `COMO-USAR.md` do lab), e o simulador **imita a mistura exatamente**, copiada do lab (e do catálogo `git.mo` do pacote de idioma): `No ramo main` + `No commits yet` + `nothing to commit, working tree clean`; `Mudanças a serem submetidas:` + `new file:`/`modified:` em inglês; `Mesclagem automática de bolo.txt` / `CONFLITO (conteúdo): conflito de mesclagem em bolo.txt` + `Automatic merge failed; …`; `ambos modificados:`; `Seu ramo está atrás de 'origin/main' em 1 submissão, e pode ser avançado.`; `O seu branch e 'origin/main' divergiram-se,`; `error: não foi possível aplicar d3bd4db... Ana escreve` no rebase; `hint:` sempre em inglês; `git log`/`Date:` sempre em inglês. **Não "corrija" as frases**: se o simulador e o lab divergirem, vale o lab — avise o agente do simulador.

### Metas (`data-goal`)
Valem as do Guia Bash (`dir: file: absent: exec: link: contains: cwd: var: ran: out: outre: err: errre: exit:`) e as do Git:

| Meta | Verdade quando… |
| --- | --- |
| `repo` | a pasta atual está dentro de um repositório |
| `commits:N` | o HEAD tem exatamente N commits (`git rev-list --count HEAD`; 0 sem commits) |
| `limpo` | `git status --porcelain` vazio (nada preparado, nada modificado, **nenhum não rastreado**, sem conflito) |
| `preparado:CAMINHO` | o arquivo tem mudança na área de preparo (HEAD × índice; vale o nome novo ou o antigo de um `mv`) |
| `naopreparado:CAMINHO` | o arquivo tem mudança fora da área de preparo (índice × pasta), ou está em conflito |
| `rastreado:CAMINHO` / `ignorado:CAMINHO` | está no índice / é ignorado e não rastreado |
| `branch:NOME` / `semBranch:NOME` | o branch local existe / não existe |
| `head:NOME` | o branch atual é NOME; `head:destacado` = HEAD destacado |
| `msg:TEXTO` | a mensagem do commit HEAD contém TEXTO |
| `logre:REGEX` | a saída de `git log --oneline` do HEAD (sem decoração) casa com a regex (JavaScript, multilinha: `^`/`$` por linha) |
| `tag:NOME` / `remoto:NOME` | a tag existe / o remoto existe (`remote.NOME.url`) |
| `conflito` | há arquivos em conflito no índice |
| `semconflito` | não há conflito **e** não há merge/cherry-pick/revert/rebase em andamento |
| `contem:REF=TEXTO` | o arquivo na versão REF contém TEXTO (`HEAD:bolo.txt`, `main:README.md`, `HEAD~1:a.txt`, `origin/main:a.txt`; caminho a partir da raiz do repositório) |
| `stash:N` | há exatamente N itens no stash |

> ⚠ **Caminhos nas metas:** as metas **de arquivo do Bash** (`file:`, `dir:`, `absent:`, `contains:`, `exec:`, `link:`) são a partir de **`~` (a pasta pessoal da Ana), NÃO da pasta atual**: dentro de `~/receitas`, escreva `contains:receitas/bolo.txt=…` (ou `contains:~/receitas/bolo.txt=…`), nunca `contains:bolo.txt=…`. O testador acusa erro quando o caminho só faz sentido a partir da pasta atual. Já as metas **do Git** (`preparado:`, `naopreparado:`, `rastreado:`, `ignorado:`) são a partir da **pasta atual** (como o leitor digitaria `git add bolo.txt`), e `contem:` a partir da raiz do repositório.

Separe as metas com vírgula; `\,` é uma vírgula dentro de uma meta.

### Testador e testes
- `node tools/testar-missoes.js pagina.html` (na VPS; ou `~/guia-git-lab/testar pagina.html`): para cada `.try`, roda o `data-setup`, confere que a meta **ainda não** foi cumprida, digita o `data-solucao` e confere que **foi**; e acusa metas de arquivo com caminho relativo à pasta atual.
- **`--nativo`**: roda também o setup + a solução **no Git real do lab** (as linhas `github …` no `~/guia-git-lab/github`) e mostra um aviso ⚠ com a diferença quando a saída do terminal do simulador não é igual à do lab. Lento (~1–2 s por missão; resultados em `tools/.cache-nativo.json`). Use antes de publicar uma página.
- `node tools/testes/rodar.js git` compara os casos `tools/testes/20-git-*.casos` com o Git do lab (os outros `.casos` são do Bash, contra o lab do Guia Bash, com a pasta antiga da Ana).

### O que não existe no simulador (e diferenças conhecidas)
- **Editores de tela** (`nano`, `vim`): ver "Editor" acima. `git add -p`/`-i` e `git clean -i` respondem `(simulador) …`.
- **Hooks não rodam** (`.git/hooks` existe, vazio). **Não há pager nem cores** (como no `lab -i`): `--color-words` não existe.
- **Progresso** do `clone`/`push`/`fetch` (`Enumerating objects…`, `Writing objects…`) não aparece: o simulador imita o `lab -i` (sem terminal). Se a aula mostrar a saída do `lab -t`, explique que o terminal do guia mostra a versão curta.
- O conteúdo de `.git/objects/…` e de `.git/index` é texto num formato próprio (no Git real é comprimido/binário): não mostre `cat` desses arquivos a partir do simulador. `ls .git` é igual ao real (menos `packed-refs`, que o simulador não usa).
- `git blame` não segue renomeações; `log --follow` é aceito e ignorado; similaridade de renomeação (`R087`) é aproximada (as de 100% são exatas).
- Submódulos, worktree, `notes`, `format-patch/am`, `archive`, `gc`, `describe`, `shortlog` respondem `(simulador) …`.
- A sugestão de comando parecido (`git sw` → `switch`, `show`) segue a conta do Git, mas a ordem entre empatados pode variar.

## 5. Fidelidade: o laboratório (`~/guia-git-lab/lab`, na VPS)
É a máquina da Ana (usuária `ana`, computador `notebook`, `/home/ana`, pt_BR, Ubuntu 26.04) com **o Git real do Ubuntu**, a data fixa (15/10/2026 10:30, a mesma do simulador) e um "GitHub de mentira" local para `clone`/`push`/`pull` (detalhes no `~/guia-git-lab/COMO-USAR.md`, na VPS):
- toda saída de `pre.term` sai do lab, **nunca de memória**;
- **as mensagens do Git saem misturadas**: a tradução do Git do Ubuntu é parcial (português do Brasil, de Portugal e muito inglês: o merge, o stash, o tag, as dicas `hint:`). Copie exatamente como saíram e aponte para a nota de `primeiro-commit.html`, que explica isso ao leitor;
- o que é do site do GitHub (botões, telas, pull request na web) é **ilustrativo**: diga isso e baseie-se na documentação oficial (docs.github.com/pt);
- **Privacidade:** nada da máquina real nem da VPS; só `/home/ana/…`, `ana@notebook`, `Ana Souza <ana@exemplo.com>`, usuário `ana-souza` no GitHub (fictício).

## 6. Escrita
- Português do Brasil, frases curtas, "você". O leitor nunca usou Git.
- Termos em inglês ganham tradução na primeira vez: *commit* = "registro/fotografia", *branch* = "ramo", *merge* = "mesclar/juntar", *staging area* = "área de preparo", *push* = "empurrar/enviar".
- Exemplos com a vida da Ana: o site de receitas, o TCC, a lojinha, trabalhando em dupla com o Bruno.
- Boas práticas desde o começo, sempre com o porquê: commits pequenos, mensagens claras no imperativo, `git status` sempre, nunca `--force` sem `--with-lease`, nunca commitar senhas.
